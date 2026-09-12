import { Test, TestingModule } from '@nestjs/testing';
import { CronService } from './cron.service';
import { PrismaService } from '../prisma/prisma.service';
import { CandidatesService } from '../candidate/candidates.service';
import { reRunPipelineDto } from './dto/re-run-pipeline.dto';
import { HandlerObjectCreation } from '../hubspot/handlers/objectCreation';
import { HandlerContactDeletion } from '../hubspot/handlers/contactDeletion';
import { HubspotAuditSource } from '@prisma/client';
import { MailService } from '../mail/mail.service';
import { HireRequestService } from '../hire-request/hire-request.service';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import { PayoutRequestsService } from '../med-alliance/payout-requests/payout-requests.service';
import { ReferralSyncService } from '../med-alliance/sync/referral-sync.service';
import { CommissionDetectionService } from '../med-alliance/sync/commission-detection.service';
import { AllianceNotificationsService } from '../med-alliance/notifications/notifications.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { BusinessUnitsService } from '../business-units/business-units.service';
import { CandidateAuditService } from '../candidate/candidate-audit.service';
import axios from 'axios';

jest.mock('axios');

describe('CronService', () => {
  let service: CronService;
  let prismaServiceMock: any;
  let candidatesServiceMock: { processData: jest.Mock };
  let handlerObjectCreationMock: { execute: jest.Mock };
  let contactDeletionMock: { execute: jest.Mock };
  let mailServiceMock: { sendMail: jest.Mock };
  let hireRequestServiceMock: Record<string, jest.Mock>;
  let positionRateConfigServiceMock: Record<string, jest.Mock>;
  let payoutRequestsServiceMock: Record<string, jest.Mock>;
  let referralSyncServiceMock: { run: jest.Mock };
  let commissionDetectionServiceMock: { run: jest.Mock };
  let allianceNotificationsMock: Record<string, jest.Mock>;
  let businessUnitContextMock: Record<string, jest.Mock>;
  let businessUnitsServiceMock: Record<string, jest.Mock>;
  let emailTemplatesServiceMock: { getTemplateContent: jest.Mock };
  let candidateAuditServiceMock: Record<string, jest.Mock>;

  beforeEach(async () => {
    emailTemplatesServiceMock = {
      getTemplateContent: jest.fn().mockResolvedValue(null),
    };

    businessUnitContextMock = {
      displayToSlug: jest.fn((v: string) =>
        v ? v.toLowerCase().replace(/\s+/g, '-') : null,
      ),
      normalizeBusinessUnit: jest.fn((v?: string | null) =>
        v ? v.trim().toLowerCase().replace(/\s+/g, '') : '',
      ),
      bustCache: jest.fn(),
    };

    businessUnitsServiceMock = {
      deactivateByBu: jest.fn().mockResolvedValue(undefined),
    };

    prismaServiceMock = {
      candidate: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      positionRateConfig: {
        create: jest.fn(),
      },
      businessUnit: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      emailBranding: {
        upsert: jest.fn(),
        // getBusinessUnitEmailTheme reads branding through findUnique and
        // swallows its own errors, so without this mock the theme lookup would
        // silently fall back and the assertions would pass for the wrong reason.
        findUnique: jest.fn().mockResolvedValue(null),
      },
      offerPanel: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      organization: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      uSER: {
        updateMany: jest.fn(),
      },
      affiliateProfile: {
        updateMany: jest.fn(),
      },
      affiliateCommission: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      medAllianceAuditLog: {
        create: jest.fn(),
      },
    };

    candidatesServiceMock = {
      processData: jest.fn(),
    };

    handlerObjectCreationMock = {
      execute: jest.fn(),
    };

    contactDeletionMock = {
      execute: jest.fn(),
    };

    mailServiceMock = {
      sendMail: jest.fn(),
    };

    hireRequestServiceMock = {
      findAll: jest.fn(),
      getVATypes: jest.fn(),
    };

    positionRateConfigServiceMock = {
      findAll: jest.fn().mockResolvedValue({
        status: 200,
        data: [],
        meta: { total: 0, page: 1, perPage: 10, totalPages: 0 },
      }),
      findAllUnpaginated: jest.fn().mockResolvedValue([]),
    };

    payoutRequestsServiceMock = {
      createFromCron: jest.fn(),
    };

    referralSyncServiceMock = {
      run: jest.fn(),
    };

    commissionDetectionServiceMock = {
      run: jest.fn(),
    };

    allianceNotificationsMock = {
      notifyCommissionEligible: jest.fn(),
      notifyAdminCommissionReverted: jest.fn(),
      notifyAdminCommissionPendingSummary: jest.fn(),
    };

    candidateAuditServiceMock = {
      log: jest.fn(),
      logOrThrow: jest.fn(),
      logMany: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CronService,
        { provide: PrismaService, useValue: prismaServiceMock },
        { provide: CandidatesService, useValue: candidatesServiceMock },
        { provide: HandlerObjectCreation, useValue: handlerObjectCreationMock },
        { provide: HandlerContactDeletion, useValue: contactDeletionMock },
        { provide: MailService, useValue: mailServiceMock },
        { provide: HireRequestService, useValue: hireRequestServiceMock },
        {
          provide: PositionRateConfigService,
          useValue: positionRateConfigServiceMock,
        },
        { provide: PayoutRequestsService, useValue: payoutRequestsServiceMock },
        { provide: ReferralSyncService, useValue: referralSyncServiceMock },
        {
          provide: CommissionDetectionService,
          useValue: commissionDetectionServiceMock,
        },
        {
          provide: AllianceNotificationsService,
          useValue: allianceNotificationsMock,
        },
        { provide: EmailTemplatesService, useValue: emailTemplatesServiceMock },
        { provide: BusinessUnitContext, useValue: businessUnitContextMock },
        { provide: BusinessUnitsService, useValue: businessUnitsServiceMock },
        { provide: CandidateAuditService, useValue: candidateAuditServiceMock },
      ],
    }).compile();

    service = module.get<CronService>(CronService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('syncPositionsFromHubspot', () => {
    it('returns true and does nothing when no new positions found', async () => {
      hireRequestServiceMock.getVATypes.mockResolvedValue([
        { label: 'Admin VA' },
        { label: 'Billing VA' },
      ]);
      positionRateConfigServiceMock.findAllUnpaginated.mockResolvedValue([
        { position: 'Admin VA' },
        { position: 'Billing VA' },
      ]);

      const result = await service.syncPositionsFromHubspot();

      expect(result).toBe(true);
      expect(
        prismaServiceMock.positionRateConfig.create,
      ).not.toHaveBeenCalled();
      expect(mailServiceMock.sendMail).not.toHaveBeenCalled();
    });

    it('creates new positions and sends alert email when new positions exist', async () => {
      hireRequestServiceMock.getVATypes.mockResolvedValue([
        { label: 'Admin VA' },
        { label: 'Billing VA' },
        { label: 'New Position' },
      ]);
      positionRateConfigServiceMock.findAllUnpaginated.mockResolvedValue([
        { position: 'Admin VA' },
        { position: 'Billing VA' },
      ]);
      prismaServiceMock.positionRateConfig.create.mockResolvedValue({});
      mailServiceMock.sendMail.mockResolvedValue({});

      const result = await service.syncPositionsFromHubspot();

      expect(result).toBe(true);
      expect(prismaServiceMock.positionRateConfig.create).toHaveBeenCalledWith({
        data: {
          position: 'New Position',
          medical_margin_per_hour: 9,
          non_medical_margin_per_hour: 9,
        },
      });
      expect(mailServiceMock.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: '[Action Required] New VA Positions Found',
        }),
      );
    });

    it('returns false when an error occurs', async () => {
      hireRequestServiceMock.getVATypes.mockRejectedValue(
        new Error('HubSpot API error'),
      );

      const result = await service.syncPositionsFromHubspot();

      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // expireStaleEligibility
  // -------------------------------------------------------------------------
  describe('expireStaleEligibility', () => {
    it('should return zero counts when no orgs qualify', async () => {
      prismaServiceMock.organization.findMany.mockResolvedValue([]);

      const result = await service.expireStaleEligibility();

      expect(result).toEqual({ companiesExpired: 0, errors: [] });
      expect(prismaServiceMock.organization.update).not.toHaveBeenCalled();
      expect(mailServiceMock.sendMail).not.toHaveBeenCalled();
    });

    it('should expire multiple orgs starting from different statuses', async () => {
      const deployedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      prismaServiceMock.organization.findMany.mockResolvedValue([
        {
          id: 'org-1',
          name: 'Clinic A',
          deployment_date: deployedAt,
          med_alliance_referral_status: 'pending_confirmation',
        },
        {
          id: 'org-2',
          name: 'Clinic B',
          deployment_date: deployedAt,
          med_alliance_referral_status: 'eligible',
        },
        {
          id: 'org-3',
          name: 'Clinic C',
          deployment_date: deployedAt,
          med_alliance_referral_status: 'not_eligible',
        },
      ]);
      prismaServiceMock.organization.update.mockResolvedValue({});
      prismaServiceMock.medAllianceAuditLog.create.mockResolvedValue({});
      mailServiceMock.sendMail.mockResolvedValue({});

      const result = await service.expireStaleEligibility();

      expect(result.companiesExpired).toBe(3);
      expect(result.errors).toHaveLength(0);
      expect(prismaServiceMock.organization.update).toHaveBeenCalledTimes(3);
    });

    it('should set org status to expired and clear block reason', async () => {
      const deployedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      prismaServiceMock.organization.findMany.mockResolvedValue([
        {
          id: 'org-1',
          name: 'Clinic',
          deployment_date: deployedAt,
          med_alliance_referral_status: 'not_eligible',
        },
      ]);
      prismaServiceMock.organization.update.mockResolvedValue({});
      prismaServiceMock.medAllianceAuditLog.create.mockResolvedValue({});
      mailServiceMock.sendMail.mockResolvedValue({});

      await service.expireStaleEligibility();

      expect(prismaServiceMock.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'org-1' },
          data: {
            med_alliance_referral_status: 'expired',
            med_alliance_block_reason: null,
          },
        }),
      );
    });

    it('should write an eligibility_expired audit log with source=cron for each expired org', async () => {
      const deployedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      prismaServiceMock.organization.findMany.mockResolvedValue([
        {
          id: 'org-1',
          name: 'Clinic',
          deployment_date: deployedAt,
          med_alliance_referral_status: 'eligible',
        },
      ]);
      prismaServiceMock.organization.update.mockResolvedValue({});
      prismaServiceMock.medAllianceAuditLog.create.mockResolvedValue({});
      mailServiceMock.sendMail.mockResolvedValue({});

      await service.expireStaleEligibility();

      expect(prismaServiceMock.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entity_type: 'referred_company',
            entity_id: 'org-1',
            event: 'eligibility_expired',
            old_status: 'eligible',
            new_status: 'expired',
            source: 'cron',
            actor_user_id: null,
          }),
        }),
      );
    });

    it('should catch per-org errors and continue processing remaining orgs', async () => {
      const deployedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      prismaServiceMock.organization.findMany.mockResolvedValue([
        {
          id: 'org-fail',
          name: 'Fail Co',
          deployment_date: deployedAt,
          med_alliance_referral_status: 'pending_confirmation',
        },
        {
          id: 'org-ok',
          name: 'Ok Co',
          deployment_date: deployedAt,
          med_alliance_referral_status: 'pending_confirmation',
        },
      ]);
      prismaServiceMock.organization.update
        .mockRejectedValueOnce(new Error('DB timeout')) // org-fail throws
        .mockResolvedValueOnce({}); // org-ok succeeds
      prismaServiceMock.medAllianceAuditLog.create.mockResolvedValue({});
      mailServiceMock.sendMail.mockResolvedValue({});

      const result = await service.expireStaleEligibility();

      expect(result.companiesExpired).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('org-fail');
    });

    it('should query with the correct structural filters (deployed stage, referred, >=365 days, excludes already-expired)', async () => {
      prismaServiceMock.organization.findMany.mockResolvedValue([]);

      await service.expireStaleEligibility();

      expect(prismaServiceMock.organization.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            referral_stage: 'deployed',
            referred_by_affiliate_id: { not: null },
            deployment_date: expect.objectContaining({ lte: expect.any(Date) }),
            med_alliance_referral_status: {
              in: ['pending_confirmation', 'eligible', 'not_eligible'],
            },
          }),
        }),
      );
      // 'canceled' orgs are structurally excluded — a single referral_stage column
      // can't simultaneously be 'deployed' and 'canceled', so no extra clause is needed.
      // Already-expired orgs are excluded via the med_alliance_referral_status `in` filter.
    });

    it('should send the expired-eligibility report email when companies are expired', async () => {
      const deployedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      prismaServiceMock.organization.findMany.mockResolvedValue([
        {
          id: 'org-1',
          name: 'Clinic',
          deployment_date: deployedAt,
          med_alliance_referral_status: 'eligible',
        },
      ]);
      prismaServiceMock.organization.update.mockResolvedValue({});
      prismaServiceMock.medAllianceAuditLog.create.mockResolvedValue({});
      mailServiceMock.sendMail.mockResolvedValue({});

      await service.expireStaleEligibility();

      expect(mailServiceMock.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining('Expired Eligibility Report'),
        }),
      );
    });

    it('should not send the report email when no companies are expired', async () => {
      prismaServiceMock.organization.findMany.mockResolvedValue([]);

      await service.expireStaleEligibility();

      expect(mailServiceMock.sendMail).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // expireStaleEligibility — mail error catch branch
  // -------------------------------------------------------------------------
  describe('expireStaleEligibility — mail error branch', () => {
    it('should swallow mail error when sendMail throws after companies are expired', async () => {
      const deployedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      prismaServiceMock.organization.findMany.mockResolvedValue([
        {
          id: 'org-1',
          name: 'Clinic',
          deployment_date: deployedAt,
          med_alliance_referral_status: 'pending_confirmation',
        },
      ]);
      prismaServiceMock.organization.update.mockResolvedValue({});
      prismaServiceMock.medAllianceAuditLog.create.mockResolvedValue({});
      mailServiceMock.sendMail.mockRejectedValue(new Error('mail server down'));

      const result = await service.expireStaleEligibility();

      expect(result.companiesExpired).toBe(1);
      expect(result.errors).toHaveLength(0);
    });
  });

  /*
  it('should re-run pipeline for all candidates with given status', async () => {
    // Arrange: simula retorno do banco
    prismaServiceMock.candidate.findMany.mockResolvedValue([
      { id: 1, first_name: 'John', last_name: 'Doe' },
      { id: 2, first_name: 'Jane', last_name: 'Smith' },
    ]);

    candidatesServiceMock.processData.mockResolvedValue(undefined);

    const dto: reRunPipelineDto = {
      status: 'processing_uploadFile' as any, // cast para evitar reclamação do tipo
    };

    // Act
    const result = await service.reRunPipeline(dto);

    // Assert
    expect(prismaServiceMock.candidate.findMany).toHaveBeenCalledWith({
      where: { processing_status: dto.status },
      select: { id: true, first_name: true, last_name: true },
    });

    expect(candidatesServiceMock.processData).toHaveBeenCalledTimes(2);
    expect(candidatesServiceMock.processData).toHaveBeenNthCalledWith(1, 1);
    expect(candidatesServiceMock.processData).toHaveBeenNthCalledWith(2, 2);

    expect(result).toBe(true);
  });

  it('should return true even if no candidates are found', async () => {
    prismaServiceMock.candidate.findMany.mockResolvedValue([]);

    const dto: reRunPipelineDto = {
      status: 'processing_extractData' as any,
    };

    const result = await service.reRunPipeline(dto);

    expect(candidatesServiceMock.processData).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  */

  // ---------------------------------------------------------------------------
  // reRunPipeline
  // ---------------------------------------------------------------------------
  describe('reRunPipeline', () => {
    const dto: reRunPipelineDto = { status: 'processing_extractData' as any };

    it('should return true and not call processData when environment is not PROD', async () => {
      const originalEnv = process.env.ENVIRONMENT;
      process.env.ENVIRONMENT = 'DEV';

      prismaServiceMock.candidate.findMany.mockResolvedValue([
        { id: 'c-1', first_name: 'John', last_name: 'Doe' },
      ]);

      const result = await service.reRunPipeline(dto);

      expect(result).toBe(true);
      expect(candidatesServiceMock.processData).not.toHaveBeenCalled();

      process.env.ENVIRONMENT = originalEnv;
    });

    it('should process candidates in PROD and return true', async () => {
      const originalEnv = process.env.ENVIRONMENT;
      process.env.ENVIRONMENT = 'PROD';

      prismaServiceMock.candidate.findMany.mockResolvedValue([
        { id: 'c-1', first_name: 'Alice', last_name: 'Smith' },
        { id: 'c-2', first_name: 'Bob', last_name: 'Jones' },
      ]);
      candidatesServiceMock.processData.mockResolvedValue(undefined);

      const result = await service.reRunPipeline(dto);

      expect(result).toBe(true);
      expect(candidatesServiceMock.processData).toHaveBeenCalledTimes(2);
      expect(candidatesServiceMock.processData).toHaveBeenCalledWith('c-1');
      expect(candidatesServiceMock.processData).toHaveBeenCalledWith('c-2');

      process.env.ENVIRONMENT = originalEnv;
    });

    it('should mark candidate as failed and continue when processData throws in PROD', async () => {
      const originalEnv = process.env.ENVIRONMENT;
      process.env.ENVIRONMENT = 'PROD';

      prismaServiceMock.candidate = {
        ...prismaServiceMock.candidate,
        update: jest.fn().mockResolvedValue({}),
      };

      prismaServiceMock.candidate.findMany.mockResolvedValue([
        { id: 'c-bad', first_name: 'Fail', last_name: 'Candidate' },
        { id: 'c-good', first_name: 'OK', last_name: 'Candidate' },
      ]);
      candidatesServiceMock.processData
        .mockRejectedValueOnce(new Error('pipeline error'))
        .mockResolvedValueOnce(undefined);

      const result = await service.reRunPipeline(dto);

      expect(result).toBe(true);
      expect(prismaServiceMock.candidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'c-bad' },
          data: { processing_status: 'failed' },
        }),
      );

      process.env.ENVIRONMENT = originalEnv;
    });

    it('should query with NOT completed when status is "failed"', async () => {
      prismaServiceMock.candidate.findMany.mockResolvedValue([]);

      await service.reRunPipeline({ status: 'failed' as any });

      expect(prismaServiceMock.candidate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            processing_status: { not: 'completed' },
          }),
        }),
      );
    });

    it('should return true when no candidates are found', async () => {
      prismaServiceMock.candidate.findMany.mockResolvedValue([]);

      const result = await service.reRunPipeline(dto);

      expect(result).toBe(true);
      expect(candidatesServiceMock.processData).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // systemReport
  // ---------------------------------------------------------------------------
  describe('systemReport', () => {
    beforeEach(() => {
      prismaServiceMock.candidate = {
        ...prismaServiceMock.candidate,
        count: jest.fn(),
      };
    });

    it('should return true and send system report email on success', async () => {
      prismaServiceMock.candidate.count
        .mockResolvedValueOnce(10) // availableCandidates
        .mockResolvedValueOnce(5) // endorsedCandidates
        .mockResolvedValueOnce(3); // withoutResume
      prismaServiceMock.candidate.findMany
        .mockResolvedValueOnce([
          {
            id: 'c-1',
            first_name: 'A',
            last_name: 'B',
            name: 'AB',
            hubspot_id: 'hs-1',
            processing_error: null,
          },
        ]) // failedResumeParsing
        .mockResolvedValueOnce([
          {
            id: 'c-2',
            first_name: 'C',
            last_name: 'D',
            name: 'CD',
            hubspot_id: 'hs-2',
          },
        ]); // withoutHeadshot
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.systemReport();

      expect(result).toBe(true);
      expect(mailServiceMock.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'System Report' }),
      );
    });

    it('should return true even when mailSent is falsy', async () => {
      prismaServiceMock.candidate.count.mockResolvedValue(0);
      prismaServiceMock.candidate.findMany.mockResolvedValue([]);
      mailServiceMock.sendMail.mockResolvedValue(null);

      const result = await service.systemReport();

      expect(result).toBe(true);
    });

    it('should return false when an error is thrown', async () => {
      prismaServiceMock.candidate.count.mockRejectedValue(
        new Error('DB error'),
      );

      const result = await service.systemReport();

      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // syncClientsWithActiveStaffs
  // ---------------------------------------------------------------------------
  describe('syncClientsWithActiveStaffs', () => {
    it('should update inactive clients that have active staffs to active', async () => {
      prismaServiceMock.organization.findMany.mockResolvedValue([
        {
          id: 'org-1',
          name: 'Clinic A',
          staff: [
            {
              id: 's-1',
              hubspot_id: 'hs-1',
              hub_deal_name: 'deal',
              hubspot_dealstage: '16981840',
            },
          ],
        },
      ]);
      prismaServiceMock.organization.update.mockResolvedValue({});

      const result = await service.syncClientsWithActiveStaffs();

      expect(result).toBe(true);
      expect(prismaServiceMock.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'org-1' },
          data: { status: 'active' },
        }),
      );
    });

    it('should return true when no inactive clients have active staffs', async () => {
      prismaServiceMock.organization.findMany.mockResolvedValue([]);

      const result = await service.syncClientsWithActiveStaffs();

      expect(result).toBe(true);
      expect(prismaServiceMock.organization.update).not.toHaveBeenCalled();
    });

    it('should return false when an error is thrown', async () => {
      prismaServiceMock.organization.findMany.mockRejectedValue(
        new Error('DB failure'),
      );

      const result = await service.syncClientsWithActiveStaffs();

      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // deactivateClientUsersWithNoStaff
  // ---------------------------------------------------------------------------
  describe('deactivateClientUsersWithNoStaff', () => {
    beforeEach(() => {
      prismaServiceMock.uSER = {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      };
      prismaServiceMock.$transaction = jest.fn();
    });

    it('should return true immediately when no clients have no staff', async () => {
      prismaServiceMock.organization.findMany.mockResolvedValue([]);

      const result = await service.deactivateClientUsersWithNoStaff();

      expect(result).toBe(true);
      expect(prismaServiceMock.uSER.findMany).not.toHaveBeenCalled();
    });

    it('should deactivate active users and delete invited users, then send report', async () => {
      prismaServiceMock.organization.findMany.mockResolvedValue([
        { id: 'org-1', name: 'Clinic A' },
      ]);
      prismaServiceMock.uSER.findMany
        .mockResolvedValueOnce([
          {
            id: 'u-active',
            email: 'active@test.com',
            first_name: 'Active',
            last_name: 'User',
            organization_id: 'org-1',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'u-invited',
            email: 'invited@test.com',
            first_name: 'Invited',
            last_name: 'User',
            organization_id: 'org-1',
          },
        ]);
      prismaServiceMock.uSER.updateMany = jest.fn().mockResolvedValue({});

      const txMock = {
        emailVerification: { deleteMany: jest.fn().mockResolvedValue({}) },
        emailInvitation: { deleteMany: jest.fn().mockResolvedValue({}) },
        uSER: { delete: jest.fn().mockResolvedValue({}) },
      };
      prismaServiceMock.$transaction.mockImplementation(async (fn: any) =>
        fn(txMock),
      );
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.deactivateClientUsersWithNoStaff();

      expect(result).toBe(true);
      expect(prismaServiceMock.uSER.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'inactive', status_before_deactivation: 'active' },
        }),
      );
      expect(txMock.uSER.delete).toHaveBeenCalledWith({
        where: { id: 'u-invited' },
      });
      expect(mailServiceMock.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Client Users Deactivation Report',
        }),
      );
    });

    it('should handle no active or invited users gracefully and send report', async () => {
      prismaServiceMock.organization.findMany.mockResolvedValue([
        { id: 'org-1', name: 'Clinic A' },
      ]);
      prismaServiceMock.uSER.findMany
        .mockResolvedValueOnce([]) // no active users
        .mockResolvedValueOnce([]); // no invited users
      prismaServiceMock.uSER.updateMany = jest.fn().mockResolvedValue({});
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.deactivateClientUsersWithNoStaff();

      expect(result).toBe(true);
      expect(prismaServiceMock.$transaction).not.toHaveBeenCalled();
    });

    it('should return false and send error email when an error is thrown', async () => {
      prismaServiceMock.organization.findMany.mockRejectedValue(
        new Error('DB down'),
      );
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.deactivateClientUsersWithNoStaff();

      expect(result).toBe(false);
      expect(mailServiceMock.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: '[ERROR] Client Users Deactivation Cron Job Failed',
        }),
      );
    });

    it('should return false and swallow mail error when both main and mail throw', async () => {
      prismaServiceMock.organization.findMany.mockRejectedValue(
        new Error('DB down'),
      );
      mailServiceMock.sendMail.mockRejectedValue(new Error('mail error'));

      const result = await service.deactivateClientUsersWithNoStaff();

      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // syncStaffHubspotDealStages
  // ---------------------------------------------------------------------------
  describe('syncStaffHubspotDealStages', () => {
    let axiosMock: jest.Mocked<typeof import('axios').default>;

    beforeEach(() => {
      prismaServiceMock.staff = {
        findMany: jest.fn(),
        update: jest.fn(),
      };
      axiosMock = jest.requireMock('axios');
      axiosMock.get = jest.fn();
    });

    it('should return true when no staffs match criteria', async () => {
      prismaServiceMock.staff.findMany.mockResolvedValue([]);

      const result = await service.syncStaffHubspotDealStages();

      expect(result).toBe(true);
      expect(prismaServiceMock.staff.update).not.toHaveBeenCalled();
    });

    it('should update staff dealstage for each staff and return true', async () => {
      prismaServiceMock.staff.findMany.mockResolvedValue([
        { id: 's-1', hubspot_id: 'hs-100' },
        { id: 's-2', hubspot_id: 'hs-200' },
      ]);
      prismaServiceMock.staff.update.mockResolvedValue({});
      axiosMock.get.mockResolvedValue({
        data: { properties: { dealstage: '16981840' } },
      });

      const result = await service.syncStaffHubspotDealStages();

      expect(result).toBe(true);
      expect(prismaServiceMock.staff.update).toHaveBeenCalledTimes(2);
      expect(prismaServiceMock.staff.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 's-1' },
          data: expect.objectContaining({ hubspot_dealstage: '16981840' }),
        }),
      );
    });

    it('should continue processing remaining staffs when one axios call fails', async () => {
      prismaServiceMock.staff.findMany.mockResolvedValue([
        { id: 's-fail', hubspot_id: 'hs-bad' },
        { id: 's-ok', hubspot_id: 'hs-good' },
      ]);
      prismaServiceMock.staff.update.mockResolvedValue({});
      axiosMock.get
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({
          data: { properties: { dealstage: '148234581' } },
        }); // inactive stage

      const result = await service.syncStaffHubspotDealStages();

      expect(result).toBe(true);
      expect(prismaServiceMock.staff.update).toHaveBeenCalledTimes(1);
      expect(prismaServiceMock.staff.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 's-ok' },
          data: expect.objectContaining({ status: 'inactive' }),
        }),
      );
    });

    it('should return false when prisma.staff.findMany throws', async () => {
      prismaServiceMock.staff.findMany.mockRejectedValue(new Error('DB down'));

      const result = await service.syncStaffHubspotDealStages();

      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // sweepStaleContactIds
  // ---------------------------------------------------------------------------
  describe('sweepStaleContactIds', () => {
    let axiosMock: jest.Mocked<typeof import('axios').default>;

    beforeEach(() => {
      prismaServiceMock.contact = {
        findMany: jest.fn(),
      };
      prismaServiceMock.uSER = {
        findMany: jest.fn(),
      };
      axiosMock = jest.requireMock('axios');
      axiosMock.get = jest.fn();
    });

    it('should not clear anything when every HubSpot contact still exists', async () => {
      prismaServiceMock.contact.findMany.mockResolvedValue([
        { hubspot_id: 'hs-1' },
      ]);
      prismaServiceMock.uSER.findMany.mockResolvedValue([]);
      axiosMock.get.mockResolvedValue({ data: {} });

      const result = await service.sweepStaleContactIds();

      expect(contactDeletionMock.execute).not.toHaveBeenCalled();
      expect(result).toEqual({
        checkedContacts: 1,
        checkedUsers: 0,
        cleared: 0,
        errors: [],
      });
    });

    it('should clear the stale pointer via contactDeletion when HubSpot returns 404', async () => {
      prismaServiceMock.contact.findMany.mockResolvedValue([
        { hubspot_id: 'hs-stale' },
      ]);
      prismaServiceMock.uSER.findMany.mockResolvedValue([]);
      axiosMock.get.mockRejectedValue({ response: { status: 404 } });

      const result = await service.sweepStaleContactIds();

      expect(contactDeletionMock.execute).toHaveBeenCalledWith(
        { objectId: 'hs-stale' },
        HubspotAuditSource.cron,
      );
      expect(result.cleared).toBe(1);
      expect(result.errors).toEqual([]);
    });

    it('should record non-404 errors and continue without clearing', async () => {
      prismaServiceMock.contact.findMany.mockResolvedValue([
        { hubspot_id: 'hs-broken' },
      ]);
      prismaServiceMock.uSER.findMany.mockResolvedValue([]);
      axiosMock.get.mockRejectedValue(new Error('network error'));

      const result = await service.sweepStaleContactIds();

      expect(contactDeletionMock.execute).not.toHaveBeenCalled();
      expect(result.cleared).toBe(0);
      expect(result.errors).toEqual(['hubspot_id=hs-broken: network error']);
    });

    it('should dedupe a HubSpot id shared by both a Contact and a USER row into a single check', async () => {
      prismaServiceMock.contact.findMany.mockResolvedValue([
        { hubspot_id: 'hs-shared' },
      ]);
      prismaServiceMock.uSER.findMany.mockResolvedValue([
        { hubspot_contact_id: 'hs-shared' },
      ]);
      axiosMock.get.mockRejectedValue({ response: { status: 404 } });

      const result = await service.sweepStaleContactIds();

      expect(axiosMock.get).toHaveBeenCalledTimes(1);
      expect(contactDeletionMock.execute).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        checkedContacts: 1,
        checkedUsers: 1,
        cleared: 1,
        errors: [],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getCandidateId
  // ---------------------------------------------------------------------------
  describe('getCandidateId', () => {
    let axiosMock: jest.Mocked<typeof import('axios').default>;

    beforeEach(() => {
      prismaServiceMock.staff = {
        findMany: jest.fn(),
        update: jest.fn(),
      };
      prismaServiceMock.sync = {
        create: jest.fn().mockResolvedValue({}),
      };
      prismaServiceMock.candidate = {
        ...prismaServiceMock.candidate,
        findUnique: jest.fn(),
      };
      axiosMock = jest.requireMock('axios');
      axiosMock.get = jest.fn();
    });

    it('should return true and create a sync record when no staffs need updating', async () => {
      prismaServiceMock.staff.findMany.mockResolvedValue([]);

      const result = await service.getCandidateId();

      expect(result).toBe(true);
      expect(prismaServiceMock.sync.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: 'get-candidate-id' }),
        }),
      );
    });

    it('should link existing candidate to staff when candidate already exists in DB', async () => {
      prismaServiceMock.staff.findMany.mockResolvedValue([
        { id: 's-1', hubspot_id: 'deal-123' },
      ]);
      prismaServiceMock.staff.update.mockResolvedValue({});
      prismaServiceMock.candidate.findUnique.mockResolvedValue({
        id: 'cand-99',
      });
      axiosMock.get.mockResolvedValue({
        data: { results: [{ id: 'hs-obj-1' }] },
      });

      const result = await service.getCandidateId();

      expect(result).toBe(true);
      expect(prismaServiceMock.staff.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 's-1' },
          data: expect.objectContaining({ candidate_id: 'cand-99' }),
        }),
      );
      expect(handlerObjectCreationMock.execute).not.toHaveBeenCalled();
    });

    it('should call objectCreation.execute when candidate does not exist and then re-query', async () => {
      prismaServiceMock.staff.findMany.mockResolvedValue([
        { id: 's-1', hubspot_id: 'deal-123' },
      ]);
      prismaServiceMock.staff.update.mockResolvedValue({});
      prismaServiceMock.candidate.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'cand-new' });
      handlerObjectCreationMock.execute.mockResolvedValue(undefined);
      axiosMock.get.mockResolvedValue({
        data: { results: [{ id: 'hs-obj-1' }] },
      });

      const result = await service.getCandidateId();

      expect(result).toBe(true);
      expect(handlerObjectCreationMock.execute).toHaveBeenCalledWith(
        expect.objectContaining({ objectId: 'hs-obj-1' }),
      );
      expect(prismaServiceMock.staff.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ candidate_id: 'cand-new' }),
        }),
      );
    });

    it('should set candidate_id to null when staff has no associated VA object', async () => {
      prismaServiceMock.staff.findMany.mockResolvedValue([
        { id: 's-1', hubspot_id: 'deal-123' },
      ]);
      axiosMock.get.mockResolvedValue({
        data: { results: [] },
      });

      const result = await service.getCandidateId();

      expect(result).toBe(true);
      expect(prismaServiceMock.staff.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // createQuarterlyPayoutRequests
  // ---------------------------------------------------------------------------
  describe('createQuarterlyPayoutRequests', () => {
    beforeEach(() => {
      prismaServiceMock.affiliateProfile = {
        findMany: jest.fn(),
      };
    });

    it('should return created=0 and failed=0 when no affiliates have eligible commissions', async () => {
      prismaServiceMock.affiliateProfile.findMany.mockResolvedValue([]);
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.createQuarterlyPayoutRequests();

      expect(result).toEqual({ created: 0, failed: 0, total_amount: '0.00' });
      expect(mailServiceMock.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining('Quarterly Payout Report'),
        }),
      );
    });

    it('should create payout requests for each affiliate and report successes', async () => {
      prismaServiceMock.affiliateProfile.findMany.mockResolvedValue([
        {
          id: 'aff-1',
          full_name: 'Affiliate One',
          user: { email: 'aff1@test.com', first_name: 'Aff', last_name: 'One' },
          commissions: [
            { id: 'comm-1', commission_amount: 100 },
            { id: 'comm-2', commission_amount: 200 },
          ],
        },
      ]);
      payoutRequestsServiceMock.createFromCron.mockResolvedValue({
        id: 'payout-req-1',
        requested_amount: 300,
      });
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.createQuarterlyPayoutRequests();

      expect(result.created).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.total_amount).toBe('300.00');
      expect(payoutRequestsServiceMock.createFromCron).toHaveBeenCalledWith(
        'aff-1',
        ['comm-1', 'comm-2'],
      );
    });

    it('should record failures when createFromCron throws and still send report', async () => {
      prismaServiceMock.affiliateProfile.findMany.mockResolvedValue([
        {
          id: 'aff-2',
          full_name: null,
          user: {
            email: 'aff2@test.com',
            first_name: 'Fail',
            last_name: 'Aff',
          },
          commissions: [{ id: 'comm-3', commission_amount: 50 }],
        },
      ]);
      payoutRequestsServiceMock.createFromCron.mockRejectedValue(
        new Error('payout error'),
      );
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.createQuarterlyPayoutRequests();

      expect(result.created).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.total_amount).toBe('0.00');
      expect(mailServiceMock.sendMail).toHaveBeenCalled();
    });

    it('should derive affiliate name from user when full_name is null', async () => {
      prismaServiceMock.affiliateProfile.findMany.mockResolvedValue([
        {
          id: 'aff-3',
          full_name: null,
          user: {
            email: 'aff3@test.com',
            first_name: 'Jane',
            last_name: 'Smith',
          },
          commissions: [{ id: 'comm-4', commission_amount: 75 }],
        },
      ]);
      payoutRequestsServiceMock.createFromCron.mockResolvedValue({
        id: 'pr-2',
        requested_amount: 75,
      });
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.createQuarterlyPayoutRequests();

      expect(result.created).toBe(1);
      expect(result.total_amount).toBe('75.00');
    });

    it('should use affiliate id as name when full_name and user are both null', async () => {
      prismaServiceMock.affiliateProfile.findMany.mockResolvedValue([
        {
          id: 'aff-4',
          full_name: null,
          user: null,
          commissions: [{ id: 'comm-5', commission_amount: 25 }],
        },
      ]);
      payoutRequestsServiceMock.createFromCron.mockResolvedValue({
        id: 'pr-3',
        requested_amount: 25,
      });
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.createQuarterlyPayoutRequests();

      expect(result.created).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // syncOrganizationsWithHubspot
  // ---------------------------------------------------------------------------
  describe('syncOrganizationsWithHubspot', () => {
    beforeEach(() => {
      prismaServiceMock.affiliateCommission = {
        ...prismaServiceMock.affiliateCommission,
        findMany: jest.fn(),
        update: jest.fn(),
      };
      prismaServiceMock.medAllianceAuditLog = {
        create: jest.fn(),
      };
    });

    it('should process a single org when organization_id is provided', async () => {
      const syncResult = {
        organizationId: 'org-1',
        phaseA: { outcome: 'already_matched' },
      };
      referralSyncServiceMock.run.mockResolvedValue(syncResult);
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.syncOrganizationsWithHubspot('org-1');

      expect(referralSyncServiceMock.run).toHaveBeenCalledTimes(1);
      expect(referralSyncServiceMock.run).toHaveBeenCalledWith('org-1');
      expect(result.processed).toBe(1);
      expect(result.syncFailed).toBe(0);
      expect(result.syncResults).toHaveLength(1);
    });

    it('should query all active orgs when no organization_id is given', async () => {
      prismaServiceMock.organization.findMany.mockResolvedValue([
        { id: 'org-a' },
        { id: 'org-b' },
      ]);
      referralSyncServiceMock.run.mockResolvedValue({
        organizationId: 'x',
        phaseA: { outcome: 'already_matched' },
      });
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.syncOrganizationsWithHubspot();

      expect(referralSyncServiceMock.run).toHaveBeenCalledTimes(2);
      expect(result.processed).toBe(2);
      // Called once for the active-org list and once to resolve org names
      // for the report email.
      expect(prismaServiceMock.organization.findMany).toHaveBeenCalledTimes(2);
    });

    it('should increment syncFailed and continue when referralSync.run throws', async () => {
      prismaServiceMock.organization.findMany.mockResolvedValue([
        { id: 'org-fail' },
        { id: 'org-ok' },
      ]);
      referralSyncServiceMock.run
        .mockRejectedValueOnce(new Error('hubspot down'))
        .mockResolvedValueOnce({
          organizationId: 'org-ok',
          phaseA: { outcome: 'synced' },
        });
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.syncOrganizationsWithHubspot();

      expect(result.syncFailed).toBe(1);
      expect(result.processed).toBe(2);
      expect(result.syncResults).toHaveLength(1);
    });

    it('should return only processed/syncFailed/syncResults (no promotion fields)', async () => {
      referralSyncServiceMock.run.mockResolvedValue({
        organizationId: 'org-1',
        phaseA: { outcome: 'already_matched' },
      });
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.syncOrganizationsWithHubspot('org-1');

      expect(Object.keys(result).sort()).toEqual([
        'processed',
        'syncFailed',
        'syncResults',
      ]);
    });

    it('should send a report email to paulo@regenta.ai summarizing the run', async () => {
      referralSyncServiceMock.run.mockResolvedValue({
        organizationId: 'org-1',
        phaseA: { outcome: 'synced', hubspotCompanyId: 'hs-1' },
        phaseB: {
          invoices: { created: 2, updated: 0, skipped: 0 },
          commissions: { created: 1, skipped: 0 },
        },
      });
      mailServiceMock.sendMail.mockResolvedValue(true);

      await service.syncOrganizationsWithHubspot('org-1');

      expect(mailServiceMock.sendMail).toHaveBeenCalledTimes(1);
      expect(mailServiceMock.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'MedVirtual <noreply@medvirtual.ai>',
          to: ['paulo@regenta.ai'],
          subject: expect.stringContaining(
            'Med Alliance — HubSpot Sync Report',
          ),
          html: expect.any(String),
        }),
      );
    });

    it('should still send the report email when no organizations were processed', async () => {
      prismaServiceMock.organization.findMany.mockResolvedValue([]);
      mailServiceMock.sendMail.mockResolvedValue(true);

      const result = await service.syncOrganizationsWithHubspot();

      expect(result.processed).toBe(0);
      expect(mailServiceMock.sendMail).toHaveBeenCalledTimes(1);
    });

    it('should not throw and should keep the normal return value when sending the report email fails', async () => {
      referralSyncServiceMock.run.mockResolvedValue({
        organizationId: 'org-1',
        phaseA: { outcome: 'already_matched' },
      });
      mailServiceMock.sendMail.mockRejectedValue(new Error('resend down'));

      const result = await service.syncOrganizationsWithHubspot('org-1');

      expect(result).toEqual({
        processed: 1,
        syncFailed: 0,
        syncResults: [
          { organizationId: 'org-1', phaseA: { outcome: 'already_matched' } },
        ],
      });
    });
  });

  // ── syncBusinessUnits (Task 05) ────────────────────────────────────────────

  describe('syncBusinessUnits', () => {
    const mockedAxios = axios as jest.Mocked<typeof axios>;

    const hubspotPropertyResponse = (options: { label: string }[]) => ({
      status: 200,
      data: {
        name: 'business_unit',
        options,
      },
    });

    beforeEach(() => {
      mockedAxios.get.mockReset();
    });

    it('upserts a new HubSpot option as a dormant BU (is_visible=false)', async () => {
      mockedAxios.get.mockResolvedValue(
        hubspotPropertyResponse([
          { label: 'MedVirtual' },
          { label: 'Berry Virtual' },
          { label: 'MMVA' },
        ]),
      );
      prismaServiceMock.businessUnit.findMany.mockResolvedValue([
        {
          id: '1',
          slug: 'medvirtual',
          hubspot_value: 'MedVirtual',
          is_visible: true,
        },
        {
          id: '2',
          slug: 'berry-virtual',
          hubspot_value: 'Berry Virtual',
          is_visible: true,
        },
      ]);
      prismaServiceMock.businessUnit.upsert.mockResolvedValue({});

      const result = await service.syncBusinessUnits();

      expect(prismaServiceMock.businessUnit.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: 'mmva' },
          create: expect.objectContaining({
            slug: 'mmva',
            hubspot_value: 'MMVA',
            candidate_pool: 'medical',
            is_visible: false,
          }),
        }),
      );
      expect(result.aborted).toBe(false);
      expect(businessUnitContextMock.bustCache).toHaveBeenCalled();
    });

    it('creates a companion EmailBranding row per BU (create-once, empty update — idempotent, never clobbers edits)', async () => {
      mockedAxios.get.mockResolvedValue(
        hubspotPropertyResponse([{ label: 'MMVA' }]),
      );
      prismaServiceMock.businessUnit.findMany.mockResolvedValue([
        {
          id: '1',
          slug: 'medvirtual',
          hubspot_value: 'MedVirtual',
          is_visible: true,
        },
      ]);
      prismaServiceMock.businessUnit.upsert.mockResolvedValue({});

      await service.syncBusinessUnits();

      expect(prismaServiceMock.emailBranding.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { business_unit: 'mmva' },
          create: expect.objectContaining({
            business_unit: 'mmva',
            company_name: 'MMVA',
            layout_preset: 'default',
          }),
          update: {},
        }),
      );
    });

    it('never flips visibility of an existing BU during upsert', async () => {
      mockedAxios.get.mockResolvedValue(
        hubspotPropertyResponse([{ label: 'MedVirtual' }]),
      );
      prismaServiceMock.businessUnit.findMany.mockResolvedValue([
        {
          id: '1',
          slug: 'medvirtual',
          hubspot_value: 'MedVirtual',
          is_visible: true,
        },
      ]);
      prismaServiceMock.businessUnit.upsert.mockResolvedValue({});

      await service.syncBusinessUnits();

      const upsertCall = prismaServiceMock.businessUnit.upsert.mock.calls.find(
        (c: any[]) => c[0].where.slug === 'medvirtual',
      );
      expect(upsertCall[0].update).not.toHaveProperty('is_visible');
    });

    it('reconciles removed options by delegating the cascade to businessUnitsService.deactivateByBu (once per decommissioned BU, right slug/value)', async () => {
      mockedAxios.get.mockResolvedValue(
        hubspotPropertyResponse([{ label: 'MedVirtual' }]),
      );
      prismaServiceMock.businessUnit.findMany.mockResolvedValue([
        {
          id: '1',
          slug: 'medvirtual',
          hubspot_value: 'MedVirtual',
          is_visible: true,
        },
        { id: '2', slug: 'mmva', hubspot_value: 'MMVA', is_visible: true },
      ]);
      prismaServiceMock.businessUnit.upsert.mockResolvedValue({});

      const result = await service.syncBusinessUnits();

      // The cron no longer performs the cascade inline — it delegates to the
      // shared method exactly once, with the decommissioned BU's slug + value.
      expect(businessUnitsServiceMock.deactivateByBu).toHaveBeenCalledTimes(1);
      expect(businessUnitsServiceMock.deactivateByBu).toHaveBeenCalledWith(
        'mmva',
        'MMVA',
      );
      expect(result.aborted).toBe(false);
      expect(result.removed).toEqual(['mmva']);
    });

    it('delegates once per decommissioned BU when several are removed', async () => {
      mockedAxios.get.mockResolvedValue(
        hubspotPropertyResponse([{ label: 'MedVirtual' }]),
      );
      prismaServiceMock.businessUnit.findMany.mockResolvedValue([
        {
          id: '1',
          slug: 'medvirtual',
          hubspot_value: 'MedVirtual',
          is_visible: true,
        },
        { id: '2', slug: 'mmva', hubspot_value: 'MMVA', is_visible: true },
        {
          id: '3',
          slug: 'berry-virtual',
          hubspot_value: 'Berry Virtual',
          is_visible: true,
        },
      ]);
      prismaServiceMock.businessUnit.upsert.mockResolvedValue({});

      const result = await service.syncBusinessUnits();

      expect(businessUnitsServiceMock.deactivateByBu).toHaveBeenCalledTimes(2);
      expect(businessUnitsServiceMock.deactivateByBu).toHaveBeenCalledWith(
        'mmva',
        'MMVA',
      );
      expect(businessUnitsServiceMock.deactivateByBu).toHaveBeenCalledWith(
        'berry-virtual',
        'Berry Virtual',
      );
      expect(result.removed).toEqual(['mmva', 'berry-virtual']);
    });

    it('never touches BusinessUnit rows outside the reconcile diff (idempotent re-run creates no dupes)', async () => {
      mockedAxios.get.mockResolvedValue(
        hubspotPropertyResponse([
          { label: 'MedVirtual' },
          { label: 'Berry Virtual' },
        ]),
      );
      prismaServiceMock.businessUnit.findMany.mockResolvedValue([
        {
          id: '1',
          slug: 'medvirtual',
          hubspot_value: 'MedVirtual',
          is_visible: true,
        },
        {
          id: '2',
          slug: 'berry-virtual',
          hubspot_value: 'Berry Virtual',
          is_visible: true,
        },
      ]);
      prismaServiceMock.businessUnit.upsert.mockResolvedValue({});

      const result = await service.syncBusinessUnits();

      expect(prismaServiceMock.businessUnit.update).not.toHaveBeenCalled();
      expect(businessUnitsServiceMock.deactivateByBu).not.toHaveBeenCalled();
      expect(result.removed).toEqual([]);
    });

    it('aborts the reconcile step (no cascade delete) when HubSpot GET returns non-200', async () => {
      mockedAxios.get.mockResolvedValue({ status: 500, data: null });
      prismaServiceMock.businessUnit.findMany.mockResolvedValue([
        {
          id: '1',
          slug: 'medvirtual',
          hubspot_value: 'MedVirtual',
          is_visible: true,
        },
        { id: '2', slug: 'mmva', hubspot_value: 'MMVA', is_visible: true },
      ]);

      const result = await service.syncBusinessUnits();

      expect(prismaServiceMock.businessUnit.update).not.toHaveBeenCalled();
      expect(businessUnitsServiceMock.deactivateByBu).not.toHaveBeenCalled();
      expect(result.aborted).toBe(true);
    });

    it('aborts the reconcile step when options array is empty', async () => {
      mockedAxios.get.mockResolvedValue(hubspotPropertyResponse([]));
      prismaServiceMock.businessUnit.findMany.mockResolvedValue([
        {
          id: '1',
          slug: 'medvirtual',
          hubspot_value: 'MedVirtual',
          is_visible: true,
        },
      ]);

      const result = await service.syncBusinessUnits();

      expect(prismaServiceMock.businessUnit.update).not.toHaveBeenCalled();
      expect(businessUnitsServiceMock.deactivateByBu).not.toHaveBeenCalled();
      expect(result.aborted).toBe(true);
    });

    it('aborts the reconcile step when options is malformed (not an array)', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: { name: 'business_unit', options: null },
      });
      prismaServiceMock.businessUnit.findMany.mockResolvedValue([
        {
          id: '1',
          slug: 'medvirtual',
          hubspot_value: 'MedVirtual',
          is_visible: true,
        },
      ]);

      const result = await service.syncBusinessUnits();

      expect(prismaServiceMock.businessUnit.update).not.toHaveBeenCalled();
      expect(businessUnitsServiceMock.deactivateByBu).not.toHaveBeenCalled();
      expect(result.aborted).toBe(true);
    });

    it('aborts the reconcile step when the GET throws/times out', async () => {
      mockedAxios.get.mockRejectedValue(new Error('timeout'));
      prismaServiceMock.businessUnit.findMany.mockResolvedValue([
        {
          id: '1',
          slug: 'medvirtual',
          hubspot_value: 'MedVirtual',
          is_visible: true,
        },
      ]);

      const result = await service.syncBusinessUnits();

      expect(result.aborted).toBe(true);
      expect(prismaServiceMock.businessUnit.update).not.toHaveBeenCalled();
      expect(businessUnitsServiceMock.deactivateByBu).not.toHaveBeenCalled();
    });

    it('is idempotent — re-running with the same options creates no duplicate BU rows', async () => {
      mockedAxios.get.mockResolvedValue(
        hubspotPropertyResponse([{ label: 'MedVirtual' }, { label: 'MMVA' }]),
      );
      prismaServiceMock.businessUnit.findMany.mockResolvedValue([
        {
          id: '1',
          slug: 'medvirtual',
          hubspot_value: 'MedVirtual',
          is_visible: true,
        },
        { id: '2', slug: 'mmva', hubspot_value: 'MMVA', is_visible: false },
      ]);
      prismaServiceMock.businessUnit.upsert.mockResolvedValue({});

      await service.syncBusinessUnits();
      await service.syncBusinessUnits();

      // upsert (not create) is used both times — no duplicate rows possible
      expect(prismaServiceMock.businessUnit.upsert).toHaveBeenCalled();
      const createCalls = prismaServiceMock.businessUnit.create;
      expect(createCalls).toBeUndefined();
    });
  });

  describe('weeklyOfferPanelReport', () => {
    // Fri 2026-07-31 17:00Z = 10:00 PDT, the scheduled run time.
    // Window: Fri Jul 24 00:00 PT → the run instant.
    const FRIDAY = new Date('2026-07-31T17:00:00Z');
    const EXPECTED_START = '2026-07-24T07:00:00.000Z';
    const EXPECTED_END = '2026-07-31T17:00:00.000Z';
    const originalEnvironment = process.env.ENVIRONMENT;
    const originalFrontendUrl = process.env.FRONTEND_URL;

    const buildPanel = (overrides: Record<string, any> = {}) => ({
      id: 'panel-1',
      title: 'Front Desk VA Panel',
      business_unit: 'MedVirtual',
      status: 'viewed',
      is_public: false,
      recipient_name: 'Dr. Smith',
      recipient_email: 'dr.smith@sunrise.example',
      recipient_org_name: 'Sunrise Clinic',
      viewed_at: new Date('2026-07-27T15:00:00Z'),
      view_count: 1,
      decided_at: null,
      createdAt: new Date('2026-07-27T13:00:00Z'),
      created_by_user_id: 'user-1',
      createdBy: {
        id: 'user-1',
        first_name: 'Ana',
        last_name: 'Souza',
        email: 'ana@medvirtual.ai',
      },
      recipientCompany: { name: 'Sunrise Clinic' },
      _count: { candidates: 3 },
      ...overrides,
    });

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(FRIDAY);
      mailServiceMock.sendMail.mockResolvedValue(true);
      // Pin FRONTEND_URL so the report's CTA link is deterministic regardless of
      // the ambient env — otherwise a CI runner without FRONTEND_URL rendered
      // "undefined/offer-panels" and the no-undefined assertion below failed
      // (passed locally only because .env set FRONTEND_URL).
      process.env.FRONTEND_URL = 'https://app.medvirtual.ai';
    });

    afterEach(() => {
      jest.useRealTimers();
      process.env.ENVIRONMENT = originalEnvironment;
      if (originalFrontendUrl === undefined) {
        delete process.env.FRONTEND_URL;
      } else {
        process.env.FRONTEND_URL = originalFrontendUrl;
      }
    });

    it('sends the email even when no panels were created that week', async () => {
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([]);

      const result = await service.weeklyOfferPanelReport();

      expect(mailServiceMock.sendMail).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        sent: true,
        totalPanels: 0,
        totalCreators: 0,
      });
    });

    it('queries the exact rolling 8-day PT window ending at the run instant', async () => {
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([]);

      await service.weeklyOfferPanelReport();

      const where =
        prismaServiceMock.offerPanel.findMany.mock.calls[0][0].where;
      expect(where.createdAt.gte.toISOString()).toBe(EXPECTED_START);
      expect(where.createdAt.lte.toISOString()).toBe(EXPECTED_END);
    });

    it('orders creator sections by panel count descending', async () => {
      const panelFor = (userId: string, name: string, index: number) =>
        buildPanel({
          id: `${userId}-${index}`,
          created_by_user_id: userId,
          createdBy: {
            id: userId,
            first_name: name,
            last_name: 'X',
            email: `${userId}@medvirtual.ai`,
          },
        });

      prismaServiceMock.offerPanel.findMany.mockResolvedValue([
        panelFor('user-a', 'Aaa', 1),
        panelFor('user-b', 'Bbb', 1),
        panelFor('user-b', 'Bbb', 2),
        panelFor('user-b', 'Bbb', 3),
        panelFor('user-c', 'Ccc', 1),
        panelFor('user-c', 'Ccc', 2),
      ]);

      await service.weeklyOfferPanelReport();

      const html = mailServiceMock.sendMail.mock.calls[0][0].html;
      expect(html.indexOf('Bbb X')).toBeLessThan(html.indexOf('Ccc X'));
      expect(html.indexOf('Ccc X')).toBeLessThan(html.indexOf('Aaa X'));
    });

    it('breaks ties alphabetically by creator name', async () => {
      const panelFor = (userId: string, name: string, index: number) =>
        buildPanel({
          id: `${userId}-${index}`,
          created_by_user_id: userId,
          createdBy: {
            id: userId,
            first_name: name,
            last_name: 'Zed',
            email: `${userId}@medvirtual.ai`,
          },
        });

      prismaServiceMock.offerPanel.findMany.mockResolvedValue([
        panelFor('user-z', 'Zoe', 1),
        panelFor('user-z', 'Zoe', 2),
        panelFor('user-m', 'Marco', 1),
        panelFor('user-m', 'Marco', 2),
      ]);

      await service.weeklyOfferPanelReport();

      const html = mailServiceMock.sendMail.mock.calls[0][0].html;
      expect(html.indexOf('Marco Zed')).toBeLessThan(html.indexOf('Zoe Zed'));
    });

    it('falls back to the creator email when the name parts are empty', async () => {
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([
        buildPanel({
          createdBy: {
            id: 'user-1',
            first_name: '',
            last_name: '',
            email: 'nameless@medvirtual.ai',
          },
        }),
      ]);

      await service.weeklyOfferPanelReport();

      const html = mailServiceMock.sendMail.mock.calls[0][0].html;
      expect(html).toContain('nameless@medvirtual.ai');
    });

    it('renders panels with no view or decision without leaking bad values', async () => {
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([
        buildPanel({
          status: 'sent',
          viewed_at: null,
          decided_at: null,
          view_count: 0,
          recipient_org_name: null,
          recipientCompany: null,
        }),
      ]);

      await service.weeklyOfferPanelReport();

      const html = mailServiceMock.sendMail.mock.calls[0][0].html;
      expect(html).not.toContain('NaN');
      expect(html).not.toContain('Invalid Date');
      expect(html).not.toContain('undefined');
      // recipient_org_name is null, so the contact name is used instead.
      expect(html).toContain('Dr. Smith');
    });

    it('does not repeat the recipient email when no name or org is available', async () => {
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([
        buildPanel({
          recipient_org_name: null,
          recipientCompany: null,
          recipient_name: null,
        }),
      ]);

      await service.weeklyOfferPanelReport();

      const html = mailServiceMock.sendMail.mock.calls[0][0].html;
      const occurrences = html.split('dr.smith@sunrise.example').length - 1;
      expect(occurrences).toBe(1);
    });

    it('sends to all three stakeholders in PROD', async () => {
      process.env.ENVIRONMENT = 'PROD';
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([]);

      await service.weeklyOfferPanelReport();

      expect(mailServiceMock.sendMail.mock.calls[0][0].to).toEqual([
        'hanieh@berryvirtual.com',
        'paulo@regenta.ai',
        'shayan@regenta.ai',
      ]);
    });

    it('sends only to the engineering address outside PROD', async () => {
      process.env.ENVIRONMENT = 'STAGE';
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([]);

      await service.weeklyOfferPanelReport();

      expect(mailServiceMock.sendMail.mock.calls[0][0].to).toEqual([
        'paulo@regenta.ai',
      ]);
    });

    it('returns sent:false instead of throwing when the email fails', async () => {
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([]);
      mailServiceMock.sendMail.mockRejectedValue(new Error('resend down'));

      const result = await service.weeklyOfferPanelReport();

      expect(result.sent).toBe(false);
      expect(result.error).toContain('resend down');
    });

    it('builds the subject in code without consulting EmailTemplatesService', async () => {
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([]);

      await service.weeklyOfferPanelReport();

      expect(mailServiceMock.sendMail.mock.calls[0][0].subject).toBe(
        'Offer Panel Report — Jul 24, 2026 to Jul 31, 2026',
      );
      expect(
        emailTemplatesServiceMock.getTemplateContent,
      ).not.toHaveBeenCalled();
    });

    it('emits no placeholder tokens that MailService would strip', async () => {
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([buildPanel()]);

      await service.weeklyOfferPanelReport();

      const html = mailServiceMock.sendMail.mock.calls[0][0].html;
      expect(html).not.toMatch(/\{\{|\[\[/);
    });

    it('flags an off-schedule run and still reports the trailing 8 days', async () => {
      // Wed 2026-07-29 07:00 PDT.
      jest.setSystemTime(new Date('2026-07-29T14:00:00Z'));
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([]);

      const result = await service.weeklyOfferPanelReport();

      expect(result.ranOnFridayPt).toBe(false);
      expect(result.weekStart).toBe('2026-07-22T07:00:00.000Z');
      expect(result.weekEnd).toBe('2026-07-29T14:00:00.000Z');
      expect(mailServiceMock.sendMail.mock.calls[0][0].html).toContain(
        'outside the usual Friday schedule',
      );
    });

    it('closes the window at the run instant rather than the end of the day', async () => {
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([]);

      const result = await service.weeklyOfferPanelReport();

      // 10:00 PT Friday — the remaining ~14h of the day have not happened yet
      // and must not be advertised as covered.
      expect(result.weekEnd).toBe(FRIDAY.toISOString());
    });

    it('replays a past window at the scheduled 10:00 PT dispatch time when week_of is supplied', async () => {
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([]);

      // Wed 2026-01-28 10:00 PST === 18:00Z; window opens Wed 2026-01-21.
      const result = await service.weeklyOfferPanelReport('2026-01-28');

      const where =
        prismaServiceMock.offerPanel.findMany.mock.calls[0][0].where;
      expect(where.createdAt.gte.toISOString()).toBe(
        '2026-01-21T08:00:00.000Z',
      );
      expect(where.createdAt.lte.toISOString()).toBe(
        '2026-01-28T18:00:00.000Z',
      );
      expect(result.ranOnFridayPt).toBe(false);
    });

    it('marks a Friday backfill as on-schedule', async () => {
      prismaServiceMock.offerPanel.findMany.mockResolvedValue([]);

      const result = await service.weeklyOfferPanelReport('2026-01-30');

      expect(result.ranOnFridayPt).toBe(true);
      expect(result.weekStart).toBe('2026-01-23T08:00:00.000Z');
      expect(mailServiceMock.sendMail.mock.calls[0][0].html).not.toContain(
        'outside the usual Friday schedule',
      );
    });

    it('rejects a malformed week_of value', async () => {
      await expect(
        service.weeklyOfferPanelReport('not-a-date'),
      ).rejects.toThrow(/Expected format YYYY-MM-DD/);
    });
  });
});
