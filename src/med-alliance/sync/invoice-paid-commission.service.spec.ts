import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import { InvoicePaidCommissionService } from './invoice-paid-commission.service';
import { PrismaService } from '../../prisma/prisma.service';

const mockPrisma = {
  hubspotInvoiceSnapshot: { findUnique: jest.fn() },
  affiliateCommission: { upsert: jest.fn() },
  staff: { update: jest.fn() },
  organization: { findUnique: jest.fn(), updateMany: jest.fn() },
  medAllianceAuditLog: { create: jest.fn() },
  $transaction: jest.fn((fn) => fn(mockPrisma)),
};

const lineItem = (id: string, amount: number) => ({
  id,
  amount,
  staff_id: `staff-${id}`,
  staff: {
    id: `staff-${id}`,
    hubspot_id: `deal-${id}`,
    hubspot_commission_start_date: new Date('2026-01-01'),
  },
});

const buildSnapshot = (overrides: Record<string, any> = {}) => ({
  id: 'snap-1',
  source: 'hubspot',
  hubspot_id: '588407860315',
  internal_invoice_id: null,
  invoice_amount: 3600,
  paid_at: new Date('2026-03-01'),
  due_date: new Date('2026-03-01'),
  lineItems: [lineItem('li-1', 1500)],
  organization: {
    id: 'org-1',
    med_alliance_referral_status: 'pending_confirmation',
    eligibility_start_at: null,
    referredByAffiliate: {
      id: 'affiliate-1',
      first_name: 'A',
      last_name: 'B',
      affiliateProfile: {
        id: 'profile-1',
        full_name: 'A B',
        commission_percent_default: 10,
        status: 'active',
      },
    },
  },
  ...overrides,
});

