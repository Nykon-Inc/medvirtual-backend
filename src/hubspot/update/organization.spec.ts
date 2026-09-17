import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { OrganizationUpdateService } from './organization';
import { PrismaService } from '../../prisma/prisma.service';
import { HubspotAuditService } from '../hubspot-audit.service';
import { OwnerCreationService } from '../create/Owner';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const prismaMock = {
  uSER: { findUnique: jest.fn() },
  organization: { findUnique: jest.fn() },
  affiliateProfile: { findUnique: jest.fn() },
};
const auditMock = { log: jest.fn() };
const ownerCreationMock = { execute: jest.fn() };

const baseData = {
  id: 'org-uuid-001',
  hubspot_id: 'hs-company-123',
  admin: { id: null },
};

describe('OrganizationUpdateService', () => {
  let service: OrganizationUpdateService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationUpdateService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HubspotAuditService, useValue: auditMock },
        { provide: OwnerCreationService, useValue: ownerCreationMock },
      ],
    }).compile();

    service = module.get<OrganizationUpdateService>(OrganizationUpdateService);
  });

  // ── execute() — success ───────────────────────────────────────────────────────

  describe('execute() — success', () => {
    beforeEach(() => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });
    });

    it('returns true on success', async () => {
      const result = await service.execute(baseData, 'user-abc');
      expect(result).toBe(true);
    });

    it('logs UPDATE with success=true and correct entity fields', async () => {
      await service.execute(baseData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-abc',
          entityType: HubspotEntityType.organization,
          entityId: 'org-uuid-001',
          hubspotObjectId: 'hs-company-123',
          hubspotObjectType: 'companies',
          action: HubspotAuditAction.UPDATE,
          source: HubspotAuditSource.user_action,
          success: true,
          payload: expect.objectContaining({ fields: expect.any(Array) }),
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

    it('falls back to hubspot_id as entityId when id is missing', async () => {
      const dataWithoutId = { ...baseData, id: undefined };
      await service.execute(dataWithoutId, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'hs-company-123' }),
      );
    });
  });

  // ── execute() — failure ───────────────────────────────────────────────────────

  describe('execute() — failure', () => {
    it('logs UPDATE with success=false on HTTP error', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        response: { status: 403, data: {} },
        message: 'Forbidden',
      });

      await service.execute(baseData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.organization,
          entityId: 'org-uuid-001',
          hubspotObjectId: 'hs-company-123',
          hubspotObjectType: 'companies',
          action: HubspotAuditAction.UPDATE,
          success: false,
          errorCode: '403',
          errorMessage: 'Forbidden',
        }),
      );
    });

    it('logs success=false with error.code on network error', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        message: 'Network Error',
        code: 'ECONNRESET',
      });

      await service.execute(baseData);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'ECONNRESET',
          source: HubspotAuditSource.cron,
        }),
      );
    });
  });

  // ── setAffiliateReferral() ────────────────────────────────────────────────────

  describe('setAffiliateReferral()', () => {
    const orgId = 'org-uuid-001';
    const affiliateUserId = 'aff-user-001';

    beforeEach(() => {
      prismaMock.organization.findUnique.mockResolvedValue({
        hubspot_id: 'hs-company-123',
      });
      prismaMock.affiliateProfile.findUnique.mockResolvedValue({
        hubspot_id: 'hs-gp-001',
      });
      prismaMock.uSER.findUnique.mockResolvedValue({
        email: 'aff@example.com',
      });
    });

    it('logs UPDATE with success=true on successful referral patch', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });
      mockedAxios.put.mockResolvedValueOnce({ data: {} });

      await service.setAffiliateReferral(orgId, affiliateUserId, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.organization,
          entityId: orgId,
          hubspotObjectId: 'hs-company-123',
          hubspotObjectType: 'companies',
          action: HubspotAuditAction.UPDATE,
          success: true,
          payload: { fields: ['referral_source', 'referral_partners_email'] },
        }),
      );
    });

    it('logs success=false when referral patch fails', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        response: { status: 400 },
        message: 'Bad Request',
      });

      await service.setAffiliateReferral(orgId, affiliateUserId, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: orgId,
          action: HubspotAuditAction.UPDATE,
          success: false,
          errorCode: '400',
        }),
      );
    });

    it('returns early without calling API when org has no hubspot_id', async () => {
      prismaMock.organization.findUnique.mockResolvedValueOnce({
        hubspot_id: null,
      });

      await service.setAffiliateReferral(orgId, affiliateUserId);

      expect(mockedAxios.patch).not.toHaveBeenCalled();
      expect(auditMock.log).not.toHaveBeenCalled();
    });
  });

  // ── setHubstaffProjectId() ────────────────────────────────────────────────────

  describe('setHubstaffProjectId()', () => {
    const orgId = 'org-uuid-001';

    beforeEach(() => {
      prismaMock.organization.findUnique.mockResolvedValue({
        hubspot_id: 'hs-company-123',
      });
    });

    it('patches hubspot_project_id on the matching company', async () => {
      prismaMock.organization.findUnique.mockResolvedValueOnce({
        hubspot_id: '987654',
      });
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });

      await service.setHubstaffProjectId(orgId, 'hubstaff-999', 'user-abc');

      expect(mockedAxios.patch).toHaveBeenCalledWith(
        'https://api.hubapi.com/crm/v3/objects/companies/987654',
        { properties: { hubspot_project_id: 'hubstaff-999' } },
        expect.any(Object),
      );
    });

    it('logs UPDATE with success=true and the patched field', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });

      await service.setHubstaffProjectId(
        orgId,
        'hubstaff-999',
        'user-abc',
        'Hubstaff ID updated from organization profile',
      );

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-abc',
          entityType: HubspotEntityType.organization,
          entityId: orgId,
          hubspotObjectId: 'hs-company-123',
          hubspotObjectType: 'companies',
          action: HubspotAuditAction.UPDATE,
          source: HubspotAuditSource.user_action,
          success: true,
          payload: {
            fields: ['hubspot_project_id'],
            reason: 'Hubstaff ID updated from organization profile',
          },
        }),
      );
    });

    it('sends an empty string when clearing the value', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });

      await service.setHubstaffProjectId(orgId, null, 'user-abc');

      expect(mockedAxios.patch).toHaveBeenCalledWith(
        expect.any(String),
        { properties: { hubspot_project_id: '' } },
        expect.any(Object),
      );
    });

    it('returns early without calling the API when org has no hubspot_id', async () => {
      prismaMock.organization.findUnique.mockResolvedValueOnce({
        hubspot_id: null,
      });

      await service.setHubstaffProjectId(orgId, 'hubstaff-999');

      expect(mockedAxios.patch).not.toHaveBeenCalled();
      expect(auditMock.log).not.toHaveBeenCalled();
    });

    it('logs success=false and does not throw when the patch fails', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        response: { status: 429, data: {} },
        message: 'Too Many Requests',
      });

      await expect(
        service.setHubstaffProjectId(orgId, 'hubstaff-999', 'user-abc'),
      ).resolves.toBeUndefined();

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: orgId,
          action: HubspotAuditAction.UPDATE,
          success: false,
          errorCode: '429',
          errorMessage: 'Too Many Requests',
        }),
      );
    });

    it('uses cron source when actorUserId is absent', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });

      await service.setHubstaffProjectId(orgId, 'hubstaff-999');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          source: HubspotAuditSource.cron,
          success: true,
        }),
      );
    });
  });

  // ── Source inference ──────────────────────────────────────────────────────────

  describe('source inference', () => {
    it('uses user_action when actorUserId provided', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });
      await service.execute(baseData, 'user-123');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.user_action }),
      );
    });

    it('uses cron when actorUserId absent', async () => {
      mockedAxios.patch.mockRejectedValueOnce({ message: 'err', code: 'ERR' });
      await service.execute(baseData);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.cron }),
      );
    });
  });
});
