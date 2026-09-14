import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BillComPayoutService } from './bill-com-payout.service';
import { BillComService } from './bill-com.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AllianceNotificationsService } from '../notifications/notifications.service';

const mockBillComService = {
  createBillAndPayment: jest.fn(),
};

const mockAllianceNotifications: Partial<AllianceNotificationsService> = {
  notifyPayoutPaid: jest.fn(),
  notifyAdminPaymentFailed: jest.fn(),
};

const mockPrisma = {
  affiliatePayoutRequest: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  affiliateProfile: {
    findUnique: jest.fn(),
  },
  affiliateCommission: {
    updateMany: jest.fn(),
  },
  medAllianceAuditLog: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockAdminUser = {
  id: 'admin-1',
  first_name: 'Admin',
  last_name: 'User',
  email: 'admin@medvirtual.ai',
} as any;

describe('BillComPayoutService', () => {
  let service: BillComPayoutService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillComPayoutService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: BillComService, useValue: mockBillComService },
        {
          provide: AllianceNotificationsService,
          useValue: mockAllianceNotifications,
        },
      ],
    }).compile();

    service = module.get<BillComPayoutService>(BillComPayoutService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createBillAndPaymentForMarkPaid', () => {
    it('threads adminUser.id into billComService.createBillAndPayment', async () => {
      mockBillComService.createBillAndPayment.mockResolvedValue({
        paymentId: 'pay-1',
        billId: 'bill-1',
        status: 'SCHEDULED',
        confirmationNumber: 'conf-1',
        transactionNumber: 'txn-1',
      });

      const payload = {
        vendorId: 'vendor-1',
        affiliateName: 'Jane Affiliate',
        affiliateEmail: 'jane@example.com',
        amount: 150,
        today: '2026-06-01',
      };

      await service.createBillAndPaymentForMarkPaid(
        payload,
        mockAdminUser,
        'payout-1',
      );

      expect(mockBillComService.createBillAndPayment).toHaveBeenCalledWith(
        'admin-1',
        expect.objectContaining({
          vendorId: 'vendor-1',
          amount: 150,
          processDate: '2026-06-01',
        }),
      );
    });
  });

  describe('initiatePayment', () => {
    const makeRequest = (overrides: Partial<any> = {}) => ({
      id: 'payout-1',
      status: 'approved',
      approved_amount: '150.00',
      requested_amount: '150.00',
      commissions: [{ commission_id: 'commission-1' }],
      ...overrides,
    });

    const makeProfile = () => ({
      status: 'active',
      contact: { hubspot_billcom_vendor_id: 'vendor-1' },
      user: {
        first_name: 'Jane',
        last_name: 'Affiliate',
        email: 'jane@example.com',
        contact: null,
      },
    });

    it('throws NotFoundException when payout request does not exist', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.initiatePayment('payout-99', mockAdminUser),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when payout is not in a payable status', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique.mockResolvedValue(
        makeRequest({ status: 'paid' }),
      );

      await expect(
        service.initiatePayment('payout-1', mockAdminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('threads adminUser.id into billComService.createBillAndPayment and persists the result', async () => {
      mockPrisma.affiliatePayoutRequest.findUnique
        .mockResolvedValueOnce(makeRequest()) // initiatePayment's own lookup
        .mockResolvedValueOnce(makeRequest()) // validateAndPreparePayment's lookup
        .mockResolvedValueOnce({
          // findOneForAdmin's lookup at the end
          ...makeRequest({ status: 'processing' }),
          commissions: [
            {
              commission: {
                id: 'commission-1',
                commission_amount: '150.00',
                base_amount_snapshot: '150.00',
                commission_percent_snapshot: '10',
                status: 'paid',
                admin_decision_reason: null,
                organization: { id: 'org-1', name: 'Acme' },
                hubspotInvoiceSnapshot: null,
              },
            },
          ],
        });
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockBillComService.createBillAndPayment.mockResolvedValue({
        paymentId: 'pay-1',
        billId: 'bill-1',
        status: 'SCHEDULED',
        confirmationNumber: 'conf-1',
        transactionNumber: 'txn-1',
      });

      const txMock = {
        affiliatePayoutRequest: { update: jest.fn().mockResolvedValue({}) },
        affiliateCommission: { updateMany: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await service.initiatePayment('payout-1', mockAdminUser);

      expect(mockBillComService.createBillAndPayment).toHaveBeenCalledWith(
        'admin-1',
        expect.objectContaining({ vendorId: 'vendor-1', amount: 150 }),
      );
      expect(txMock.affiliatePayoutRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'processing',
            bill_com_billId: 'bill-1',
          }),
        }),
      );
    });
  });
});