describe('InvoicePaidCommissionService', () => {
  let service: InvoicePaidCommissionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicePaidCommissionService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(InvoicePaidCommissionService);
    mockPrisma.affiliateCommission.upsert.mockResolvedValue({ id: 'c' });
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.clearAllMocks());

  describe('createCommissionsForPaidSnapshot', () => {
    it('keeps the HubSpot idempotency key byte-for-byte identical to the pre-refactor key', async () => {
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        buildSnapshot(),
      );

      await service.createCommissionsForPaidSnapshot(
        { hubspot_id: '588407860315' },
        '588407860315',
      );

      const legacyKey = createHash('sha256')
        .update(['affiliate-1', '588407860315', 'li-1'].join('|'))
        .digest('hex');
      expect(mockPrisma.affiliateCommission.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { idempotency_key: legacyKey },
          create: expect.objectContaining({ source: 'hubspot' }),
        }),
      );
    });

    it('creates one commission per internal line with source=internal and an internal: key', async () => {
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        buildSnapshot({
          source: 'internal',
          hubspot_id: null,
          internal_invoice_id: 'inv-1',
          lineItems: [lineItem('li-primary', 1000), lineItem('li-bonus', 200)],
        }),
      );

      await service.createCommissionsForPaidSnapshot({ id: 'snap-1' }, 'x');

      expect(mockPrisma.affiliateCommission.upsert).toHaveBeenCalledTimes(2);
      const first = mockPrisma.affiliateCommission.upsert.mock.calls[0][0];
      expect(first.where.idempotency_key).toBe(
        createHash('sha256')
          .update(['affiliate-1', 'internal:inv-1', 'li-primary'].join('|'))
          .digest('hex'),
      );
      expect(first.create).toEqual(
        expect.objectContaining({
          source: 'internal',
          hubspot_invoice_snapshot_id: 'snap-1',
          hubspot_line_item_snapshot_id: 'li-primary',
          base_amount_snapshot: 1000,
          status: 'detected',
        }),
      );
      expect(first.create.commission_amount.toString()).toBe('100');
    });

    it('never creates negative commissions from internal credit lines', async () => {
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        buildSnapshot({
          source: 'internal',
          hubspot_id: null,
          internal_invoice_id: 'inv-1',
          lineItems: [
            lineItem('li-primary', 1000),
            lineItem('li-credit', -150),
          ],
        }),
      );

      await service.createCommissionsForPaidSnapshot({ id: 'snap-1' }, 'x');

      expect(mockPrisma.affiliateCommission.upsert).toHaveBeenCalledTimes(1);
      expect(
        mockPrisma.affiliateCommission.upsert.mock.calls[0][0].create
          .hubspot_line_item_snapshot_id,
      ).toBe('li-primary');
    });

    it('creates pending_admin_confirmation commissions once the company is confirmed eligible', async () => {
      const snapshot = buildSnapshot();
      snapshot.organization.med_alliance_referral_status = 'eligible';
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(snapshot);

      await service.createCommissionsForPaidSnapshot({ id: 'snap-1' }, 'x');

      expect(
        mockPrisma.affiliateCommission.upsert.mock.calls[0][0].create.status,
      ).toBe('pending_admin_confirmation');
    });

    it('creates nothing when the affiliate is not active', async () => {
      const snapshot = buildSnapshot();
      snapshot.organization.referredByAffiliate.affiliateProfile.status =
        'inactive';
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(snapshot);

      await expect(
        service.createCommissionsForPaidSnapshot({ id: 'snap-1' }, 'x'),
      ).resolves.toBeUndefined();
      expect(mockPrisma.affiliateCommission.upsert).not.toHaveBeenCalled();
    });

    it('creates nothing when there are no matched line items yet', async () => {
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        buildSnapshot({ lineItems: [] }),
      );

      await expect(
        service.createCommissionsForPaidSnapshot({ id: 'snap-1' }, 'x'),
      ).resolves.toBeUndefined();
      expect(mockPrisma.affiliateCommission.upsert).not.toHaveBeenCalled();
    });

    it('creates nothing when the invoice has no amount', async () => {
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        buildSnapshot({ invoice_amount: null }),
      );

      await expect(
        service.createCommissionsForPaidSnapshot({ id: 'snap-1' }, 'x'),
      ).resolves.toBeUndefined();
      expect(mockPrisma.affiliateCommission.upsert).not.toHaveBeenCalled();
    });

    it('creates nothing when the snapshot does not exist', async () => {
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);

      await expect(
        service.createCommissionsForPaidSnapshot({ id: 'missing' }, 'x'),
      ).resolves.toBeUndefined();
    });

    it('skips a line whose staff 365-day window had expired by the due date', async () => {
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        buildSnapshot({ due_date: new Date('2027-03-01') }),
      );

      await service.createCommissionsForPaidSnapshot({ id: 'snap-1' }, 'x');

      expect(mockPrisma.affiliateCommission.upsert).not.toHaveBeenCalled();
    });

    it('treats a snapshot without source as HubSpot', async () => {
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        buildSnapshot({ source: undefined }),
      );

      await service.createCommissionsForPaidSnapshot({ id: 'snap-1' }, 'x');

      expect(
        mockPrisma.affiliateCommission.upsert.mock.calls[0][0].create.source,
      ).toBe('hubspot');
    });

    it('does not let one line failure block the other lines', async () => {
      const errorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        buildSnapshot({
          lineItems: [lineItem('li-1', 1000), lineItem('li-2', 500)],
        }),
      );
      mockPrisma.affiliateCommission.upsert
        .mockRejectedValueOnce(new Error('db'))
        .mockResolvedValueOnce({ id: 'c2' });

      await expect(
        service.createCommissionsForPaidSnapshot({ id: 'snap-1' }, 'x'),
      ).resolves.toBe(true);
      expect(mockPrisma.affiliateCommission.upsert).toHaveBeenCalledTimes(2);
      errorSpy.mockRestore();
    });

    it('only considers matched, non-removed line items', async () => {
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        buildSnapshot(),
      );

      await service.createCommissionsForPaidSnapshot({ id: 'snap-1' }, 'x');

      expect(
        mockPrisma.hubspotInvoiceSnapshot.findUnique.mock.calls[0][0].select
          .lineItems.where,
      ).toEqual({
        match_status: 'matched',
        staff_id: { not: null },
        removed_at: null,
      });
    });
  });

  describe('markOrganizationDeployedFromFirstPaidInvoice', () => {
    const baseOrg = {
      id: 'org-1',
      referred_by_affiliate_id: 'affiliate-1',
      med_alliance_referral_status: 'pending_confirmation',
      med_alliance_block_reason: null,
      first_paid_invoice_at: null,
      referral_stage: 'contract_signed',
    };
    const params = {
      organizationId: 'org-1',
      firstInvoiceDate: new Date('2026-03-01'),
      internalInvoiceId: 'inv-1',
    };

    it('transitions the org to deployed and records the internal invoice in the audit log', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(baseOrg);
      mockPrisma.organization.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.markOrganizationDeployedFromFirstPaidInvoice(params),
      ).resolves.toBe(true);

      expect(mockPrisma.organization.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            referral_stage: 'deployed',
            first_paid_invoice_at: params.firstInvoiceDate,
          }),
        }),
      );
      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              internal_invoice_id: 'inv-1',
              hubspot_invoice_id: null,
            }),
          }),
        }),
      );
    });

    it.each([
      ['has no referring affiliate', { referred_by_affiliate_id: null }],
      [
        'is active-client blocked',
        { med_alliance_block_reason: 'active_client_block: email' },
      ],
      [
        'already had a first paid invoice',
        { first_paid_invoice_at: new Date() },
      ],
      ['is canceled', { referral_stage: 'canceled' }],
      ['is already deployed', { referral_stage: 'deployed' }],
    ])('skips the transition when the org %s', async (_label, overrides) => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        ...baseOrg,
        ...overrides,
      });

      await expect(
        service.markOrganizationDeployedFromFirstPaidInvoice(params),
      ).resolves.toBe(false);
      expect(mockPrisma.organization.updateMany).not.toHaveBeenCalled();
    });

    it('returns false when the org does not exist', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(null);

      await expect(
        service.markOrganizationDeployedFromFirstPaidInvoice(params),
      ).resolves.toBe(false);
    });

    it('returns false when a concurrent process already changed the org', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(baseOrg);
      mockPrisma.organization.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.markOrganizationDeployedFromFirstPaidInvoice(params),
      ).resolves.toBe(false);
      expect(mockPrisma.medAllianceAuditLog.create).not.toHaveBeenCalled();
    });
  });
});
