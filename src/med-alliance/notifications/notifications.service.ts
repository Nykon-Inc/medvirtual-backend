import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { EmailTheme } from '../../common/utils/email-templates/theme';
import { getBusinessUnitEmailTheme } from '../../common/utils/email-templates/theme-helper';
import { EmailTemplatesService } from '../../email-templates/email-templates.service';
import {
  commissionEligibleTemplate,
  CommissionEligiblePayload,
} from './templates/commission-eligible';
import { payoutPaidTemplate, PayoutPaidPayload } from './templates/payout-paid';
import {
  payoutCancelledTemplate,
  PayoutCancelledPayload,
} from './templates/payout-cancelled';
import {
  referralStageChangedTemplate,
  ReferralStageChangedPayload,
  stageToLabel,
} from './templates/referral-stage-changed';
import {
  adminPayoutRequestedTemplate,
  AdminPayoutRequestedPayload,
} from './templates/admin-payout-requested';
import {
  adminCommissionPendingTemplate,
  AdminCommissionPendingPayload,
} from './templates/admin-commission-pending';
import {
  adminReferralNewTemplate,
  AdminReferralNewPayload,
} from './templates/admin-referral-new';
import {
  adminPartnerRegisteredTemplate,
  AdminPartnerRegisteredPayload,
} from './templates/admin-partner-registered';
import {
  adminPaymentFailedTemplate,
  AdminPaymentFailedPayload,
} from './templates/admin-payment-failed';
import {
  adminCommissionRevertedTemplate,
  AdminCommissionRevertedPayload,
} from './templates/admin-commission-reverted';
import {
  adminCommissionPendingSummaryTemplate,
  AdminCommissionPendingSummaryPayload,
} from './templates/admin-commission-pending-summary';
import {
  adminReferredOrgDeletedTemplate,
  AdminReferredOrgDeletedPayload,
} from './templates/admin-referred-org-deleted';
import {
  adminReferredOrgRestoredTemplate,
  AdminReferredOrgRestoredPayload,
} from './templates/admin-referred-org-restored';
import {
  adminInvoiceReassociatedTemplate,
  AdminInvoiceReassociatedPayload,
} from './templates/admin-invoice-reassociated';
import { payoutProcessingTemplate } from './templates/payout-processing';
import {
  adminMarkPaidErrorTemplate,
  AdminMarkPaidErrorPayload,
} from './templates/admin-markpaid-error';
import { FRONTEND_ROUTES } from '../../common/utils/frontend-routes';

@Injectable()
export class AllianceNotificationsService {
  private readonly logger = new Logger(AllianceNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly emailTemplates: EmailTemplatesService,
  ) {}

  // ── EmailTemplatesService fallback helper ──────────────────────────────────
  private async getTplContent(
    key: string,
    runtimeValues: Record<string, string>,
    theme: EmailTheme,
  ): Promise<{ subject: string; html: string } | null> {
    try {
      return await this.emailTemplates.getTemplateContent(
        key,
        runtimeValues,
        theme,
      );
    } catch {
      return null;
    }
  }

  // Resolves the MedVirtual theme from EmailBranding (DB) so custom design —
  // including buttonColor / buttonTextColor / layoutPreset — is applied.
  // Falls back to the hardcoded theme inside getBusinessUnitEmailTheme.
  private async defaultTheme(): Promise<EmailTheme> {
    return getBusinessUnitEmailTheme(this.prisma, 'MedVirtual');
  }

  private buildFrom(theme?: EmailTheme): string {
    const name = theme?.companyName || 'MedVirtual';
    return `${name} <noreply@medvirtual.ai>`;
  }

  private getAdminEmails(): string[] {
    const isProduction = process.env.ENVIRONMENT === 'PROD';
    return isProduction ? ['hanieh@berryvirtual.com'] : ['paulo@regenta.ai'];

    //on 2026/06/03 Pauli ask me to replace this logic below to the logic above after Kimberly received the email about pending commission
    /*const admins = await this.prisma.uSER.findMany({
      where: {
        role: { in: ['system_admin', 'system_super_admin'] },
        status: 'active',
      },
      select: { email: true },
    });
    return admins.map((a) => a.email);
    */
  }

