import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { OrganizationCreationService } from './Organization';
import { PrismaService } from '../../prisma/prisma.service';
import { HubspotAuditService } from '../hubspot-audit.service';
import { BusinessUnitContext } from '../../business-units/business-unit-context.service';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const prismaMock = {
  uSER: { findUnique: jest.fn() },
  affiliateProfile: { findUnique: jest.fn() },
  organization: { update: jest.fn() },
};
const auditMock = { log: jest.fn() };

/**
 * Minimal visible-BU table for `resolveByHubspotValue` — mirrors the real
 * `BusinessUnitContext` normalization (trim/lowercase/strip-spaces) without
 * touching Prisma. Covers Med, Berry, and a 3rd BU (MMVA) so the outbound
 * normalization is proven data-driven, not a 2-BU special case.
 */
const BU_ROWS = [
  { hubspot_value: 'MedVirtual', name: 'Med Virtual', slug: 'medvirtual' },
  {
    hubspot_value: 'Berry Virtual',
    name: 'Berry Virtual',
    slug: 'berryvirtual',
  },
  { hubspot_value: 'MMVA', name: 'My Medical VA', slug: 'mmva' },
];
const normalize = (v?: string | null) =>
  (v ?? '').trim().toLowerCase().replace(/\s+/g, '');

const businessUnitContextMock = {
  resolveByHubspotValue: jest.fn(async (v: string) => {
    const target = normalize(v);
    if (!target) return null;
    return (
      BU_ROWS.find(
        (row) =>
          normalize(row.hubspot_value) === target ||
          normalize(row.name) === target ||
          normalize(row.slug) === target,
      ) ?? null
    );
  }),
};

const baseData = {
  id: 'org-uuid-001',
  name: 'Acme Hospital',
  description: 'A great hospital',
  address: '123 Main St',
  city: 'Miami',
  state: 'FL',
  postal_code: '33101',
  location: 'USA',
  website_url: 'https://acme.com',
  number_of_employees: 50,
  phone: '5551234567',
  email: 'contact@acme.com',
  type: 'Healthcare',
  business_unit: 'MedVirtual',
};

