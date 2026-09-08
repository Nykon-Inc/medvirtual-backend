import { Test, TestingModule } from '@nestjs/testing';
import { CommissionDetectionService } from './commission-detection.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AllianceNotificationsService } from '../notifications/notifications.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockPrisma = {
  organization: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  affiliateProfile: { findFirst: jest.fn() },
  hubspotInvoiceSnapshot: { findMany: jest.fn(), findFirst: jest.fn() },
  hubspotLineItemSnapshot: { findMany: jest.fn() },
  affiliateCommission: { create: jest.fn() },
  medAllianceAuditLog: { create: jest.fn() },
  uSER: { findUnique: jest.fn() },
};

const mockAllianceNotifications = {
  notifyAdminCommissionPending: jest.fn(),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
// Default: newly deployed org — not_eligible, commissions go to 'detected'.
// Tests that need eligible behavior override med_alliance_referral_status.
const makeOrg = (overrides: Partial<any> = {}) => ({
  id: 'org-1',
  name: 'Acme Corp',
  referred_by_affiliate_id: 'user-1',
  med_alliance_referral_status: 'not_eligible',
  med_alliance_block_reason: null,
  eligibility_start_at: new Date('2026-01-15'),
  first_paid_invoice_at: new Date('2026-01-15'),
  referral_stage: 'deployed',
  deployment_date: new Date('2026-01-15'),
  createdAt: new Date('2025-01-01'),
  ...overrides,
});

const makeProfile = (overrides: Partial<any> = {}) => ({
  id: 'profile-1',
  user_id: 'user-1',
  commission_percent_default: '10.00',
  ...overrides,
});

const makeSnapshot = (overrides: Partial<any> = {}) => ({
  id: 'snap-1',
  hubspot_id: 'inv-1',
  invoice_amount: '1500.00',
  payment_status: null,
  paid_at: new Date('2026-02-10'),
  ...overrides,
});

// A matched line item, joined with its parent invoice's hubspot_id and its Staff row —
// exactly the shape CommissionDetectionService.run() selects from hubspotLineItemSnapshot.
const makeLineItem = (overrides: Partial<any> = {}) => ({
  id: 'li-1',
  amount: '1500.00',
  invoice_id: 'snap-1',
  staff_id: 'staff-1',
  invoice: { hubspot_id: 'inv-1' },
  staff: { id: 'staff-1', start_date: new Date('2026-02-01') }, // 9 days before paid_at, well within window
  ...overrides,
});

describe('CommissionDetectionService', () => {
  let service: CommissionDetectionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommissionDetectionService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: AllianceNotificationsService,
          useValue: mockAllianceNotifications,
        },
      ],
    }).compile();

    service = module.get<CommissionDetectionService>(CommissionDetectionService);

    // trackFirstPaidInvoice runs unconditionally at the top of run() whenever
    // org.first_paid_invoice_at is falsy — default to a no-op find so it never
    // interferes with tests that don't care about it.
    mockPrisma.hubspotInvoiceSnapshot.findFirst.mockResolvedValue(null);
    mockPrisma.organization.updateMany.mockResolvedValue({ count: 0 });
    // Default: no matched line items, so tests focused on earlier guards don't need to stub this.
    mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([]);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // Guard: deleted organization
  // -------------------------------------------------------------------------
  it('should return zeros when the organization is deleted', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(
      makeOrg({ status: 'deleted' }),
    );

    const result = await service.run('org-1');

    expect(result).toEqual({ created: 0, skipped: 0 });
    expect(mockPrisma.affiliateProfile.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.affiliateCommission.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Guard: no affiliate
  // -------------------------------------------------------------------------
  it('should return zeros when org has no referred_by_affiliate_id', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(
      makeOrg({ referred_by_affiliate_id: null }),
    );

    const result = await service.run('org-1');

    expect(result).toEqual({ created: 0, skipped: 0 });
    expect(mockPrisma.affiliateProfile.findFirst).not.toHaveBeenCalled();
  });

  it('should return zeros when org does not exist', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null);

    const result = await service.run('non-existent');

    expect(result).toEqual({ created: 0, skipped: 0 });
  });

  // -------------------------------------------------------------------------
  // trackFirstPaidInvoice
  // -------------------------------------------------------------------------
  describe('trackFirstPaidInvoice', () => {
    it('should backfill first_paid_invoice_at when org has none and an earliest paid snapshot exists', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ referred_by_affiliate_id: null, first_paid_invoice_at: null }),
      );
      mockPrisma.hubspotInvoiceSnapshot.findFirst.mockResolvedValue({
        paid_at: new Date('2026-01-01'),
      });
      mockPrisma.organization.updateMany.mockResolvedValue({ count: 1 });

      await service.run('org-1');

      expect(mockPrisma.organization.updateMany).toHaveBeenCalledWith({
        where: { id: 'org-1', first_paid_invoice_at: null },
        data: { first_paid_invoice_at: new Date('2026-01-01') },
      });
    });

    it('should not attempt to backfill when no earliest paid snapshot exists', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ referred_by_affiliate_id: null, first_paid_invoice_at: null }),
      );
      mockPrisma.hubspotInvoiceSnapshot.findFirst.mockResolvedValue(null);

      await service.run('org-1');

      expect(mockPrisma.organization.updateMany).not.toHaveBeenCalled();
    });

    it('should skip trackFirstPaidInvoice entirely when org already has first_paid_invoice_at', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ referred_by_affiliate_id: null, first_paid_invoice_at: new Date('2026-01-01') }),
      );

      await service.run('org-1');

      expect(mockPrisma.hubspotInvoiceSnapshot.findFirst).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Guard: active-client block (MA-004)
  // -------------------------------------------------------------------------
  it('should return zeros when org is blocked as active client (MA-004)', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(
      makeOrg({
        med_alliance_referral_status: 'not_eligible',
        med_alliance_block_reason: 'active_client_block: organization_active_by_email',
      }),
    );

    const result = await service.run('org-1');

    expect(result).toEqual({ created: 0, skipped: 0 });
    expect(mockPrisma.affiliateProfile.findFirst).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Guard: already expired
  // -------------------------------------------------------------------------
  it('should return zeros when status is already expired (direct check, no more prefix parsing)', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(
      makeOrg({ med_alliance_referral_status: 'expired' }),
    );

    const result = await service.run('org-1');

    expect(result).toEqual({ created: 0, skipped: 0 });
    expect(mockPrisma.affiliateProfile.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.organization.update).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Inline expiry backstop — DISABLED per §4.6 (company eligibility is manual-only now).
  // This used to auto-flip med_alliance_referral_status to 'expired'; it must no longer
  // do so, and must no longer touch organization.update for this reason at all.
  // -------------------------------------------------------------------------
  describe('inline expiry backstop (disabled)', () => {
    it('should NOT expire a pending_confirmation org deployed > 365 days ago (status auto-transitions removed)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({
          med_alliance_referral_status: 'pending_confirmation',
          referral_stage: 'deployed',
          deployment_date: new Date('2024-01-01'),
        }),
      );
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([]);

      const result = await service.run('org-1');

      expect(result).toEqual({ created: 0, skipped: 0 });
      expect(mockPrisma.organization.update).not.toHaveBeenCalled();
    });

    it('should NOT expire an eligible org deployed > 365 days ago', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({
          med_alliance_referral_status: 'eligible',
          referral_stage: 'deployed',
          deployment_date: new Date('2024-01-01'),
        }),
      );
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([]);

      await service.run('org-1');

      expect(mockPrisma.organization.update).not.toHaveBeenCalled();
    });

    it('should NOT expire a not_eligible (blocked) org deployed > 365 days ago', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({
          med_alliance_referral_status: 'not_eligible',
          referral_stage: 'deployed',
          deployment_date: new Date('2024-01-01'),
        }),
      );
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([]);

      await service.run('org-1');

      expect(mockPrisma.organization.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Guard: no active affiliate profile
  // -------------------------------------------------------------------------
  it('should return zeros when affiliate has no active profile', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
    mockPrisma.affiliateProfile.findFirst.mockResolvedValue(null);

    const result = await service.run('org-1');

    expect(result).toEqual({ created: 0, skipped: 0 });
    expect(mockPrisma.hubspotInvoiceSnapshot.findMany).not.toHaveBeenCalled();
  });

  it('should return zeros when affiliate profile has no connected user', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
    mockPrisma.affiliateProfile.findFirst.mockResolvedValue(
      makeProfile({ user_id: null }),
    );

    const result = await service.run('org-1');

    expect(result).toEqual({ created: 0, skipped: 0 });
    expect(mockPrisma.hubspotInvoiceSnapshot.findMany).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // No candidate snapshots
  // -------------------------------------------------------------------------
  it('should return zeros when no eligible snapshots exist for the org', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
    mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
    mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([]);

    const result = await service.run('org-1');

    expect(result).toEqual({ created: 0, skipped: 0 });
    expect(mockPrisma.affiliateCommission.create).not.toHaveBeenCalled();
  });

  it('should return zeros when invoices exist but have no matched line items', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
    mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
    mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
    mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([]);

    const result = await service.run('org-1');

    expect(result).toEqual({ created: 0, skipped: 0 });
    expect(mockPrisma.affiliateCommission.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // THE BUG FIX — per-collaborator commission, not per-invoice/per-company
  // -------------------------------------------------------------------------
  describe('per-collaborator commission (the core fix)', () => {
    it('creates a commission ONLY for the recently-started staff line item, at that line item amount × commission %, when two staff with different start_dates share the same paid invoice', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(
        makeProfile({ commission_percent_default: '7.00' }),
      );
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        makeSnapshot({ id: 'snap-1', hubspot_id: 'inv-1', invoice_amount: '5000.00' }),
      ]);

      const now = new Date('2026-02-10T00:00:00.000Z');
      jest.useFakeTimers().setSystemTime(now);

      const expiredStaffStart = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000); // 400 days ago
      const recentStaffStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        makeLineItem({
          id: 'li-expired',
          amount: '2000.00',
          staff_id: 'staff-expired',
          staff: { id: 'staff-expired', start_date: expiredStaffStart },
        }),
        makeLineItem({
          id: 'li-recent',
          amount: '3000.00',
          staff_id: 'staff-recent',
          staff: { id: 'staff-recent', start_date: recentStaffStart },
        }),
      ]);
      mockPrisma.affiliateCommission.create.mockResolvedValue({ id: 'comm-1' });
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.run('org-1');

      jest.useRealTimers();

      // Only ONE commission created — the expired staff's line item is skipped entirely.
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(1);
      expect(mockPrisma.affiliateCommission.create).toHaveBeenCalledTimes(1);

      // The amount is the LINE ITEM amount × 7%, not the full $5000 invoice × 7%.
      expect(mockPrisma.affiliateCommission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            hubspot_line_item_snapshot_id: 'li-recent',
            staff_id: 'staff-recent',
            base_amount_snapshot: '3000.00',
            commission_amount: expect.objectContaining({ d: expect.anything() }), // Decimal instance
          }),
        }),
      );
      const createdAmount = String(
        mockPrisma.affiliateCommission.create.mock.calls[0][0].data.commission_amount,
      );
      expect(createdAmount).toBe('210'); // 3000 * 7% = 210, not 5000 * 7% = 350

      // The expired staff's line item never reaches affiliateCommission.create.
      const allCreateCalls = mockPrisma.affiliateCommission.create.mock.calls;
      expect(
        allCreateCalls.some(
          (call: any) => call[0].data.hubspot_line_item_snapshot_id === 'li-expired',
        ),
      ).toBe(false);
    });

    it('logs a medAllianceAuditLog entry linking org, invoice snapshot, and staff when a line item is skipped for exceeding the 365-day window', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);

      const now = new Date('2026-02-10T00:00:00.000Z');
      jest.useFakeTimers().setSystemTime(now);
      const expiredStaffStart = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);

      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        makeLineItem({
          id: 'li-expired',
          invoice_id: 'snap-1',
          staff_id: 'staff-expired',
          staff: { id: 'staff-expired', start_date: expiredStaffStart },
        }),
      ]);
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.run('org-1');
      jest.useRealTimers();

      expect(result).toEqual({ created: 0, skipped: 1 });
      expect(mockPrisma.affiliateCommission.create).not.toHaveBeenCalled();
      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entity_type: 'referred_company',
            entity_id: 'org-1',
            event: 'commission_skipped_staff_expired',
            metadata: expect.objectContaining({
              hubspot_invoice_snapshot_id: 'snap-1',
              hubspot_line_item_snapshot_id: 'li-expired',
              staff_id: 'staff-expired',
            }),
          }),
        }),
      );
    });

    it('does NOT log an audit entry when a line item is skipped because staff has no start_date yet (not an expiry)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        makeLineItem({ staff: { id: 'staff-1', start_date: null } }),
      ]);

      const result = await service.run('org-1');

      expect(result).toEqual({ created: 0, skipped: 1 });
      expect(mockPrisma.medAllianceAuditLog.create).not.toHaveBeenCalled();
    });

    it('only queries line items scoped to this organization\'s paid invoice ids, with match_status=matched and a non-null staff_id', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        makeSnapshot({ id: 'snap-1' }),
      ]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([]);

      await service.run('org-1');

      expect(mockPrisma.hubspotLineItemSnapshot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            invoice_id: { in: ['snap-1'] },
            match_status: 'matched',
            staff_id: { not: null },
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Commission creation — status/notification lifecycle (unchanged by the rewrite)
  // -------------------------------------------------------------------------
  describe('commission creation', () => {
    it('should create commission with correct fields', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([makeLineItem()]);
      mockPrisma.affiliateCommission.create.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.run('org-1');

      expect(mockPrisma.affiliateCommission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            affiliate_id: 'user-1',
            affiliate_profile_id: 'profile-1',
            organization_id: 'org-1',
            hubspot_invoice_snapshot_id: 'snap-1',
            hubspot_line_item_snapshot_id: 'li-1',
            staff_id: 'staff-1',
            status: 'detected',
          }),
        }),
      );
    });

    it('should write exactly one audit log entry per created commission', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        makeLineItem({ id: 'li-1', staff_id: 'staff-1', staff: { id: 'staff-1', start_date: new Date('2026-02-01') } }),
        makeLineItem({ id: 'li-2', staff_id: 'staff-2', staff: { id: 'staff-2', start_date: new Date('2026-02-01') } }),
      ]);
      mockPrisma.affiliateCommission.create.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.run('org-1');

      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledTimes(2);
    });

    it('should set audit log source to sync', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([makeLineItem()]);
      mockPrisma.affiliateCommission.create.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.run('org-1');

      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            source: 'sync',
            event: 'commission_detected',
            new_status: 'detected',
          }),
        }),
      );
    });

    it('should create commission as "pending_admin_confirmation" and notify admin when org is eligible', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ med_alliance_referral_status: 'eligible' }),
      );
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([makeLineItem()]);
      mockPrisma.uSER.findUnique.mockResolvedValue({
        email: 'affiliate@example.com',
        first_name: 'Jane',
      });
      mockPrisma.affiliateCommission.create.mockResolvedValue({ id: 'comm-1' });
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.run('org-1');

      expect(mockPrisma.affiliateCommission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'pending_admin_confirmation' }),
        }),
      );
      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: 'commission_pending_admin_confirmation',
            new_status: 'pending_admin_confirmation',
          }),
        }),
      );
      expect(mockAllianceNotifications.notifyAdminCommissionPending).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationName: 'Acme Corp',
          affiliateName: 'affiliate@example.com',
          commissionId: 'comm-1',
        }),
      );
    });

    it('should create commission as "detected" for a pending_confirmation org (isEligibleNow = false)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ med_alliance_referral_status: 'pending_confirmation' }),
      );
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([makeLineItem()]);
      mockPrisma.affiliateCommission.create.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.run('org-1');

      expect(mockPrisma.uSER.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.affiliateCommission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'detected' }),
        }),
      );
      expect(mockAllianceNotifications.notifyAdminCommissionPending).not.toHaveBeenCalled();
    });

    it('should create commission as "detected" for not_eligible org (standard deployed state)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([makeLineItem()]);
      mockPrisma.affiliateCommission.create.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.run('org-1');

      expect(mockPrisma.affiliateCommission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'detected' }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency — P2002
  // -------------------------------------------------------------------------
  describe('idempotency', () => {
    it('should count as skipped when P2002 unique constraint is violated', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([makeLineItem()]);

      const prismaUniqueError = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      mockPrisma.affiliateCommission.create.mockRejectedValue(prismaUniqueError);
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.run('org-1');

      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
      // Audit log should not be written for skipped commissions
      expect(mockPrisma.medAllianceAuditLog.create).not.toHaveBeenCalled();
    });

    it('should produce the same idempotency_key for the same inputs', async () => {
      const profile = makeProfile();
      const item = makeLineItem();

      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(profile);
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([item]);
      mockPrisma.affiliateCommission.create.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.run('org-1');
      const key1 =
        mockPrisma.affiliateCommission.create.mock.calls[0][0].data.idempotency_key;

      jest.clearAllMocks();
      mockPrisma.hubspotInvoiceSnapshot.findFirst.mockResolvedValue(null);
      mockPrisma.organization.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(profile);
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([item]);
      mockPrisma.affiliateCommission.create.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.run('org-1');
      const key2 =
        mockPrisma.affiliateCommission.create.mock.calls[0][0].data.idempotency_key;

      expect(key1).toBe(key2);
      expect(key1).toHaveLength(64); // SHA-256 hex
    });

    it('should produce different idempotency_keys for different line items on the same invoice', async () => {
      const profile = makeProfile();

      const runWith = async (lineItemId: string) => {
        jest.clearAllMocks();
        mockPrisma.hubspotInvoiceSnapshot.findFirst.mockResolvedValue(null);
        mockPrisma.organization.updateMany.mockResolvedValue({ count: 0 });
        mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
        mockPrisma.affiliateProfile.findFirst.mockResolvedValue(profile);
        mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
        mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
          makeLineItem({ id: lineItemId }),
        ]);
        mockPrisma.affiliateCommission.create.mockResolvedValue({});
        mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});
        await service.run('org-1');
        return mockPrisma.affiliateCommission.create.mock.calls[0][0].data.idempotency_key;
      };

      const key1 = await runWith('li-1500');
      const key2 = await runWith('li-2000');

      expect(key1).not.toBe(key2);
    });

    it('should continue processing remaining line items when one fails with non-P2002 error', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        makeLineItem({ id: 'li-1', staff_id: 'staff-1', staff: { id: 'staff-1', start_date: new Date('2026-02-01') } }),
        makeLineItem({ id: 'li-2', staff_id: 'staff-2', staff: { id: 'staff-2', start_date: new Date('2026-02-01') } }),
      ]);
      mockPrisma.affiliateCommission.create
        .mockRejectedValueOnce(new Error('DB connection lost'))
        .mockResolvedValueOnce({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.run('org-1');

      // One failed, one created
      expect(result.created).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Deployment lifecycle (markDeployed) — untouched by the per-collaborator rewrite,
  // still keyed on the invoice snapshot (not line items), still auto (stage/date-only,
  // never touches med_alliance_referral_status — see §4.6).
  // -------------------------------------------------------------------------
  describe('deployment lifecycle', () => {
    it('should call markDeployed (organization.update + audit log) on the first invoice with a raw eligibility_start_at', async () => {
      const newOrg = makeOrg({
        first_paid_invoice_at: null,
        eligibility_start_at: null,
        referral_stage: 'referred',
        deployment_date: null,
        med_alliance_referral_status: 'pending_confirmation',
      });
      mockPrisma.organization.findUnique.mockResolvedValue(newOrg);
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([]);
      mockPrisma.organization.update.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.run('org-1');

      const firstInvoiceDate = makeSnapshot().paid_at;
      expect(mockPrisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'org-1' },
          data: {
            referral_stage: 'deployed',
            eligibility_start_at: firstInvoiceDate,
            first_paid_invoice_at: firstInvoiceDate,
            med_alliance_block_reason: null,
          },
        }),
      );
    });

    it('should NOT call markDeployed when org is already deployed', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ referral_stage: 'deployed' }),
      );
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([]);
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.run('org-1');

      expect(mockPrisma.organization.update).not.toHaveBeenCalled();
    });

    it('should NOT call markDeployed when org has a deployment_date set (webhook already fired)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({
          first_paid_invoice_at: null,
          referral_stage: 'contract_signed',
          deployment_date: new Date('2026-01-01'),
        }),
      );
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([]);
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.run('org-1');

      expect(mockPrisma.organization.update).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Canceled guard
    // -----------------------------------------------------------------------
    it('should skip commission creation for canceled org', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ referral_stage: 'canceled' }),
      );
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);

      const result = await service.run('org-1');

      expect(result).toEqual({ created: 0, skipped: 0 });
      expect(mockPrisma.affiliateCommission.create).not.toHaveBeenCalled();
    });

    it('should skip commission creation for newly canceled org (no prior invoices)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({
          first_paid_invoice_at: null,
          eligibility_start_at: null,
          referral_stage: 'canceled',
          deployment_date: null,
        }),
      );
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);

      const result = await service.run('org-1');

      expect(result).toEqual({ created: 0, skipped: 0 });
      expect(mockPrisma.organization.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // isEligibleNow simplification — status-only check, no more date-math
  // -------------------------------------------------------------------------
  describe('isEligibleNow simplification', () => {
    it('should treat status=eligible as eligible regardless of how old eligibility_start_at is', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({
          med_alliance_referral_status: 'eligible',
          eligibility_start_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
          deployment_date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        }),
      );
      mockPrisma.affiliateProfile.findFirst.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([makeLineItem()]);
      mockPrisma.uSER.findUnique.mockResolvedValue({ email: 'a@b.com', first_name: 'A' });
      mockPrisma.affiliateCommission.create.mockResolvedValue({ id: 'c1' });
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.run('org-1');

      expect(mockPrisma.affiliateCommission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'pending_admin_confirmation' }),
        }),
      );
    });
  });
});
