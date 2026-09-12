import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminReviewReasonCode, AdminReviewStatus } from '@prisma/client';
import { ReviewCasesService } from './review-cases.service';
import { PrismaService } from '../../prisma/prisma.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockPrisma = {
  medAllianceAdminReviewCase: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  organization: { update: jest.fn() },
  affiliateCommission: { update: jest.fn() },
  hubspotInvoiceSnapshot: { update: jest.fn() },
  medAllianceAuditLog: { create: jest.fn() },
  $transaction: jest.fn(),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const makeCase = (overrides: Partial<any> = {}) => ({
  id: 'case-1',
  organization_id: 'org-1',
  reason_code: AdminReviewReasonCode.multiple_hubspot_matches,
  status: AdminReviewStatus.open,
  metadata: null,
  resolved_by_id: null,
  resolved_at: null,
  resolution: null,
  createdAt: new Date('2026-03-01'),
  updatedAt: new Date('2026-03-01'),
  organization: {
    id: 'org-1',
    name: 'Acme Corp',
    email: null,
    hubspot_id: null,
    med_alliance_referral_status: 'eligible',
    hubspot_sync_status: null,
    referredByAffiliate: null,
  },
  resolvedBy: null,
  ...overrides,
});

describe('ReviewCasesService', () => {
  let service: ReviewCasesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewCasesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ReviewCasesService>(ReviewCasesService);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // openOrSkip
  // -------------------------------------------------------------------------
  describe('openOrSkip', () => {
    it('should create a review case and return { opened: true }', async () => {
      mockPrisma.medAllianceAdminReviewCase.create.mockResolvedValue({});

      const result = await service.openOrSkip(
        'org-1',
        AdminReviewReasonCode.multiple_hubspot_matches,
      );

      expect(result).toEqual({ opened: true });
      expect(mockPrisma.medAllianceAdminReviewCase.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organization_id: 'org-1',
            reason_code: AdminReviewReasonCode.multiple_hubspot_matches,
            status: AdminReviewStatus.open,
          }),
        }),
      );
    });

    it('should return { opened: false } on P2002 (duplicate open case)', async () => {
      const uniqueError = Object.assign(new Error('Unique constraint'), {
        code: 'P2002',
      });
      mockPrisma.medAllianceAdminReviewCase.create.mockRejectedValue(
        uniqueError,
      );

      const result = await service.openOrSkip(
        'org-1',
        AdminReviewReasonCode.multiple_hubspot_matches,
      );

      expect(result).toEqual({ opened: false });
    });

    it('should rethrow non-P2002 errors', async () => {
      mockPrisma.medAllianceAdminReviewCase.create.mockRejectedValue(
        new Error('DB failure'),
      );

      await expect(
        service.openOrSkip(
          'org-1',
          AdminReviewReasonCode.multiple_hubspot_matches,
        ),
      ).rejects.toThrow('DB failure');
    });

    it('should store metadata when provided', async () => {
      mockPrisma.medAllianceAdminReviewCase.create.mockResolvedValue({});

      await service.openOrSkip(
        'org-1',
        AdminReviewReasonCode.soft_duplicate_referral,
        {
          matched_organization_id: 'org-2',
        },
      );

      expect(mockPrisma.medAllianceAdminReviewCase.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: { matched_organization_id: 'org-2' },
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // findAll
  // -------------------------------------------------------------------------
  describe('findAll', () => {
    it('should return paginated cases', async () => {
      mockPrisma.$transaction.mockResolvedValue([[makeCase()], 1]);

      const result = await service.findAll({});

      expect(result.data).toHaveLength(1);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1 });
    });

    it('should filter by status', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.findAll({ status: 'resolved' });

      expect(result.data).toHaveLength(0);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('should filter by reason_code', async () => {
      mockPrisma.$transaction.mockResolvedValue([[makeCase()], 1]);

      const result = await service.findAll({
        reason_code: 'multiple_hubspot_matches',
      });

      expect(result.data).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // findOne
  // -------------------------------------------------------------------------
  describe('findOne', () => {
    it('should throw NotFoundException when case does not exist', async () => {
      mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(null);

      await expect(service.findOne('non-existent')).rejects.toThrow(
        new NotFoundException('Review case not found'),
      );
    });

    it('should return the case when found', async () => {
      mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(
        makeCase(),
      );

      const result = await service.findOne('case-1');

      expect(result.id).toBe('case-1');
    });
  });

  // -------------------------------------------------------------------------
  // resolve
  // -------------------------------------------------------------------------
  describe('resolve', () => {
    it('should throw BadRequestException when case is already resolved', async () => {
      mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(
        makeCase({ status: AdminReviewStatus.resolved }),
      );

      await expect(
        service.resolve('case-1', 'admin-1', { resolution: 'Done' }),
      ).rejects.toThrow(
        new BadRequestException('Review case is already resolved'),
      );
    });

    it('should close the case with resolved status and resolution note', async () => {
      mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(
        makeCase(),
      );
      mockPrisma.medAllianceAdminReviewCase.update.mockResolvedValue(
        makeCase({ status: AdminReviewStatus.resolved }),
      );

      await service.resolve('case-1', 'admin-1', {
        resolution: 'Handled manually',
      });

      expect(mockPrisma.medAllianceAdminReviewCase.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: AdminReviewStatus.resolved,
            resolved_by_id: 'admin-1',
            resolution: 'Handled manually',
          }),
        }),
      );
    });

    it('should set org.hubspot_id when resolving multiple_hubspot_matches with hubspot_company_id', async () => {
      mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(
        makeCase(),
      );
      mockPrisma.organization.update.mockResolvedValue({});
      mockPrisma.medAllianceAdminReviewCase.update.mockResolvedValue({});

      await service.resolve('case-1', 'admin-1', {
        resolution: 'Set correct company',
        hubspot_company_id: 'hs-company-99',
      });

      expect(mockPrisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'org-1' },
          data: expect.objectContaining({
            hubspot_id: 'hs-company-99',
            hubspot_sync_status: 'synced',
          }),
        }),
      );
    });

    it('should not update org when resolving multiple_hubspot_matches without hubspot_company_id', async () => {
      mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(
        makeCase(),
      );
      mockPrisma.medAllianceAdminReviewCase.update.mockResolvedValue({});

      await service.resolve('case-1', 'admin-1', {
        resolution: 'Will handle later',
      });

      expect(mockPrisma.organization.update).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // multiple_hubspot_matches — med_alliance_referral_status guard
    // -----------------------------------------------------------------------
    describe('multiple_hubspot_matches status guard', () => {
      it('should NOT include med_alliance_referral_status in the update when org is already eligible', async () => {
        mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(
          makeCase({
            organization: {
              id: 'org-1',
              med_alliance_referral_status: 'eligible',
            },
          }),
        );
        mockPrisma.organization.update.mockResolvedValue({});
        mockPrisma.medAllianceAdminReviewCase.update.mockResolvedValue({});

        await service.resolve('case-1', 'admin-1', {
          resolution: 'Set correct company',
          hubspot_company_id: 'hs-company-99',
        });

        const updateData = mockPrisma.organization.update.mock.calls[0][0].data;
        expect(updateData).not.toHaveProperty('med_alliance_referral_status');
        expect(updateData).toEqual(
          expect.objectContaining({
            hubspot_id: 'hs-company-99',
            hubspot_sync_status: 'synced',
          }),
        );
      });

      it('should NOT include med_alliance_referral_status in the update when org is expired', async () => {
        mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(
          makeCase({
            organization: {
              id: 'org-1',
              med_alliance_referral_status: 'expired',
            },
          }),
        );
        mockPrisma.organization.update.mockResolvedValue({});
        mockPrisma.medAllianceAdminReviewCase.update.mockResolvedValue({});

        await service.resolve('case-1', 'admin-1', {
          resolution: 'Set correct company',
          hubspot_company_id: 'hs-company-99',
        });

        const updateData = mockPrisma.organization.update.mock.calls[0][0].data;
        expect(updateData).not.toHaveProperty('med_alliance_referral_status');
      });

      it('should set med_alliance_referral_status to pending_confirmation when org is pending_confirmation', async () => {
        mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(
          makeCase({
            organization: {
              id: 'org-1',
              med_alliance_referral_status: 'pending_confirmation',
            },
          }),
        );
        mockPrisma.organization.update.mockResolvedValue({});
        mockPrisma.medAllianceAdminReviewCase.update.mockResolvedValue({});

        await service.resolve('case-1', 'admin-1', {
          resolution: 'Set correct company',
          hubspot_company_id: 'hs-company-99',
        });

        expect(mockPrisma.organization.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              med_alliance_referral_status: 'pending_confirmation',
            }),
          }),
        );
      });

      it('should set med_alliance_referral_status to pending_confirmation when org is not_eligible (un-block)', async () => {
        mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(
          makeCase({
            organization: {
              id: 'org-1',
              med_alliance_referral_status: 'not_eligible',
            },
          }),
        );
        mockPrisma.organization.update.mockResolvedValue({});
        mockPrisma.medAllianceAdminReviewCase.update.mockResolvedValue({});

        await service.resolve('case-1', 'admin-1', {
          resolution: 'Set correct company',
          hubspot_company_id: 'hs-company-99',
        });

        expect(mockPrisma.organization.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              med_alliance_referral_status: 'pending_confirmation',
            }),
          }),
        );
      });
    });

    it('should void commission and clear sync_hash on void_and_recreate action', async () => {
      const reconCase = makeCase({
        reason_code: AdminReviewReasonCode.reconciliation_invoice_changed,
        metadata: { commission_id: 'comm-1', snapshot_id: 'snap-1' },
      });
      mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(
        reconCase,
      );
      mockPrisma.affiliateCommission.update.mockResolvedValue({});
      mockPrisma.hubspotInvoiceSnapshot.update.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});
      mockPrisma.medAllianceAdminReviewCase.update.mockResolvedValue({});

      await service.resolve('case-1', 'admin-1', {
        resolution: 'Voided and reset for re-detection',
        action: 'void_and_recreate',
      });

      expect(mockPrisma.affiliateCommission.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'comm-1' },
          data: { status: 'void' },
        }),
      );
      expect(mockPrisma.hubspotInvoiceSnapshot.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'snap-1' },
          data: { sync_hash: '' },
        }),
      );
    });

    it('should not modify commission on keep_existing action', async () => {
      const reconCase = makeCase({
        reason_code: AdminReviewReasonCode.reconciliation_invoice_changed,
        metadata: { commission_id: 'comm-1', snapshot_id: 'snap-1' },
      });
      mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(
        reconCase,
      );
      mockPrisma.medAllianceAdminReviewCase.update.mockResolvedValue({});

      await service.resolve('case-1', 'admin-1', {
        resolution: 'Keep as-is',
        action: 'keep_existing',
      });

      expect(mockPrisma.affiliateCommission.update).not.toHaveBeenCalled();
      expect(mockPrisma.hubspotInvoiceSnapshot.update).not.toHaveBeenCalled();
    });

    it('should write audit log entry on void_and_recreate', async () => {
      const reconCase = makeCase({
        reason_code: AdminReviewReasonCode.reconciliation_invoice_changed,
        metadata: { commission_id: 'comm-1', snapshot_id: 'snap-1' },
      });
      mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(
        reconCase,
      );
      mockPrisma.affiliateCommission.update.mockResolvedValue({});
      mockPrisma.hubspotInvoiceSnapshot.update.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});
      mockPrisma.medAllianceAdminReviewCase.update.mockResolvedValue({});

      await service.resolve('case-1', 'admin-1', {
        resolution: 'Voided',
        action: 'void_and_recreate',
      });

      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entity_type: 'commission',
            entity_id: 'comm-1',
            event: 'voided_by_reconciliation',
            new_status: 'void',
            source: 'admin_action',
          }),
        }),
      );
    });

    it('should handle void_and_recreate gracefully when metadata has no commission_id', async () => {
      const reconCase = makeCase({
        reason_code: AdminReviewReasonCode.reconciliation_invoice_changed,
        metadata: null,
      });
      mockPrisma.medAllianceAdminReviewCase.findUnique.mockResolvedValue(
        reconCase,
      );
      mockPrisma.medAllianceAdminReviewCase.update.mockResolvedValue({});

      // Should not throw even with null metadata
      await expect(
        service.resolve('case-1', 'admin-1', {
          resolution: 'Handled',
          action: 'void_and_recreate',
        }),
      ).resolves.not.toThrow();

      expect(mockPrisma.affiliateCommission.update).not.toHaveBeenCalled();
    });
  });
});
