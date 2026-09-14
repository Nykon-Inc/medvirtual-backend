import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { ContactFromCompanyCreationService } from './contactFromCompany';
import { PrismaService } from '../../prisma/prisma.service';
import { HubspotAuditService } from '../hubspot-audit.service';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const prismaMock = {
  uSER: { findUnique: jest.fn() },
};
const auditMock = { log: jest.fn() };

const baseData = {
  id: 'org-uuid-001',
  hubspot_id: 'hs-company-123',
  name: 'Clinic Partners',
  business_unit: 'Med Virtual',
  email: 'clinic@example.com',
  contact_email: 'contact@example.com',
  contact_first_name: 'Bob',
  contact_last_name: 'Builder',
  phone: '5558887777',
  website_url: 'https://clinic.com',
  job_title: 'Director',
  referToUser: null,
  admin_id: null,
  referredByAffiliate: {
    email: 'affiliate@example.com',
    affiliateProfile: {
      full_name: 'Partner Name',
      hubspot_id: 'hs-gp-001',
      commission_percent_default: 10,
      preferred_payment_method: 'ACH',
    },
    organization: {
      name: 'Partner Org',
      email: 'partnerorg@example.com',
    },
  },
};

describe('ContactFromCompanyCreationService', () => {
  let service: ContactFromCompanyCreationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactFromCompanyCreationService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HubspotAuditService, useValue: auditMock },
      ],
    }).compile();

    service = module.get<ContactFromCompanyCreationService>(
      ContactFromCompanyCreationService,
    );
  });

  // ── Success path ─────────────────────────────────────────────────────────────

  describe('execute() — success', () => {
    beforeEach(() => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { id: 'hs-contact-777' },
      });
    });

    it('returns the HubSpot contact id on success', async () => {
      const result = await service.execute(baseData, 'user-abc');
      expect(result).toBe('hs-contact-777');
    });

    it('logs CREATE with success=true and correct fields', async () => {
      await service.execute(baseData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-abc',
          entityType: HubspotEntityType.contact,
          entityId: 'org-uuid-001',
          hubspotObjectId: 'hs-contact-777',
          hubspotObjectType: 'contacts',
          action: HubspotAuditAction.CREATE,
          source: HubspotAuditSource.user_action,
          success: true,
          payload: { email: 'clinic@example.com' },
          response: { id: 'hs-contact-777' },
        }),
      );
    });

    it('uses cron source when actorUserId is absent', async () => {
      await service.execute(baseData);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          source: HubspotAuditSource.cron,
          success: true,
        }),
      );
    });
  });

  // ── Failure path ──────────────────────────────────────────────────────────────

  describe('execute() — failure', () => {
    it('logs CREATE with success=false and rethrows on HTTP error', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 500, data: {} },
        message: 'Internal Server Error',
      });

      // The service catches + rethrows — but only when error.response is set.
      // With response present the service logs + rethrows.
      let threw = false;
      try {
        await service.execute(baseData, 'user-abc');
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.contact,
          entityId: 'org-uuid-001',
          hubspotObjectType: 'contacts',
          action: HubspotAuditAction.CREATE,
          success: false,
          errorCode: '500',
          errorMessage: 'Internal Server Error',
        }),
      );
    });

    it('logs success=false with error.code on network error and rethrows', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        message: 'Network Error',
        code: 'ECONNREFUSED',
      });

      let threw = false;
      try {
        await service.execute(baseData);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'ECONNREFUSED',
          errorMessage: 'Network Error',
        }),
      );
    });
  });

  // ── Source inference ──────────────────────────────────────────────────────────

  describe('source inference', () => {
    it('uses user_action when actorUserId provided', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { id: 'hs-1' } });
      await service.execute(baseData, 'user-123');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.user_action }),
      );
    });

    it('uses cron when actorUserId absent and logs it before rethrowing', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        message: 'err',
        code: 'ERR',
      });

      let threw = false;
      try {
        await service.execute(baseData);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.cron }),
      );
    });
  });
});