  async notifyCommissionEligible(
    affiliate: { email: string; first_name: string },
    payload: Omit<CommissionEligiblePayload, 'firstName'>,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const fallbackHtml = commissionEligibleTemplate(
        { firstName: affiliate.first_name, ...payload },
        resolvedTheme,
      );
      const fallbackSubject = `Your commission is ready — $${payload.commissionAmount.toFixed(2)} from ${payload.organizationName}`;
      const tpl = await this.getTplContent(
        'alliance-commission-eligible',
        {
          '{{firstName}}': affiliate.first_name,
          '{{organizationName}}': payload.organizationName,
          '{{commissionAmount}}': payload.commissionAmount.toFixed(2),
          '{{commissionPercent}}': String(payload.commissionPercent),
          '{{earningsUrl}}': `${process.env.FRONTEND_URL}/modules/alliance/partner/earnings`,
        },
        resolvedTheme,
      );
      await this.mail.sendMail({
        from: this.buildFrom(resolvedTheme),
        to: affiliate.email,
        subject: tpl?.subject ?? fallbackSubject,
        html: tpl?.html ?? fallbackHtml,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send commission eligible email to ${affiliate.email}`,
        err,
      );
    }
  }

  async notifyPayoutCancelled(
    affiliate: { email: string; first_name: string },
    payload: Omit<PayoutCancelledPayload, 'firstName'>,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const fallbackHtml = payoutCancelledTemplate(
        { firstName: affiliate.first_name, ...payload },
        resolvedTheme,
      );
      const fallbackSubject = `Update on your payout request of $${payload.totalAmount.toFixed(2)}`;
      const tpl = await this.getTplContent(
        'alliance-payout-cancelled',
        {
          '{{firstName}}': affiliate.first_name,
          '{{totalAmount}}': payload.totalAmount.toFixed(2),
          '{{cancellationReason}}': payload.cancellationReason
            ? `Why it was cancelled: ${payload.cancellationReason}`
            : '',
          '{{payoutsUrl}}': `${process.env.FRONTEND_URL}/modules/alliance/partner/payouts`,
        },
        resolvedTheme,
      );
      await this.mail.sendMail({
        from: this.buildFrom(resolvedTheme),
        to: affiliate.email,
        subject: tpl?.subject ?? fallbackSubject,
        html: tpl?.html ?? fallbackHtml,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send payout cancelled email to ${affiliate.email}`,
        err,
      );
    }
  }

  async notifyPayoutProcessing(
    affiliate: { email: string; first_name: string },
    payload: Omit<
      { firstName: string; totalAmount: number; processedAt: Date },
      'firstName'
    >,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const fallbackHtml = payoutProcessingTemplate(
        { firstName: affiliate.first_name, ...payload },
        resolvedTheme,
      );
      const fallbackSubject = `Your payout of $${payload.totalAmount.toFixed(2)} is being processed`;
      const tpl = await this.getTplContent(
        'alliance-payout-processing',
        {
          '{{firstName}}': affiliate.first_name,
          '{{totalAmount}}': payload.totalAmount.toFixed(2),
          '{{processedDate}}': new Date(payload.processedAt).toLocaleDateString(
            'en-US',
          ),
          '{{payoutsUrl}}': `${process.env.FRONTEND_URL}/modules/alliance/partner/payouts`,
        },
        resolvedTheme,
      );
      await this.mail.sendMail({
        from: this.buildFrom(resolvedTheme),
        to: affiliate.email,
        subject: tpl?.subject ?? fallbackSubject,
        html: tpl?.html ?? fallbackHtml,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send payout processing email to ${affiliate.email}`,
        err,
      );
    }
  }

  async notifyPayoutPaid(
    affiliate: { email: string; first_name: string },
    payload: Omit<PayoutPaidPayload, 'firstName'>,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const fallbackHtml = payoutPaidTemplate(
        { firstName: affiliate.first_name, ...payload },
        resolvedTheme,
      );
      const fallbackSubject = `Your payout of $${payload.totalAmount.toFixed(2)} has been sent — money is on its way!`;
      const tpl = await this.getTplContent(
        'alliance-payout-paid',
        {
          '{{firstName}}': affiliate.first_name,
          '{{totalAmount}}': payload.totalAmount.toFixed(2),
          '{{paidDate}}': new Date(payload.paidAt).toLocaleDateString('en-US'),
          '{{payoutsUrl}}': `${process.env.FRONTEND_URL}/modules/alliance/partner/payouts`,
        },
        resolvedTheme,
      );
      await this.mail.sendMail({
        from: this.buildFrom(resolvedTheme),
        to: affiliate.email,
        subject: tpl?.subject ?? fallbackSubject,
        html: tpl?.html ?? fallbackHtml,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send payout paid email to ${affiliate.email}`,
        err,
      );
    }
  }