describe('OrganizationCreationService', () => {
  let service: OrganizationCreationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationCreationService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HubspotAuditService, useValue: auditMock },
        { provide: BusinessUnitContext, useValue: businessUnitContextMock },
      ],
    }).compile();

    service = module.get<OrganizationCreationService>(
      OrganizationCreationService,
    );
  });

  // ── Success path ─────────────────────────────────────────────────────────────

  describe('execute() — success', () => {
    beforeEach(() => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { id: 'hs-company-999' },
      });
      prismaMock.organization.update.mockResolvedValueOnce({});
    });

    it('returns true on success', async () => {
      const result = await service.execute(baseData, 'user-abc');
      expect(result).toBe(true);
    });

    it('saves hubspot_id to organization record', async () => {
      await service.execute(baseData, 'user-abc');
      expect(prismaMock.organization.update).toHaveBeenCalledWith({
        where: { id: 'org-uuid-001' },
        data: { hubspot_id: 'hs-company-999' },
      });
    });

    it('logs CREATE with success=true and correct entity fields', async () => {
      await service.execute(baseData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-abc',
          entityType: HubspotEntityType.organization,
          entityId: 'org-uuid-001',
          hubspotObjectId: 'hs-company-999',
          hubspotObjectType: 'companies',
          action: HubspotAuditAction.CREATE,
          source: HubspotAuditSource.user_action,
          success: true,
          payload: { name: 'Acme Hospital' },
          response: { id: 'hs-company-999' },
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
        response: { status: 422, data: {} },
        message: 'Unprocessable Entity',
      });

      await service.execute(baseData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.organization,
          entityId: 'org-uuid-001',
          hubspotObjectType: 'companies',
          action: HubspotAuditAction.CREATE,
          source: HubspotAuditSource.user_action,
          success: false,
          errorCode: '422',
          errorMessage: 'Unprocessable Entity',
        }),
      );
    });

    it('logs success=false with error.code on network error', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        message: 'Network Error',
        code: 'ECONNRESET',
      });

      await service.execute(baseData);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'ECONNRESET',
          errorMessage: 'Network Error',
        }),
      );
    });

    it('does not save hubspot_id when API fails', async () => {
      mockedAxios.post.mockRejectedValueOnce({ message: 'fail', code: 'ERR' });
      await service.execute(baseData);
      expect(prismaMock.organization.update).not.toHaveBeenCalled();
    });
  });

  // ── Source inference ──────────────────────────────────────────────────────────

  describe('source inference', () => {
    it('uses user_action when actorUserId provided', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { id: 'hs-1' } });
      prismaMock.organization.update.mockResolvedValueOnce({});
      await service.execute(baseData, 'user-123');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.user_action }),
      );
    });

    it('uses cron when actorUserId absent', async () => {
      mockedAxios.post.mockRejectedValueOnce({ message: 'err', code: 'ERR' });
      await service.execute(baseData);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.cron }),
      );
    });
  });

  // ── Outbound business_unit normalization (data-driven, any BU) ──────────────
  //
  // Regression: the old hardcoded rule was `data.business_unit === 'Med Virtual'
  // ? 'MedVirtual' : data.business_unit || ''`. These cases prove the new
  // BusinessUnitContext-backed resolver reproduces that exact behavior for
  // Med/Berry while ALSO correctly normalizing a 3rd BU (MMVA) with no new
  // hardcoded branch.

  describe('outbound business_unit normalization', () => {
    beforeEach(() => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { id: 'hs-company-999' },
      });
      prismaMock.organization.update.mockResolvedValueOnce({});
    });

    it('normalizes "Med Virtual" to "MedVirtual" (regression — old hardcoded rule)', async () => {
      await service.execute({ ...baseData, business_unit: 'Med Virtual' });

      const payload = mockedAxios.post.mock.calls[0][1] as {
        properties: { business_unit: string };
      };
      expect(payload.properties.business_unit).toBe('MedVirtual');
    });

    it('passes "MedVirtual" through unchanged (regression)', async () => {
      await service.execute({ ...baseData, business_unit: 'MedVirtual' });

      const payload = mockedAxios.post.mock.calls[0][1] as {
        properties: { business_unit: string };
      };
      expect(payload.properties.business_unit).toBe('MedVirtual');
    });

    it('passes "Berry Virtual" through unchanged (regression)', async () => {
      await service.execute({ ...baseData, business_unit: 'Berry Virtual' });

      const payload = mockedAxios.post.mock.calls[0][1] as {
        properties: { business_unit: string };
      };
      expect(payload.properties.business_unit).toBe('Berry Virtual');
    });

    it('normalizes "BerryVirtual" (no space) to the canonical "Berry Virtual" hubspot_value', async () => {
      await service.execute({ ...baseData, business_unit: 'BerryVirtual' });

      const payload = mockedAxios.post.mock.calls[0][1] as {
        properties: { business_unit: string };
      };
      expect(payload.properties.business_unit).toBe('Berry Virtual');
    });

    it('resolves a 3rd BU (MMVA) to its own hubspot_value — no code change needed', async () => {
      await service.execute({ ...baseData, business_unit: 'MMVA' });

      const payload = mockedAxios.post.mock.calls[0][1] as {
        properties: { business_unit: string };
      };
      expect(payload.properties.business_unit).toBe('MMVA');
    });

    it('resolves "My Medical VA" (display name) to the MMVA hubspot_value', async () => {
      await service.execute({ ...baseData, business_unit: 'My Medical VA' });

      const payload = mockedAxios.post.mock.calls[0][1] as {
        properties: { business_unit: string };
      };
      expect(payload.properties.business_unit).toBe('MMVA');
    });

    it('falls back to the raw input for an unrecognized business_unit (non-destructive)', async () => {
      await service.execute({ ...baseData, business_unit: 'SomeFutureBU' });

      const payload = mockedAxios.post.mock.calls[0][1] as {
        properties: { business_unit: string };
      };
      expect(payload.properties.business_unit).toBe('SomeFutureBU');
    });

    it('sends an empty string when business_unit is missing (regression)', async () => {
      const { business_unit: _omit, ...withoutBu } = baseData;
      await service.execute(withoutBu);

      const payload = mockedAxios.post.mock.calls[0][1] as {
        properties: { business_unit: string };
      };
      expect(payload.properties.business_unit).toBe('');
    });
  });
});
