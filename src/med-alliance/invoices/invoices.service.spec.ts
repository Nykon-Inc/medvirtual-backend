import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../prisma/prisma.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockPrisma = {
  organization: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  affiliateProfile: {
    findUnique: jest.fn(),
  },
  hubspotInvoiceSnapshot: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
  $transaction: jest.fn(),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const mockCurrentUser = {
  id: 'user-1',
  role: 'organization_admin',
} as any;

const makeSnapshot = (overrides: Partial<any> = {}) => ({
  id: 'snap-1',
  hubspot_id: 'hs-inv-1',
  organization_id: 'org-1',
  invoice_status: 'paid',
  payment_status: null,
  invoice_amount: '1500.00',
  currency: 'USD',
  paid_at: new Date('2026-02-15'),
  sync_hash: 'abc123',
  createdAt: new Date('2026-02-15'),
  updatedAt: new Date('2026-02-15'),
  ...overrides,
});

describe('InvoicesService', () => {
  let service: InvoicesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // is_candidate_input logic (tested through the public API responses)
  // -------------------------------------------------------------------------
  describe('is_candidate_input flag', () => {
    const cases = [
      {
        label: 'true when invoice_status=paid, amount>0, payment_status=null',
        snapshot: makeSnapshot({
          invoice_status: 'paid',
          invoice_amount: '1500.00',
          payment_status: null,
        }),
        expected: true,
      },
      {
        label:
          'true when invoice_status=paid, amount>0, payment_status=succeeded',
        snapshot: makeSnapshot({
          invoice_status: 'paid',
          invoice_amount: '1500.00',
          payment_status: 'succeeded',
        }),
        expected: true,
      },
      {
        label: 'false when invoice_status is not paid',
        snapshot: makeSnapshot({
          invoice_status: 'outstanding',
          invoice_amount: '1500.00',
          payment_status: null,
        }),
        expected: false,
      },
      {
        label: 'false when invoice_amount is 0',
        snapshot: makeSnapshot({
          invoice_status: 'paid',
          invoice_amount: '0.00',
          payment_status: null,
        }),
        expected: false,
      },
      {
        label: 'false when invoice_amount is negative',
        snapshot: makeSnapshot({
          invoice_status: 'paid',
          invoice_amount: '-100.00',
          payment_status: null,
        }),
        expected: false,
      },
      {
        label: 'false when payment_status is present and not succeeded',
        snapshot: makeSnapshot({
          invoice_status: 'paid',
          invoice_amount: '1000.00',
          payment_status: 'failed',
        }),
        expected: false,
      },
    ];

    cases.forEach(({ label, snapshot, expected }) => {
      it(`should return ${expected}: ${label}`, async () => {
        mockPrisma.organization.findUnique.mockResolvedValue({
          id: 'org-1',
          referred_by_affiliate_id: 'user-1',
        });
        mockPrisma.$transaction.mockResolvedValue([[snapshot], 1]);

        const result = await service.getForAffiliate(
          'org-1',
          mockCurrentUser,
          {},
        );

        expect(result.data[0].is_candidate_input).toBe(expected);
      });
    });
  });

  // -------------------------------------------------------------------------
  // getForAffiliate
  // -------------------------------------------------------------------------
  describe('getForAffiliate', () => {
    it('should throw NotFoundException when organization does not exist', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(null);

      await expect(
        service.getForAffiliate('org-99', mockCurrentUser, {}),
      ).rejects.toThrow(new NotFoundException('Organization not found'));
    });

    it('should throw ForbiddenException when org was not referred by the current user', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        referred_by_affiliate_id: 'different-user',
      });

      await expect(
        service.getForAffiliate('org-1', mockCurrentUser, {}),
      ).rejects.toThrow(
        new ForbiddenException('You do not have access to this organization'),
      );
    });

    it('should return snapshots with is_candidate_input flag', async () => {
      const snapshot = makeSnapshot();
      mockPrisma.organization.findUnique.mockResolvedValue({
        referred_by_affiliate_id: 'user-1',
      });
      mockPrisma.$transaction.mockResolvedValue([[snapshot], 1]);

      const result = await service.getForAffiliate(
        'org-1',
        mockCurrentUser,
        {},
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toHaveProperty('is_candidate_input');
      expect(result.data[0]).not.toHaveProperty('raw_payload');
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1 });
    });

    it('should filter by candidates_only — only return is_candidate_input=true records', async () => {
      const eligible = makeSnapshot({
        invoice_status: 'paid',
        invoice_amount: '500.00',
        payment_status: null,
      });
      const ineligible = makeSnapshot({
        invoice_status: 'outstanding',
        invoice_amount: '200.00',
        payment_status: null,
        id: 'snap-2',
      });

      mockPrisma.organization.findUnique.mockResolvedValue({
        referred_by_affiliate_id: 'user-1',
      });
      mockPrisma.$transaction.mockResolvedValue([[eligible, ineligible], 2]);

      const result = await service.getForAffiliate('org-1', mockCurrentUser, {
        candidates_only: true,
      });

      expect(result.data.every((s) => s.is_candidate_input)).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    it('should apply paid_at_from and paid_at_to date filters', async () => {
      const snapshot = makeSnapshot();
      mockPrisma.organization.findUnique.mockResolvedValue({
        referred_by_affiliate_id: 'user-1',
      });
      mockPrisma.$transaction.mockResolvedValue([[snapshot], 1]);

      const result = await service.getForAffiliate('org-1', mockCurrentUser, {
        paid_at_from: '2026-01-01',
        paid_at_to: '2026-03-01',
      });

      expect(result.data).toHaveLength(1);
    });

    it('should respect custom pagination', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        referred_by_affiliate_id: 'user-1',
      });
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.getForAffiliate('org-1', mockCurrentUser, {
        page: 2,
        limit: 5,
      });

      expect(result.pagination).toEqual({ page: 2, limit: 5, total: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // getForAdmin
  // -------------------------------------------------------------------------
  describe('getForAdmin', () => {
    it('should throw NotFoundException when organization does not exist', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(null);

      await expect(service.getForAdmin('org-99', {})).rejects.toThrow(
        new NotFoundException('Organization not found'),
      );
    });

    it('should return snapshots without affiliate scoping', async () => {
      const snapshot = makeSnapshot();
      mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-1' });
      mockPrisma.$transaction.mockResolvedValue([[snapshot], 1]);

      const result = await service.getForAdmin('org-1', {});

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toHaveProperty('is_candidate_input');
    });

    it('should filter by invoice_status when provided', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-1' });
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.getForAdmin('org-1', {
        invoice_status: 'outstanding',
      });

      expect(result.data).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // listAllForAdmin
  // -------------------------------------------------------------------------
  describe('listAllForAdmin', () => {
    it('should return all snapshots across organizations', async () => {
      const snapshotWithOrg = {
        ...makeSnapshot(),
        organization: { id: 'org-1', name: 'Acme Corp' },
      };
      mockPrisma.$transaction.mockResolvedValue([[snapshotWithOrg], 1]);

      const result = await service.listAllForAdmin({});

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toHaveProperty('organization');
      expect(result.data[0]).toHaveProperty('is_candidate_input');
    });

    it('should filter by candidates_only across all organizations', async () => {
      const eligible = {
        ...makeSnapshot(),
        organization: { id: 'org-1', name: 'Acme' },
      };
      const ineligible = {
        ...makeSnapshot({ invoice_status: 'outstanding', id: 'snap-2' }),
        organization: { id: 'org-2', name: 'Beta' },
      };

      mockPrisma.$transaction.mockResolvedValue([[eligible, ineligible], 2]);

      const result = await service.listAllForAdmin({ candidates_only: true });

      expect(result.data.every((s) => s.is_candidate_input)).toBe(true);
    });

    it('should apply date range filter', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.listAllForAdmin({
        paid_at_from: '2026-01-01',
        paid_at_to: '2026-12-31',
      });

      expect(result.data).toHaveLength(0);
    });

    it('should return correct pagination metadata', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 42]);

      const result = await service.listAllForAdmin({ page: 3, limit: 10 });

      expect(result.pagination).toEqual({ page: 3, limit: 10, total: 42 });
    });
  });

  // -------------------------------------------------------------------------
  // getEligibleInvoicesForAffiliate
  // -------------------------------------------------------------------------
  describe('getEligibleInvoicesForAffiliate', () => {
    const makeProfile = (overrides: Partial<any> = {}) => ({
      id: 'profile-1',
      user_id: 'affiliate-1',
      status: 'active',
      ...overrides,
    });

    it('should throw NotFoundException when affiliate profile does not exist', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.getEligibleInvoicesForAffiliate('profile-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when affiliate profile is not active', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(
        makeProfile({ status: 'inactive' }),
      );

      await expect(
        service.getEligibleInvoicesForAffiliate('profile-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when affiliate profile has no connected user', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(
        makeProfile({ user_id: null }),
      );

      await expect(
        service.getEligibleInvoicesForAffiliate('profile-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should query orgs with referral_stage=deployed, status not expired and org not deleted', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.organization.findMany.mockResolvedValue([]);

      await service.getEligibleInvoicesForAffiliate('profile-1');

      expect(mockPrisma.organization.findMany).toHaveBeenCalledWith({
        where: {
          referred_by_affiliate_id: 'affiliate-1',
          referral_stage: 'deployed',
          med_alliance_referral_status: { not: 'expired' },
          status: { not: 'deleted' },
        },
        select: { id: true },
      });
    });

    it('should return an empty array when no deployed orgs qualify', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.organization.findMany.mockResolvedValue([]);

      const result = await service.getEligibleInvoicesForAffiliate('profile-1');

      expect(result).toEqual([]);
      expect(mockPrisma.hubspotInvoiceSnapshot.findMany).not.toHaveBeenCalled();
    });

    it('should return eligible invoices mapped to the row shape', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.organization.findMany.mockResolvedValue([{ id: 'org-1' }]);
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        {
          id: 'snap-1',
          hubspot_id: 'hs-inv-1',
          organization_id: 'org-1',
          invoice_amount: '1500.00',
          payment_status: null,
          currency: 'USD',
          paid_at: new Date('2026-02-10'),
          hubspot_pdf_link: 'https://hubspot.example/pdf',
          invoice_number: 'INV-001',
          organization: { name: 'Acme Corp' },
        },
      ]);

      const result = await service.getEligibleInvoicesForAffiliate('profile-1');

      expect(result).toEqual([
        {
          id: 'snap-1',
          hubspot_id: 'hs-inv-1',
          organization_id: 'org-1',
          organization_name: 'Acme Corp',
          invoice_amount: '1500.00',
          currency: 'USD',
          paid_at: new Date('2026-02-10'),
          hubspot_pdf_link: 'https://hubspot.example/pdf',
          invoice_number: 'INV-001',
        },
      ]);
    });

    it('should exclude invoices with a non-succeeded payment_status', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.organization.findMany.mockResolvedValue([{ id: 'org-1' }]);
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        {
          id: 'snap-1',
          hubspot_id: 'hs-inv-1',
          organization_id: 'org-1',
          invoice_amount: '1500.00',
          payment_status: 'failed',
          currency: 'USD',
          paid_at: new Date('2026-02-10'),
          hubspot_pdf_link: null,
          invoice_number: 'INV-001',
          organization: { name: 'Acme Corp' },
        },
        {
          id: 'snap-2',
          hubspot_id: 'hs-inv-2',
          organization_id: 'org-1',
          invoice_amount: '1000.00',
          payment_status: 'succeeded',
          currency: 'USD',
          paid_at: new Date('2026-02-11'),
          hubspot_pdf_link: null,
          invoice_number: 'INV-002',
          organization: { name: 'Acme Corp' },
        },
      ]);

      const result = await service.getEligibleInvoicesForAffiliate('profile-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('snap-2');
    });

    it('should exclude invoices that already have a commission for this affiliate (query-level)', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.organization.findMany.mockResolvedValue([{ id: 'org-1' }]);
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([]);

      await service.getEligibleInvoicesForAffiliate('profile-1');

      expect(mockPrisma.hubspotInvoiceSnapshot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organization_id: { in: ['org-1'] },
            invoice_status: 'paid',
            invoice_amount: { gt: 0 },
            NOT: {
              commissions: { some: { affiliate_id: 'affiliate-1' } },
            },
          }),
        }),
      );
    });
  });
});
