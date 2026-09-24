import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { AffiliateCreationService } from './affiliate';
import { PrismaService } from '../../prisma/prisma.service';
import { HubspotAuditService } from '../hubspot-audit.service';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { UserAuditService } from '../../user-audit/user-audit.service';

const userAuditServiceMock = {
  log: jest.fn().mockResolvedValue(undefined),
  logOrThrow: jest.fn().mockResolvedValue(undefined),
  logMany: jest.fn().mockResolvedValue(undefined),
  logUpdate: jest.fn().mockResolvedValue(undefined),
  logBulkUpdate: jest.fn().mockResolvedValue(undefined),
  buildUpdateEntries: jest.fn().mockReturnValue([]),
};

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const prismaMock = {
  uSER: { findUnique: jest.fn(), update: jest.fn() },
  contact: { updateMany: jest.fn() },
  affiliateProfile: { update: jest.fn() },
};
const auditMock = { log: jest.fn() };

const baseData = {
  id: 'aff-uuid-001',
  status: 'active',
  created_by: null,
  user: {
    id: 'user-uuid-001',
    first_name: 'Jane',
    last_name: 'Smith',
    email: 'jane@example.com',
    phone: '5559999999',
    hubspot_contact_id: null,
    organization: {
      name: 'Acme',
      business_unit: 'MedVirtual',
      hubspot_id: null,
    },
    contact: null,
  },
};

