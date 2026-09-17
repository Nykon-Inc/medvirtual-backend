import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { PayoutRequestsService } from './payout-requests.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AffiliatesService } from '../affiliates/affiliates.service';
import { AllianceNotificationsService } from '../notifications/notifications.service';
import { BillComPayoutService } from '../bill-com/bill-com-payout.service';
import { BillComService } from '../bill-com/bill-com.service';
import { BillComSessionRequiredException } from '../bill-com/bill-com-session-required.exception';

const mockAllianceNotifications: Partial<AllianceNotificationsService> = {
  notifyAdminPayoutRequested: jest.fn(),
  notifyPayoutPaid: jest.fn(),
  notifyAdminMarkPaidError: jest.fn(),
  notifyPayoutProcessing: jest.fn(),
};

const mockBillComPayoutService = {
  validateAndPreparePayment: jest.fn(),
  createBillAndPaymentForMarkPaid: jest.fn(),
};

const mockBillComService = {
  hasValidSession: jest.fn(),
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockPrisma = {
  affiliateCommission: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  affiliateProfile: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
  },
  affiliatePayoutRequest: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  affiliatePayoutRequestCommission: {
    createMany: jest.fn(),
  },
  medAllianceAuditLog: {
    create: jest.fn(),
    createMany: jest.fn(),
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockAffiliatesService = {
  requireActiveProfile: jest.fn(),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const mockAdminUser = {
  id: 'admin-1',
  first_name: 'Admin',
  last_name: 'User',
  role: 'system_admin',
} as any;

const mockAffiliateUser = {
  id: 'affiliate-1',
  first_name: 'Jane',
  last_name: 'Affiliate',
  role: 'organization_admin',
} as any;

const mockProfile = {
  id: 'profile-1',
  user_id: 'affiliate-1',
  status: 'active',
  payout_preference_method: 'ach',
};

// Profile shape as returned by the `affiliateProfile.findUnique`/`findUniqueOrThrow`
// calls that back the vendor-ID check (includes contact + user.contact relations).
const makeProfileWithVendor = (overrides: Partial<any> = {}) => ({
  id: 'profile-1',
  user_id: 'affiliate-1',
  payout_preference_method: 'ach',
  contact: { hubspot_billcom_vendor_id: 'vendor-123' },
  user: { contact: { hubspot_billcom_vendor_id: null } },
  ...overrides,
});

const makeProfileWithoutVendor = (overrides: Partial<any> = {}) => ({
  id: 'profile-1',
  user_id: 'affiliate-1',
  payout_preference_method: 'ach',
  contact: null,
  user: { contact: null },
  ...overrides,
});

const makeCommission = (overrides: Partial<any> = {}) => ({
  id: 'commission-1',
  affiliate_id: 'affiliate-1',
  status: 'eligible',
  commission_amount: '150.00',
  ...overrides,
});

const makePayoutRequest = (overrides: Partial<any> = {}) => ({
  id: 'payout-1',
  affiliate_id: 'affiliate-1',
  affiliate_profile_id: 'profile-1',
  status: 'requested',
  requested_amount: '150.00',
  approved_amount: null,
  payment_method: 'ach',
  payment_reference: null,
  approved_by: null,
  approved_at: null,
  paid_at: null,
  rejection_reason: null,
  createdAt: new Date('2026-03-01'),
  updatedAt: new Date('2026-03-01'),
  commissions: [
    {
      commission: {
        id: 'commission-1',
        commission_amount: '150.00',
        status: 'requested',
        organization: { id: 'org-1', name: 'Acme' },
      },
    },
  ],
  ...overrides,
});

describe('PayoutRequestsService', () => {
  let service: PayoutRequestsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutRequestsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AffiliatesService, useValue: mockAffiliatesService },
        {
          provide: AllianceNotificationsService,
          useValue: mockAllianceNotifications,
        },
        { provide: BillComPayoutService, useValue: mockBillComPayoutService },
        { provide: BillComService, useValue: mockBillComService },
        {
          provide: Logger,
          useValue: {
            log: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PayoutRequestsService>(PayoutRequestsService);
    mockBillComService.hasValidSession.mockResolvedValue(true);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------
  describe('create', () => {
    const createDto = {
      commission_ids: ['commission-1'],
      payment_method: undefined,
    } as any;

    it('should throw ForbiddenException when affiliate profile is inactive or missing', async () => {
      mockAffiliatesService.requireActiveProfile.mockRejectedValue(
        new BadRequestException('Affiliate profile is inactive'),
      );

      await expect(
        service.create(createDto, mockAffiliateUser),
      ).rejects.toThrow();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when the affiliate has no Bill.com vendor ID', async () => {
      mockAffiliatesService.requireActiveProfile.mockResolvedValue(mockProfile);
      mockPrisma.affiliateProfile.findUniqueOrThrow.mockResolvedValue(
        makeProfileWithoutVendor(),
      );

      await expect(
        service.create(createDto, mockAffiliateUser),
      ).rejects.toThrow(
        new BadRequestException(
          'Bill.com vendor ID is missing for this affiliate. Cannot create a payout request until a vendor ID is configured.',
        ),
      );
      expect(mockPrisma.affiliateCommission.findMany).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when a commission ID is not found', async () => {
      mockAffiliatesService.requireActiveProfile.mockResolvedValue(mockProfile);
      mockPrisma.affiliateProfile.findUniqueOrThrow.mockResolvedValue(
        makeProfileWithVendor(),
      );
      // Return fewer commissions than requested (simulates missing ID)
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([]);

      await expect(
        service.create(createDto, mockAffiliateUser),
      ).rejects.toThrow(
        new BadRequestException('One or more commission IDs were not found'),
      );
    });

    it('should throw BadRequestException when a commission belongs to another affiliate', async () => {
      mockAffiliatesService.requireActiveProfile.mockResolvedValue(mockProfile);
      mockPrisma.affiliateProfile.findUniqueOrThrow.mockResolvedValue(
        makeProfileWithVendor(),
      );
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission({ affiliate_id: 'other-user' }),
      ]);

      await expect(
        service.create(createDto, mockAffiliateUser),
      ).rejects.toThrow(
        new BadRequestException(
          'One or more commissions do not belong to your account',
        ),
      );
    });

    it('should throw BadRequestException when a commission is not in "eligible" status', async () => {
      mockAffiliatesService.requireActiveProfile.mockResolvedValue(mockProfile);
      mockPrisma.affiliateProfile.findUniqueOrThrow.mockResolvedValue(
        makeProfileWithVendor(),
      );
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission({ status: 'detected' }),
      ]);

      await expect(
        service.create(createDto, mockAffiliateUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when a commission belongs to a deleted organization', async () => {
      mockAffiliatesService.requireActiveProfile.mockResolvedValue(mockProfile);
      mockPrisma.affiliateProfile.findUniqueOrThrow.mockResolvedValue(
        makeProfileWithVendor(),
      );
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission({
          organization: { status: 'deleted' },
        }),
      ]);

      await expect(
        service.create(createDto, mockAffiliateUser),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('should create payout request, junction records and update commissions in a transaction', async () => {
      mockAffiliatesService.requireActiveProfile.mockResolvedValue(mockProfile);
      mockPrisma.affiliateProfile.findUniqueOrThrow.mockResolvedValue(
        makeProfileWithVendor(),
      );
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission(),
      ]);

      // $transaction receives a callback — execute it with a tx mock
      const txMock = {
        affiliatePayoutRequest: {
          create: jest.fn().mockResolvedValue({ id: 'payout-1' }),
        },
        affiliatePayoutRequestCommission: {
          createMany: jest.fn().mockResolvedValue({}),
        },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest(),
      );
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.create(createDto, mockAffiliateUser);

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(txMock.affiliatePayoutRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            affiliate_id: 'affiliate-1',
            affiliate_profile_id: 'profile-1',
            status: 'requested',
          }),
        }),
      );
      expect(
        txMock.affiliatePayoutRequestCommission.createMany,
      ).toHaveBeenCalledWith({
        data: [
          { payout_request_id: 'payout-1', commission_id: 'commission-1' },
        ],
      });
      expect(txMock.affiliateCommission.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['commission-1'] } },
        data: { status: 'requested' },
      });
      expect(result).toEqual(makePayoutRequest());
    });

    it('should calculate requested_amount as sum of commission_amounts', async () => {
      mockAffiliatesService.requireActiveProfile.mockResolvedValue(mockProfile);
      mockPrisma.affiliateProfile.findUniqueOrThrow.mockResolvedValue(
        makeProfileWithVendor(),
      );
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission({ id: 'c-1', commission_amount: '100.00' }),
        makeCommission({ id: 'c-2', commission_amount: '250.50' }),
      ]);

      const txMock = {
        affiliatePayoutRequest: {
          create: jest.fn().mockResolvedValue({ id: 'payout-1' }),
        },
        affiliatePayoutRequestCommission: {
          createMany: jest.fn().mockResolvedValue({}),
        },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest(),
      );
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.create(
        { commission_ids: ['c-1', 'c-2'] } as any,
        mockAffiliateUser,
      );

      const createCall = txMock.affiliatePayoutRequest.create.mock.calls[0][0];
      // 100.00 + 250.50 = 350.50
      expect(createCall.data.requested_amount.toString()).toBe('350.5');
    });

    it('should use DTO payment_method when provided, otherwise fall back to profile default', async () => {
      mockAffiliatesService.requireActiveProfile.mockResolvedValue(mockProfile);
      mockPrisma.affiliateProfile.findUniqueOrThrow.mockResolvedValue(
        makeProfileWithVendor({ payout_preference_method: 'ach' }),
      );
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission(),
      ]);

      const txMock = {
        affiliatePayoutRequest: {
          create: jest.fn().mockResolvedValue({ id: 'payout-1' }),
        },
        affiliatePayoutRequestCommission: {
          createMany: jest.fn().mockResolvedValue({}),
        },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest(),
      );
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      // DTO overrides with 'wire'
      await service.create(
        { commission_ids: ['commission-1'], payment_method: 'wire' } as any,
        mockAffiliateUser,
      );

      const createCall = txMock.affiliatePayoutRequest.create.mock.calls[0][0];
      expect(createCall.data.payment_method).toBe('wire');
    });

    it('should write audit log entries for payout request and each commission', async () => {
      mockAffiliatesService.requireActiveProfile.mockResolvedValue(mockProfile);
      mockPrisma.affiliateProfile.findUniqueOrThrow.mockResolvedValue(
        makeProfileWithVendor(),
      );
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission(),
      ]);

      const txMock = {
        affiliatePayoutRequest: {
          create: jest.fn().mockResolvedValue({ id: 'payout-1' }),
        },
        affiliatePayoutRequestCommission: {
          createMany: jest.fn().mockResolvedValue({}),
        },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest(),
      );
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.create(createDto, mockAffiliateUser);

      // Should have written audit for payout request + 1 commission = 2 entries
      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // findAllForAffiliate
  // -------------------------------------------------------------------------
  describe('findAllForAffiliate', () => {
    it('should return paginated payout requests scoped to the current affiliate', async () => {
      mockPrisma.$transaction.mockResolvedValue([[makePayoutRequest()], 1]);

      const result = await service.findAllForAffiliate({}, mockAffiliateUser);

      expect(result.data).toHaveLength(1);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1 });
    });

    it('should filter by status', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.findAllForAffiliate(
        { status: 'paid' as any },
        mockAffiliateUser,
      );

      expect(result.data).toHaveLength(0);
    });

    it('should apply date range filters', async () => {
      mockPrisma.$transaction.mockResolvedValue([[makePayoutRequest()], 1]);

      const result = await service.findAllForAffiliate(
        { created_from: '2026-01-01', created_to: '2026-12-31' },
        mockAffiliateUser,
      );

      expect(result.data).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // findOneForAffiliate
  // -------------------------------------------------------------------------
  describe('findOneForAffiliate', () => {
    it('should throw NotFoundException when payout request does not exist', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.findOneForAffiliate('payout-99', mockAffiliateUser),
      ).rejects.toThrow(new NotFoundException('Payout request not found'));
    });

    it('should throw NotFoundException when payout request belongs to another affiliate', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest({ affiliate_id: 'other-user' }),
      );

      await expect(
        service.findOneForAffiliate('payout-1', mockAffiliateUser),
      ).rejects.toThrow(new NotFoundException('Payout request not found'));
    });

    it('should return the payout request when it belongs to the current affiliate', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest(),
      );

      const result = await service.findOneForAffiliate(
        'payout-1',
        mockAffiliateUser,
      );

      expect(result.id).toBe('payout-1');
    });

    it('should pass through the widened hubspotInvoiceSnapshot fields untouched', async () => {
      const snapshot = {
        id: 'snap-1',
        invoice_amount: '150.00',
        invoice_status: 'paid',
        invoice_number: 'INV-001',
        hubspot_id: 'hs-123',
        currency: 'USD',
        paid_at: new Date('2026-03-05'),
        hubspot_pdf_link: 'https://hubspot.example.com/invoice.pdf',
      };
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest({
          commissions: [
            {
              commission: {
                id: 'commission-1',
                commission_amount: '150.00',
                status: 'requested',
                organization: { id: 'org-1', name: 'Acme' },
                hubspotInvoiceSnapshot: snapshot,
              },
            },
          ],
        }),
      );

      const result = await service.findOneForAffiliate(
        'payout-1',
        mockAffiliateUser,
      );

      expect(
        (result as any).commissions[0].commission.hubspotInvoiceSnapshot,
      ).toEqual(snapshot);
    });
  });

  // -------------------------------------------------------------------------
  // findAllForAdmin
  // -------------------------------------------------------------------------
  describe('findAllForAdmin', () => {
    it('should return all payout requests without affiliate scoping', async () => {
      const requestWithDetails = {
        ...makePayoutRequest(),
        affiliate: {
          id: 'affiliate-1',
          first_name: 'Jane',
          last_name: 'Affiliate',
          email: 'jane@example.com',
        },
        approvedBy: null,
      };
      mockPrisma.$transaction.mockResolvedValue([[requestWithDetails], 1]);

      const result = await service.findAllForAdmin({});

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toHaveProperty('affiliate');
    });

    it('should filter by affiliate_id', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.findAllForAdmin({
        affiliate_id: 'affiliate-99',
      });

      expect(result.data).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // findOneForAdmin
  // -------------------------------------------------------------------------
  describe('findOneForAdmin', () => {
    it('should throw NotFoundException when payout request does not exist', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(null);

      await expect(service.findOneForAdmin('payout-99')).rejects.toThrow(
        new NotFoundException('Payout request not found'),
      );
    });

    it('should return payout request with affiliate and approvedBy details', async () => {
      const fullRequest = {
        ...makePayoutRequest({ status: 'approved', approved_by: 'admin-1' }),
        affiliate: {
          id: 'affiliate-1',
          first_name: 'Jane',
          last_name: 'Affiliate',
          email: 'jane@example.com',
        },
        approvedBy: { id: 'admin-1', first_name: 'Admin', last_name: 'User' },
      };
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        fullRequest,
      );

      const result = await service.findOneForAdmin('payout-1');

      expect(result.approvedBy.id).toBe('admin-1');
    });

    it('should flatten the widened hubspotInvoiceSnapshot fields with the invoice_ prefix', async () => {
      const fullRequest = {
        ...makePayoutRequest({ status: 'approved', approved_by: 'admin-1' }),
        affiliate: {
          id: 'affiliate-1',
          first_name: 'Jane',
          last_name: 'Affiliate',
          email: 'jane@example.com',
        },
        approvedBy: { id: 'admin-1', first_name: 'Admin', last_name: 'User' },
        commissions: [
          {
            commission: {
              id: 'commission-1',
              commission_amount: '150.00',
              base_amount_snapshot: '1000.00',
              commission_percent_snapshot: '15',
              status: 'requested',
              admin_decision_reason: null,
              organization: { id: 'org-1', name: 'Acme' },
              createdAt: new Date('2026-03-01'),
              hubspotInvoiceSnapshot: {
                id: 'snap-1',
                invoice_amount: '150.00',
                invoice_status: 'paid',
                invoice_number: 'INV-001',
                hubspot_id: 'hs-123',
                currency: 'USD',
                paid_at: new Date('2026-03-05'),
                hubspot_pdf_link: 'https://hubspot.example.com/invoice.pdf',
              },
            },
          },
        ],
      };
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        fullRequest,
      );

      const result = await service.findOneForAdmin('payout-1');
      const commission = result.commissions[0];

      expect(commission.invoice_hubspot_id).toBe('hs-123');
      expect(commission.invoice_currency).toBe('USD');
      expect(commission.invoice_paid_at).toEqual(new Date('2026-03-05'));
      expect(commission.invoice_pdf_link).toBe(
        'https://hubspot.example.com/invoice.pdf',
      );
    });

    it('should default the widened invoice fields to null when hubspotInvoiceSnapshot is null', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue({
        ...makePayoutRequest(),
        affiliate: {
          id: 'affiliate-1',
          first_name: 'Jane',
          last_name: 'Affiliate',
          email: 'jane@example.com',
        },
        approvedBy: null,
        commissions: [
          {
            commission: {
              id: 'commission-1',
              commission_amount: '150.00',
              base_amount_snapshot: '1000.00',
              commission_percent_snapshot: '15',
              status: 'requested',
              admin_decision_reason: null,
              organization: { id: 'org-1', name: 'Acme' },
              createdAt: new Date('2026-03-01'),
              hubspotInvoiceSnapshot: null,
            },
          },
        ],
      });

      const result = await service.findOneForAdmin('payout-1');
      const commission = result.commissions[0];

      expect(commission.invoice_hubspot_id).toBeNull();
      expect(commission.invoice_currency).toBeNull();
      expect(commission.invoice_paid_at).toBeNull();
      expect(commission.invoice_pdf_link).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // decide
  // -------------------------------------------------------------------------
  describe('decide', () => {
    it('should throw NotFoundException when payout request does not exist', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.decide('payout-99', { decision: 'approved' }, mockAdminUser),
      ).rejects.toThrow(new NotFoundException('Payout request not found'));
    });

    it('should throw BadRequestException when payout request is not in "requested" status', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest({ status: 'approved' }),
      );

      await expect(
        service.decide('payout-1', { decision: 'approved' }, mockAdminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should approve the payout request and set approved_amount', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          ...makePayoutRequest(),
          commissions: [{ commission_id: 'commission-1' }],
        })
        .mockResolvedValueOnce(
          makePayoutRequest({
            status: 'approved',
            approved_amount: '150.00',
            approved_by: 'admin-1',
          }),
        );

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.decide(
        'payout-1',
        { decision: 'approved', approved_amount: 150 },
        mockAdminUser,
      );

      expect(txMock.affiliatePayoutRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'approved',
            approved_by: 'admin-1',
          }),
        }),
      );
      // On approval, commissions should NOT be reverted
      expect(txMock.affiliateCommission.updateMany).not.toHaveBeenCalled();
    });

    it('should reject the payout request and revert commissions to "rejected"', async () => {
      const commissionIds = ['commission-1', 'commission-2'];
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          ...makePayoutRequest(),
          commissions: commissionIds.map((id) => ({ commission_id: id })),
        })
        .mockResolvedValueOnce(makePayoutRequest({ status: 'rejected' }));

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.decide(
        'payout-1',
        {
          decision: 'rejected',
          rejection_reason: 'Insufficient documentation',
        },
        mockAdminUser,
      );

      expect(txMock.affiliateCommission.updateMany).toHaveBeenCalledWith({
        where: { id: { in: commissionIds } },
        data: { status: 'rejected' },
      });
    });

    it('should write audit log entries for the request and each reverted commission on rejection', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          ...makePayoutRequest(),
          commissions: [{ commission_id: 'commission-1' }],
        })
        .mockResolvedValueOnce(makePayoutRequest({ status: 'rejected' }));

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.decide(
        'payout-1',
        {
          decision: 'rejected',
          rejection_reason: 'Insufficient documentation',
        },
        mockAdminUser,
      );

      // 1 for payout request + 1 for each reverted commission
      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // markPaid
  // -------------------------------------------------------------------------
  describe('markPaid', () => {
    const mockBillPayload = {
      vendorId: 'vendor-1',
      affiliateName: 'Jane Affiliate',
      affiliateEmail: 'jane@example.com',
      amount: 150,
      today: '2026-05-29',
      duedate: '2026-06-05',
      commissionsItems: [{ description: 'Invoice 123', amount: 150 }],
    };
    const mockBillResponse = {
      paymentId: 'pay-abc',
      billId: 'bill-abc',
      status: 'SCHEDULED',
      confirmationNumber: 'conf-abc',
      transactionNumber: 'txn-abc',
    };

    it('should throw NotFoundException when payout request does not exist', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.markPaid('payout-99', {}, mockAdminUser),
      ).rejects.toThrow(new NotFoundException('Payout request not found'));
    });

    it('should throw BadRequestException when payout request is not in a payable status', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest({ status: 'requested' }),
      );

      await expect(
        service.markPaid('payout-1', {}, mockAdminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BillComSessionRequiredException before any Bill.com/DB work when admin has no valid session', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest({
          status: 'approved',
          commissions: [{ commission_id: 'c-1' }],
        }),
      );
      mockBillComService.hasValidSession.mockResolvedValue(false);

      await expect(
        service.markPaid('payout-1', {}, mockAdminUser),
      ).rejects.toThrow(BillComSessionRequiredException);

      expect(
        mockBillComPayoutService.validateAndPreparePayment,
      ).not.toHaveBeenCalled();
      expect(
        mockBillComPayoutService.createBillAndPaymentForMarkPaid,
      ).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('should not write to DB when validateAndPreparePayment throws (vendor ID missing)', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest({
          status: 'approved',
          commissions: [{ commission_id: 'c-1' }],
        }),
      );
      mockBillComPayoutService.validateAndPreparePayment.mockRejectedValue(
        new BadRequestException(
          'Bill.com vendor ID is missing for this affiliate.',
        ),
      );

      await expect(
        service.markPaid('payout-1', {}, mockAdminUser),
      ).rejects.toThrow(BadRequestException);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('should not write to DB when createBillAndPaymentForMarkPaid (Bill.com API) throws', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest({
          status: 'approved',
          commissions: [{ commission_id: 'c-1' }],
        }),
      );
      mockBillComPayoutService.validateAndPreparePayment.mockResolvedValue(
        mockBillPayload,
      );
      mockBillComPayoutService.createBillAndPaymentForMarkPaid.mockRejectedValue(
        new Error('Bill.com API error'),
      );

      await expect(
        service.markPaid('payout-1', {}, mockAdminUser),
      ).rejects.toThrow();

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('should set status to "processing" and store bill_com_billId in transaction on success', async () => {
      const commissionIds = ['commission-1'];
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          ...makePayoutRequest({ status: 'approved' }),
          commissions: commissionIds.map((id) => ({ commission_id: id })),
        })
        .mockResolvedValueOnce(makePayoutRequest({ status: 'processing' }));

      mockBillComPayoutService.validateAndPreparePayment.mockResolvedValue(
        mockBillPayload,
      );
      mockBillComPayoutService.createBillAndPaymentForMarkPaid.mockResolvedValue(
        mockBillResponse,
      );

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
        medAllianceAuditLog: {
          create: jest.fn().mockResolvedValue({}),
          createMany: jest.fn().mockResolvedValue({}),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await service.markPaid('payout-1', {}, mockAdminUser);

      expect(txMock.affiliatePayoutRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'processing',
            bill_com_billId: 'bill-abc',
            bill_com_payment_id: 'conf-abc',
            bill_com_status: 'SCHEDULED',
            transaction_reference: 'txn-abc',
          }),
        }),
      );
      expect(txMock.affiliateCommission.updateMany).toHaveBeenCalledWith({
        where: { id: { in: commissionIds } },
        data: { status: 'paid' },
      });
    });

    it('should write audit logs inside the transaction (payout_request + commissions)', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          ...makePayoutRequest({ status: 'approved' }),
          commissions: [{ commission_id: 'commission-1' }],
        })
        .mockResolvedValueOnce(makePayoutRequest({ status: 'processing' }));

      mockBillComPayoutService.validateAndPreparePayment.mockResolvedValue(
        mockBillPayload,
      );
      mockBillComPayoutService.createBillAndPaymentForMarkPaid.mockResolvedValue(
        mockBillResponse,
      );

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
        medAllianceAuditLog: {
          create: jest.fn().mockResolvedValue({}),
          createMany: jest.fn().mockResolvedValue({}),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await service.markPaid('payout-1', {}, mockAdminUser);

      expect(txMock.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: 'bill_com_payment_initiated',
            new_status: 'processing',
          }),
        }),
      );
      expect(txMock.medAllianceAuditLog.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              entity_id: 'commission-1',
              new_status: 'paid',
            }),
          ]),
        }),
      );
    });

    it('should set approved_by and approved_at when coming from "under_review"', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          ...makePayoutRequest({ status: 'under_review' }),
          commissions: [{ commission_id: 'c-1' }],
        })
        .mockResolvedValueOnce(makePayoutRequest({ status: 'processing' }));

      mockBillComPayoutService.validateAndPreparePayment.mockResolvedValue(
        mockBillPayload,
      );
      mockBillComPayoutService.createBillAndPaymentForMarkPaid.mockResolvedValue(
        mockBillResponse,
      );

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
        medAllianceAuditLog: {
          create: jest.fn().mockResolvedValue({}),
          createMany: jest.fn().mockResolvedValue({}),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await service.markPaid('payout-1', {}, mockAdminUser);

      expect(txMock.affiliatePayoutRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            approved_by: 'admin-1',
            approved_at: expect.any(Date),
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // getAuditLog
  // -------------------------------------------------------------------------
  describe('getAuditLog', () => {
    it('should throw NotFoundException when payout request does not exist', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(null);

      await expect(service.getAuditLog('payout-99')).rejects.toThrow(
        new NotFoundException('Payout request not found'),
      );
    });

    it('should return audit entries ordered chronologically', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue({
        id: 'payout-1',
      });

      const entries = [
        {
          id: 'log-1',
          event: 'status_changed',
          old_status: null,
          new_status: 'requested',
          source: 'user',
          createdAt: new Date('2026-03-01'),
          actorUser: {
            id: 'affiliate-1',
            first_name: 'Jane',
            last_name: 'Affiliate',
          },
        },
        {
          id: 'log-2',
          event: 'admin_decision',
          old_status: 'requested',
          new_status: 'approved',
          source: 'admin_action',
          createdAt: new Date('2026-03-02'),
          actorUser: { id: 'admin-1', first_name: 'Admin', last_name: 'User' },
        },
      ];
      mockPrisma.medAllianceAuditLog.findMany.mockResolvedValue(entries);

      const result = await service.getAuditLog('payout-1');

      expect(result).toHaveLength(2);
      expect(result[0].new_status).toBe('requested');
      expect(result[1].new_status).toBe('approved');
      expect(mockPrisma.medAllianceAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { entity_type: 'payout_request', entity_id: 'payout-1' },
          orderBy: { createdAt: 'asc' },
        }),
      );
    });

    it('should expose from_status/to_status aliases for the frontend timeline', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue({
        id: 'payout-1',
      });

      const entries = [
        {
          id: 'log-1',
          event: 'status_changed',
          old_status: null,
          new_status: 'requested',
          source: 'user',
          createdAt: new Date('2026-03-01'),
          actorUser: {
            id: 'affiliate-1',
            first_name: 'Jane',
            last_name: 'Affiliate',
          },
        },
        {
          id: 'log-2',
          event: 'admin_decision',
          old_status: 'requested',
          new_status: 'approved',
          source: 'admin_action',
          createdAt: new Date('2026-03-02'),
          actorUser: { id: 'admin-1', first_name: 'Admin', last_name: 'User' },
        },
      ];
      mockPrisma.medAllianceAuditLog.findMany.mockResolvedValue(entries);

      const result = await service.getAuditLog('payout-1');

      expect(result[0].from_status).toBeNull();
      expect(result[0].to_status).toBe('requested');
      expect(result[1].from_status).toBe('requested');
      expect(result[1].to_status).toBe('approved');
      // Legacy aliases must still be present.
      expect(result[0].old_status).toBeNull();
      expect(result[0].new_status).toBe('requested');
      expect(mockPrisma.medAllianceAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { entity_type: 'payout_request', entity_id: 'payout-1' },
          orderBy: { createdAt: 'asc' },
        }),
      );
    });

    it('should upgrade generic events to descriptive, transition-specific actions', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue({
        id: 'payout-1',
      });

      const entries = [
        {
          id: 'l1',
          event: 'status_changed',
          old_status: null,
          new_status: 'requested',
          source: 'user',
          createdAt: new Date('2026-03-01'),
          actorUser: null,
        },
        {
          id: 'l2',
          event: 'status_changed',
          old_status: 'requested',
          new_status: 'under_review',
          source: 'admin_action',
          createdAt: new Date('2026-03-02'),
          actorUser: null,
        },
        {
          id: 'l3',
          event: 'admin_decision',
          old_status: 'under_review',
          new_status: 'approved',
          source: 'admin_action',
          createdAt: new Date('2026-03-03'),
          actorUser: null,
        },
        {
          id: 'l4',
          event: 'admin_decision',
          old_status: 'requested',
          new_status: 'rejected',
          source: 'admin_action',
          createdAt: new Date('2026-03-04'),
          actorUser: null,
        },
        {
          id: 'l5',
          event: 'status_changed',
          old_status: 'under_review',
          new_status: 'cancelled',
          source: 'admin_action',
          createdAt: new Date('2026-03-05'),
          actorUser: null,
        },
        {
          id: 'l6',
          event: 'status_changed',
          old_status: 'rejected',
          new_status: 'requested',
          source: 'admin_action',
          createdAt: new Date('2026-03-06'),
          actorUser: null,
        },
        // Already-descriptive events are passed through untouched.
        {
          id: 'l7',
          event: 'bill_com_payment_initiated',
          old_status: 'under_review',
          new_status: 'processing',
          source: 'admin_action',
          createdAt: new Date('2026-03-07'),
          actorUser: null,
        },
      ];
      mockPrisma.medAllianceAuditLog.findMany.mockResolvedValue(entries);

      const result = await service.getAuditLog('payout-1');

      expect(result[0].action).toBe('request_submitted');
      expect(result[1].action).toBe('review_started');
      expect(result[2].action).toBe('request_approved');
      expect(result[3].action).toBe('request_rejected');
      expect(result[4].action).toBe('request_cancelled');
      expect(result[5].action).toBe('request_reopened');
      expect(result[6].action).toBe('bill_com_payment_initiated');
      // Actor falls back to "System" when no user is attached.
      expect(result[0].actor).toBe('System');
    });
  });

  // -------------------------------------------------------------------------
  // cancelPayoutRequest
  // -------------------------------------------------------------------------
  describe('cancelPayoutRequest', () => {
    it('should throw NotFoundException when payout request does not exist', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.cancelPayoutRequest('payout-99', {}, mockAdminUser),
      ).rejects.toThrow(new NotFoundException('Payout request not found'));
    });

    it('should return the current request without error when already cancelled (idempotent)', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          id: 'payout-1',
          status: 'cancelled',
          commissions: [],
        })
        .mockResolvedValueOnce(makePayoutRequest({ status: 'cancelled' }));

      const result = await service.cancelPayoutRequest(
        'payout-1',
        {},
        mockAdminUser,
      );

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(result.status).toBe('cancelled');
      expect(result.id).toBe('payout-1');
    });

    it('should throw BadRequestException when status is "approved"', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest({ status: 'approved' }),
      );

      await expect(
        service.cancelPayoutRequest('payout-1', {}, mockAdminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when status is "paid"', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest({ status: 'paid' }),
      );

      await expect(
        service.cancelPayoutRequest('payout-1', {}, mockAdminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when status is "rejected"', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest({ status: 'rejected' }),
      );

      await expect(
        service.cancelPayoutRequest('payout-1', {}, mockAdminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should cancel a "requested" payout and revert commissions to "eligible"', async () => {
      const commissionIds = ['commission-1', 'commission-2'];
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          id: 'payout-1',
          status: 'requested',
          commissions: commissionIds.map((id) => ({ commission_id: id })),
        })
        .mockResolvedValueOnce(makePayoutRequest({ status: 'cancelled' }));

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.cancelPayoutRequest('payout-1', {}, mockAdminUser);

      expect(txMock.affiliatePayoutRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'cancelled',
            cancelled_by: 'admin-1',
          }),
        }),
      );
      expect(txMock.affiliateCommission.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: commissionIds } }),
          data: { status: 'eligible' },
        }),
      );
    });

    it('should cancel an "under_review" payout request', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          id: 'payout-1',
          status: 'under_review',
          commissions: [{ commission_id: 'commission-1' }],
        })
        .mockResolvedValueOnce(makePayoutRequest({ status: 'cancelled' }));

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.cancelPayoutRequest('payout-1', {}, mockAdminUser);

      expect(txMock.affiliatePayoutRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'cancelled' }),
        }),
      );
    });

    it('should persist the cancellation reason when provided', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          id: 'payout-1',
          status: 'requested',
          commissions: [],
        })
        .mockResolvedValueOnce(makePayoutRequest({ status: 'cancelled' }));

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.cancelPayoutRequest(
        'payout-1',
        { reason: 'Duplicate entry' },
        mockAdminUser,
      );

      expect(txMock.affiliatePayoutRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cancellation_reason: 'Duplicate entry',
          }),
        }),
      );
    });

    it('should not call updateMany when there are no linked commissions', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          id: 'payout-1',
          status: 'requested',
          commissions: [],
        })
        .mockResolvedValueOnce(makePayoutRequest({ status: 'cancelled' }));

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.cancelPayoutRequest('payout-1', {}, mockAdminUser);

      expect(txMock.affiliateCommission.updateMany).not.toHaveBeenCalled();
    });

    it('should write a payout request audit log entry plus one per commission', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          id: 'payout-1',
          status: 'requested',
          commissions: [
            { commission_id: 'commission-1' },
            { commission_id: 'commission-2' },
          ],
        })
        .mockResolvedValueOnce(makePayoutRequest({ status: 'cancelled' }));

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.cancelPayoutRequest('payout-1', {}, mockAdminUser);

      // 1 for payout request + 2 for commissions
      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledTimes(3);
    });

    it('should return the updated payout request with cancelled status', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          id: 'payout-1',
          status: 'requested',
          commissions: [],
        })
        .mockResolvedValueOnce(
          makePayoutRequest({
            status: 'cancelled',
            cancellation_reason: 'Test',
          }),
        );

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.cancelPayoutRequest(
        'payout-1',
        { reason: 'Test' },
        mockAdminUser,
      );

      expect(result.status).toBe('cancelled');
      expect(result.id).toBe('payout-1');
    });
  });

  // -------------------------------------------------------------------------
  // createForAdmin
  // -------------------------------------------------------------------------
  describe('createForAdmin', () => {
    const adminCreateDto = {
      affiliate_profile_id: 'profile-1',
      commission_ids: ['commission-1'],
    } as any;

    beforeEach(() => {
      // findOneForAdmin is called at the end; mock affiliatePayoutRequest.findUnique
      // for both the internal profile lookup and the final findOneForAdmin call.
    });

    it('should throw NotFoundException when affiliate profile is not found', async () => {
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest.fn().mockResolvedValue(null),
      };

      await expect(
        service.createForAdmin(adminCreateDto, mockAdminUser),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when the affiliate has no Bill.com vendor ID', async () => {
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest.fn().mockResolvedValue(makeProfileWithoutVendor()),
      };

      await expect(
        service.createForAdmin(adminCreateDto, mockAdminUser),
      ).rejects.toThrow(
        new BadRequestException(
          'Bill.com vendor ID is missing for this affiliate. Cannot create a payout request until a vendor ID is configured.',
        ),
      );
      expect(mockPrisma.affiliateCommission.findMany).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when a commission ID is not found', async () => {
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest.fn().mockResolvedValue(makeProfileWithVendor()),
      };
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([]);

      await expect(
        service.createForAdmin(adminCreateDto, mockAdminUser),
      ).rejects.toThrow(
        new BadRequestException('One or more commission IDs were not found'),
      );
    });

    it('should throw BadRequestException when commission belongs to a different affiliate', async () => {
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest.fn().mockResolvedValue(makeProfileWithVendor()),
      };
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission({ affiliate_id: 'some-other-user' }),
      ]);

      await expect(
        service.createForAdmin(adminCreateDto, mockAdminUser),
      ).rejects.toThrow(
        new BadRequestException(
          'One or more commissions do not belong to this affiliate',
        ),
      );
    });

    it('should throw BadRequestException when commission is not eligible', async () => {
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest.fn().mockResolvedValue(makeProfileWithVendor()),
      };
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission({ status: 'detected' }),
      ]);

      await expect(
        service.createForAdmin(adminCreateDto, mockAdminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create payout request in transaction and return admin-shaped result', async () => {
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest.fn().mockResolvedValue(makeProfileWithVendor()),
      };
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission(),
      ]);

      const txMock = {
        affiliatePayoutRequest: {
          create: jest.fn().mockResolvedValue({ id: 'payout-1' }),
        },
        affiliatePayoutRequestCommission: {
          createMany: jest.fn().mockResolvedValue({}),
        },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      // findOneForAdmin calls findUnique with ADMIN_SELECT
      const adminRequest = {
        ...makePayoutRequest(),
        affiliate: {
          id: 'affiliate-1',
          first_name: 'Jane',
          last_name: 'Affiliate',
          email: 'jane@example.com',
        },
        affiliateProfile: {
          id: 'profile-1',
          payout_details: null,
          payout_preference_method: 'ach',
          payout_preference_reference: null,
          payout_preference_notes: null,
          createdAt: new Date(),
        },
        approvedBy: null,
        reviewedBy: null,
      };
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        adminRequest,
      );
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.createForAdmin(
        adminCreateDto,
        mockAdminUser,
      );

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(txMock.affiliatePayoutRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'requested',
            affiliate_id: 'affiliate-1',
          }),
        }),
      );
      // Audit log: 1 for payout request + 1 per commission
      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledTimes(2);
      expect(result).toBeDefined();
    });

    it('should not reject solely for having no connected user when vendor ID is present (falls through to commission ownership check instead)', async () => {
      // The dedicated "no connected user" rejection has been removed. A profile
      // with user_id: null and a vendor ID now proceeds past profile validation;
      // it only fails afterwards if a requested commission doesn't match
      // profile.user_id (commissions always carry a real USER id today).
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest
          .fn()
          .mockResolvedValue(makeProfileWithVendor({ user_id: null })),
      };
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission({ affiliate_id: 'affiliate-1' }),
      ]);

      await expect(
        service.createForAdmin(adminCreateDto, mockAdminUser),
      ).rejects.toThrow(
        new BadRequestException(
          'One or more commissions do not belong to this affiliate',
        ),
      );
    });
  });

  // -------------------------------------------------------------------------
  // createFromCron
  // -------------------------------------------------------------------------
  describe('createFromCron', () => {
    it('should throw NotFoundException when affiliate profile is not found', async () => {
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest.fn().mockResolvedValue(null),
      };

      await expect(
        service.createFromCron('profile-99', ['commission-1']),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when the affiliate has no Bill.com vendor ID', async () => {
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest.fn().mockResolvedValue(makeProfileWithoutVendor()),
      };

      await expect(
        service.createFromCron('profile-1', ['commission-1']),
      ).rejects.toThrow(
        new BadRequestException(
          'Bill.com vendor ID is missing for this affiliate. Cannot create a payout request until a vendor ID is configured.',
        ),
      );
      expect(mockPrisma.affiliateCommission.findMany).not.toHaveBeenCalled();
    });

    it('should not reject solely for having no connected user when vendor ID is present (falls through to commission ownership check instead)', async () => {
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest
          .fn()
          .mockResolvedValue(makeProfileWithVendor({ user_id: null })),
      };
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission({ affiliate_id: 'affiliate-1' }),
      ]);

      await expect(
        service.createFromCron('profile-1', ['commission-1']),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when a commission ID is not found', async () => {
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            makeProfileWithVendor({ payout_preference_method: null }),
          ),
      };
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([]);

      await expect(
        service.createFromCron('profile-1', ['commission-1']),
      ).rejects.toThrow(
        new BadRequestException('One or more commission IDs were not found'),
      );
    });

    it('should throw BadRequestException when commission belongs to a different affiliate', async () => {
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            makeProfileWithVendor({ payout_preference_method: null }),
          ),
      };
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission({ affiliate_id: 'other-user' }),
      ]);

      await expect(
        service.createFromCron('profile-1', ['commission-1']),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when commission is not eligible', async () => {
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            makeProfileWithVendor({ payout_preference_method: null }),
          ),
      };
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission({ status: 'pending_admin_confirmation' }),
      ]);

      await expect(
        service.createFromCron('profile-1', ['commission-1']),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create payout request and return id + requested_amount', async () => {
      (mockPrisma as any).affiliateProfile = {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            makeProfileWithVendor({ payout_preference_method: null }),
          ),
      };
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        makeCommission({ commission_amount: '200.00' }),
      ]);

      const txMock = {
        affiliatePayoutRequest: {
          create: jest.fn().mockResolvedValue({ id: 'payout-cron-1' }),
        },
        affiliatePayoutRequestCommission: {
          createMany: jest.fn().mockResolvedValue({}),
        },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.createFromCron('profile-1', [
        'commission-1',
      ]);

      expect(result.id).toBe('payout-cron-1');
      expect(result.requested_amount.toString()).toBe('200');
      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // findAllForAffiliate — amount filters (lines 543-545)
  // -------------------------------------------------------------------------
  describe('findAllForAffiliate — amount filters', () => {
    it('should apply amount_min filter', async () => {
      mockPrisma.$transaction.mockResolvedValue([[makePayoutRequest()], 1]);

      const result = await service.findAllForAffiliate(
        { amount_min: 100 } as any,
        mockAffiliateUser,
      );

      expect(result.data).toHaveLength(1);
    });

    it('should apply amount_max filter', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.findAllForAffiliate(
        { amount_max: 50 } as any,
        mockAffiliateUser,
      );

      expect(result.data).toHaveLength(0);
    });

    it('should apply both amount_min and amount_max', async () => {
      mockPrisma.$transaction.mockResolvedValue([[makePayoutRequest()], 1]);

      const result = await service.findAllForAffiliate(
        { amount_min: 100, amount_max: 500 } as any,
        mockAffiliateUser,
      );

      expect(result.data).toHaveLength(1);
    });

    it('should apply payment_method filter', async () => {
      mockPrisma.$transaction.mockResolvedValue([[makePayoutRequest()], 1]);

      const result = await service.findAllForAffiliate(
        { payment_method: 'ach' } as any,
        mockAffiliateUser,
      );

      expect(result.data).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // findAllForAdmin — date range, amount, search filters (lines 606-618)
  // -------------------------------------------------------------------------
  describe('findAllForAdmin — additional filters', () => {
    const adminRequest = () => ({
      ...makePayoutRequest(),
      affiliate: {
        id: 'affiliate-1',
        first_name: 'Jane',
        last_name: 'Affiliate',
        email: 'jane@example.com',
      },
      affiliateProfile: null,
      approvedBy: null,
      reviewedBy: null,
      createdAt: new Date('2026-03-01'),
    });

    it('should apply created_from and created_to date filters', async () => {
      mockPrisma.$transaction.mockResolvedValue([[adminRequest()], 1]);

      const result = await service.findAllForAdmin({
        created_from: '2026-01-01',
        created_to: '2026-12-31',
      });

      expect(result.data).toHaveLength(1);
    });

    it('should apply amount_min filter', async () => {
      mockPrisma.$transaction.mockResolvedValue([[adminRequest()], 1]);

      const result = await service.findAllForAdmin({ amount_min: 100 });

      expect(result.data).toHaveLength(1);
    });

    it('should apply amount_max filter', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.findAllForAdmin({ amount_max: 10 });

      expect(result.data).toHaveLength(0);
    });

    it('should apply search filter on affiliate name/email', async () => {
      mockPrisma.$transaction.mockResolvedValue([[adminRequest()], 1]);

      const result = await service.findAllForAdmin({ search: 'Jane' });

      expect(result.data).toHaveLength(1);
    });

    it('should build a where.OR combining affiliate match and included commission id / invoice number match', async () => {
      mockPrisma.$transaction.mockResolvedValue([[adminRequest()], 1]);

      await service.findAllForAdmin({ search: 'INV-1234' });

      const { where } =
        mockPrisma.affiliatePayoutRequest.findMany.mock.calls[0][0];
      expect(where.OR).toEqual(
        expect.arrayContaining([
          {
            affiliate: {
              OR: [
                { first_name: { contains: 'INV-1234', mode: 'insensitive' } },
                { last_name: { contains: 'INV-1234', mode: 'insensitive' } },
                { email: { contains: 'INV-1234', mode: 'insensitive' } },
              ],
            },
          },
          {
            commissions: {
              some: {
                commission: {
                  OR: [
                    { id: { contains: 'INV-1234', mode: 'insensitive' } },
                    {
                      hubspotInvoiceSnapshot: {
                        OR: [
                          {
                            invoice_number: {
                              contains: 'INV-1234',
                              mode: 'insensitive',
                            },
                          },
                          {
                            hubspot_id: {
                              contains: 'INV-1234',
                              mode: 'insensitive',
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        ]),
      );
    });

    it('should post-filter by risk_flag=duplicate and update total', async () => {
      // Two rows with same affiliate_id to trigger duplicate risk
      const rows = [
        {
          ...adminRequest(),
          affiliate_id: 'affiliate-1',
          createdAt: new Date('2026-03-01'),
        },
        {
          ...adminRequest(),
          affiliate_id: 'affiliate-1',
          createdAt: new Date('2026-03-02'),
        },
      ];
      mockPrisma.$transaction.mockResolvedValue([rows, 2]);

      const result = await service.findAllForAdmin({
        risk_flag: 'duplicate',
      } as any);

      expect(result.pagination.total).toBe(result.data.length);
    });

    it('should post-filter by risk_flag=missing_banking', async () => {
      const row = {
        ...adminRequest(),
        affiliateProfile: { banking_complete: false },
      };
      mockPrisma.$transaction.mockResolvedValue([[row], 1]);

      const result = await service.findAllForAdmin({
        risk_flag: 'missing_banking',
      } as any);

      expect(result.pagination.total).toBe(result.data.length);
    });

    it('should post-filter by risk_flag=aging for old requests', async () => {
      const oldRow = {
        ...adminRequest(),
        createdAt: new Date('2020-01-01'), // definitely older than 14 days
      };
      mockPrisma.$transaction.mockResolvedValue([[oldRow], 1]);

      const result = await service.findAllForAdmin({
        risk_flag: 'aging',
      } as any);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].is_aging).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // startReview (lines 670-700)
  // -------------------------------------------------------------------------
  describe('startReview', () => {
    it('should throw NotFoundException when payout request does not exist', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.startReview('payout-99', mockAdminUser),
      ).rejects.toThrow(new NotFoundException('Payout request not found'));
    });

    it('should throw BadRequestException when status is not "requested"', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue({
        id: 'payout-1',
        status: 'approved',
      });

      await expect(
        service.startReview('payout-1', mockAdminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should update status to "under_review" and return admin-shaped result', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({ id: 'payout-1', status: 'requested' })
        .mockResolvedValueOnce({
          ...makePayoutRequest({ status: 'under_review' }),
          affiliate: {
            id: 'affiliate-1',
            first_name: 'Jane',
            last_name: 'Affiliate',
            email: 'jane@example.com',
          },
          affiliateProfile: null,
          approvedBy: null,
          reviewedBy: null,
        });
      mockPrisma.affiliatePayoutRequest.update.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.startReview('payout-1', mockAdminUser);

      expect(mockPrisma.affiliatePayoutRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'under_review',
            reviewed_by: 'admin-1',
          }),
        }),
      );
      expect(result).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // reopen (lines 953-1010)
  // -------------------------------------------------------------------------
  describe('reopen', () => {
    it('should throw NotFoundException when payout request does not exist', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.reopen('payout-99', 'requested', mockAdminUser),
      ).rejects.toThrow(new NotFoundException('Payout request not found'));
    });

    it('should throw BadRequestException for invalid transition (requested → requested)', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue({
        id: 'payout-1',
        status: 'requested',
        commissions: [],
      });

      await expect(
        service.reopen('payout-1', 'requested', mockAdminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for invalid transition (approved → requested)', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue({
        id: 'payout-1',
        status: 'approved',
        commissions: [],
      });

      await expect(
        service.reopen('payout-1', 'requested', mockAdminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reopen from "under_review" to "requested" and clear reviewed fields', async () => {
      const adminRequest = {
        ...makePayoutRequest({ status: 'requested' }),
        affiliate: {
          id: 'affiliate-1',
          first_name: 'Jane',
          last_name: 'Affiliate',
          email: 'jane@example.com',
        },
        affiliateProfile: null,
        approvedBy: null,
        reviewedBy: null,
      };
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          id: 'payout-1',
          status: 'under_review',
          commissions: [],
        })
        .mockResolvedValueOnce(adminRequest);

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.reopen('payout-1', 'requested', mockAdminUser);

      expect(txMock.affiliatePayoutRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'requested',
            reviewed_by: null,
            reviewed_at: null,
          }),
        }),
      );
    });

    it('should reopen from "rejected" to "requested" and revert commissions', async () => {
      const adminRequest = {
        ...makePayoutRequest({ status: 'requested' }),
        affiliate: {
          id: 'affiliate-1',
          first_name: 'Jane',
          last_name: 'Affiliate',
          email: 'jane@example.com',
        },
        affiliateProfile: null,
        approvedBy: null,
        reviewedBy: null,
      };
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          id: 'payout-1',
          status: 'rejected',
          commissions: [{ commission_id: 'commission-1' }],
        })
        .mockResolvedValueOnce(adminRequest);

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.reopen('payout-1', 'requested', mockAdminUser);

      expect(txMock.affiliateCommission.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['commission-1'] } },
        data: { status: 'requested' },
      });
      expect(txMock.affiliatePayoutRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'requested',
            rejection_reason: null,
          }),
        }),
      );
    });

    it('should reopen from "rejected" to "under_review"', async () => {
      const adminRequest = {
        ...makePayoutRequest({ status: 'under_review' }),
        affiliate: {
          id: 'affiliate-1',
          first_name: 'Jane',
          last_name: 'Affiliate',
          email: 'jane@example.com',
        },
        affiliateProfile: null,
        approvedBy: null,
        reviewedBy: null,
      };
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce({
          id: 'payout-1',
          status: 'rejected',
          commissions: [],
        })
        .mockResolvedValueOnce(adminRequest);

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.reopen('payout-1', 'under_review', mockAdminUser);

      expect(txMock.affiliatePayoutRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'under_review' }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // addNote (lines 1015-1047)
  // -------------------------------------------------------------------------
  describe('addNote', () => {
    const noteDto = {
      type: 'internal',
      content: 'This looks suspicious',
    } as any;

    it('should throw NotFoundException when payout request does not exist', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.addNote('payout-99', noteDto, mockAdminUser),
      ).rejects.toThrow(new NotFoundException('Payout request not found'));
    });

    it('should create and return the note with author name', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue({
        id: 'payout-1',
      });
      (mockPrisma as any).payoutRequestNote = {
        create: jest.fn().mockResolvedValue({
          id: 'note-1',
          type: 'internal',
          content: 'This looks suspicious',
          createdAt: new Date('2026-03-01'),
          author: { id: 'admin-1', first_name: 'Admin', last_name: 'User' },
        }),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      };

      const result = await service.addNote('payout-1', noteDto, mockAdminUser);

      expect((mockPrisma as any).payoutRequestNote.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            payout_request_id: 'payout-1',
            author_user_id: 'admin-1',
            type: 'internal',
            content: 'This looks suspicious',
          }),
        }),
      );
      expect(result.author).toBe('Admin User');
      expect(result.created_at).toBeDefined();
    });

    it('should fall back to "Admin" when author is null', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue({
        id: 'payout-1',
      });
      (mockPrisma as any).payoutRequestNote = {
        create: jest.fn().mockResolvedValue({
          id: 'note-1',
          type: 'internal',
          content: 'Note content',
          createdAt: new Date('2026-03-01'),
          author: null,
        }),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      };

      const result = await service.addNote('payout-1', noteDto, mockAdminUser);

      expect(result.author).toBe('Admin');
    });
  });

  // -------------------------------------------------------------------------
  // getNotes (lines 1052-1082)
  // -------------------------------------------------------------------------
  describe('getNotes', () => {
    it('should throw NotFoundException when payout request does not exist', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(null);

      await expect(service.getNotes('payout-99')).rejects.toThrow(
        new NotFoundException('Payout request not found'),
      );
    });

    it('should return all notes with author names', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue({
        id: 'payout-1',
      });
      (mockPrisma as any).payoutRequestNote = {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'note-1',
            type: 'internal',
            content: 'First note',
            createdAt: new Date('2026-03-01'),
            author: { id: 'admin-1', first_name: 'Admin', last_name: 'User' },
          },
          {
            id: 'note-2',
            type: 'user',
            content: 'Second note',
            createdAt: new Date('2026-03-02'),
            author: null,
          },
        ]),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      };

      const result = await service.getNotes('payout-1');

      expect(result).toHaveLength(2);
      expect(result[0].author).toBe('Admin User');
      expect(result[1].author).toBe('Admin');
    });
  });

  // -------------------------------------------------------------------------
  // getNotesForAffiliates (lines 1087-1117)
  // -------------------------------------------------------------------------
  describe('getNotesForAffiliates', () => {
    it('should throw NotFoundException when payout request does not exist', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(null);

      await expect(service.getNotesForAffiliates('payout-99')).rejects.toThrow(
        new NotFoundException('Payout request not found'),
      );
    });

    it('should return only user-type notes', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue({
        id: 'payout-1',
      });
      (mockPrisma as any).payoutRequestNote = {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'note-1',
            type: 'user',
            content: 'User-visible note',
            createdAt: new Date('2026-03-01'),
            author: { id: 'admin-1', first_name: 'Admin', last_name: 'User' },
          },
        ]),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      };

      const result = await service.getNotesForAffiliates('payout-1');

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('user');
    });
  });

  // -------------------------------------------------------------------------
  // updateNote (lines 1122-1149)
  // -------------------------------------------------------------------------
  describe('updateNote', () => {
    it('should throw NotFoundException when note is not found', async () => {
      (mockPrisma as any).payoutRequestNote = {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        delete: jest.fn(),
      };

      await expect(
        service.updateNote('payout-1', 'note-99', {
          content: 'Updated',
        } as any),
      ).rejects.toThrow(new NotFoundException('Note not found'));
    });

    it('should update and return the note with author name', async () => {
      (mockPrisma as any).payoutRequestNote = {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'note-1', payout_request_id: 'payout-1' }),
        update: jest.fn().mockResolvedValue({
          id: 'note-1',
          type: 'internal',
          content: 'Updated content',
          createdAt: new Date('2026-03-01'),
          author: { id: 'admin-1', first_name: 'Admin', last_name: 'User' },
        }),
        delete: jest.fn(),
      };

      const result = await service.updateNote('payout-1', 'note-1', {
        content: 'Updated content',
      } as any);

      expect((mockPrisma as any).payoutRequestNote.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'note-1' },
          data: { content: 'Updated content' },
        }),
      );
      expect(result.author).toBe('Admin User');
      expect(result.created_at).toBeDefined();
    });

    it('should fall back to "Admin" when updated note author is null', async () => {
      (mockPrisma as any).payoutRequestNote = {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn().mockResolvedValue({ id: 'note-1' }),
        update: jest.fn().mockResolvedValue({
          id: 'note-1',
          type: 'internal',
          content: 'Updated',
          createdAt: new Date(),
          author: null,
        }),
        delete: jest.fn(),
      };

      const result = await service.updateNote('payout-1', 'note-1', {
        content: 'Updated',
      } as any);

      expect(result.author).toBe('Admin');
    });
  });

  // -------------------------------------------------------------------------
  // deleteNote (lines 1154-1161)
  // -------------------------------------------------------------------------
  describe('deleteNote', () => {
    it('should throw NotFoundException when note is not found', async () => {
      (mockPrisma as any).payoutRequestNote = {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        delete: jest.fn(),
      };

      await expect(service.deleteNote('payout-1', 'note-99')).rejects.toThrow(
        new NotFoundException('Note not found'),
      );
    });

    it('should delete the note when found', async () => {
      (mockPrisma as any).payoutRequestNote = {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'note-1', payout_request_id: 'payout-1' }),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
      };

      await service.deleteNote('payout-1', 'note-1');

      expect((mockPrisma as any).payoutRequestNote.delete).toHaveBeenCalledWith(
        {
          where: { id: 'note-1' },
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // getStatusCounts (lines 1206-1224)
  // -------------------------------------------------------------------------
  describe('getStatusCounts', () => {
    it('should return zero counts when no payout requests exist', async () => {
      (mockPrisma.affiliatePayoutRequest as any).groupBy = jest
        .fn()
        .mockResolvedValue([]);

      const result = await service.getStatusCounts();

      expect(result).toEqual({
        requested: 0,
        under_review: 0,
        approved: 0,
        paid: 0,
        rejected: 0,
        cancelled: 0,
        failed: 0,
        processing: 0,
      });
    });

    it('should populate counts from groupBy results', async () => {
      (mockPrisma.affiliatePayoutRequest as any).groupBy = jest
        .fn()
        .mockResolvedValue([
          { status: 'requested', _count: { id: 5 } },
          { status: 'under_review', _count: { id: 2 } },
          { status: 'approved', _count: { id: 3 } },
          { status: 'paid', _count: { id: 10 } },
        ]);

      const result = await service.getStatusCounts();

      expect(result.requested).toBe(5);
      expect(result.under_review).toBe(2);
      expect(result.approved).toBe(3);
      expect(result.paid).toBe(10);
      expect(result.rejected).toBe(0);
      expect(result.cancelled).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // mapCommissionStatus (lines 160, 164-168) — covered via shapeAdminRequest
  // -------------------------------------------------------------------------
  describe('mapCommissionStatus (via findOneForAdmin / findAllForAdmin)', () => {
    const makeAdminRaw = (commissionStatus: string) => ({
      ...makePayoutRequest(),
      affiliate: {
        id: 'affiliate-1',
        first_name: 'Jane',
        last_name: 'Affiliate',
        email: 'jane@example.com',
      },
      affiliateProfile: null,
      approvedBy: null,
      reviewedBy: null,
      commissions: [
        {
          commission: {
            id: 'c-1',
            commission_amount: '150.00',
            base_amount_snapshot: '1000.00',
            commission_percent_snapshot: '15',
            status: commissionStatus,
            admin_decision_reason: null,
            organization: { id: 'org-1', name: 'Acme' },
            hubspotInvoiceSnapshot: null,
          },
        },
      ],
    });

    it('should map "paid" commission status to "approved_for_payout"', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makeAdminRaw('paid'),
      );

      const result = await service.findOneForAdmin('payout-1');

      expect(result.commissions[0].decision).toBe('approved_for_payout');
    });

    it('should map "requested" commission status to "pending_review"', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makeAdminRaw('requested'),
      );

      const result = await service.findOneForAdmin('payout-1');

      expect(result.commissions[0].decision).toBe('pending_review');
    });

    it('should map "eligible" commission status to "pending_review"', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makeAdminRaw('eligible'),
      );

      const result = await service.findOneForAdmin('payout-1');

      expect(result.commissions[0].decision).toBe('pending_review');
    });

    it('should map "rejected" commission status to "rejected_for_payout"', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makeAdminRaw('rejected'),
      );

      const result = await service.findOneForAdmin('payout-1');

      expect(result.commissions[0].decision).toBe('rejected_for_payout');
    });

    it('should map unknown commission status to "pending_review"', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makeAdminRaw('detected'),
      );

      const result = await service.findOneForAdmin('payout-1');

      expect(result.commissions[0].decision).toBe('pending_review');
    });
  });

  // -------------------------------------------------------------------------
  // Regression: commission `created_at` must be selected and mapped through
  // -------------------------------------------------------------------------
  describe('commission created_at (findOneForAdmin)', () => {
    it('should select createdAt on the nested commission so it can be mapped', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makePayoutRequest(),
      );

      await service.findOneForAdmin('payout-1');

      const callArgs =
        mockPrisma.affiliatePayoutRequest.findUnique.mock.calls[0][0];
      expect(
        callArgs.select.commissions.select.commission.select.createdAt,
      ).toBe(true);
    });

    it('should map the commission createdAt into created_at on the response', async () => {
      const commissionCreatedAt = new Date('2026-03-01');
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue({
        ...makePayoutRequest(),
        affiliate: {
          id: 'affiliate-1',
          first_name: 'Jane',
          last_name: 'Affiliate',
          email: 'jane@example.com',
        },
        affiliateProfile: null,
        approvedBy: null,
        reviewedBy: null,
        commissions: [
          {
            commission: {
              id: 'c-1',
              commission_amount: '150.00',
              base_amount_snapshot: '1000.00',
              commission_percent_snapshot: '15',
              status: 'eligible',
              admin_decision_reason: null,
              organization: { id: 'org-1', name: 'Acme' },
              hubspotInvoiceSnapshot: null,
              createdAt: commissionCreatedAt,
            },
          },
        ],
      });

      const result = await service.findOneForAdmin('payout-1');

      expect(result.commissions[0].created_at).toBe(commissionCreatedAt);
    });
  });
});