  async notifyReferralStageChanged(
    affiliate: { email: string; first_name: string },
    payload: Omit<ReferralStageChangedPayload, 'firstName'>,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const fallbackHtml = referralStageChangedTemplate(
        { firstName: affiliate.first_name, ...payload },
        resolvedTheme,
      );
      const fallbackSubject = `Pipeline update: ${payload.organizationName} is now at "${stageToLabel(payload.newStage)}"`;
      const tpl = await this.getTplContent(
        'alliance-referral-stage-changed',
        {
          '{{firstName}}': affiliate.first_name,
          '{{organizationName}}': payload.organizationName,
          '{{previousStage}}': stageToLabel(payload.previousStage),
          '{{newStage}}': stageToLabel(payload.newStage),
          '{{referralsUrl}}': `${process.env.FRONTEND_URL}/modules/alliance/partner/referred`,
        },
        resolvedTheme,
      );
      await this.mail.sendMail({
        from: this.buildFrom(resolvedTheme),
        to: affiliate.email,
        subject: tpl?.subject ?? fallbackSubject,
        html: tpl?.html ?? fallbackHtml,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send referral stage changed email to ${affiliate.email}`,
        err,
      );
    }
  }

  async notifyAdminPayoutRequested(
    payload: AdminPayoutRequestedPayload,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const adminEmails = this.getAdminEmails();
      const fallbackSubject = `Payout request from ${payload.affiliateName} — $${payload.totalAmount.toFixed(2)}`;
      const fallbackHtml = adminPayoutRequestedTemplate(payload, resolvedTheme);
      const tpl = await this.getTplContent(
        'alliance-admin-payout-requested',
        {
          '{{affiliateName}}': payload.affiliateName,
          '{{totalAmount}}': payload.totalAmount.toFixed(2),
          '{{commissionCount}}': String(payload.commissionCount),
          '{{payoutRequestId}}': payload.payoutRequestId,
          '{{payoutRequestsUrl}}': `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminPayoutRequests}`,
        },
        resolvedTheme,
      );
      for (const email of adminEmails) {
        try {
          await this.mail.sendMail({
            from: this.buildFrom(resolvedTheme),
            to: email,
            subject: tpl?.subject ?? fallbackSubject,
            html: tpl?.html ?? fallbackHtml,
          });
        } catch (err) {
          this.logger.error(
            `Failed to send admin payout requested email to ${email}`,
            err,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        'Failed to send admin payout requested notifications',
        err,
      );
    }
  }

  async notifyAdminCommissionPending(
    payload: AdminCommissionPendingPayload,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const adminEmails = this.getAdminEmails();
      const fallbackSubject = `Commission ready for review — ${payload.organizationName}`;
      const fallbackHtml = adminCommissionPendingTemplate(
        payload,
        resolvedTheme,
      );
      const tpl = await this.getTplContent(
        'alliance-admin-commission-pending',
        {
          '{{organizationName}}': payload.organizationName,
          '{{affiliateName}}': payload.affiliateName,
          '{{commissionAmount}}': payload.commissionAmount.toFixed(2),
          '{{commissionId}}': payload.commissionId,
          '{{commissionsUrl}}': `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminCommissions}`,
        },
        resolvedTheme,
      );
      for (const email of adminEmails) {
        try {
          await this.mail.sendMail({
            from: this.buildFrom(resolvedTheme),
            to: email,
            subject: tpl?.subject ?? fallbackSubject,
            html: tpl?.html ?? fallbackHtml,
          });
        } catch (err) {
          this.logger.error(
            `Failed to send admin commission pending email to ${email}`,
            err,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        'Failed to send admin commission pending notifications',
        err,
      );
    }
  }

  async notifyAdminCommissionReverted(
    payload: AdminCommissionRevertedPayload,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const adminEmails = this.getAdminEmails();
      const fallbackSubject = `Commission reverted to Pending — ${payload.organizationName}`;
      const fallbackHtml = adminCommissionRevertedTemplate(
        payload,
        resolvedTheme,
      );
      const tpl = await this.getTplContent(
        'alliance-admin-commission-reverted',
        {
          '{{organizationName}}': payload.organizationName,
          '{{affiliateName}}': payload.affiliateName,
          '{{commissionAmount}}': payload.commissionAmount.toFixed(2),
          '{{commissionId}}': payload.commissionId,
          '{{revertedByName}}': payload.revertedByName,
          '{{commissionsUrl}}': `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminCommissions}`,
        },
        resolvedTheme,
      );
      for (const email of adminEmails) {
        try {
          await this.mail.sendMail({
            from: this.buildFrom(resolvedTheme),
            to: email,
            subject: tpl?.subject ?? fallbackSubject,
            html: tpl?.html ?? fallbackHtml,
          });
        } catch (err) {
          this.logger.error(
            `Failed to send admin commission reverted email to ${email}`,
            err,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        'Failed to send admin commission reverted notifications',
        err,
      );
    }
  }

  async notifyAdminReferredOrgDeleted(
    payload: AdminReferredOrgDeletedPayload,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const adminEmails = this.getAdminEmails();
      const fallbackSubject = `Referred company deleted in HubSpot — ${payload.organizationName}`;
      const fallbackHtml = adminReferredOrgDeletedTemplate(
        payload,
        resolvedTheme,
      );
      const tpl = await this.getTplContent(
        'alliance-admin-referred-org-deleted',
        {
          '{{organizationName}}': payload.organizationName,
          '{{affiliateName}}': payload.affiliateName,
          '{{commissionsVoided}}': String(payload.commissionsVoided),
          '{{commissionsInPendingPayout}}': String(
            payload.commissionsInPendingPayout,
          ),
          '{{pipelineUrl}}': `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminPipeline}`,
        },
        resolvedTheme,
      );
      for (const email of adminEmails) {
        try {
          await this.mail.sendMail({
            from: this.buildFrom(resolvedTheme),
            to: email,
            subject: tpl?.subject ?? fallbackSubject,
            html: tpl?.html ?? fallbackHtml,
          });
        } catch (err) {
          this.logger.error(
            `Failed to send admin referred org deleted email to ${email}`,
            err,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        'Failed to send admin referred org deleted notifications',
        err,
      );
    }
  }

  async notifyAdminReferredOrgRestored(
    payload: AdminReferredOrgRestoredPayload,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const adminEmails = this.getAdminEmails();
      const fallbackSubject = `Referred company restored in HubSpot — ${payload.organizationName}`;
      const fallbackHtml = adminReferredOrgRestoredTemplate(
        payload,
        resolvedTheme,
      );
      const tpl = await this.getTplContent(
        'alliance-admin-referred-org-restored',
        {
          '{{organizationName}}': payload.organizationName,
          '{{affiliateName}}': payload.affiliateName,
          '{{pipelineUrl}}': `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminPipeline}`,
        },
        resolvedTheme,
      );
      for (const email of adminEmails) {
        try {
          await this.mail.sendMail({
            from: this.buildFrom(resolvedTheme),
            to: email,
            subject: tpl?.subject ?? fallbackSubject,
            html: tpl?.html ?? fallbackHtml,
          });
        } catch (err) {
          this.logger.error(
            `Failed to send admin referred org restored email to ${email}`,
            err,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        'Failed to send admin referred org restored notifications',
        err,
      );
    }
  }

  async notifyAdminInvoiceReassociated(
    payload: AdminInvoiceReassociatedPayload,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      // This alert intentionally goes to a single dedicated recipient rather
      // than the general Med Alliance admin list.
      const adminEmails = ['paulo@regenta.ai'];
      const fallbackSubject = `Invoice re-associated to a different company — needs review`;
      const fallbackHtml = adminInvoiceReassociatedTemplate(
        payload,
        resolvedTheme,
      );
      const tpl = await this.getTplContent(
        'alliance-admin-invoice-reassociated',
        {
          '{{invoiceHubspotId}}': payload.invoiceHubspotId,
          '{{invoiceNumber}}': payload.invoiceNumber ?? '',
          '{{oldOrganizationName}}': payload.oldOrganizationName,
          '{{newOrganizationName}}': payload.newOrganizationName,
          '{{oldAffiliateName}}': payload.oldAffiliateName ?? '',
          '{{newAffiliateName}}': payload.newAffiliateName ?? '',
          '{{pipelineUrl}}': `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminPipeline}`,
        },
        resolvedTheme,
      );
      for (const email of adminEmails) {
        try {
          await this.mail.sendMail({
            from: this.buildFrom(resolvedTheme),
            to: email,
            subject: tpl?.subject ?? fallbackSubject,
            html: tpl?.html ?? fallbackHtml,
          });
        } catch (err) {
          this.logger.error(
            `Failed to send admin invoice re-associated email to ${email}`,
            err,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        'Failed to send admin invoice re-associated notifications',
        err,
      );
    }
  }

  async notifyAdminReferralNew(
    payload: AdminReferralNewPayload,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const adminEmails = this.getAdminEmails();
      const fallbackSubject = payload.adminName
        ? `New referral: ${payload.organizationName} — initiated by ${payload.adminName}`
        : `New referral: ${payload.organizationName} referred by ${payload.affiliateName}`;
      const fallbackHtml = adminReferralNewTemplate(payload, resolvedTheme);
      const tpl = await this.getTplContent(
        'alliance-admin-referral-new',
        {
          '{{organizationName}}': payload.organizationName,
          '{{affiliateName}}': payload.affiliateName,
          '{{referredCompanyId}}': payload.referredCompanyId,
          '{{pipelineUrl}}': `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminPipeline}`,
        },
        resolvedTheme,
      );
      for (const email of adminEmails) {
        try {
          await this.mail.sendMail({
            from: this.buildFrom(resolvedTheme),
            to: email,
            subject: tpl?.subject ?? fallbackSubject,
            html: tpl?.html ?? fallbackHtml,
          });
        } catch (err) {
          this.logger.error(
            `Failed to send admin new referral email to ${email}`,
            err,
          );
        }
      }
    } catch (err) {
      this.logger.error('Failed to send admin new referral notifications', err);
    }
  }

  async notifyAdminPartnerRegistered(
    payload: AdminPartnerRegisteredPayload,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const adminEmails = this.getAdminEmails();
      const fallbackSubject = `New Alliance partner registered: ${payload.partnerName}`;
      const fallbackHtml = adminPartnerRegisteredTemplate(
        payload,
        resolvedTheme,
      );
      const tpl = await this.getTplContent(
        'alliance-admin-partner-registered',
        {
          '{{partnerName}}': payload.partnerName,
          '{{partnerEmail}}': payload.partnerEmail,
          '{{affiliateProfileId}}': payload.affiliateProfileId,
          '{{partnersUrl}}': `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminPartners}`,
        },
        resolvedTheme,
      );
      for (const email of adminEmails) {
        try {
          await this.mail.sendMail({
            from: this.buildFrom(resolvedTheme),
            to: email,
            subject: tpl?.subject ?? fallbackSubject,
            html: tpl?.html ?? fallbackHtml,
          });
        } catch (err) {
          this.logger.error(
            `Failed to send admin partner registered email to ${email}`,
            err,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        'Failed to send admin partner registered notifications',
        err,
      );
    }
  }

  async notifyAdminDailyCommissionSummary(
    payload: AdminCommissionPendingSummaryPayload,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const adminEmails = this.getAdminEmails();
      const fallbackSubject = `Daily commission review — ${payload.commissions.length} pending ($${payload.totalAmount.toFixed(2)})`;
      const fallbackHtml = adminCommissionPendingSummaryTemplate(
        payload,
        resolvedTheme,
      );
      const formattedDate = new Date(payload.reportDate).toLocaleDateString(
        'en-US',
        { month: 'long', day: 'numeric', year: 'numeric' },
      );
      const tpl = await this.getTplContent(
        'alliance-admin-commission-summary',
        {
          '{{commissionCount}}': String(payload.commissions.length),
          '{{totalAmount}}': payload.totalAmount.toFixed(2),
          '{{reportDate}}': formattedDate,
          '{{commissionsTable}}': payload.commissions
            .map(
              (c) =>
                `- ${c.organizationName} / ${c.affiliateName}: $${c.commissionAmount.toFixed(2)} (${c.commissionId})`,
            )
            .join('\n'),
          '{{commissionsUrl}}': `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminCommissions}`,
        },
        resolvedTheme,
      );
      for (const email of adminEmails) {
        try {
          await this.mail.sendMail({
            from: this.buildFrom(resolvedTheme),
            to: email,
            subject: tpl?.subject ?? fallbackSubject,
            html: tpl?.html ?? fallbackHtml,
          });
        } catch (err) {
          this.logger.error(
            `Failed to send daily commission summary email to ${email}`,
            err,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        'Failed to send daily commission summary notifications',
        err,
      );
    }
  }

  async notifyAdminMarkPaidError(
    payload: AdminMarkPaidErrorPayload,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    const amountLabel =
      payload.amount !== undefined ? ` — $${payload.amount.toFixed(2)}` : '';
    const fallbackSubject = `markPaid() error at "${payload.errorPhase}" — payout ${payload.payoutRequestId}${amountLabel}`;
    const fallbackHtml = adminMarkPaidErrorTemplate(payload, resolvedTheme);
    try {
      const tpl = await this.getTplContent(
        'alliance-admin-mark-paid-error',
        {
          '{{errorPhase}}': payload.errorPhase,
          '{{payoutRequestId}}': payload.payoutRequestId,
          '{{adminName}}': payload.adminName,
          '{{affiliateName}}': payload.affiliateName || 'N/A',
          '{{amount}}':
            payload.amount !== undefined
              ? `$${payload.amount.toFixed(2)}`
              : 'N/A',
          '{{errorMessage}}': payload.errorMessage,
          '{{payoutRequestUrl}}': `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminPayoutRequests}?payout=${payload.payoutRequestId}`,
        },
        resolvedTheme,
      );
      await this.mail.sendMail({
        from: this.buildFrom(resolvedTheme),
        to: 'paulo@regenta.ai',
        subject: tpl?.subject ?? fallbackSubject,
        html: tpl?.html ?? fallbackHtml,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send markPaid error fallback email for payout ${payload.payoutRequestId}`,
        err,
      );
    }
  }

  async notifyAdminPaymentFailed(
    payload: AdminPaymentFailedPayload,
    theme?: EmailTheme,
  ): Promise<void> {
    const resolvedTheme = theme ?? (await this.defaultTheme());
    try {
      const adminEmails = this.getAdminEmails();
      const fallbackSubject = `Bill.com payment failed — ${payload.partnerName} ($${payload.amount.toFixed(2)})`;
      const fallbackHtml = adminPaymentFailedTemplate(payload, resolvedTheme);
      const tpl = await this.getTplContent(
        'alliance-admin-payment-failed',
        {
          '{{partnerName}}': payload.partnerName,
          '{{amount}}': payload.amount.toFixed(2),
          '{{billIds}}': payload.billIds,
          '{{payoutRequestId}}': payload.payoutRequestId,
          '{{errorMsg}}': payload.errorMsg,
          '{{payoutRequestsUrl}}': `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminPayoutRequests}`,
        },
        resolvedTheme,
      );
      for (const email of adminEmails) {
        try {
          await this.mail.sendMail({
            from: this.buildFrom(resolvedTheme),
            to: email,
            subject: tpl?.subject ?? fallbackSubject,
            html: tpl?.html ?? fallbackHtml,
          });
        } catch (err) {
          this.logger.error(
            `Failed to send admin payment failed email to ${email}`,
            err,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        'Failed to send admin payment failed notifications',
        err,
      );
    }
  }
}
