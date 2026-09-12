import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationStatus } from '@prisma/client';
import { HandlerOrganizationPropertyChange } from './organizationPropertyChange';
import { HandlerOrganizationCreation } from './organizationCreation';
import { HandlerOrganizationDeletion } from './organizationDeletion';
import { HandlerOrganizationReactivation } from './organizationReactivation';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessUnitContext } from '../../business-units/business-unit-context.service';

const prismaMock = {
  organization: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  uSER: {
    findUnique: jest.fn(),
  },
  medAllianceAuditLog: {
    create: jest.fn(),
  },
};

const organizationCreationMock = { execute: jest.fn() };
const organizationDeletionMock = { execute: jest.fn() };
const organizationReactivationMock = { execute: jest.fn() };
const businessUnitContextMock = { isAllowedHubspotValue: jest.fn() };

describe('HandlerOrganizationPropertyChange', () => {
  let handler: HandlerOrganizationPropertyChange;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HandlerOrganizationPropertyChange,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: HandlerOrganizationCreation,
          useValue: organizationCreationMock,
        },
        {
          provide: HandlerOrganizationDeletion,
          useValue: organizationDeletionMock,
        },
        {
          provide: HandlerOrganizationReactivation,
          useValue: organizationReactivationMock,
        },
        { provide: BusinessUnitContext, useValue: businessUnitContextMock },
      ],
    }).compile();

    handler = module.get<HandlerOrganizationPropertyChange>(
      HandlerOrganizationPropertyChange,
    );
    // mockReset (not just clearAllMocks) also drains any queued
    // mockResolvedValueOnce values so tests cannot leak into each other.
    prismaMock.organization.findUnique.mockReset();
    prismaMock.organization.update.mockReset();
    prismaMock.uSER.findUnique.mockReset();
    prismaMock.medAllianceAuditLog.create.mockReset();
    organizationCreationMock.execute.mockReset();
    organizationDeletionMock.execute.mockReset();
    organizationReactivationMock.execute.mockReset();
    businessUnitContextMock.isAllowedHubspotValue.mockReset();
    // Default: MedVirtual/Berry Virtual allowed, anything else not — individual
    // tests override this via mockResolvedValueOnce/mockImplementation as needed.
    businessUnitContextMock.isAllowedHubspotValue.mockImplementation(
      (v: string) =>
        Promise.resolve(v === 'MedVirtual' || v === 'Berry Virtual'),
    );
  });

  it('should be defined', () => {
    expect(handler).toBeDefined();
  });

  // ─── organization not found → creation ─────────────────────────────────────

  it('should delegate to organizationCreation when the organization does not exist', async () => {
    prismaMock.organization.findUnique.mockResolvedValue(null);
    organizationCreationMock.execute.mockResolvedValue('created');

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'business_unit',
      propertyValue: 'MedVirtual',
    });

    expect(organizationCreationMock.execute).toHaveBeenCalledTimes(1);
    expect(result).toBe('created');
    expect(organizationDeletionMock.execute).not.toHaveBeenCalled();
    expect(organizationReactivationMock.execute).not.toHaveBeenCalled();
  });

  // ─── business_unit invalid → deletion ──────────────────────────────────────

  it('should delegate to organizationDeletion when business_unit becomes invalid (org active)', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    organizationDeletionMock.execute.mockResolvedValue('deleted');

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'business_unit',
      propertyValue: 'Other Co',
    });

    expect(organizationDeletionMock.execute).toHaveBeenCalledTimes(1);
    expect(result).toBe('deleted');
    expect(organizationReactivationMock.execute).not.toHaveBeenCalled();
    expect(prismaMock.organization.update).not.toHaveBeenCalled();
  });

  it('should still delegate to organizationDeletion when business_unit invalid and org already deleted', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.deleted,
    });
    organizationDeletionMock.execute.mockResolvedValue('deleted');

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'business_unit',
      propertyValue: 'Other Co',
    });

    expect(organizationDeletionMock.execute).toHaveBeenCalledTimes(1);
    expect(result).toBe('deleted');
    expect(organizationReactivationMock.execute).not.toHaveBeenCalled();
  });

  // ─── business_unit valid again + org deleted → reactivation ────────────────

  it('should delegate to organizationReactivation when business_unit is MedVirtual and org is deleted', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.deleted,
    });
    organizationReactivationMock.execute.mockResolvedValue('reactivated');

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'business_unit',
      propertyValue: 'MedVirtual',
    });

    expect(organizationReactivationMock.execute).toHaveBeenCalledTimes(1);
    expect(result).toBe('reactivated');
    expect(organizationDeletionMock.execute).not.toHaveBeenCalled();
    expect(prismaMock.organization.update).not.toHaveBeenCalled();
  });

  it('should delegate to organizationReactivation when business_unit is Berry Virtual and org is deleted', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.deleted,
    });
    organizationReactivationMock.execute.mockResolvedValue('reactivated');

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'business_unit',
      propertyValue: 'Berry Virtual',
    });

    expect(organizationReactivationMock.execute).toHaveBeenCalledTimes(1);
    expect(result).toBe('reactivated');
    expect(organizationDeletionMock.execute).not.toHaveBeenCalled();
    expect(prismaMock.organization.update).not.toHaveBeenCalled();
  });

  // ─── resolver-driven (no more hardcoded literals) ──────────────────────────

  it('delegates the allow/deny decision to BusinessUnitContext.isAllowedHubspotValue', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.deleted,
    });
    organizationReactivationMock.execute.mockResolvedValue('reactivated');

    await handler.execute({
      objectId: 1,
      propertyName: 'business_unit',
      propertyValue: 'MMVA',
    });

    expect(businessUnitContextMock.isAllowedHubspotValue).toHaveBeenCalledWith(
      'MMVA',
    );
  });

  it('reactivates a previously-deleted org when business_unit becomes a newly-visible BU (e.g. MMVA)', async () => {
    businessUnitContextMock.isAllowedHubspotValue.mockResolvedValue(true);
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.deleted,
    });
    organizationReactivationMock.execute.mockResolvedValue('reactivated');

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'business_unit',
      propertyValue: 'MMVA',
    });

    expect(organizationReactivationMock.execute).toHaveBeenCalledTimes(1);
    expect(result).toBe('reactivated');
    expect(organizationDeletionMock.execute).not.toHaveBeenCalled();
  });

  it('forwards the new business_unit value to organizationDeletion so it can be persisted on soft-delete', async () => {
    businessUnitContextMock.isAllowedHubspotValue.mockResolvedValue(false);
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    organizationDeletionMock.execute.mockResolvedValue('deleted');

    await handler.execute({
      objectId: 1,
      propertyName: 'business_unit',
      propertyValue: 'MMVA',
    });

    // The full event (including propertyName/propertyValue) must reach the
    // deletion handler so it can record the new business_unit.
    expect(organizationDeletionMock.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyName: 'business_unit',
        propertyValue: 'MMVA',
      }),
    );
  });

  it('soft-deletes when business_unit moves to a dormant BU (known but not visible)', async () => {
    businessUnitContextMock.isAllowedHubspotValue.mockResolvedValue(false);
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    organizationDeletionMock.execute.mockResolvedValue('deleted');

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'business_unit',
      propertyValue: 'MMVA',
    });

    expect(organizationDeletionMock.execute).toHaveBeenCalledTimes(1);
    expect(result).toBe('deleted');
    expect(organizationReactivationMock.execute).not.toHaveBeenCalled();
  });

  // ─── business_unit valid + org NOT deleted → generic update ────────────────

  it('should fall through to a generic update when switching between valid business units on a non-deleted org', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    prismaMock.organization.update.mockResolvedValue({});

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'business_unit',
      propertyValue: 'Berry Virtual',
    });

    expect(organizationReactivationMock.execute).not.toHaveBeenCalled();
    expect(organizationDeletionMock.execute).not.toHaveBeenCalled();
    expect(prismaMock.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { business_unit: 'Berry Virtual' },
    });
    expect(result).toBe(true);
  });

  // ─── pre-existing generic paths (smoke coverage) ───────────────────────────

  it('should update a generic mapped field (name)', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    prismaMock.organization.update.mockResolvedValue({});

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'name',
      propertyValue: 'New Org Name',
    });

    expect(prismaMock.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { name: 'New Org Name' },
    });
    expect(result).toBe(true);
  });

  it('should map organization_role "prospect" to the prospect enum', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    prismaMock.organization.update.mockResolvedValue({});

    await handler.execute({
      objectId: 1,
      propertyName: 'type',
      propertyValue: 'Prospect',
    });

    // `type` maps to the DB field `type`, which is not organization_role, so it
    // is passed through unchanged.
    expect(prismaMock.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { type: 'Prospect' },
    });
  });

  it('should translate a known industry value via the industry dictionary', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    prismaMock.organization.update.mockResolvedValue({});

    await handler.execute({
      objectId: 1,
      propertyName: 'industry',
      propertyValue: 'ACCOUNTING',
    });

    expect(prismaMock.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { industry: 'Accounting' },
    });
  });

  it('should default industry to empty string when the value is missing', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    prismaMock.organization.update.mockResolvedValue({});

    await handler.execute({
      objectId: 1,
      propertyName: 'industry',
      propertyValue: '',
    });

    expect(prismaMock.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { industry: '' },
    });
  });

  it('should split, trim and filter specialties into an array', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    prismaMock.organization.update.mockResolvedValue({});

    await handler.execute({
      objectId: 1,
      propertyName: 'specialty',
      propertyValue: 'Cardiology, Neurology , ',
    });

    expect(prismaMock.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { specialties: ['Cardiology', 'Neurology'] },
    });
  });

  it('should parse number_of_employees into a number', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    prismaMock.organization.update.mockResolvedValue({});

    await handler.execute({
      objectId: 1,
      propertyName: 'numberofemployees',
      propertyValue: '42',
    });

    expect(prismaMock.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { number_of_employees: 42 },
    });
  });

  it('should set number_of_employees to null when the value is empty', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    prismaMock.organization.update.mockResolvedValue({});

    await handler.execute({
      objectId: 1,
      propertyName: 'numberofemployees',
      propertyValue: '',
    });

    expect(prismaMock.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { number_of_employees: null },
    });
  });

  it('should reset to in_negotiation + pending_confirmation when deployment_date is cleared for a referred org', async () => {
    prismaMock.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', status: OrganizationStatus.active })
      .mockResolvedValueOnce({
        referred_by_affiliate_id: 'aff-1',
        deployment_date: new Date('2026-01-01T00:00:00.000Z'),
        med_alliance_referral_status: 'eligible',
      });
    prismaMock.organization.update.mockResolvedValue({});
    prismaMock.medAllianceAuditLog.create.mockResolvedValue({});

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'deploy_date_of_first_va',
      propertyValue: '',
    });

    // First update: set the deployment_date field itself to null.
    expect(prismaMock.organization.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'org-1' },
      data: { deployment_date: null },
    });
    // Second update: revert referral stage/eligibility to the resting pending state.
    expect(prismaMock.organization.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'org-1' },
      data: {
        referral_stage: 'in_negotiation',
        med_alliance_referral_status: 'pending_confirmation',
        eligibility_start_at: null,
        med_alliance_block_reason: null,
      },
    });
    expect(prismaMock.medAllianceAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'deployment_date_cleared',
          old_status: 'eligible',
          new_status: 'pending_confirmation',
        }),
      }),
    );
    expect(result).toBe(true);
  });

  it('should no-op (skip status/stage update) when deployment_date is cleared but was already null', async () => {
    prismaMock.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', status: OrganizationStatus.active })
      .mockResolvedValueOnce({
        referred_by_affiliate_id: 'aff-1',
        deployment_date: null,
        med_alliance_referral_status: 'pending_confirmation',
      });
    prismaMock.organization.update.mockResolvedValue({});

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'deploy_date_of_first_va',
      propertyValue: '',
    });

    // Only the generic field update runs — no second write, no audit log.
    expect(prismaMock.organization.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.organization.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'org-1' },
      data: { deployment_date: null },
    });
    expect(prismaMock.medAllianceAuditLog.create).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('should no-op (skip status/stage update) when deployment_date is re-delivered with the same timestamp', async () => {
    const sameDate = new Date('2026-01-01T00:00:00.000Z');
    prismaMock.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', status: OrganizationStatus.active })
      .mockResolvedValueOnce({
        referred_by_affiliate_id: 'aff-1',
        deployment_date: sameDate,
        med_alliance_referral_status: 'eligible',
      });
    prismaMock.organization.update.mockResolvedValue({});

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'deploy_date_of_first_va',
      propertyValue: String(sameDate.getTime()),
    });

    expect(prismaMock.organization.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.organization.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'org-1' },
      data: { deployment_date: sameDate },
    });
    expect(prismaMock.medAllianceAuditLog.create).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('should default industry to empty string when the value is not in the dictionary', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    prismaMock.organization.update.mockResolvedValue({});

    await handler.execute({
      objectId: 1,
      propertyName: 'industry',
      propertyValue: 'NOT_A_REAL_INDUSTRY',
    });

    expect(prismaMock.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { industry: '' },
    });
  });

  it('should mark deployed + pending_confirmation when deployment_date is set to a future date for a referred org', async () => {
    prismaMock.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', status: OrganizationStatus.active })
      .mockResolvedValueOnce({
        referred_by_affiliate_id: 'aff-1',
        deployment_date: null,
        med_alliance_referral_status: 'pending_confirmation',
      });
    prismaMock.organization.update.mockResolvedValue({});
    prismaMock.medAllianceAuditLog.create.mockResolvedValue({});

    const futureMs = Date.now() + 10 * 24 * 60 * 60 * 1000;

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'deploy_date_of_first_va',
      propertyValue: String(futureMs),
    });

    // Future dates now land on deployed + pending_confirmation, same as recent-past dates —
    // the deployment_date guard rejecting future dates lives in approveEligibility, not here.
    expect(prismaMock.organization.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'org-1' },
        data: expect.objectContaining({
          referral_stage: 'deployed',
          med_alliance_referral_status: 'pending_confirmation',
        }),
      }),
    );
    expect(prismaMock.medAllianceAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'eligibility_pending_confirmation',
        }),
      }),
    );
    expect(result).toBe(true);
  });

  it('should mark deployed + expired and audit-log "eligibility_expired" when deployment_date is more than 365 days ago', async () => {
    prismaMock.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', status: OrganizationStatus.active })
      .mockResolvedValueOnce({
        referred_by_affiliate_id: 'aff-1',
        deployment_date: null,
        med_alliance_referral_status: 'pending_confirmation',
      });
    prismaMock.organization.update.mockResolvedValue({});
    prismaMock.medAllianceAuditLog.create.mockResolvedValue({});

    const overAYearAgoMs = Date.now() - 400 * 24 * 60 * 60 * 1000;

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'deploy_date_of_first_va',
      propertyValue: String(overAYearAgoMs),
    });

    expect(prismaMock.organization.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'org-1' },
        data: expect.objectContaining({
          referral_stage: 'deployed',
          med_alliance_referral_status: 'expired',
          med_alliance_block_reason: null,
        }),
      }),
    );
    expect(prismaMock.medAllianceAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'eligibility_expired',
          new_status: 'expired',
        }),
      }),
    );
    expect(result).toBe(true);
  });

  it('should mark deployed + pending_confirmation and audit-log when deployment_date is 30+ days ago', async () => {
    prismaMock.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', status: OrganizationStatus.active })
      .mockResolvedValueOnce({
        referred_by_affiliate_id: 'aff-1',
        deployment_date: null,
        med_alliance_referral_status: 'pending_confirmation',
      });
    prismaMock.organization.update.mockResolvedValue({});
    prismaMock.medAllianceAuditLog.create.mockResolvedValue({});

    const fortyDaysAgoMs = Date.now() - 40 * 24 * 60 * 60 * 1000;

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'deploy_date_of_first_va',
      propertyValue: String(fortyDaysAgoMs),
    });

    expect(prismaMock.organization.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'org-1' },
        data: expect.objectContaining({
          referral_stage: 'deployed',
          med_alliance_referral_status: 'pending_confirmation',
        }),
      }),
    );
    expect(prismaMock.medAllianceAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'eligibility_pending_confirmation',
        }),
      }),
    );
    expect(result).toBe(true);
  });

  it('should mark deployed + pending_confirmation when deployment_date is within the last 30 days', async () => {
    prismaMock.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', status: OrganizationStatus.active })
      .mockResolvedValueOnce({
        referred_by_affiliate_id: 'aff-1',
        deployment_date: null,
        med_alliance_referral_status: 'pending_confirmation',
      });
    prismaMock.organization.update.mockResolvedValue({});
    prismaMock.medAllianceAuditLog.create.mockResolvedValue({});

    const tenDaysAgoMs = Date.now() - 10 * 24 * 60 * 60 * 1000;

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'deploy_date_of_first_va',
      propertyValue: String(tenDaysAgoMs),
    });

    // The 30-day stabilization window is gone — decisions are available immediately.
    expect(prismaMock.organization.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'org-1' },
        data: expect.objectContaining({
          referral_stage: 'deployed',
          med_alliance_referral_status: 'pending_confirmation',
        }),
      }),
    );
    expect(prismaMock.medAllianceAuditLog.create).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('should re-open from canceled following the 365-day rule and record prior_stage in the audit metadata', async () => {
    prismaMock.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', status: OrganizationStatus.active })
      .mockResolvedValueOnce({
        referred_by_affiliate_id: 'aff-1',
        deployment_date: null,
        med_alliance_referral_status: 'not_eligible',
        referral_stage: 'canceled',
      });
    prismaMock.organization.update.mockResolvedValue({});
    prismaMock.medAllianceAuditLog.create.mockResolvedValue({});

    const overAYearAgoMs = Date.now() - 400 * 24 * 60 * 60 * 1000;

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'deploy_date_of_first_va',
      propertyValue: String(overAYearAgoMs),
    });

    // >365 days ago → expired, per the same rule as any other re-derivation.
    expect(prismaMock.organization.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'org-1' },
        data: expect.objectContaining({
          referral_stage: 'deployed',
          med_alliance_referral_status: 'expired',
        }),
      }),
    );
    expect(prismaMock.medAllianceAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'eligibility_expired',
          new_status: 'expired',
          metadata: expect.objectContaining({ prior_stage: 'canceled' }),
        }),
      }),
    );
    expect(result).toBe(true);
  });

  it('should record prior_stage in the audit metadata when a canceled company re-opens within the 365-day window', async () => {
    prismaMock.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', status: OrganizationStatus.active })
      .mockResolvedValueOnce({
        referred_by_affiliate_id: 'aff-1',
        deployment_date: null,
        med_alliance_referral_status: 'not_eligible',
        referral_stage: 'canceled',
      });
    prismaMock.organization.update.mockResolvedValue({});
    prismaMock.medAllianceAuditLog.create.mockResolvedValue({});

    const fortyDaysAgoMs = Date.now() - 40 * 24 * 60 * 60 * 1000;

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'deploy_date_of_first_va',
      propertyValue: String(fortyDaysAgoMs),
    });

    expect(prismaMock.organization.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          referral_stage: 'deployed',
          med_alliance_referral_status: 'pending_confirmation',
        }),
      }),
    );
    expect(prismaMock.medAllianceAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'eligibility_pending_confirmation',
          metadata: expect.objectContaining({ prior_stage: 'canceled' }),
        }),
      }),
    );
    expect(result).toBe(true);
  });

  it('should not touch referral fields when deployment_date changes for a non-referred org', async () => {
    prismaMock.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', status: OrganizationStatus.active })
      .mockResolvedValueOnce({ referred_by_affiliate_id: null });
    prismaMock.organization.update.mockResolvedValue({});

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'deploy_date_of_first_va',
      propertyValue: '',
    });

    // Only the deployment_date field is updated; no referral revert.
    expect(prismaMock.organization.update).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('should return early for a property not in the dictionary', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'unknown_property',
      propertyValue: 'x',
    });

    expect(result).toBeUndefined();
    expect(prismaMock.organization.update).not.toHaveBeenCalled();
  });

  it('should connect the admin when hubspot_owner_id changes and the user exists', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    prismaMock.uSER.findUnique.mockResolvedValue({ id: 'user-1' });
    prismaMock.organization.update.mockResolvedValue({});

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'hubspot_owner_id',
      propertyValue: 'hs-owner-1',
    });

    expect(prismaMock.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { admin: { connect: { id: 'user-1' } } },
    });
    expect(result).toBe(true);
  });

  it('should not update the admin when hubspot_owner_id changes but the user does not exist', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });
    prismaMock.uSER.findUnique.mockResolvedValue(null);

    const result = await handler.execute({
      objectId: 1,
      propertyName: 'hubspot_owner_id',
      propertyValue: 'hs-owner-unknown',
    });

    expect(prismaMock.organization.update).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});
