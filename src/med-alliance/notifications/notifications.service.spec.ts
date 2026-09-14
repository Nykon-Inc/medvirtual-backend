import { Test, TestingModule } from '@nestjs/testing';
import { AllianceNotificationsService } from './notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { EmailTemplatesService } from '../../email-templates/email-templates.service';

const mockMail = { sendMail: jest.fn() };
const mockPrisma = {};
const mockEmailTemplates = {
  getTemplateContent: jest.fn().mockResolvedValue(null),
};

const affiliate = { email: 'partner@test.com', first_name: 'Jane' };

describe('AllianceNotificationsService', () => {
  let service: AllianceNotificationsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AllianceNotificationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MailService, useValue: mockMail },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();

    service = module.get<AllianceNotificationsService>(
      AllianceNotificationsService,
    );
    process.env.ENVIRONMENT = 'DEV';
    process.env.FRONTEND_URL = 'https://app.test';
  });

  // ---------------------------------------------------------------------------
  // Partner-facing notifications
  // ---------------------------------------------------------------------------

  describe('notifyCommissionEligible', () => {
    it('sends email with correct subject and new body wording', async () => {
      await service.notifyCommissionEligible(affiliate, {
        organizationName: 'Clinic A',
        commissionAmount: 150,
        commissionPercent: 10,
      });

      expect(mockMail.sendMail).toHaveBeenCalledTimes(1);
      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.to).toBe(affiliate.email);
      expect(call.subject).toBe(
        'Your commission is ready — $150.00 from Clinic A',
      );
      expect(call.html).toContain('Great news!');
      expect(call.html).toContain(
        "This means you can request a transfer to your account whenever you're ready.",
      );
      expect(call.html).toContain(
        'Head to your earnings dashboard to request your payout',
      );
    });

    it('does not throw when mail fails', async () => {
      mockMail.sendMail.mockRejectedValueOnce(new Error('SMTP down'));
      await expect(
        service.notifyCommissionEligible(affiliate, {
          organizationName: 'Clinic A',
          commissionAmount: 50,
          commissionPercent: 5,
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('notifyPayoutProcessing', () => {
    it('sends email with correct subject and updated body', async () => {
      await service.notifyPayoutProcessing(affiliate, {
        totalAmount: 300,
        processedAt: new Date('2026-06-08'),
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.subject).toBe('Your payout of $300.00 is being processed');
      expect(call.html).toContain(
        "We've received your payout request and it's currently being processed.",
      );
      expect(call.html).toContain('Request submitted on');
      expect(call.html).toContain('In the meantime,');
    });

    it('does not throw when mail fails', async () => {
      mockMail.sendMail.mockRejectedValueOnce(new Error('timeout'));
      await expect(
        service.notifyPayoutProcessing(affiliate, {
          totalAmount: 100,
          processedAt: new Date(),
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('notifyPayoutPaid', () => {
    it('sends email with updated subject and body', async () => {
      await service.notifyPayoutPaid(affiliate, {
        totalAmount: 500,
        paidAt: new Date('2026-06-08'),
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.subject).toBe(
        'Your payout of $500.00 has been sent — money is on its way!',
      );
      expect(call.html).toContain('Your payout has been sent!');
      expect(call.html).toContain('Sent on');
      expect(call.html).toContain(
        'You can view this payment and your full payout history',
      );
    });

    it('does not throw when mail fails', async () => {
      mockMail.sendMail.mockRejectedValueOnce(new Error('fail'));
      await expect(
        service.notifyPayoutPaid(affiliate, {
          totalAmount: 200,
          paidAt: new Date(),
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('notifyPayoutCancelled', () => {
    it('sends email with soft subject and updated body', async () => {
      await service.notifyPayoutCancelled(affiliate, {
        totalAmount: 250,
        cancellationReason: 'Duplicate request',
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.subject).toBe('Update on your payout request of $250.00');
      expect(call.html).toContain(
        'We wanted to let you know that your recent payout request has been cancelled',
      );
      expect(call.html).toContain('Why it was cancelled');
      expect(call.html).toContain('Duplicate request');
      expect(call.html).toContain('The good news:');
    });

    it('omits reason block when no cancellationReason provided', async () => {
      await service.notifyPayoutCancelled(affiliate, { totalAmount: 100 });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.html).not.toContain('Why it was cancelled');
    });

    it('does not throw when mail fails', async () => {
      mockMail.sendMail.mockRejectedValueOnce(new Error('fail'));
      await expect(
        service.notifyPayoutCancelled(affiliate, { totalAmount: 50 }),
      ).resolves.not.toThrow();
    });
  });

  describe('notifyReferralStageChanged', () => {
    it('sends email with formatted subject using stageToLabel', async () => {
      await service.notifyReferralStageChanged(affiliate, {
        organizationName: 'MedGroup',
        previousStage: 'contacted',
        newStage: 'contract_signed',
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.subject).toBe(
        'Pipeline update: MedGroup is now at "Contract Signed"',
      );
      expect(call.html).toContain('Good news');
      expect(call.html).toContain('progressed to a new stage');
      expect(call.html).toContain('track their progress toward deployment');
    });

    it('does not throw when mail fails', async () => {
      mockMail.sendMail.mockRejectedValueOnce(new Error('fail'));
      await expect(
        service.notifyReferralStageChanged(affiliate, {
          organizationName: 'Org',
          previousStage: 'referred',
          newStage: 'deployed',
        }),
      ).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Admin notifications
  // ---------------------------------------------------------------------------

  describe('notifyAdminPayoutRequested', () => {
    it('sends email to admin with correct subject', async () => {
      await service.notifyAdminPayoutRequested({
        affiliateName: 'John Doe',
        totalAmount: 400,
        commissionCount: 3,
        payoutRequestId: 'req-1',
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.subject).toBe('Payout request from John Doe — $400.00');
    });

    it('does not throw when mail fails', async () => {
      mockMail.sendMail.mockRejectedValueOnce(new Error('fail'));
      await expect(
        service.notifyAdminPayoutRequested({
          affiliateName: 'John',
          totalAmount: 100,
          commissionCount: 1,
          payoutRequestId: 'req-x',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('notifyAdminCommissionPending', () => {
    it('sends email with updated body copy', async () => {
      await service.notifyAdminCommissionPending({
        organizationName: 'Clinic B',
        affiliateName: 'Partner X',
        commissionAmount: 200,
        commissionId: 'com-1',
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.subject).toBe('Commission ready for review — Clinic B');
      expect(call.html).toContain('A new commission is ready for your review.');
      expect(call.html).toContain('Please approve or reject it');
    });
  });

  describe('notifyAdminCommissionReverted', () => {
    it('sends email with updated body copy', async () => {
      await service.notifyAdminCommissionReverted({
        organizationName: 'Clinic C',
        affiliateName: 'Partner Y',
        commissionAmount: 300,
        commissionId: 'com-2',
        revertedByName: 'Admin Z',
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.subject).toBe('Commission reverted to Pending — Clinic C');
      expect(call.html).toContain(
        'An admin has reverted a commission back to pending review.',
      );
      expect(call.html).toContain(
        'Please check the details below and take action.',
      );
    });
  });

  describe('notifyAdminReferralNew', () => {
    it('builds subject with affiliate name when no admin name', async () => {
      await service.notifyAdminReferralNew({
        organizationName: 'New Clinic',
        affiliateName: 'Partner A',
        referredCompanyId: 'org-1',
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.subject).toBe(
        'New referral: New Clinic referred by Partner A',
      );
    });

    it('builds subject with admin name when admin initiated', async () => {
      await service.notifyAdminReferralNew({
        organizationName: 'New Clinic',
        affiliateName: 'Partner A',
        referredCompanyId: 'org-1',
        adminName: 'Admin B',
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.subject).toBe(
        'New referral: New Clinic — initiated by Admin B',
      );
    });
  });

  describe('notifyAdminInvoiceReassociated', () => {
    it('sends email with the re-association subject and both company names', async () => {
      await service.notifyAdminInvoiceReassociated({
        invoiceHubspotId: '200',
        invoiceNumber: 'INV-9',
        oldOrganizationName: 'Old Org',
        newOrganizationName: 'New Org',
        oldAffiliateName: 'Xavier X',
        newAffiliateName: 'Yara Y',
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.to).toBe('paulo@regenta.ai');
      expect(call.subject).toBe(
        'Invoice re-associated to a different company — needs review',
      );
      expect(call.html).toContain('Old Org');
      expect(call.html).toContain('New Org');
    });

    it('does not throw when mail fails', async () => {
      mockMail.sendMail.mockRejectedValueOnce(new Error('SMTP down'));
      await expect(
        service.notifyAdminInvoiceReassociated({
          invoiceHubspotId: '200',
          oldOrganizationName: 'Old Org',
          newOrganizationName: 'New Org',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('notifyAdminPartnerRegistered', () => {
    it('sends email with correct subject', async () => {
      await service.notifyAdminPartnerRegistered({
        partnerName: 'New Partner',
        partnerEmail: 'partner@example.com',
        affiliateProfileId: 'profile-1',
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.subject).toBe('New Alliance partner registered: New Partner');
    });
  });

  describe('notifyAdminDailyCommissionSummary', () => {
    it('sends email with count and total in subject', async () => {
      await service.notifyAdminDailyCommissionSummary({
        commissions: [
          {
            organizationName: 'Org A',
            affiliateName: 'Partner A',
            commissionAmount: 100,
            commissionId: 'c1',
          },
          {
            organizationName: 'Org B',
            affiliateName: 'Partner B',
            commissionAmount: 200,
            commissionId: 'c2',
          },
        ],
        totalAmount: 300,
        reportDate: new Date('2026-06-08'),
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.subject).toBe(
        'Daily commission review — 2 pending ($300.00)',
      );
    });
  });

  describe('notifyAdminMarkPaidError', () => {
    it('sends email to paulo@regenta.ai with phase in subject', async () => {
      await service.notifyAdminMarkPaidError({
        payoutRequestId: 'req-1',
        adminName: 'Admin A',
        errorPhase: 'bill-creation',
        errorMessage: 'timeout',
        amount: 150,
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.to).toBe('paulo@regenta.ai');
      expect(call.subject).toContain('markPaid() error at "bill-creation"');
      expect(call.subject).toContain('$150.00');
    });

    it('omits amount from subject when amount is undefined', async () => {
      await service.notifyAdminMarkPaidError({
        payoutRequestId: 'req-2',
        adminName: 'Admin A',
        errorPhase: 'db-update',
        errorMessage: 'connection refused',
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.subject).not.toContain('$');
    });

    it('does not throw when mail fails', async () => {
      mockMail.sendMail.mockRejectedValueOnce(new Error('fail'));
      await expect(
        service.notifyAdminMarkPaidError({
          payoutRequestId: 'req-3',
          adminName: 'Admin A',
          errorPhase: 'db-update',
          errorMessage: 'error',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('notifyAdminPaymentFailed', () => {
    it('sends email with bill.com failure subject', async () => {
      await service.notifyAdminPaymentFailed({
        partnerName: 'Partner Z',
        amount: 800,
        billIds: 'bill-123',
        payoutRequestId: 'req-99',
        errorMsg: 'declined',
      });

      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.subject).toBe(
        'Bill.com payment failed — Partner Z ($800.00)',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // buildFrom helper
  // ---------------------------------------------------------------------------

  describe('buildFrom (via email from field)', () => {
    it('passes from without [DEV] prefix to MailService (prefix is applied by MailService)', async () => {
      await service.notifyCommissionEligible(affiliate, {
        organizationName: 'Org',
        commissionAmount: 10,
        commissionPercent: 5,
      });
      const call = mockMail.sendMail.mock.calls[0][0];
      expect(call.from).toContain('MedVirtual');
      expect(call.from).toContain('noreply@medvirtual.ai');
      expect(call.from).not.toContain('[DEV]');
    });
  });
});
