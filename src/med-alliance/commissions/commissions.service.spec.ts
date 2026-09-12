import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CommissionsService } from './commissions.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AllianceNotificationsService } from '../notifications/notifications.service';

const mockAllianceNotifications: Partial<AllianceNotificationsService> = {
  notifyCommissionEligible: jest.fn(),
  notifyAdminCommissionReverted: jest.fn(),
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockPrisma = {
  affiliateCommission: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  organization: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  affiliateProfile: {
    findUnique: jest.fn(),
  },
  hubspotInvoiceSnapshot: {
    findUnique: jest.fn(),
  },
  medAllianceAuditLog: {
    create: jest.fn(),
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
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

const makeCommission = (overrides: Partial<any> = {}) => ({
  id: 'commission-1',
  affiliate_id: 'affiliate-1',
  affiliate_profile_id: 'profile-1',
  organization_id: 'org-1',
  hubspot_invoice_snapshot_id: 'snap-1',
  commission_percent_snapshot: '10.00',
  base_amount_snapshot: '1500.00',
  commission_amount: '150.00',
  status: 'detected',
  admin_decision_by: null,
  admin_decision_reason: null,
  admin_decision_at: null,
  createdAt: new Date('2026-02-15'),
  updatedAt: new Date('2026-02-15'),
  organization: { id: 'org-1', name: 'Acme Corp' },
  hubspotInvoiceSnapshot: {
    id: 'snap-1',
    hubspot_id: 'hs-inv-1',
    invoice_amount: '1500.00',
    currency: 'USD',
    paid_at: new Date('2026-02-10'),
  },
  ...overrides,
});

describe('CommissionsService', () => {
  let service: CommissionsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommissionsService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: AllianceNotificationsService,
          useValue: mockAllianceNotifications,
        },
      ],
    }).compile();

    service = module.get<CommissionsService>(CommissionsService);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // findAllForAffiliate
  // -------------------------------------------------------------------------
  describe('findAllForAffiliate', () => {
    it('should return paginated commissions scoped to the current affiliate', async () => {
      mockPrisma.$transaction.mockResolvedValue([[makeCommission()], 1]);

      const result = await service.findAllForAffiliate({}, mockAffiliateUser);

      expect(result.data).toHaveLength(1);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1 });
    });

    it('should apply status filter', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.findAllForAffiliate(
        { status: 'eligible' as any },
        mockAffiliateUser,
      );

      expect(result.data).toHaveLength(0);
    });

    it('should apply created_from and created_to date range', async () => {
      mockPrisma.$transaction.mockResolvedValue([[makeCommission()], 1]);

      const result = await service.findAllForAffiliate(
        { created_from: '2026-01-01', created_to: '2026-12-31' },
        mockAffiliateUser,
      );

      expect(result.data).toHaveLength(1);
    });

    it('should respect custom pagination', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.findAllForAffiliate(
        { page: 2, limit: 5 },
        mockAffiliateUser,
      );

      expect(result.pagination).toEqual({ page: 2, limit: 5, total: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // findOneForAffiliate
  // -------------------------------------------------------------------------
  describe('findOneForAffiliate', () => {
    it('should throw NotFoundException when commission does not exist', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(null);

      await expect(
        service.findOneForAffiliate('commission-99', mockAffiliateUser),
      ).rejects.toThrow(new NotFoundException('Commission not found'));
    });

    it('should throw ForbiddenException when commission belongs to another affiliate', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({ affiliate_id: 'other-user' }),
      );

      await expect(
        service.findOneForAffiliate('commission-1', mockAffiliateUser),
      ).rejects.toThrow(
        new ForbiddenException('You do not have access to this commission'),
      );
    });

    it('should return commission when it belongs to the current affiliate', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission(),
      );

      const result = await service.findOneForAffiliate(
        'commission-1',
        mockAffiliateUser,
      );

      expect(result.id).toBe('commission-1');
      expect(result.affiliate_id).toBe('affiliate-1');
    });
  });

  // -------------------------------------------------------------------------
  // findAllForAdmin
  // -------------------------------------------------------------------------
  describe('findAllForAdmin', () => {
    it('should return all commissions without affiliate scoping', async () => {
      const commissionWithAffiliate = {
        ...makeCommission(),
        affiliate: {
          id: 'affiliate-1',
          first_name: 'Jane',
          last_name: 'Affiliate',
          email: 'jane@example.com',
        },
        adminDecisionBy: null,
      };
      mockPrisma.$transaction.mockResolvedValue([[commissionWithAffiliate], 1]);

      const result = await service.findAllForAdmin({});

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toHaveProperty('affiliate');
    });

    it('should filter by organization_id when provided', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.findAllForAdmin({
        organization_id: 'org-99',
      });

      expect(result.data).toHaveLength(0);
    });

    it('should filter by affiliate_id when provided', async () => {
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
    it('should throw NotFoundException when commission does not exist', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(null);

      await expect(service.findOneForAdmin('commission-99')).rejects.toThrow(
        new NotFoundException('Commission not found'),
      );
    });

    it('should return commission with affiliate and adminDecisionBy details', async () => {
      const fullCommission = {
        ...makeCommission({ status: 'eligible', admin_decision_by: 'admin-1' }),
        affiliate: {
          id: 'affiliate-1',
          first_name: 'Jane',
          last_name: 'Affiliate',
          email: 'jane@example.com',
        },
        adminDecisionBy: {
          id: 'admin-1',
          first_name: 'Admin',
          last_name: 'User',
        },
      };
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        fullCommission,
      );

      const result = await service.findOneForAdmin('commission-1');

      expect(result.status).toBe('eligible');
      expect(result.adminDecisionBy!.id).toBe('admin-1');
    });

    it('should select paid_amount and transaction_reference on the linked payout request', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission(),
      );

      await service.findOneForAdmin('commission-1');

      const call = mockPrisma.affiliateCommission.findUnique.mock.calls[0][0];
      const payoutRequestSelect =
        call.select.payoutRequestCommissions.select.payoutRequest.select;

      expect(payoutRequestSelect.paid_amount).toBe(true);
      expect(payoutRequestSelect.transaction_reference).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // decide
  // -------------------------------------------------------------------------
  describe('decide', () => {
    it('should throw NotFoundException when commission does not exist', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(null);

      await expect(
        service.decide(
          'commission-99',
          { decision: 'eligible' },
          mockAdminUser,
        ),
      ).rejects.toThrow(new NotFoundException('Commission not found'));
    });

    it('should throw BadRequestException when commission is in a non-decidable status', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({ status: 'paid' }),
      );

      await expect(
        service.decide('commission-1', { decision: 'eligible' }, mockAdminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should approve a commission in "pending_admin_confirmation" status when org is eligible', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({ status: 'pending_admin_confirmation' }),
      );
      // MA-004: org is eligible — approval should proceed
      mockPrisma.organization.findUnique.mockResolvedValue({
        med_alliance_referral_status: 'eligible',
      });
      const updated = makeCommission({
        status: 'eligible',
        admin_decision_by: 'admin-1',
      });
      mockPrisma.affiliateCommission.update.mockResolvedValue(updated);
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.decide(
        'commission-1',
        { decision: 'eligible' },
        mockAdminUser,
      );

      expect(result.status).toBe('eligible');
      expect(mockPrisma.affiliateCommission.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'eligible',
            admin_decision_by: 'admin-1',
            admin_decision_at: expect.any(Date),
          }),
        }),
      );
    });

    it('should throw BadRequestException when commission is in "detected" status (no longer decidable)', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({ status: 'detected' }),
      );

      await expect(
        service.decide('commission-1', { decision: 'eligible' }, mockAdminUser),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.affiliateCommission.update).not.toHaveBeenCalled();
    });

    it('should reject a commission and persist reason', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({ status: 'pending_admin_confirmation' }),
      );
      // MA-004 guard is skipped for rejections — no org lookup needed
      const updated = makeCommission({
        status: 'rejected',
        admin_decision_by: 'admin-1',
        admin_decision_reason: 'Invoice reversed',
      });
      mockPrisma.affiliateCommission.update.mockResolvedValue(updated);
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.decide(
        'commission-1',
        { decision: 'rejected', reason: 'Invoice reversed' },
        mockAdminUser,
      );

      expect(result.status).toBe('rejected');
      expect(result.admin_decision_reason).toBe('Invoice reversed');
      // Guard should not run for rejections
      expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
    });

    it('should write an audit log entry after a decision', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({ status: 'pending_admin_confirmation' }),
      );
      mockPrisma.organization.findUnique.mockResolvedValue({
        med_alliance_referral_status: 'eligible',
      });
      mockPrisma.affiliateCommission.update.mockResolvedValue(
        makeCommission({ status: 'eligible' }),
      );
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.decide(
        'commission-1',
        { decision: 'eligible' },
        mockAdminUser,
      );

      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entity_type: 'commission',
            entity_id: 'commission-1',
            event: 'admin_decision',
            old_status: 'pending_admin_confirmation',
            new_status: 'eligible',
            source: 'admin_action',
            actor_user_id: 'admin-1',
          }),
        }),
      );
    });

    // -----------------------------------------------------------------------
    // MA-004 guard tests
    // -----------------------------------------------------------------------
    describe('MA-004 guard — active client block', () => {
      it('should throw BadRequestException when approving a commission from a blocked org', async () => {
        mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
          makeCommission({ status: 'pending_admin_confirmation' }),
        );
        mockPrisma.organization.findUnique.mockResolvedValue({
          med_alliance_referral_status: 'not_eligible',
        });

        await expect(
          service.decide(
            'commission-1',
            { decision: 'eligible' },
            mockAdminUser,
          ),
        ).rejects.toThrow(
          new BadRequestException(
            'Cannot approve commission: referred organization is not eligible for the Med Alliance program.',
          ),
        );
        // Commission should NOT be updated
        expect(mockPrisma.affiliateCommission.update).not.toHaveBeenCalled();
      });

      it('should allow rejection even when org is blocked as active client', async () => {
        mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
          makeCommission({ status: 'pending_admin_confirmation' }),
        );
        // Guard is skipped for decision === 'rejected' — no org lookup
        const updated = makeCommission({
          status: 'rejected',
          admin_decision_reason: 'blocked org',
        });
        mockPrisma.affiliateCommission.update.mockResolvedValue(updated);
        mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

        const result = await service.decide(
          'commission-1',
          { decision: 'rejected', reason: 'blocked org' },
          mockAdminUser,
        );

        expect(result.status).toBe('rejected');
        expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
      });

      it('should skip the org guard when commission has no organization_id', async () => {
        mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
          makeCommission({
            status: 'pending_admin_confirmation',
            organization_id: null,
          }),
        );
        mockPrisma.organization.findUnique.mockResolvedValue(null);
        const updated = makeCommission({ status: 'eligible' });
        mockPrisma.affiliateCommission.update.mockResolvedValue(updated);
        mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

        const result = await service.decide(
          'commission-1',
          { decision: 'eligible' },
          mockAdminUser,
        );

        expect(result.status).toBe('eligible');
        expect(mockPrisma.affiliateCommission.update).toHaveBeenCalled();
      });

      it('should allow approval when org has null med_alliance_referral_status (no check run yet)', async () => {
        mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
          makeCommission({ status: 'pending_admin_confirmation' }),
        );
        mockPrisma.organization.findUnique.mockResolvedValue({
          med_alliance_referral_status: null,
        });
        const updated = makeCommission({ status: 'eligible' });
        mockPrisma.affiliateCommission.update.mockResolvedValue(updated);
        mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

        const result = await service.decide(
          'commission-1',
          { decision: 'eligible' },
          mockAdminUser,
        );

        expect(result.status).toBe('eligible');
      });
    });
  });

  // -------------------------------------------------------------------------
  // void
  // -------------------------------------------------------------------------
  describe('void', () => {
    it('should throw NotFoundException when commission does not exist', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(null);

      await expect(
        service.void('commission-99', { reason: 'test' }, mockAdminUser),
      ).rejects.toThrow(new NotFoundException('Commission not found'));
    });

    it.each(['paid', 'void', 'rejected'])(
      'should throw BadRequestException when commission is already in terminal status "%s"',
      async (status) => {
        mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
          makeCommission({ status }),
        );

        await expect(
          service.void('commission-1', { reason: 'test' }, mockAdminUser),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it.each([
      'detected',
      'pending_admin_confirmation',
      'eligible',
      'requested',
    ])(
      'should void a commission in non-terminal status "%s"',
      async (status) => {
        mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
          makeCommission({ status }),
        );
        const updated = makeCommission({
          status: 'void',
          admin_decision_by: 'admin-1',
        });
        mockPrisma.affiliateCommission.update.mockResolvedValue(updated);
        mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

        const result = await service.void(
          'commission-1',
          { reason: 'Invoice was reversed' },
          mockAdminUser,
        );

        expect(result.status).toBe('void');
        expect(mockPrisma.affiliateCommission.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: 'void',
              admin_decision_reason: 'Invoice was reversed',
            }),
          }),
        );
      },
    );

    it('should write audit log with status_changed event when voiding', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({ status: 'eligible' }),
      );
      mockPrisma.affiliateCommission.update.mockResolvedValue(
        makeCommission({ status: 'void' }),
      );
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.void(
        'commission-1',
        { reason: 'Cancelled' },
        mockAdminUser,
      );

      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: 'status_changed',
            old_status: 'eligible',
            new_status: 'void',
            reason: 'Cancelled',
            source: 'admin_action',
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // getAuditLog
  // -------------------------------------------------------------------------
  describe('getAuditLog', () => {
    it('should throw NotFoundException when commission does not exist', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(null);

      await expect(service.getAuditLog('commission-99')).rejects.toThrow(
        new NotFoundException('Commission not found'),
      );
    });

    it('should return audit entries ordered chronologically', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue({
        id: 'commission-1',
      });

      const auditEntries = [
        {
          id: 'log-1',
          event: 'status_changed',
          old_status: null,
          new_status: 'detected',
          source: 'sync',
          createdAt: new Date('2026-02-01'),
          actorUser: null,
        },
        {
          id: 'log-2',
          event: 'admin_decision',
          old_status: 'detected',
          new_status: 'eligible',
          source: 'admin_action',
          createdAt: new Date('2026-02-02'),
          actorUser: { id: 'admin-1', first_name: 'Admin', last_name: 'User' },
        },
      ];
      mockPrisma.medAllianceAuditLog.findMany.mockResolvedValue(auditEntries);

      const result = await service.getAuditLog('commission-1');

      expect(result).toHaveLength(2);
      expect(result[0].event).toBe('status_changed');
      expect(result[1].event).toBe('admin_decision');
      expect(mockPrisma.medAllianceAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { entity_type: 'commission', entity_id: 'commission-1' },
          orderBy: { createdAt: 'asc' },
        }),
      );
    });

    it('should return empty array when no audit entries exist', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue({
        id: 'commission-1',
      });
      mockPrisma.medAllianceAuditLog.findMany.mockResolvedValue([]);

      const result = await service.getAuditLog('commission-1');

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // revertToPending
  // -------------------------------------------------------------------------
  describe('revertToPending', () => {
    it('should throw NotFoundException when commission does not exist', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(null);

      await expect(
        service.revertToPending('commission-99', mockAdminUser),
      ).rejects.toThrow(new NotFoundException('Commission not found'));
    });

    it.each([
      'detected',
      'pending_admin_confirmation',
      'rejected',
      'void',
      'paid',
    ])(
      'should throw BadRequestException when commission is in non-eligible status "%s"',
      async (status) => {
        mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
          makeCommission({ status }),
        );

        await expect(
          service.revertToPending('commission-1', mockAdminUser),
        ).rejects.toThrow(BadRequestException);
        expect(mockPrisma.affiliateCommission.update).not.toHaveBeenCalled();
      },
    );

    it('should revert commission from "eligible" to "pending_admin_confirmation"', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({ status: 'eligible', admin_decision_by: 'admin-1' }),
      );
      const updated = makeCommission({
        status: 'pending_admin_confirmation',
        admin_decision_by: null,
        admin_decision_reason: null,
        admin_decision_at: null,
      });
      mockPrisma.affiliateCommission.update.mockResolvedValue(updated);
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.revertToPending(
        'commission-1',
        mockAdminUser,
      );

      expect(result.status).toBe('pending_admin_confirmation');
      expect(result.admin_decision_by).toBeNull();
      expect(mockPrisma.affiliateCommission.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'pending_admin_confirmation',
            admin_decision_by: null,
            admin_decision_reason: null,
            admin_decision_at: null,
          }),
        }),
      );
    });

    it('should write audit log with event "admin_reverted_to_pending"', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({ status: 'eligible' }),
      );
      mockPrisma.affiliateCommission.update.mockResolvedValue(
        makeCommission({ status: 'pending_admin_confirmation' }),
      );
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.revertToPending('commission-1', mockAdminUser);

      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: 'admin_reverted_to_pending',
            old_status: 'eligible',
            new_status: 'pending_admin_confirmation',
            source: 'admin_action',
            actor_user_id: 'admin-1',
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // unvoid
  // -------------------------------------------------------------------------
  describe('unvoid', () => {
    it('should throw NotFoundException when commission does not exist', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(null);

      await expect(
        service.unvoid('commission-99', { reason: 'mistake' }, mockAdminUser),
      ).rejects.toThrow(new NotFoundException('Commission not found'));
    });

    it.each([
      'detected',
      'pending_admin_confirmation',
      'eligible',
      'rejected',
      'paid',
    ])(
      'should throw BadRequestException when commission is in non-void status "%s"',
      async (status) => {
        mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
          makeCommission({ status }),
        );

        await expect(
          service.unvoid('commission-1', { reason: 'mistake' }, mockAdminUser),
        ).rejects.toThrow(BadRequestException);
        expect(mockPrisma.affiliateCommission.update).not.toHaveBeenCalled();
      },
    );

    it('should restore to "pending_admin_confirmation" when org is eligible', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({
          status: 'void',
          organization: {
            id: 'org-1',
            name: 'Acme Corp',
            med_alliance_referral_status: 'eligible',
          },
        }),
      );
      const updated = makeCommission({ status: 'pending_admin_confirmation' });
      mockPrisma.affiliateCommission.update.mockResolvedValue(updated);
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.unvoid(
        'commission-1',
        { reason: 'mistake' },
        mockAdminUser,
      );

      expect(result.status).toBe('pending_admin_confirmation');
      expect(mockPrisma.affiliateCommission.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'pending_admin_confirmation',
          }),
        }),
      );
    });

    it('should restore to "detected" when org is not_eligible', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({
          status: 'void',
          organization: {
            id: 'org-1',
            name: 'Acme Corp',
            med_alliance_referral_status: 'not_eligible',
          },
        }),
      );
      const updated = makeCommission({ status: 'detected' });
      mockPrisma.affiliateCommission.update.mockResolvedValue(updated);
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.unvoid(
        'commission-1',
        { reason: 'mistake' },
        mockAdminUser,
      );

      expect(result.status).toBe('detected');
      expect(mockPrisma.affiliateCommission.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'detected' }),
        }),
      );
    });

    it('should restore to "detected" when commission has no org (null)', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({ status: 'void', organization: null }),
      );
      const updated = makeCommission({ status: 'detected' });
      mockPrisma.affiliateCommission.update.mockResolvedValue(updated);
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.unvoid(
        'commission-1',
        { reason: 'mistake' },
        mockAdminUser,
      );

      expect(result.status).toBe('detected');
    });

    it('should write audit log with event "admin_unvoided"', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({
          status: 'void',
          organization: {
            id: 'org-1',
            name: 'Acme Corp',
            med_alliance_referral_status: 'eligible',
          },
        }),
      );
      mockPrisma.affiliateCommission.update.mockResolvedValue(
        makeCommission({ status: 'pending_admin_confirmation' }),
      );
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.unvoid(
        'commission-1',
        { reason: 'mistake' },
        mockAdminUser,
      );

      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: 'admin_unvoided',
            old_status: 'void',
            new_status: 'pending_admin_confirmation',
            reason: 'mistake',
            source: 'admin_action',
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // updateBaseAmount
  // -------------------------------------------------------------------------
  describe('updateBaseAmount', () => {
    it('should throw NotFoundException when commission does not exist', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(null);

      await expect(
        service.updateBaseAmount(
          'commission-99',
          { base_amount: '2000' },
          mockAdminUser,
        ),
      ).rejects.toThrow(new NotFoundException('Commission not found'));
    });

    it.each(['eligible', 'rejected', 'void', 'paid', 'requested'])(
      'should throw BadRequestException when commission is in non-editable status "%s"',
      async (status) => {
        mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
          makeCommission({ status }),
        );

        await expect(
          service.updateBaseAmount(
            'commission-1',
            { base_amount: '2000' },
            mockAdminUser,
          ),
        ).rejects.toThrow(BadRequestException);
        expect(mockPrisma.affiliateCommission.update).not.toHaveBeenCalled();
      },
    );

    it.each(['detected', 'pending_admin_confirmation'])(
      'should update base_amount and recalculate commission for status "%s"',
      async (status) => {
        mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
          makeCommission({
            status,
            commission_percent_snapshot: '10.00',
            base_amount_snapshot: '1500.00',
          }),
        );
        const updated = makeCommission({
          status,
          base_amount_snapshot: '2000.00',
          commission_amount: '200.00',
        });
        mockPrisma.affiliateCommission.update.mockResolvedValue(updated);
        mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

        const result = await service.updateBaseAmount(
          'commission-1',
          { base_amount: '2000' },
          mockAdminUser,
        );

        expect(result.base_amount_snapshot).toBe('2000.00');
        expect(result.commission_amount).toBe('200.00');
        expect(mockPrisma.affiliateCommission.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              base_amount_snapshot: '2000',
              commission_amount: '200.00',
            }),
          }),
        );
      },
    );

    it('should throw BadRequestException when base_amount is not a positive number', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({ status: 'detected' }),
      );

      await expect(
        service.updateBaseAmount(
          'commission-1',
          { base_amount: '-500' },
          mockAdminUser,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when base_amount is zero', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({ status: 'detected' }),
      );

      await expect(
        service.updateBaseAmount(
          'commission-1',
          { base_amount: '0' },
          mockAdminUser,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should write audit log with old and new amounts', async () => {
      mockPrisma.affiliateCommission.findUnique.mockResolvedValue(
        makeCommission({
          status: 'detected',
          commission_percent_snapshot: '10.00',
          base_amount_snapshot: '1500.00',
        }),
      );
      mockPrisma.affiliateCommission.update.mockResolvedValue(
        makeCommission({ status: 'detected' }),
      );
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.updateBaseAmount(
        'commission-1',
        { base_amount: '2000' },
        mockAdminUser,
      );

      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: 'admin_updated_base_amount',
            source: 'admin_action',
            metadata: expect.objectContaining({
              old_base_amount: '1500.00',
              new_base_amount: '2000',
            }),
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // createFromInvoices
  // -------------------------------------------------------------------------
  describe('createFromInvoices', () => {
    const makeProfile = (overrides: Partial<any> = {}) => ({
      id: 'profile-1',
      user_id: 'affiliate-1',
      status: 'active',
      commission_percent_default: '10.00',
      ...overrides,
    });

    const makeSnapshot = (overrides: Partial<any> = {}) => ({
      id: 'snap-1',
      hubspot_id: 'hs-inv-1',
      organization_id: 'org-1',
      invoice_status: 'paid',
      invoice_amount: '1500.00',
      payment_status: null,
      paid_at: new Date('2026-02-10'),
      ...overrides,
    });

    const makeOrg = (overrides: Partial<any> = {}) => ({
      id: 'org-1',
      referred_by_affiliate_id: 'affiliate-1',
      med_alliance_block_reason: null,
      med_alliance_referral_status: 'pending_confirmation',
      eligibility_start_at: null,
      first_paid_invoice_at: new Date('2026-01-15'),
      referral_stage: 'deployed',
      createdAt: new Date('2025-01-01'),
      ...overrides,
    });

    it('should throw NotFoundException when affiliate profile does not exist', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.createFromInvoices('profile-1', ['snap-1'], mockAdminUser),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when affiliate profile is not active', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(
        makeProfile({ status: 'inactive' }),
      );

      await expect(
        service.createFromInvoices('profile-1', ['snap-1'], mockAdminUser),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when affiliate profile has no connected user', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(
        makeProfile({ user_id: null }),
      );

      await expect(
        service.createFromInvoices('profile-1', ['snap-1'], mockAdminUser),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should skip an invoice snapshot that does not exist', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);

      const result = await service.createFromInvoices(
        'profile-1',
        ['snap-missing'],
        mockAdminUser,
      );

      expect(result).toEqual({ created: 0, skipped: 1 });
    });

    it('should skip an invoice that fails re-validation (not paid)', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        makeSnapshot({ invoice_status: 'open' }),
      );

      const result = await service.createFromInvoices(
        'profile-1',
        ['snap-1'],
        mockAdminUser,
      );

      expect(result).toEqual({ created: 0, skipped: 1 });
      expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
    });

    it('should skip when org is not found or not referred by this affiliate', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        makeSnapshot(),
      );
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ referred_by_affiliate_id: 'someone-else' }),
      );

      const result = await service.createFromInvoices(
        'profile-1',
        ['snap-1'],
        mockAdminUser,
      );

      expect(result).toEqual({ created: 0, skipped: 1 });
    });

    it('should skip when org has an active_client_block reason (MA-004)', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        makeSnapshot(),
      );
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({
          med_alliance_block_reason:
            'active_client_block: organization_active_by_email',
        }),
      );

      const result = await service.createFromInvoices(
        'profile-1',
        ['snap-1'],
        mockAdminUser,
      );

      expect(result).toEqual({ created: 0, skipped: 1 });
      expect(mockPrisma.affiliateCommission.create).not.toHaveBeenCalled();
    });

    it('should skip (read-only) when org status is expired — no inline write', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        makeSnapshot(),
      );
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ med_alliance_referral_status: 'expired' }),
      );

      const result = await service.createFromInvoices(
        'profile-1',
        ['snap-1'],
        mockAdminUser,
      );

      expect(result).toEqual({ created: 0, skipped: 1 });
      // Expiry is read-only here — this file never writes med_alliance_referral_status itself.
      expect(mockPrisma.organization.update).not.toHaveBeenCalled();
      expect(mockPrisma.affiliateCommission.create).not.toHaveBeenCalled();
    });

    it('should skip when org referral_stage is canceled', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        makeSnapshot(),
      );
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ referral_stage: 'canceled' }),
      );

      const result = await service.createFromInvoices(
        'profile-1',
        ['snap-1'],
        mockAdminUser,
      );

      expect(result).toEqual({ created: 0, skipped: 1 });
    });

    it('should transition org to deployed with a raw (no-offset) eligibility_start_at on first paid invoice', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      const snapshot = makeSnapshot({ paid_at: new Date('2026-03-01') });
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(snapshot);
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({
          first_paid_invoice_at: null,
          referral_stage: 'contract_signed',
        }),
      );
      mockPrisma.organization.update.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});
      mockPrisma.affiliateCommission.create.mockResolvedValue({
        id: 'comm-new',
      });

      await service.createFromInvoices('profile-1', ['snap-1'], mockAdminUser);

      expect(mockPrisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'org-1' },
          data: {
            referral_stage: 'deployed',
            eligibility_start_at: new Date('2026-03-01'),
            first_paid_invoice_at: new Date('2026-03-01'),
            med_alliance_block_reason: null,
          },
        }),
      );
    });

    it('should NOT transition to deployed when org already has first_paid_invoice_at', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        makeSnapshot(),
      );
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateCommission.create.mockResolvedValue({
        id: 'comm-new',
      });
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.createFromInvoices('profile-1', ['snap-1'], mockAdminUser);

      expect(mockPrisma.organization.update).not.toHaveBeenCalled();
    });

    it('should create a commission as pending_admin_confirmation and write an audit log', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        makeSnapshot(),
      );
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateCommission.create.mockResolvedValue({
        id: 'comm-new',
      });
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.createFromInvoices(
        'profile-1',
        ['snap-1'],
        mockAdminUser,
      );

      expect(result).toEqual({ created: 1, skipped: 0 });
      expect(mockPrisma.affiliateCommission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            affiliate_id: 'affiliate-1',
            affiliate_profile_id: 'profile-1',
            organization_id: 'org-1',
            hubspot_invoice_snapshot_id: 'snap-1',
            status: 'pending_admin_confirmation',
          }),
        }),
      );
      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: 'manual_commission_created',
            new_status: 'pending_admin_confirmation',
            source: 'admin_action',
          }),
        }),
      );
    });

    it('should count as skipped when commission creation hits a P2002 unique constraint', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
        makeSnapshot(),
      );
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      const uniqueError = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
      });
      mockPrisma.affiliateCommission.create.mockRejectedValue(uniqueError);

      const result = await service.createFromInvoices(
        'profile-1',
        ['snap-1'],
        mockAdminUser,
      );

      expect(result).toEqual({ created: 0, skipped: 1 });
    });

    it('should count as skipped and continue when commission creation fails with a non-P2002 error', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.hubspotInvoiceSnapshot.findUnique
        .mockResolvedValueOnce(
          makeSnapshot({ id: 'snap-1', hubspot_id: 'hs-inv-1' }),
        )
        .mockResolvedValueOnce(
          makeSnapshot({ id: 'snap-2', hubspot_id: 'hs-inv-2' }),
        );
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.affiliateCommission.create
        .mockRejectedValueOnce(new Error('DB connection lost'))
        .mockResolvedValueOnce({ id: 'comm-2' });
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.createFromInvoices(
        'profile-1',
        ['snap-1', 'snap-2'],
        mockAdminUser,
      );

      expect(result).toEqual({ created: 1, skipped: 1 });
    });
  });
});