describe('AffiliateCreationService', () => {
  let service: AffiliateCreationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: UserAuditService, useValue: userAuditServiceMock },
        AffiliateCreationService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HubspotAuditService, useValue: auditMock },
      ],
    }).compile();

    service = module.get<AffiliateCreationService>(AffiliateCreationService);
  });

  // ── Success path ─────────────────────────────────────────────────────────────

  describe('execute() — success', () => {
    beforeEach(() => {
      // ensureContact POST (creates contact)
      mockedAxios.post.mockResolvedValueOnce({
        data: { id: 'hs-contact-111' },
      });
      prismaMock.uSER.update.mockResolvedValueOnce({});
      prismaMock.contact.updateMany.mockResolvedValueOnce({});
      // Growth Partner POST
      mockedAxios.post.mockResolvedValueOnce({ data: { id: 'hs-gp-999' } });
      prismaMock.affiliateProfile.update.mockResolvedValueOnce({});
    });

    it('returns true on success', async () => {
      const result = await service.execute(baseData, 'user-abc');
      expect(result).toBe(true);
    });

    it('saves hubspot_id to affiliateProfile', async () => {
      await service.execute(baseData, 'user-abc');
      expect(prismaMock.affiliateProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'aff-uuid-001' },
          data: { hubspot_id: 'hs-gp-999' },
        }),
      );
    });

    it('logs CREATE with success=true and correct fields', async () => {
      await service.execute(baseData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-abc',
          entityType: HubspotEntityType.affiliate,
          entityId: 'aff-uuid-001',
          hubspotObjectId: 'hs-gp-999',
          hubspotObjectType: 'p20630393_growth_partners',
          action: HubspotAuditAction.CREATE,
          source: HubspotAuditSource.user_action,
          success: true,
          payload: { email: 'jane@example.com' },
          response: { id: 'hs-gp-999' },
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
    it('logs CREATE with success=false and throws BadRequestException on HTTP error', async () => {
      // ensureContact succeeds, Growth Partner POST fails
      mockedAxios.post.mockResolvedValueOnce({
        data: { id: 'hs-contact-111' },
      });
      prismaMock.uSER.update.mockResolvedValueOnce({});
      prismaMock.contact.updateMany.mockResolvedValueOnce({});
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 500, data: {} },
        message: 'Internal Server Error',
      });

      await expect(service.execute(baseData, 'user-abc')).rejects.toThrow(
        BadRequestException,
      );

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.affiliate,
          entityId: 'aff-uuid-001',
          action: HubspotAuditAction.CREATE,
          success: false,
          errorCode: '500',
          errorMessage: 'Internal Server Error',
        }),
      );
    });

    it('logs success=false with error.code on network error', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { id: 'hs-contact-111' },
      });
      prismaMock.uSER.update.mockResolvedValueOnce({});
      prismaMock.contact.updateMany.mockResolvedValueOnce({});
      mockedAxios.post.mockRejectedValueOnce({
        message: 'Network Error',
        code: 'ECONNRESET',
      });

      await expect(service.execute(baseData)).rejects.toThrow(
        BadRequestException,
      );

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'ECONNRESET',
          errorMessage: 'Network Error',
        }),
      );
    });
  });

  // ── Source inference ──────────────────────────────────────────────────────────

  describe('source inference', () => {
    it('uses user_action when actorUserId is provided', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { id: 'hs-contact-111' },
      });
      prismaMock.uSER.update.mockResolvedValueOnce({});
      prismaMock.contact.updateMany.mockResolvedValueOnce({});
      mockedAxios.post.mockResolvedValueOnce({ data: { id: 'hs-gp-001' } });
      prismaMock.affiliateProfile.update.mockResolvedValueOnce({});

      await service.execute(baseData, 'user-123');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.user_action }),
      );
    });
  });

  // ── ensureContact resilience ────────────────────────────────────────────────

  describe('execute() — ensureContact resilience', () => {
    const dataWithExistingId = {
      ...baseData,
      user: { ...baseData.user, hubspot_contact_id: 'hs-contact-stale' },
    };

    it('patches the existing contact successfully when the id is not stale', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });
      mockedAxios.post.mockResolvedValueOnce({ data: { id: 'hs-gp-776' } });
      prismaMock.affiliateProfile.update.mockResolvedValueOnce({});

      const result = await service.execute(dataWithExistingId, 'user-abc');

      expect(result).toBe(true);
      expect(mockedAxios.patch).toHaveBeenCalledTimes(1);
      expect(mockedAxios.patch).toHaveBeenCalledWith(
        expect.stringContaining('hs-contact-stale'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('recovers from a stale existingContactId (404 on PATCH) by searching email and re-patching', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        response: { status: 404, data: {} },
      });
      mockedAxios.post.mockResolvedValueOnce({
        data: { results: [{ id: 'hs-contact-found' }] },
      });
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });
      prismaMock.uSER.update.mockResolvedValueOnce({});
      prismaMock.contact.updateMany.mockResolvedValueOnce({});
      mockedAxios.post.mockResolvedValueOnce({ data: { id: 'hs-gp-777' } });
      prismaMock.affiliateProfile.update.mockResolvedValueOnce({});

      const result = await service.execute(dataWithExistingId, 'user-abc');

      expect(result).toBe(true);
      expect(mockedAxios.patch).toHaveBeenCalledTimes(2);
      expect(mockedAxios.patch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('hs-contact-found'),
        expect.anything(),
        expect.anything(),
      );
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.contact,
          action: HubspotAuditAction.UPDATE,
          success: true,
          payload: expect.objectContaining({ recovery: 'stale_contact_id' }),
        }),
      );
    });

    it('falls through to create when stale id 404s and email search finds nothing', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        response: { status: 404, data: {} },
      });
      mockedAxios.post.mockResolvedValueOnce({
        data: { total: 0, results: [] },
      });
      mockedAxios.post.mockResolvedValueOnce({
        data: { id: 'hs-contact-new' },
      });
      prismaMock.uSER.update.mockResolvedValueOnce({});
      prismaMock.contact.updateMany.mockResolvedValueOnce({});
      mockedAxios.post.mockResolvedValueOnce({ data: { id: 'hs-gp-778' } });
      prismaMock.affiliateProfile.update.mockResolvedValueOnce({});

      const result = await service.execute(dataWithExistingId, 'user-abc');

      expect(result).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.hubapi.com/crm/v3/objects/contacts',
        expect.anything(),
        expect.anything(),
      );
    });

    it('recovers from a 409 conflict on create by searching email and linking the existing contact', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: {
          status: 409,
          data: { category: 'CONFLICT', message: 'Contact already exists' },
        },
      });
      mockedAxios.post.mockResolvedValueOnce({
        data: { results: [{ id: 'hs-contact-existing' }] },
      });
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });
      prismaMock.uSER.update.mockResolvedValueOnce({});
      prismaMock.contact.updateMany.mockResolvedValueOnce({});
      mockedAxios.post.mockResolvedValueOnce({ data: { id: 'hs-gp-779' } });
      prismaMock.affiliateProfile.update.mockResolvedValueOnce({});

      const result = await service.execute(baseData, 'user-abc');

      expect(result).toBe(true);
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.contact,
          action: HubspotAuditAction.UPDATE,
          payload: expect.objectContaining({
            recovery: 'untracked_duplicate_conflict',
          }),
        }),
      );
    });

    it('propagates a 409 conflict as-is when email search finds nothing (unrecoverable)', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: {
          status: 409,
          data: { category: 'CONFLICT', message: 'Contact already exists' },
        },
      });
      mockedAxios.post.mockResolvedValueOnce({
        data: { total: 0, results: [] },
      });

      await expect(service.execute(baseData, 'user-abc')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('propagates a non-404 error on PATCH by existingContactId without attempting recovery', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        response: { status: 500, data: {} },
        message: 'Server Error',
      });

      await expect(
        service.execute(dataWithExistingId, 'user-abc'),
      ).rejects.toThrow(BadRequestException);
      expect(mockedAxios.post).not.toHaveBeenCalledWith(
        expect.stringContaining('/search'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('falls through to create when the stale-id email search itself throws', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        response: { status: 404, data: {} },
      });
      mockedAxios.post.mockRejectedValueOnce({ message: 'Search unavailable' });
      mockedAxios.post.mockResolvedValueOnce({
        data: { id: 'hs-contact-new-2' },
      });
      prismaMock.uSER.update.mockResolvedValueOnce({});
      prismaMock.contact.updateMany.mockResolvedValueOnce({});
      mockedAxios.post.mockResolvedValueOnce({ data: { id: 'hs-gp-780' } });
      prismaMock.affiliateProfile.update.mockResolvedValueOnce({});

      const result = await service.execute(dataWithExistingId, 'user-abc');

      expect(result).toBe(true);
    });

    it('propagates a plain network error without attempting recovery', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        message: 'Network Error',
        code: 'ECONNRESET',
      });

      await expect(service.execute(baseData, 'user-abc')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockedAxios.patch).not.toHaveBeenCalled();
    });
  });
});
