import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { ContactCreationService } from './contact';
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
  uSER: { findUnique: jest.fn(), update: jest.fn() },
};
const auditMock = { log: jest.fn() };

const baseData = {
  id: 'user-uuid-001',
  first_name: 'Alice',
  last_name: 'Wonder',
  email: 'alice@example.com',
  phone: '5551112222',
  job_title: 'Manager',
  organization: {
    name: 'Org Inc',
    business_unit: 'MedVirtual',
    hubspot_id: 'hs-company-123',
    admin_id: null,
  },
};

describe('ContactCreationService', () => {
  let service: ContactCreationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactCreationService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HubspotAuditService, useValue: auditMock },
      ],
    }).compile();

    service = module.get<ContactCreationService>(ContactCreationService);
  });

  // ── Success path ─────────────────────────────────────────────────────────────

  describe('execute() — success', () => {
    beforeEach(() => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { id: 'hs-contact-555' },
      });
      prismaMock.uSER.update.mockResolvedValueOnce({});
    });

    it('returns true on success', async () => {
      const result = await service.execute(baseData, 'user-abc');
      expect(result).toBe(true);
    });

    it('saves hubspot_contact_id to USER record', async () => {
      await service.execute(baseData, 'user-abc');
      expect(prismaMock.uSER.update).toHaveBeenCalledWith({
        where: { id: 'user-uuid-001' },
        data: { hubspot_contact_id: 'hs-contact-555' },
      });
    });

    it('logs CREATE with success=true and correct fields', async () => {
      await service.execute(baseData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-abc',
          entityType: HubspotEntityType.contact,
          entityId: 'user-uuid-001',
          hubspotObjectId: 'hs-contact-555',
          hubspotObjectType: 'contacts',
          action: HubspotAuditAction.CREATE,
          source: HubspotAuditSource.user_action,
          success: true,
          payload: { email: 'alice@example.com' },
          response: { id: 'hs-contact-555' },
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
    it('logs CREATE with success=false on HTTP error', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 409, data: {} },
        message: 'Conflict',
      });

      await service.execute(baseData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.contact,
          entityId: 'user-uuid-001',
          hubspotObjectType: 'contacts',
          action: HubspotAuditAction.CREATE,
          source: HubspotAuditSource.user_action,
          success: false,
          errorCode: '409',
          errorMessage: 'Conflict',
        }),
      );
    });

    it('logs success=false with error.code on network error', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        message: 'Network Error',
        code: 'ETIMEDOUT',
      });

      await service.execute(baseData);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'ETIMEDOUT',
          errorMessage: 'Network Error',
        }),
      );
    });

    it('does not update USER when API fails', async () => {
      mockedAxios.post.mockRejectedValueOnce({ message: 'fail', code: 'ERR' });
      await service.execute(baseData);
      expect(prismaMock.uSER.update).not.toHaveBeenCalled();
    });
  });

  // ── Source inference ──────────────────────────────────────────────────────────

  describe('source inference', () => {
    it('uses user_action when actorUserId is provided', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { id: 'hs-1' } });
      prismaMock.uSER.update.mockResolvedValueOnce({});
      await service.execute(baseData, 'user-123');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.user_action }),
      );
    });

    it('uses cron when actorUserId is absent', async () => {
      mockedAxios.post.mockRejectedValueOnce({ message: 'err', code: 'ERR' });
      await service.execute(baseData);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.cron }),
      );
    });
  });
});
