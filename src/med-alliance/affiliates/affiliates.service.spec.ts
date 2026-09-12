import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AffiliatesService } from './affiliates.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { AffiliateCreationService } from '../../hubspot/create/affiliate';
import { AffiliateUpdateService } from '../../hubspot/update/affiliate';
import { HubspotService } from '../../hubspot/hubspot.service';
import { InvoiceIngestionService } from '../sync/invoice-ingestion.service';
import { AllianceNotificationsService } from '../notifications/notifications.service';
import { EmailTemplatesService } from '../../email-templates/email-templates.service';

const mockAllianceNotifications: Partial<AllianceNotificationsService> = {
  notifyAdminPartnerRegistered: jest.fn(),
};

// ---------------------------------------------------------------------------
// Prisma mock — only the tables touched by AffiliatesService
// ---------------------------------------------------------------------------
const mockPrisma = {
  affiliateProfile: {
    findUnique: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  uSER: {
    findUnique: jest.fn(),
  },
  affiliatePayoutRequest: {
    aggregate: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  affiliateCommission: {
    aggregate: jest.fn(),
    groupBy: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
  },
  organization: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  hubspotInvoiceSnapshot: {
    findMany: jest.fn(),
  },
  medAllianceAuditLog: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockMailService = {
  sendMail: jest.fn(),
};

const mockAffiliateCreationService = {
  execute: jest.fn(),
};

const mockAffiliateUpdateService = {
  deactivate: jest.fn(),
};

const mockHubspotService = {
  setCompanyAffiliateReferral: jest.fn(),
};

const mockInvoiceIngestionService = {
  run: jest.fn(),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const mockUser = {
  id: 'user-1',
  first_name: 'John',
  last_name: 'Doe',
  email: 'john@example.com',
  organization_id: 'org-1',
  role: 'organization_admin',
  status: 'active',
};

const mockAdminUser = {
  id: 'admin-1',
  first_name: 'Admin',
  last_name: 'User',
  email: 'admin@example.com',
  role: 'system_admin',
  status: 'active',
} as any;

const mockProfile = {
  id: 'profile-1',
  user_id: 'user-1',
  hubspot_id: null,
  commission_percent_default: '10.00',
  status: 'active',
  payout_preference_method: 'ach',
  payout_preference_reference: null,
  payout_preference_notes: null,
  created_by: 'admin-1',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  user: mockUser,
  payout_details: {
    billcom_vendor_id: null,
  },
  banking_complete: false,
};

describe('AffiliatesService', () => {
  let service: AffiliatesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AffiliatesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MailService, useValue: { sendMail: jest.fn() } },
        {
          provide: AffiliateCreationService,
          useValue: mockAffiliateCreationService,
        },
        {
          provide: AffiliateUpdateService,
          useValue: mockAffiliateUpdateService,
        },
        { provide: HubspotService, useValue: mockHubspotService },
        {
          provide: InvoiceIngestionService,
          useValue: mockInvoiceIngestionService,
        },
        {
          provide: AllianceNotificationsService,
          useValue: mockAllianceNotifications,
        },
        {
          provide: EmailTemplatesService,
          useValue: { getTemplateContent: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get<AffiliatesService>(AffiliatesService);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // requireActiveProfile
  // -------------------------------------------------------------------------
  describe('requireActiveProfile', () => {
    it('should throw ForbiddenException when profile does not exist', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(null);

      await expect(service.requireActiveProfile('user-1')).rejects.toThrow(
        new ForbiddenException('Affiliate profile not found'),
      );
    });

    it('should throw ForbiddenException when profile is inactive', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        status: 'inactive',
      });

      await expect(service.requireActiveProfile('user-1')).rejects.toThrow(
        new ForbiddenException('Affiliate profile is inactive'),
      );
    });

    it('should return the profile when active', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);

      const result = await service.requireActiveProfile('user-1');

      expect(result).toEqual(mockProfile);
      expect(mockPrisma.affiliateProfile.findUnique).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
      });
    });
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------
  describe('create', () => {
    const createDto = {
      user_id: 'user-1',
      commission_percent_default: 10,
      payout_preference_method: undefined,
      payout_preference_reference: undefined,
      payout_preference_notes: undefined,
      hubspot_id: undefined,
    } as any;

    it('should throw NotFoundException when target user does not exist', async () => {
      mockPrisma.uSER.findUnique.mockResolvedValue(null);

      await expect(service.create(createDto, mockAdminUser)).rejects.toThrow(
        new NotFoundException('User not found'),
      );
    });

    it('should throw ConflictException when profile already exists', async () => {
      mockPrisma.uSER.findUnique.mockResolvedValue(mockUser);
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);

      await expect(service.create(createDto, mockAdminUser)).rejects.toThrow(
        new ConflictException('This user already has an affiliate profile'),
      );
    });

    it('should create and return a new profile', async () => {
      mockPrisma.uSER.findUnique.mockResolvedValue(mockUser);
      // 1st call: conflict check → no existing profile
      // 2nd call: inside findOne after create → return the created profile
      mockPrisma.affiliateProfile.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockProfile);
      mockPrisma.affiliateProfile.create.mockResolvedValue(mockProfile);

      const result = await service.create(createDto, mockAdminUser);

      expect(result).toEqual(mockProfile);
      expect(mockPrisma.affiliateProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            user_id: 'user-1',
            commission_percent_default: 10,
            created_by: 'admin-1',
          }),
        }),
      );
    });

    it('should request the welcome email template with {{firstName}} (not {{partnerName}}) so the greeting is never literal "Hello, {{firstName}}!"', async () => {
      mockPrisma.uSER.findUnique.mockResolvedValue(mockUser);
      mockPrisma.affiliateProfile.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockProfile);
      mockPrisma.affiliateProfile.create.mockResolvedValue(mockProfile);

      const emailTemplates = (service as any).emailTemplates;

      await service.create(createDto, mockAdminUser);

      expect(emailTemplates.getTemplateContent).toHaveBeenCalledWith(
        'med-alliance-invitation',
        expect.objectContaining({ '{{firstName}}': mockUser.first_name }),
        expect.anything(),
      );
      const [, runtimeValues] = (emailTemplates.getTemplateContent as jest.Mock)
        .mock.calls[0];
      expect(runtimeValues).not.toHaveProperty('{{partnerName}}');
    });
  });

  // -------------------------------------------------------------------------
  // findAll
  // -------------------------------------------------------------------------
  describe('findAll', () => {
    it('should return paginated profiles with default params', async () => {
      mockPrisma.$transaction.mockResolvedValue([[mockProfile], 1]);

      const result = await service.findAll({});

      expect(result).toEqual({
        data: [mockProfile],
        pagination: { page: 1, limit: 20, total: 1 },
      });
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('should apply status filter', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      await service.findAll({ status: 'inactive' as any });

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('should apply search filter', async () => {
      mockPrisma.$transaction.mockResolvedValue([[mockProfile], 1]);

      const result = await service.findAll({ search: 'john' });

      expect(result.data).toHaveLength(1);
    });

    it('should respect custom page and limit', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.findAll({ page: 2, limit: 5 });

      expect(result.pagination).toEqual({ page: 2, limit: 5, total: 0 });
    });

    it('should not apply an AND clause when payable is omitted', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      await service.findAll({});

      const findManyArgs =
        mockPrisma.affiliateProfile.findMany.mock.calls[0][0];
      expect(findManyArgs.where.AND).toBeUndefined();
    });

    it('should apply payable filter with eligible commissions and vendor id conditions', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      await service.findAll({ payable: true });

      const findManyArgs =
        mockPrisma.affiliateProfile.findMany.mock.calls[0][0];
      const countArgs = mockPrisma.affiliateProfile.count.mock.calls[0][0];

      expect(findManyArgs.where.AND).toContainEqual({
        commissions: { some: { status: 'eligible' } },
      });
      expect(findManyArgs.where.AND).toContainEqual({
        OR: [
          { contact: { hubspot_billcom_vendor_id: { not: null } } },
          { user: { contact: { hubspot_billcom_vendor_id: { not: null } } } },
        ],
      });
      expect(countArgs.where.AND).toEqual(findManyArgs.where.AND);
    });

    it('should combine payable with search without dropping either filter', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      await service.findAll({ payable: true, search: 'jane' });

      const findManyArgs =
        mockPrisma.affiliateProfile.findMany.mock.calls[0][0];

      expect(findManyArgs.where.AND).toContainEqual({
        OR: [
          { full_name: { contains: 'jane', mode: 'insensitive' } },
          { user: { email: { contains: 'jane', mode: 'insensitive' } } },
        ],
      });
      expect(findManyArgs.where.AND).toContainEqual({
        commissions: { some: { status: 'eligible' } },
      });
    });
  });

  // -------------------------------------------------------------------------
  // findOne
  // -------------------------------------------------------------------------
  describe('findOne', () => {
    it('should throw NotFoundException when profile does not exist', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(null);

      await expect(service.findOne('profile-99')).rejects.toThrow(
        new NotFoundException('Affiliate profile not found'),
      );
    });

    it('should return the profile when found', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);

      const result = await service.findOne('profile-1');

      expect(result).toEqual(mockProfile);
      expect(mockPrisma.affiliateProfile.findUnique).toHaveBeenCalledWith({
        where: { id: 'profile-1' },
        include: expect.any(Object),
      });
    });

    it('should select the hubspot invoice snapshot relation for commissions', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);

      await service.findOne('profile-1');

      const callArg = mockPrisma.affiliateProfile.findUnique.mock.calls[0][0];
      expect(callArg.include.commissions.select).toEqual(
        expect.objectContaining({
          hubspot_invoice_snapshot_id: true,
          hubspotInvoiceSnapshot: {
            select: { hubspot_id: true, invoice_number: true },
          },
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // findOneEnriched
  // -------------------------------------------------------------------------
  describe('findOneEnriched', () => {
    const mixedStatusPayouts = [
      {
        id: 'payout-21',
        status: 'requested',
        paid_amount: null,
        paid_at: null,
        payment_method: null,
        transaction_reference: null,
        requested_amount: '100.00',
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `payout-${i}`,
        status: 'paid',
        paid_amount: '50.00',
        paid_at: new Date('2026-01-01'),
        payment_method: 'ach',
        transaction_reference: `ref-${i}`,
        requested_amount: '50.00',
      })),
    ];

    it('should return empty payout history when affiliate has no connected user', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        user_id: null,
      });

      const result = await service.findOneEnriched('profile-1');

      expect(result.payoutHistory).toEqual([]);
      expect(mockPrisma.affiliatePayoutRequest.findMany).not.toHaveBeenCalled();
    });

    it('should return the full payout history across all statuses, uncapped', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      mockPrisma.affiliatePayoutRequest.aggregate.mockResolvedValue({
        _sum: { requested_amount: 0 },
      });
      mockPrisma.affiliateCommission.aggregate.mockResolvedValue({
        _sum: { commission_amount: 0 },
      });
      mockPrisma.affiliatePayoutRequest.findMany.mockResolvedValue(
        mixedStatusPayouts,
      );
      mockPrisma.affiliateCommission.groupBy.mockResolvedValue([]);

      const result = await service.findOneEnriched('profile-1');

      // Reproduces the bug: the old query capped at 20 and filtered to
      // status: 'paid' only, so a 21-item mixed-status list would have been
      // truncated to 20 paid-only rows. The fix must return all 21.
      expect(result.payoutHistory).toHaveLength(21);
      expect(
        result.payoutHistory.some((pr: any) => pr.status === 'requested'),
      ).toBe(true);
    });

    it('should query payout requests without a status filter or take cap, ordered by createdAt desc', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      mockPrisma.affiliatePayoutRequest.aggregate.mockResolvedValue({
        _sum: { requested_amount: 0 },
      });
      mockPrisma.affiliateCommission.aggregate.mockResolvedValue({
        _sum: { commission_amount: 0 },
      });
      mockPrisma.affiliatePayoutRequest.findMany.mockResolvedValue([]);
      mockPrisma.affiliateCommission.groupBy.mockResolvedValue([]);

      await service.findOneEnriched('profile-1');

      expect(mockPrisma.affiliatePayoutRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { affiliate_id: 'user-1' },
          orderBy: { createdAt: 'desc' },
          select: expect.objectContaining({ status: true }),
        }),
      );
      const callArgs =
        mockPrisma.affiliatePayoutRequest.findMany.mock.calls[0][0];
      expect(callArgs.take).toBeUndefined();
      expect(callArgs.where.status).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getMyStats
  // -------------------------------------------------------------------------
  describe('getMyStats', () => {
    beforeEach(() => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      mockPrisma.affiliateCommission.aggregate.mockResolvedValue({
        _sum: { commission_amount: '0' },
      });
      mockPrisma.affiliatePayoutRequest.aggregate.mockResolvedValue({
        _sum: { requested_amount: '0' },
      });
      mockPrisma.affiliatePayoutRequest.findFirst.mockResolvedValue(null);
    });

    it('should join the hubspot invoice snapshot and expose invoice_number/invoice_hubspot_id', async () => {
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        {
          id: 'commission-1',
          organization_id: 'org-1',
          organization: { id: 'org-1', name: 'Acme Health' },
          hubspot_invoice_snapshot_id: 'snapshot-uuid-1',
          hubspotInvoiceSnapshot: {
            hubspot_id: '545991805202',
            invoice_number: 'INV-1234',
          },
          base_amount_snapshot: '1000.00',
          commission_percent_snapshot: '10.00',
          commission_amount: '100.00',
          status: 'eligible',
          createdAt: new Date('2026-01-01'),
        },
      ]);

      const result = await service.getMyStats(mockUser as any);

      const findManyArgs =
        mockPrisma.affiliateCommission.findMany.mock.calls[0][0];
      expect(findManyArgs.include).toEqual(
        expect.objectContaining({
          hubspotInvoiceSnapshot: {
            select: { hubspot_id: true, invoice_number: true },
          },
        }),
      );

      expect(result.recent_commissions[0]).toEqual(
        expect.objectContaining({
          invoice_number: 'INV-1234',
          invoice_hubspot_id: '545991805202',
        }),
      );
      expect(result.recent_commissions[0]).not.toHaveProperty('invoice_id');
    });

    it('should return null invoice fields when no snapshot is joined', async () => {
      mockPrisma.affiliateCommission.findMany.mockResolvedValue([
        {
          id: 'commission-2',
          organization_id: 'org-1',
          organization: { id: 'org-1', name: 'Acme Health' },
          hubspot_invoice_snapshot_id: 'snapshot-uuid-2',
          hubspotInvoiceSnapshot: null,
          base_amount_snapshot: '500.00',
          commission_percent_snapshot: '10.00',
          commission_amount: '50.00',
          status: 'eligible',
          createdAt: new Date('2026-01-02'),
        },
      ]);

      const result = await service.getMyStats(mockUser as any);

      expect(result.recent_commissions[0]).toEqual(
        expect.objectContaining({
          invoice_number: null,
          invoice_hubspot_id: null,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------
  describe('update', () => {
    it('should throw NotFoundException when profile does not exist', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(null);

      await expect(service.update('profile-99', {})).rejects.toThrow(
        new NotFoundException('Affiliate profile not found'),
      );
    });

    it('should update commission_percent_default', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      const updated = { ...mockProfile, commission_percent_default: '15.00' };
      mockPrisma.affiliateProfile.update.mockResolvedValue(updated);

      const result = await service.update('profile-1', {
        commission_percent_default: 15,
      });

      expect(result.commission_percent_default).toBe('15.00');
      expect(mockPrisma.affiliateProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'profile-1' },
          data: expect.objectContaining({ commission_percent_default: 15 }),
        }),
      );
    });

    it('should update status to inactive', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      const updated = { ...mockProfile, status: 'inactive' };
      mockPrisma.affiliateProfile.update.mockResolvedValue(updated);

      const result = await service.update('profile-1', {
        status: 'inactive' as any,
      });

      expect(result.status).toBe('inactive');
    });

    it('should not set undefined fields in the update data', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      mockPrisma.affiliateProfile.update.mockResolvedValue(mockProfile);

      await service.update('profile-1', {
        payout_preference_method: undefined,
      });

      expect(mockPrisma.affiliateProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({
            payout_preference_method: undefined,
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // findOwn
  // -------------------------------------------------------------------------
  describe('findOwn', () => {
    it('should throw NotFoundException when affiliate has no profile', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(null);

      await expect(service.findOwn(mockUser as any)).rejects.toThrow(
        new NotFoundException('Affiliate profile not found'),
      );
    });

    it('should return own profile', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);

      const result = await service.findOwn(mockUser as any);

      expect(result).toEqual(mockProfile);
      expect(mockPrisma.affiliateProfile.findUnique).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
        include: expect.any(Object),
      });
    });
  });

  // -------------------------------------------------------------------------
  // updateOwn
  // -------------------------------------------------------------------------
  describe('updateOwn', () => {
    it('should throw ForbiddenException when profile is inactive', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        status: 'inactive',
      });

      await expect(
        service.updateOwn(mockUser as any, {
          payout_preference_method: 'wire' as any,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should update payout preferences', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      const updated = {
        ...mockProfile,
        payout_preference_method: 'wire',
        payout_preference_reference: 'ACC-001',
      };
      mockPrisma.affiliateProfile.update.mockResolvedValue(updated);

      const result = await service.updateOwn(mockUser as any, {
        payout_preference_method: 'wire' as any,
        payout_preference_reference: 'ACC-001',
      });

      expect(result.payout_preference_method).toBe('wire');
      expect(result.payout_preference_reference).toBe('ACC-001');
    });

    it('should not allow updating commission_percent_default via updateOwn', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      mockPrisma.affiliateProfile.update.mockResolvedValue(mockProfile);

      // commission_percent_default is not a field in UpdateAffiliatePayoutPreferencesDto
      // so passing it should not affect the update call
      await service.updateOwn(mockUser as any, {} as any);

      expect(mockPrisma.affiliateProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({
            commission_percent_default: expect.anything(),
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // previewAssociation
  // -------------------------------------------------------------------------
  describe('previewAssociation', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

    const mockPreviewProfile = {
      commission_percent_default:
        new (require('@prisma/client/runtime/library').Decimal)('10.00'),
    };

    const baseOrg = {
      id: 'org-1',
      name: 'Acme Health',
      status: 'active',
      email: 'contact@acme.com',
      industry: null,
      location: null,
      hubspot_id: 'hs-org-1',
      contact_first_name: 'Jane',
      contact_last_name: 'Doe',
      contact_email: 'jane@acme.com',
      med_alliance_referral_status: null,
      eligibility_start_at: null,
      first_paid_invoice_at: null,
      deployment_date: null,
    };

    const paidInvoice = (overrides: any = {}) => ({
      id: 'inv-' + Math.random().toString(36).slice(2),
      hubspot_id: 'hs-inv',
      invoice_amount: new (require('@prisma/client/runtime/library').Decimal)(
        '100.00',
      ),
      invoice_status: 'paid',
      payment_status: null,
      currency: 'USD',
      paid_at: null,
      createdAt: daysAgo(50),
      hubspot_pdf_link: null,
      ...overrides,
    });

    beforeEach(() => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(
        mockPreviewProfile,
      );
    });

    it('should mark pending with full count when paid invoices have paid_at null (bug repro)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        ...baseOrg,
        deployment_date: null,
      });
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        paidInvoice({ createdAt: daysAgo(50) }),
        paidInvoice({ createdAt: daysAgo(48) }),
        paidInvoice({ createdAt: daysAgo(45) }),
        paidInvoice({ createdAt: daysAgo(40) }),
      ]);

      const result = await service.previewAssociation('profile-1', 'org-1');

      // The 3-tier window (no_invoices/too_new/eligible/expired) is gone — anything within
      // 365 days lands on the single 'pending' tier now (decisions are available immediately).
      expect(result.projection.eligibility_window).toBe('pending');
      expect(result.projection.commission_status).toBe('detected');
      expect(result.projection.projected_commission_count).toBe(4);
    });

    it('should remain pending with full count when paid_at is resolved (regression guard)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        ...baseOrg,
        deployment_date: null,
      });
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        paidInvoice({ paid_at: daysAgo(50), createdAt: daysAgo(50) }),
        paidInvoice({ paid_at: daysAgo(48), createdAt: daysAgo(48) }),
        paidInvoice({ paid_at: daysAgo(45), createdAt: daysAgo(45) }),
        paidInvoice({ paid_at: daysAgo(40), createdAt: daysAgo(40) }),
      ]);

      const result = await service.previewAssociation('profile-1', 'org-1');

      expect(result.projection.eligibility_window).toBe('pending');
      expect(result.projection.projected_commission_count).toBe(4);
    });

    it('should mark pending even when deployment is very recent (no more too_new tier)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        ...baseOrg,
        deployment_date: daysAgo(2),
      });
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        paidInvoice({ paid_at: daysAgo(2), createdAt: daysAgo(2) }),
      ]);

      const result = await service.previewAssociation('profile-1', 'org-1');

      expect(result.projection.eligibility_window).toBe('pending');
      expect(result.projection.commission_status).toBe('detected');
      expect(result.projection.projected_commission_count).toBe(1);
    });

    it('should exclude zero-amount invoices from projected count', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        ...baseOrg,
        deployment_date: null,
      });
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        paidInvoice({ createdAt: daysAgo(50) }),
        paidInvoice({
          invoice_amount:
            new (require('@prisma/client/runtime/library').Decimal)('0.00'),
          createdAt: daysAgo(48),
        }),
      ]);

      const result = await service.previewAssociation('profile-1', 'org-1');

      expect(result.projection.projected_commission_count).toBe(1);
    });

    it('should exclude invoices with failed payment_status', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        ...baseOrg,
        deployment_date: null,
      });
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        paidInvoice({ createdAt: daysAgo(50) }),
        paidInvoice({ payment_status: 'failed', createdAt: daysAgo(48) }),
      ]);

      const result = await service.previewAssociation('profile-1', 'org-1');

      expect(result.projection.projected_commission_count).toBe(1);
    });

    it('should return no_invoices when there are no invoices and no deployment_date', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        ...baseOrg,
        deployment_date: null,
      });
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([]);

      const result = await service.previewAssociation('profile-1', 'org-1');

      expect(result.projection.eligibility_window).toBe('no_invoices');
      expect(result.projection.commission_status).toBeNull();
      expect(result.projection.projected_commission_count).toBe(0);
    });

    it('should anchor on deployment_date when no invoice has resolved paid_at', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        ...baseOrg,
        deployment_date: daysAgo(50),
      });
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        paidInvoice({ paid_at: null, createdAt: daysAgo(10) }),
      ]);

      const result = await service.previewAssociation('profile-1', 'org-1');

      expect(result.projection.eligibility_window).toBe('pending');
    });

    it('should report 0 projected commissions and an empty invoice list when eligibility window is expired', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        ...baseOrg,
        deployment_date: daysAgo(400),
      });
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        paidInvoice({ paid_at: daysAgo(400), createdAt: daysAgo(400) }),
        paidInvoice({ paid_at: daysAgo(390), createdAt: daysAgo(390) }),
      ]);

      const result = await service.previewAssociation('profile-1', 'org-1');

      expect(result.projection.eligibility_window).toBe('expired');
      expect(result.projection.commission_status).toBeNull();
      expect(result.projection.projected_commission_count).toBe(0);
      expect(result.invoices).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // associateCompany / _backfillOnAssociation
  // -------------------------------------------------------------------------
  describe('associateCompany', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
    const Decimal = require('@prisma/client/runtime/library').Decimal;

    const mockProfile = {
      id: 'profile-1',
      user_id: 'affiliate-user-1',
      status: 'active',
      commission_percent_default: new Decimal('10.00'),
    };

    const paidSnapshot = (overrides: any = {}) => ({
      id: 'snap-' + Math.random().toString(36).slice(2),
      hubspot_id: 'hs-inv-' + Math.random().toString(36).slice(2),
      invoice_amount: new Decimal('1500.00'),
      payment_status: null,
      paid_at: daysAgo(10),
      ...overrides,
    });

    beforeEach(() => {
      mockPrisma.organization.update.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});
      mockPrisma.affiliateCommission.create.mockResolvedValue({});
      mockInvoiceIngestionService.run.mockResolvedValue(undefined);
      mockHubspotService.setCompanyAffiliateReferral.mockResolvedValue(
        undefined,
      );
    });

    it('should throw NotFoundException when affiliate profile does not exist', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.associateCompany('profile-1', 'org-1', mockAdminUser),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when affiliate has no connected user', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        user_id: null,
      });

      await expect(
        service.associateCompany('profile-1', 'org-1', mockAdminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when organization does not exist', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      mockPrisma.organization.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.associateCompany('profile-1', 'org-1', mockAdminUser),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when org already has an affiliate referral', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: 'org-1',
        referred_by_affiliate_id: 'someone-else',
      });

      await expect(
        service.associateCompany('profile-1', 'org-1', mockAdminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should set status to pending_confirmation (no 30-day tier) and anchor eligibility_start_at on the raw anchor date', async () => {
      mockPrisma.affiliateProfile.findUnique
        .mockResolvedValueOnce(mockProfile) // outer profile lookup
        .mockResolvedValueOnce(mockProfile); // inner lookup in _backfillOnAssociation
      mockPrisma.organization.findUnique
        .mockResolvedValueOnce({ id: 'org-1', referred_by_affiliate_id: null }) // ownership check
        .mockResolvedValueOnce({
          hubspot_id: 'hs-org-1',
          deployment_date: null,
        }); // backfill lookup
      const anchorDate = daysAgo(10);
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        paidSnapshot({ paid_at: anchorDate }),
      ]);
      mockPrisma.affiliateProfile.count = jest.fn();

      // findOne() is called at the end — stub whatever it needs minimally via findUnique.
      mockPrisma.affiliateProfile.findUnique.mockResolvedValueOnce(mockProfile);

      await service
        .associateCompany('profile-1', 'org-1', mockAdminUser)
        .catch(() => {});

      expect(mockPrisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'org-1' },
        }),
      );
      const updateCallArgs = mockPrisma.organization.update.mock.calls.find(
        (c: any) => c[0].data?.med_alliance_referral_status,
      );
      expect(updateCallArgs[0].data).toEqual(
        expect.objectContaining({
          referral_stage: 'deployed',
          eligibility_start_at: anchorDate,
          med_alliance_block_reason: null,
          med_alliance_referral_status: 'pending_confirmation',
        }),
      );
    });

    it('should mark expired and skip commission backfill when anchor date is more than 365 days ago', async () => {
      const oldAnchor = daysAgo(400);
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      mockPrisma.organization.findUnique
        .mockResolvedValueOnce({ id: 'org-1', referred_by_affiliate_id: null })
        .mockResolvedValueOnce({
          hubspot_id: 'hs-org-1',
          deployment_date: oldAnchor,
        });
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        paidSnapshot({ paid_at: oldAnchor }),
      ]);

      await service
        .associateCompany('profile-1', 'org-1', mockAdminUser)
        .catch(() => {});

      const updateCallArgs = mockPrisma.organization.update.mock.calls.find(
        (c: any) => c[0].data?.med_alliance_referral_status,
      );
      expect(updateCallArgs[0].data).toEqual(
        expect.objectContaining({ med_alliance_referral_status: 'expired' }),
      );
      // No commission backfill once expired.
      expect(mockPrisma.affiliateCommission.create).not.toHaveBeenCalled();
    });

    it('should always backfill commissions as "detected" (never pending_admin_confirmation) when not expired', async () => {
      const anchorDate = daysAgo(5);
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      mockPrisma.organization.findUnique
        .mockResolvedValueOnce({ id: 'org-1', referred_by_affiliate_id: null })
        .mockResolvedValueOnce({
          hubspot_id: 'hs-org-1',
          deployment_date: anchorDate,
        });
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([
        paidSnapshot({ paid_at: anchorDate }),
      ]);

      await service
        .associateCompany('profile-1', 'org-1', mockAdminUser)
        .catch(() => {});

      expect(mockPrisma.affiliateCommission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'detected' }),
        }),
      );
    });

    it('should run invoice ingestion before computing the backfill when org has a hubspot_id', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      mockPrisma.organization.findUnique
        .mockResolvedValueOnce({ id: 'org-1', referred_by_affiliate_id: null })
        .mockResolvedValueOnce({
          hubspot_id: 'hs-org-1',
          deployment_date: null,
        });
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([]);

      await service
        .associateCompany('profile-1', 'org-1', mockAdminUser)
        .catch(() => {});

      expect(mockInvoiceIngestionService.run).toHaveBeenCalledWith(
        'org-1',
        'hs-org-1',
      );
    });

    it('should return early (no eligibility-status update) when there are no candidate invoices and no deployment_date', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      mockPrisma.organization.findUnique
        .mockResolvedValueOnce({ id: 'org-1', referred_by_affiliate_id: null })
        .mockResolvedValueOnce({ hubspot_id: null, deployment_date: null });
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([]);

      await service
        .associateCompany('profile-1', 'org-1', mockAdminUser)
        .catch(() => {});

      // The initial `referred_by_affiliate_id` link update always happens, but the
      // backfill's eligibility-status update must NOT run in this early-return case.
      const eligibilityUpdate = mockPrisma.organization.update.mock.calls.find(
        (c: any) => c[0].data?.med_alliance_referral_status,
      );
      expect(eligibilityUpdate).toBeUndefined();
      expect(mockPrisma.medAllianceAuditLog.create).not.toHaveBeenCalled();
    });

    it('should call hubspot.setCompanyAffiliateReferral after associating', async () => {
      mockPrisma.affiliateProfile.findUnique.mockResolvedValue(mockProfile);
      mockPrisma.organization.findUnique
        .mockResolvedValueOnce({ id: 'org-1', referred_by_affiliate_id: null })
        .mockResolvedValueOnce({ hubspot_id: null, deployment_date: null });
      mockPrisma.hubspotInvoiceSnapshot.findMany.mockResolvedValue([]);

      await service
        .associateCompany('profile-1', 'org-1', mockAdminUser)
        .catch(() => {});

      expect(
        mockHubspotService.setCompanyAffiliateReferral,
      ).toHaveBeenCalledWith('org-1', 'affiliate-user-1', mockAdminUser.id);
    });
  });
});
