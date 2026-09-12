import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { reRunPipelineDto } from './dto/re-run-pipeline.dto';
import { CandidatesService } from '../candidate/candidates.service';
import axios from 'axios';
import { HandlerObjectCreation } from '../hubspot/handlers/objectCreation';
import { HandlerContactDeletion } from '../hubspot/handlers/contactDeletion';
import systemReport from '../common/utils/email-templates/system-report';
import clientUsersDeactivationReport from '../common/utils/email-templates/client-users-deactivation-report';
import cronJobErrorReport from '../common/utils/email-templates/cron-job-error-report';
import newPositionsAlert from '../common/utils/email-templates/new-positions-alert';
import quarterlyPayoutReport, {
  PayoutReportEntry,
  PayoutReportFailure,
} from '../common/utils/email-templates/quarterly-payout-report';
import medAllianceExpiredEligibilityReport, {
  ExpiredCompanyEntry,
} from '../common/utils/email-templates/med-alliance-expired-eligibility-report';
import medAllianceSyncReport, {
  SyncReportEntry,
} from '../common/utils/email-templates/med-alliance-sync-report';
import offerPanelWeeklyReport, {
  OfferPanelReportRow,
  OfferPanelReportSection,
} from '../common/utils/email-templates/offer-panel-weekly-report';
import {
  formatDuration,
  getRollingReportWindow,
  getZonedDateParts,
  zonedWallClockToUtc,
} from '../common/utils/formatDate';
import { getBusinessUnitEmailTheme } from '../common/utils/email-templates/theme-helper';
import { MailService } from '../mail/mail.service';
import { activePipelines } from '../common/constant/activeDealPipelines';
import { HireRequestService } from '../hire-request/hire-request.service';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import { PayoutRequestsService } from '../med-alliance/payout-requests/payout-requests.service';
import { AffiliateStatus, HubspotAuditSource } from '@prisma/client';
import {
  ReferralSyncService,
  SyncResult,
} from '../med-alliance/sync/referral-sync.service';
import { CommissionDetectionService } from '../med-alliance/sync/commission-detection.service';
import { AllianceNotificationsService } from '../med-alliance/notifications/notifications.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { getEmailThemeByBusinessUnit } from '../common/utils/email-templates/theme';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { BusinessUnitsService } from '../business-units/business-units.service';
import { CandidateAuditFieldGroup, CandidateAuditSource } from '@prisma/client';
import {
  CANDIDATE_AUDIT_EVENTS,
  CandidateAuditService,
} from '../candidate/candidate-audit.service';

type Event = {
  objectId?: string;
};

// The report is scheduled for 10:00 Pacific, so the window boundaries and every
// timestamp in the email are expressed in the same zone the schedule uses.
const REPORT_TIMEZONE = 'America/Los_Angeles';

// Narrowed outside PROD so staging deploys cannot mail stakeholders every week.
// MailService's [DEV] subject prefix alone would not prevent that. Read at call
// time rather than module load so the environment is never captured too early.
function getOfferPanelReportRecipients(): string[] {
  return process.env.ENVIRONMENT === 'PROD'
    ? ['hanieh@berryvirtual.com', 'paulo@regenta.ai', 'shayan@regenta.ai']
    : ['paulo@regenta.ai'];
}

@Injectable()
export class CronService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly candidate: CandidatesService,
    private readonly objectCreation: HandlerObjectCreation,
    private readonly mailService: MailService,
    private readonly hireRequestService: HireRequestService,
    private readonly positionRateConfigService: PositionRateConfigService,
    private readonly payoutRequestsService: PayoutRequestsService,
    private readonly referralSync: ReferralSyncService,
    private readonly commissionDetection: CommissionDetectionService,
    private readonly allianceNotifications: AllianceNotificationsService,
    private readonly emailTemplates: EmailTemplatesService,
    private readonly contactDeletion: HandlerContactDeletion,
    private readonly businessUnitContext: BusinessUnitContext,
    private readonly businessUnitsService: BusinessUnitsService,
    private readonly candidateAudit: CandidateAuditService,
  ) {}

  // ── EmailTemplatesService fallback helper ─────────────────────────────────
  // Only subject/headline come from DB; the complex report body (tables, data)
  // remains hardcoded. Returns null when template is not found so callers
  // fall back to the original hardcoded subject + html.
  private async getCronTplContent(
    key: string,
    runtimeValues: Record<string, string>,
  ): Promise<{ subject: string; html: string } | null> {
    try {
      const theme = getEmailThemeByBusinessUnit('MedVirtual');
      return await this.emailTemplates.getTemplateContent(
        key,
        runtimeValues,
        theme,
      );
    } catch {
      return null;
    }
  }

  async reRunPipeline(statusDto: reRunPipelineDto): Promise<boolean> {
    //return false;
    const { status } = statusDto;
    const candidates = await this.prisma.candidate.findMany({
      where: {
        processing_status: status === 'failed' ? { not: 'completed' } : status,
        AND: [
          { resume_url: { not: null } },
          { resume_url: { not: 'To Follow' } },
          { resume_url: { not: 'To follow' } },
          { resume_url: { not: 'N/A' } },
        ],
      },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        hubspot_id: true,
        processing_status: true,
      },
      orderBy: {
        processed_at: 'desc',
      },
    });

    if (process.env.ENVIRONMENT === 'PROD') {
      for (const candidate of candidates) {
        console.log(
          `Re-running pipeline for candidate ID: ${candidate.id}, Name: ${candidate.first_name} ${candidate.last_name}`,
        );
        try {
          await this.candidate.processData(candidate.id);
          console.log(
            `===>Finished Pipeline for the candidate ID: ${candidate.id}`,
          );
        } catch {
          await this.prisma.candidate.update({
            where: { id: candidate.id },
            data: {
              processing_status: 'failed',
            },
          });
          await this.candidateAudit.log({
            candidateId: candidate.id,
            hubspotId: candidate.hubspot_id,
            actorUserId: null,
            event: CANDIDATE_AUDIT_EVENTS.PROCESSING_STATUS_CHANGED,
            fieldGroup: CandidateAuditFieldGroup.processing,
            before: { processing_status: candidate.processing_status },
            after: { processing_status: 'failed' },
            source: CandidateAuditSource.cron,
          });
          console.log(
            `===>Error in Pipeline for the candidate ID: ${candidate.id}`,
          );
        }
      }
    } else {
      console.log('Environment is not PROD. Skipping re-run of pipelines.');
    }
    return true;
  }

  async getCandidateId(): Promise<boolean> {
    console.log('Starting getCandidateId cron job...');
    const staffs = await this.prisma.staff.findMany({
      where: {
        candidate_id: null,
        hubspot_id: { not: null },
      },
      select: {
        id: true,
        hubspot_id: true,
      },
    });

    for (const staff of staffs) {
      const event: Event = {};
      const getObjectVA = await axios.get(
        `https://api.hubapi.com/crm/v3/objects/deals/${staff.hubspot_id}/associations/${process.env.HUBSPOT_CUSTOM_OBJECT}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );
      //console.log('getObjectVA: ', getObjectVA.data);

      if (getObjectVA?.data?.results?.length > 0) {
        let candidateExists = await this.prisma.candidate.findUnique({
          where: {
            hubspot_id: String(getObjectVA.data.results[0].id),
          },
          select: {
            id: true,
          },
        });

        if (!candidateExists) {
          event.objectId = getObjectVA.data.results[0].id;
          //=> call the candidate creation service
          await this.objectCreation.execute(event);

          candidateExists = await this.prisma.candidate.findUnique({
            where: {
              hubspot_id: String(getObjectVA.data.results[0].id),
            },
            select: {
              id: true,
            },
          });
        }

        await this.prisma.staff.update({
          where: { id: staff.id },
          data: {
            hubspot_candidate_id: String(getObjectVA.data.results[0].id),
            candidate_id: candidateExists ? candidateExists.id : null,
          },
        });
      }
    }
    await this.prisma.sync.create({
      data: {
        role: 'get-candidate-id',
        last_synced_at: new Date(),
      },
    });
    return true;
  }

  async systemReport(): Promise<boolean> {
    try {
      const availableCandidates = await this.prisma.candidate.count({
        where: {
          OR: [
            { pipeline_status: '261075105' },
            { pipeline_status: '1087596819' },
          ],
        },
      });

      const endorsedCandidates = await this.prisma.candidate.count({
        where: {
          pipeline_status: '1172847191',
        },
      });

      const withoutResume = await this.prisma.candidate.count({
        where: {
          pipeline_status: {
            in: ['261075105', '1087596819'],
          },
          OR: [
            { resume_url: null },
            { resume_url: 'To Follow' },
            { resume_url: 'To follow' },
            { resume_url: 'N/A' },
            { resume_url: 'n/a' },
          ],
        },
      });

      const failedResumeParsing = await this.prisma.candidate.findMany({
        where: {
          pipeline_status: {
            in: ['261075105', '1087596819'],
          },
          processing_status: 'failed',
          resume_url: { not: null },
        },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          name: true,
          hubspot_id: true,
          processing_error: true,
        },
      });

      const withoutHeadshot = await this.prisma.candidate.findMany({
        where: {
          pipeline_status: {
            in: ['261075105', '1087596819'],
          },
          OR: [
            { headshot_url: null },
            { headshot_url: 'n/a' },
            { headshot_url: 'N/A' },
          ],
        },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          name: true,
          hubspot_id: true,
        },
      });

      const emailBody = systemReport(
        availableCandidates,
        endorsedCandidates,
        withoutResume,
        failedResumeParsing,
        withoutHeadshot,
      );
      const tplSystem = await this.getCronTplContent('system-report', {
        '{{availableCount}}': String(availableCandidates),
        '{{endorsedCount}}': String(endorsedCandidates),
        '{{withoutResumeCount}}': String(withoutResume),
        '{{failedParsingCount}}': String(failedResumeParsing?.length ?? 0),
        '{{reportContent}}': '(see attached report)',
      });
      const mailSent = await this.mailService.sendMail({
        from: 'MedVirtual <noreply@medvirtual.ai>',
        to: 'shayan@regenta.ai',
        cc: ['paulo@regenta.ai', 'hanieh@medvirtual.ai'],
        subject: tplSystem?.subject ?? 'System Report',
        html: emailBody,
      });
      if (!mailSent) {
        console.log('Failed to send system report email notification.');
      }

      return true;
    } catch (error) {
      console.error('Error generating system report:', error);
      return false;
    }
  }

  async syncClientsWithActiveStaffs(): Promise<boolean> {
    try {
      //Get just active pipelines from hubspot

      const inactiveClients = await this.prisma.organization.findMany({
        where: {
          status: 'inactive',
          staff: {
            some: {
              hubspot_dealstage: { in: activePipelines.map(([key]) => key) },
            },
          },
        },
        select: {
          id: true,
          name: true,
          staff: {
            select: {
              id: true,
              hubspot_id: true,
              hubspot_deal_name: true,
              hubspot_dealstage: true,
            },
          },
        },
      });

      console.log(`Inactive clients Found:`, inactiveClients);

      //update them for active
      await Promise.all(
        inactiveClients.map(async (client) => {
          console.log(
            `Updating client ${client.name} (ID: ${client.id}) to active status.`,
          );
          await this.prisma.organization.update({
            where: { id: client.id },
            data: {
              status: 'active',
            },
          });
        }),
      );

      return true;
    } catch (error) {
      console.error('Error syncing clients with active staffs:', error);
      return false;
    }
  }

  async deactivateClientUsersWithNoStaff(): Promise<boolean> {
    console.log('Starting deactivateClientUsersWithNoStaff cron job...');

    try {
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

      // Find organizations that have NO staff at all (regardless of status)
      const clientsWithNoActiveStaff = await this.prisma.organization.findMany({
        where: {
          staff: {
            none: {},
          },
        },
        select: { id: true, name: true },
      });

      if (clientsWithNoActiveStaff.length === 0) {
        console.log('No clients found with no active staff.');
        return true;
      }

      const organizationIds = clientsWithNoActiveStaff.map((org) => org.id);
      const orgNameById = Object.fromEntries(
        clientsWithNoActiveStaff.map((org) => [org.id, org.name]),
      );
      console.log(`Found ${organizationIds.length} clients with no staff.`);

      const userSelect = {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        organization_id: true,
      };

      // Collect active users for the report before updating
      const usersToDeactivate = await this.prisma.uSER.findMany({
        where: {
          organization_id: { in: organizationIds },
          status: 'active',
          createdAt: { lte: sixtyDaysAgo },
        },
        select: userSelect,
      });

      await this.prisma.uSER.updateMany({
        where: { id: { in: usersToDeactivate.map((u) => u.id) } },
        data: { status: 'inactive', status_before_deactivation: 'active' },
      });

      console.log(`Deactivated ${usersToDeactivate.length} active users.`);

      // Find invited users created more than 60 days ago to delete
      const invitedUsersToDelete = await this.prisma.uSER.findMany({
        where: {
          organization_id: { in: organizationIds },
          status: 'invited',
          createdAt: { lte: sixtyDaysAgo },
        },
        select: userSelect,
      });

      console.log(
        `Found ${invitedUsersToDelete.length} invited users to delete.`,
      );

      for (const user of invitedUsersToDelete) {
        await this.prisma.$transaction(async (tx) => {
          await tx.emailVerification.deleteMany({ where: { userId: user.id } });
          await tx.emailInvitation.deleteMany({ where: { userId: user.id } });
          await tx.uSER.delete({ where: { id: user.id } });
        });
        console.log(`Deleted invited user: ${user.email}`);
      }

      // Send report email
      const toReportUser = (u: (typeof usersToDeactivate)[number]) => ({
        email: u.email,
        first_name: u.first_name,
        last_name: u.last_name,
        organization_name: u.organization_id
          ? (orgNameById[u.organization_id] ?? 'N/A')
          : 'N/A',
      });

      const emailBody = clientUsersDeactivationReport(
        usersToDeactivate.map(toReportUser),
        invitedUsersToDelete.map(toReportUser),
        new Date(),
      );

      const tplDeactivation = await this.getCronTplContent(
        'client-users-deactivation',
        {
          '{{reportDate}}': new Date().toLocaleDateString('en-US'),
          '{{deactivatedCount}}': String(usersToDeactivate.length),
          '{{removedCount}}': String(invitedUsersToDelete.length),
          '{{reportContent}}': '(see attached report)',
        },
      );
      await this.mailService.sendMail({
        from: 'MedVirtual <noreply@medvirtual.ai>',
        to: 'paulo@regenta.ai',
        cc: ['paulo@regenta.ai'],
        subject: tplDeactivation?.subject ?? 'Client Users Deactivation Report',
        html: emailBody,
      });

      console.log('deactivateClientUsersWithNoStaff cron job completed.');
      return true;
    } catch (error) {
      console.error('Error in deactivateClientUsersWithNoStaff:', error);
      try {
        const emailBody = cronJobErrorReport(
          'deactivate-client-users-no-staff',
          error,
          new Date(),
        );
        const tplCronError = await this.getCronTplContent('cron-job-error', {
          '{{jobName}}': 'deactivate-client-users-no-staff',
          '{{errorTime}}': new Date().toISOString(),
          '{{errorMessage}}': error?.message || String(error),
          '{{errorStack}}': error?.stack || '',
        });
        await this.mailService.sendMail({
          from: 'MedVirtual <noreply@medvirtual.ai>',
          to: 'paulo@regenta.ai',
          cc: ['paulo@regenta.ai'],
          subject:
            tplCronError?.subject ??
            '[ERROR] Client Users Deactivation Cron Job Failed',
          html: emailBody,
        });
      } catch (mailError) {
        console.error('Failed to send error report email:', mailError);
      }
      return false;
    }
  }

  async syncStaffHubspotDealStages(): Promise<boolean> {
    try {
      const staffs = await this.prisma.staff.findMany({
        where: {
          hubspot_id: { not: null },
          hubspot_pipeline: '5155250', //5155250 => BV OPERATIONS | 85165570 => MV OPERATIONS
          status: 'active',
        },
        select: {
          id: true,
          hubspot_id: true,
        },
        orderBy: {
          updated_at: 'asc',
        },
      });

      for (const staff of staffs) {
        try {
          const response = await axios.get(
            `https://api.hubapi.com/crm/v3/objects/deals/${staff.hubspot_id}`,
            {
              headers: {
                Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
              },
            },
          );

          const dealstage = response.data.properties.dealstage;

          await this.prisma.staff.update({
            where: { id: staff.id },
            data: {
              hubspot_dealstage: dealstage,
              status: activePipelines.some(([key]) => key === dealstage)
                ? 'active'
                : 'inactive',
            },
          });
        } catch (error) {
          console.error(`Error updating staff ID ${staff.id}:`, error);
        }
      }

      return true;
    } catch (error) {
      console.error('Error syncing staff HubSpot deal stages:', error);
      return false;
    }
  }

  async syncPositionsFromHubspot(): Promise<boolean> {
    try {
      console.log('Starting syncPositionsFromHubspot cron job...');

      const hubspotOptions = await this.hireRequestService.getVATypes();
      const hubspotPositions: string[] = hubspotOptions.map(
        (opt: { label: string }) => opt.label,
      );

      const existingConfigs =
        await this.positionRateConfigService.findAllUnpaginated();
      const existingPositions = new Set(existingConfigs.map((c) => c.position));

      const newPositions = hubspotPositions.filter(
        (p) => !existingPositions.has(p),
      );

      if (newPositions.length === 0) {
        console.log('syncPositionsFromHubspot: no new positions found.');
        return true;
      }

      for (const position of newPositions) {
        await this.prisma.positionRateConfig.create({
          data: {
            position,
            medical_margin_per_hour: 9,
            non_medical_margin_per_hour: 9,
          },
        });
        console.log(
          `syncPositionsFromHubspot: created new position "${position}"`,
        );
      }

      const emailBody = newPositionsAlert(newPositions);
      const tplPositions = await this.getCronTplContent('new-positions-alert', {
        '{{positionCount}}': String(newPositions.length),
        '{{positionsList}}': newPositions.join(', '),
      });
      await this.mailService.sendMail({
        from: 'MedVirtual <noreply@medvirtual.ai>',
        to: 'shayan@regenta.ai',
        cc: ['paulo@regenta.ai'],
        subject:
          tplPositions?.subject ?? '[Action Required] New VA Positions Found',
        html: emailBody,
      });

      console.log(
        `syncPositionsFromHubspot: alert sent for ${newPositions.length} new position(s).`,
      );
      return true;
    } catch (error) {
      console.error('Error in syncPositionsFromHubspot:', error);
      return false;
    }
  }

  async createQuarterlyPayoutRequests(): Promise<{
    created: number;
    failed: number;
    total_amount: string;
  }> {
    const runAt = new Date();
    console.log('Starting createQuarterlyPayoutRequests cron job...');

    const affiliates = await this.prisma.affiliateProfile.findMany({
      where: { commissions: { some: { status: 'eligible' } } },
      select: {
        id: true,
        full_name: true,
        user: { select: { email: true, first_name: true, last_name: true } },
        commissions: {
          where: { status: 'eligible' },
          select: { id: true, commission_amount: true },
        },
      },
    });

    console.log(
      `createQuarterlyPayoutRequests: found ${affiliates.length} affiliate(s) with eligible commissions.`,
    );

    const successes: PayoutReportEntry[] = [];
    const failures: PayoutReportFailure[] = [];

    for (const affiliate of affiliates) {
      const affiliateName =
        affiliate.full_name ??
        (affiliate.user
          ? `${affiliate.user.first_name} ${affiliate.user.last_name}`.trim()
          : affiliate.id);
      const affiliateEmail = affiliate.user?.email ?? '';
      const commissionIds = affiliate.commissions.map((c) => c.id);

      try {
        const result = await this.payoutRequestsService.createFromCron(
          affiliate.id,
          commissionIds,
        );

        successes.push({
          affiliateName,
          affiliateEmail,
          commissionCount: commissionIds.length,
          totalAmount: result.requested_amount.toString(),
          payoutRequestId: result.id,
        });

        console.log(
          `createQuarterlyPayoutRequests: created payout request ${result.id} for affiliate ${affiliate.id}`,
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        failures.push({ affiliateName, affiliateEmail, error: errorMessage });
        console.error(
          `createQuarterlyPayoutRequests: failed for affiliate ${affiliate.id} — ${errorMessage}`,
        );
      }
    }

    const totalAmount = successes
      .reduce((sum, s) => sum + parseFloat(s.totalAmount), 0)
      .toFixed(2);

    const quarterlyDate = runAt.toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    });
    const tplQuarterly = await this.getCronTplContent(
      'quarterly-payout-report',
      {
        '{{reportDate}}': quarterlyDate,
        '{{successCount}}': String(successes.length),
        '{{totalAmount}}': totalAmount,
        '{{failureCount}}': String(failures.length),
        '{{reportContent}}': '(see attached report)',
      },
    );
    await this.mailService.sendMail({
      from: 'MedVirtual <noreply@medvirtual.ai>',
      to: ['paulo@regenta.ai'],
      subject:
        tplQuarterly?.subject ?? `Quarterly Payout Report — ${quarterlyDate}`,
      html: quarterlyPayoutReport(successes, failures, runAt),
    });

    console.log(
      `createQuarterlyPayoutRequests: done. Created=${successes.length}, Failed=${failures.length}, Total=$${totalAmount}`,
    );

    return {
      created: successes.length,
      failed: failures.length,
      total_amount: totalAmount,
    };
  }

  /**
   * Daily cron: promotes referred companies from 'deployed' to 'eligible' after 30 days,
   * and promotes their 'detected' commissions to 'pending_admin_confirmation'.
   * Safe to re-run — already-eligible companies are excluded by the where clause.
   */
  async syncGrowthPartnersFromHubspot(): Promise<{
    created: number;
    skipped: number;
    failed: number;
    errors: string[];
  }> {
    const createdIds: string[] = [];
    const skippedIds: string[] = [];
    const errors: string[] = [];

    const properties = [
      'growth_partner_name',
      'growth_partner_email_address',
      'hs_pipeline',
      'hs_pipeline_stage',
      'business_unit',
      'alliance_commission',
    ];

    // Paginate through all Growth Partners in HubSpot
    let after: string | undefined;
    const allGrowthPartners: any[] = [];
    do {
      const body: any = {
        properties,
        limit: 100,
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'hs_pipeline',
                operator: 'EQ',
                value: '883841953',
              },
            ],
          },
        ],
      };
      if (after) body.after = after;

      const response = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/p20630393_growth_partners/search',
        body,
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      allGrowthPartners.push(...response.data.results);
      after = response.data.paging?.next?.after;
    } while (after);

    console.log(
      `syncGrowthPartnersFromHubspot: found ${allGrowthPartners.length} Growth Partner(s) in HubSpot`,
    );

    for (const gp of allGrowthPartners) {
      const hubspotId = String(gp.id);
      const props = gp.properties ?? {};

      try {
        // Already synced — skip
        const existing = await this.prisma.affiliateProfile.findUnique({
          where: { hubspot_id: hubspotId },
        });
        if (existing) {
          skippedIds.push(hubspotId);
          continue;
        }

        // Resolve email and name from GP properties first
        let email: string | null = props.growth_partner_email_address ?? null;
        const fullName: string = props.growth_partner_name ?? '';
        const nameParts = fullName.trim().split(' ');
        let firstName = nameParts[0] ?? '';
        let lastName = nameParts.slice(1).join(' ') || '';

        // If no email on the GP object, try the associated contact
        if (!email) {
          try {
            const assocRes = await axios.get(
              `https://api.hubapi.com/crm/v3/objects/p20630393_growth_partners/${hubspotId}/associations/contacts`,
              {
                headers: {
                  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                  'Content-Type': 'application/json',
                },
              },
            );

            const contactId = assocRes.data.results?.[0]?.id;
            if (contactId) {
              const contactRes = await axios.get(
                `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=email,firstname,lastname`,
                {
                  headers: {
                    Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json',
                  },
                },
              );
              const cp = contactRes.data.properties ?? {};
              email = cp.email ?? null;
              firstName = cp.firstname || firstName;
              lastName = cp.lastname || lastName;
            }
          } catch (contactErr: any) {
            console.warn(
              `syncGrowthPartnersFromHubspot: could not fetch contact for GP ${hubspotId} — ${contactErr?.message}`,
            );
          }
        }

        if (!email) {
          const msg = `GP ${hubspotId} (${fullName || 'unknown'}): no email found — skipped`;
          console.warn(`syncGrowthPartnersFromHubspot: ${msg}`);
          errors.push(msg);
          continue;
        }

        await this.prisma.$transaction(async (tx) => {
          // Reuse existing USER if the email is already in the system
          const user = await tx.uSER.findUnique({ where: { email } });

          // If user already has a profile, just stamp the hubspot_id if missing
          const profileExists = await tx.affiliateProfile.findUnique({
            where: { hubspot_id: hubspotId },
          });
          if (profileExists) return;

          await tx.affiliateProfile.create({
            data: {
              user_id: user ? user.id : null,
              hubspot_id: hubspotId,
              full_name: fullName || null,
              commission_percent_default: props.alliance_commission
                ? Number(props.alliance_commission)
                : 7,
              hubspot_pipeline: props.hs_pipeline ?? null,
              hubspot_pipeline_stage: props.hs_pipeline_stage ?? null,
              business_unit: props.business_unit ?? null,
              status: AffiliateStatus.pending,
            },
          });
        });

        createdIds.push(hubspotId);
        console.log(
          `syncGrowthPartnersFromHubspot: created affiliate profile for GP ${hubspotId} (${email})`,
        );
      } catch (err: any) {
        const msg = `GP ${hubspotId}: ${err?.message ?? err}`;
        console.error(`syncGrowthPartnersFromHubspot: error — ${msg}`);
        errors.push(msg);
      }
    }

    console.log(
      `syncGrowthPartnersFromHubspot: created=${createdIds.length}, skipped=${skippedIds.length}, failed=${errors.length}`,
    );

    return {
      created: createdIds.length,
      skipped: skippedIds.length,
      failed: errors.length,
      errors,
    };
  }

  async syncInvoicePaymentDates(): Promise<{
    updated: number;
    skipped: number;
    failed: number;
  }> {
    console.log('Starting syncInvoicePaymentDates cron job...');

    const snapshots = await this.prisma.hubspotInvoiceSnapshot.findMany({
      where: { invoice_status: 'paid' },
      select: { id: true, hubspot_id: true },
    });

    console.log(
      `syncInvoicePaymentDates: ${snapshots.length} snapshot(s) with paid status`,
    );

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const snapshot of snapshots) {
      try {
        const response = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/invoices/${snapshot.hubspot_id}?properties=hs_payment_date,hs_pdf_download_link`,
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            },
          },
        );

        const paymentDate: string | null =
          response.data?.properties?.hs_payment_date ?? null;

        const pdf_link =
          response.data?.properties?.hs_pdf_download_link ?? null;
        if (!paymentDate) {
          skipped++;
          continue;
        }

        await this.prisma.hubspotInvoiceSnapshot.update({
          where: { id: snapshot.id },
          data: {
            paid_at: new Date(paymentDate),
            hubspot_pdf_link: pdf_link,
          },
        });

        updated++;
      } catch (err) {
        console.error(
          `syncInvoicePaymentDates: failed for invoice ${snapshot.hubspot_id} — ${err instanceof Error ? err.message : err}`,
        );
        failed++;
      }
    }

    console.log(
      `syncInvoicePaymentDates: updated=${updated}, skipped=${skipped}, failed=${failed}`,
    );

    return { updated, skipped, failed };
  }

  async syncInvoiceDueDates(): Promise<{
    updated: number;
    skipped: number;
    failed: number;
  }> {
    console.log('Starting syncInvoiceDueDates backfill...');

    const snapshots = await this.prisma.hubspotInvoiceSnapshot.findMany({
      where: { due_date: null },
      select: { id: true, hubspot_id: true },
    });

    console.log(
      `syncInvoiceDueDates: ${snapshots.length} snapshot(s) with null due_date`,
    );

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const snapshot of snapshots) {
      try {
        const response = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/invoices/${snapshot.hubspot_id}?properties=hs_due_date`,
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            },
          },
        );

        const dueDate: string | null =
          response.data?.properties?.hs_due_date ?? null;

        if (!dueDate) {
          skipped++;
          continue;
        }

        await this.prisma.hubspotInvoiceSnapshot.update({
          where: { id: snapshot.id },
          data: { due_date: new Date(dueDate) },
        });

        updated++;
      } catch (err) {
        console.error(
          `syncInvoiceDueDates: failed for invoice ${snapshot.hubspot_id} — ${err instanceof Error ? err.message : err}`,
        );
        failed++;
      }
    }

    console.log(
      `syncInvoiceDueDates: updated=${updated}, skipped=${skipped}, failed=${failed}`,
    );

    return { updated, skipped, failed };
  }

  /**
   * Sweeps referred companies whose deployment_date passed 365 days ago and marks them
   * 'expired'. Replaces the old 30-day promotion behavior — decisions (Confirm/Block) are now
   * available immediately on deploy, so there is nothing left to "promote" after 30 days.
   *
   * referral_stage: 'deployed' structurally excludes 'canceled' orgs already (a single enum
   * column can't hold both values at once) — no extra exclusion clause is needed here, unlike
   * the notIn-style guards used elsewhere in this codebase for the same canceled-org rule.
   */
  async expireStaleEligibility(): Promise<{
    companiesExpired: number;
    errors: string[];
  }> {
    const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const oneYearAgo = new Date(now.getTime() - ONE_YEAR_MS);

    const orgs = await this.prisma.organization.findMany({
      where: {
        referral_stage: 'deployed' as any,
        referred_by_affiliate_id: { not: null },
        deployment_date: { lte: oneYearAgo },
        med_alliance_referral_status: {
          in: ['pending_confirmation', 'eligible', 'not_eligible'] as any,
        },
        status: { not: 'deleted' },
      },
      select: {
        id: true,
        name: true,
        deployment_date: true,
        med_alliance_referral_status: true,
      },
    });

    let companiesExpired = 0;
    const errors: string[] = [];
    const expiredEntries: ExpiredCompanyEntry[] = [];

    for (const org of orgs) {
      try {
        console.log(
          `Expiring org ${org.id} (${org.name}): deployment_date=${org.deployment_date}, status=${org.med_alliance_referral_status}`,
        );

        await this.prisma.organization.update({
          where: { id: org.id },
          data: {
            med_alliance_referral_status: 'expired' as any,
            med_alliance_block_reason: null,
          },
        });
        await this.prisma.medAllianceAuditLog.create({
          data: {
            entity_type: 'referred_company',
            entity_id: org.id,
            event: 'eligibility_expired',
            old_status: org.med_alliance_referral_status,
            new_status: 'expired',
            reason: 'Cron sweep — deployment_date passed 365 days',
            source: 'cron',
            actor_user_id: null,
            metadata: {
              deployment_date: org.deployment_date?.toISOString(),
            } as any,
          },
        });
        companiesExpired++;

        expiredEntries.push({
          orgId: org.id,
          orgName: org.name ?? org.id,
          deploymentDate: org.deployment_date
            ? org.deployment_date.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })
            : 'N/A',
          previousStatus: org.med_alliance_referral_status ?? 'unknown',
        });
      } catch (err: any) {
        const msg = `Failed to expire org ${org.id}: ${err?.message ?? err}`;
        console.error(msg);
        errors.push(msg);
      }
    }

    console.log(
      `expireStaleEligibility: expired=${companiesExpired}, errors=${errors.length}`,
    );

    if (companiesExpired > 0) {
      try {
        const runDate = now.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
        const tplExpired = await this.getCronTplContent(
          'med-alliance-expired-eligibility',
          {
            '{{reportDate}}': runDate,
            '{{expiredCount}}': String(companiesExpired),
            '{{errorCount}}': String(errors.length),
            '{{reportContent}}': '(see attached report)',
          },
        );
        await this.mailService.sendMail({
          from: 'MedVirtual <noreply@medvirtual.ai>',
          to: ['paulo@regenta.ai'],
          subject:
            tplExpired?.subject ??
            `Med Alliance — Expired Eligibility Report (${runDate})`,
          html: medAllianceExpiredEligibilityReport(
            expiredEntries,
            errors,
            now,
          ),
        });
      } catch (mailError) {
        console.error(
          'expireStaleEligibility: failed to send report email:',
          mailError,
        );
      }
    }

    return { companiesExpired, errors };
  }

  /**
   * Syncs referred organizations against HubSpot:
   *   1. Resolves hubspot_id (Phase A — HubSpot company matching).
   *   2. Ingests invoices and creates missing HubspotInvoiceSnapshot records (Phase B).
   *   3. Detects commissions and transitions org to 'deployed' on first paid invoice.
   *
   * The old step 4 (promote deployed orgs to 'eligible' after 30 days) is gone — Confirm/Block
   * decisions are available to admins immediately on deploy. Stale eligibility (>365 days since
   * deployment_date) is expired by expireStaleEligibility(), not here.
   *
   * @param organizationId - Single org to process. If omitted, all referred orgs are processed.
   */
  async syncOrganizationsWithHubspot(organizationId?: string): Promise<{
    processed: number;
    syncFailed: number;
    syncResults: SyncResult[];
  }> {
    console.log('Organization ID provided:', organizationId);

    let orgIds: string[];

    if (organizationId) {
      orgIds = [organizationId];
    } else {
      //Since this cron goals is to ingest invoice and create commissions,
      // we only retrieve active organizations which have referred_by_affiliate_id set (i.e. referred companies)
      const orgs = await this.prisma.organization.findMany({
        where: {
          status: 'active',
          referred_by_affiliate_id: { not: null },
        },
        select: { id: true },
        orderBy: { updatedAt: 'asc' },
      });
      orgIds = orgs.map((o) => o.id);
    }

    console.log(
      `syncOrganizationsWithHubspot: processing ${orgIds.length} organization(s)`,
    );

    const syncResults: SyncResult[] = [];
    const syncFailures: { organizationId: string; error: string }[] = [];
    let syncFailed = 0;

    for (const orgId of orgIds) {
      try {
        const result = await this.referralSync.run(orgId);
        syncResults.push(result);
      } catch (err) {
        syncFailed++;
        const message = err instanceof Error ? err.message : String(err);
        syncFailures.push({ organizationId: orgId, error: message });
        console.error(
          `syncOrganizationsWithHubspot: error syncing org ${orgId} — ${message}`,
        );
      }
    }

    console.log(
      `syncOrganizationsWithHubspot: processed=${orgIds.length} syncFailed=${syncFailed}`,
    );

    try {
      await this.sendSyncReportEmail(orgIds.length, syncResults, syncFailures);
    } catch (mailError) {
      console.error(
        'syncOrganizationsWithHubspot: failed to send report email:',
        mailError,
      );
    }

    return {
      processed: orgIds.length,
      syncFailed,
      syncResults,
    };
  }

  private async sendSyncReportEmail(
    processed: number,
    syncResults: SyncResult[],
    syncFailures: { organizationId: string; error: string }[],
  ): Promise<void> {
    const orgIdsInReport = [
      ...syncResults.map((r) => r.organizationId),
      ...syncFailures.map((f) => f.organizationId),
    ];

    const orgs = orgIdsInReport.length
      ? await this.prisma.organization.findMany({
          where: { id: { in: orgIdsInReport } },
          select: { id: true, name: true },
        })
      : [];
    const orgNameById = new Map(orgs.map((o) => [o.id, o.name]));

    const attentionOutcomes = new Set(['error', 'multiple_matches']);

    const allEntries: SyncReportEntry[] = [
      ...syncResults.map((r) => ({
        organizationId: r.organizationId,
        organizationName: orgNameById.get(r.organizationId) ?? r.organizationId,
        outcome: r.phaseA.outcome,
        hubspotCompanyId: r.phaseA.hubspotCompanyId,
        invoices: r.phaseB?.invoices,
        commissions: r.phaseB?.commissions,
        error: r.phaseA.error,
      })),
      ...syncFailures.map((f) => ({
        organizationId: f.organizationId,
        organizationName: orgNameById.get(f.organizationId) ?? f.organizationId,
        outcome: 'sync_failed',
        error: f.error,
      })),
    ];

    const needsAttention = allEntries.filter(
      (e) => attentionOutcomes.has(e.outcome) || e.outcome === 'sync_failed',
    );

    const totals = allEntries.reduce(
      (acc, e) => {
        acc.invoicesCreated += e.invoices?.created ?? 0;
        acc.commissionsCreated += e.commissions?.created ?? 0;
        return acc;
      },
      { invoicesCreated: 0, commissionsCreated: 0 },
    );

    const runAt = new Date();
    const runDate = runAt.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    await this.mailService.sendMail({
      from: 'MedVirtual <noreply@medvirtual.ai>',
      to: ['paulo@regenta.ai'],
      subject: `Med Alliance — HubSpot Sync Report (${runDate})`,
      html: medAllianceSyncReport(
        processed,
        allEntries,
        needsAttention,
        totals,
        runAt,
      ),
    });
  }

  async detectCommissionsByAffiliate(affiliateProfileId: string): Promise<{
    processed: number;
    created: number;
    skipped: number;
    failed: number;
  }> {
    const profile = await this.prisma.affiliateProfile.findUnique({
      where: { id: affiliateProfileId },
      select: { id: true, user_id: true },
    });

    if (!profile) {
      throw new Error(`Affiliate profile not found: ${affiliateProfileId}`);
    }

    const orgs = await this.prisma.organization.findMany({
      where: {
        referred_by_affiliate_id: profile.user_id,
        status: { not: 'deleted' },
        hubspotInvoiceSnapshots: {
          some: { invoice_status: 'paid', invoice_amount: { gt: 0 } },
        },
      },
      select: { id: true },
    });

    //console.log(orgs)

    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const org of orgs) {
      try {
        const result = await this.commissionDetection.run(org.id);
        //console.log(`detectCommissionsByAffiliate: org ${org.id} — created=${result.created} skipped=${result.skipped}`);
        created += result.created;
        skipped += result.skipped;
      } catch (err) {
        failed++;
        console.error(
          `detectCommissionsByAffiliate: error processing org ${org.id} — ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    console.log(
      `detectCommissionsByAffiliate: affiliateProfileId=${affiliateProfileId} processed=${orgs.length} created=${created} skipped=${skipped} failed=${failed}`,
    );

    return { processed: orgs.length, created, skipped, failed };
  }

  async dailyCommissionSummary(): Promise<{ sent: boolean; count: number }> {
    const commissions = await this.prisma.affiliateCommission.findMany({
      where: { status: 'pending_admin_confirmation' },
      select: {
        id: true,
        commission_amount: true,
        organization: { select: { name: true } },
        affiliate: {
          select: { email: true, first_name: true, last_name: true },
        },
      },
    });

    if (commissions.length === 0) {
      return { sent: false, count: 0 };
    }

    const items = commissions.map((c) => {
      const u = c.affiliate;
      const affiliateName = u
        ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
        : 'Unknown';
      return {
        commissionId: c.id,
        organizationName: c.organization?.name ?? 'Unknown',
        affiliateName,
        commissionAmount: Number(c.commission_amount),
      };
    });

    const totalAmount = items.reduce((sum, i) => sum + i.commissionAmount, 0);

    void this.allianceNotifications.notifyAdminDailyCommissionSummary({
      commissions: items,
      totalAmount,
      reportDate: new Date(),
    });

    return { sent: true, count: commissions.length };
  }

  private formatEtTimestamp(date: Date): string {
    return date.toLocaleString('en-US', {
      timeZone: REPORT_TIMEZONE,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  }

  async weeklyOfferPanelReport(weekOf?: string): Promise<{
    sent: boolean;
    totalPanels: number;
    totalCreators: number;
    weekStart: string;
    weekEnd: string;
    ranOnFridayPt: boolean;
    error?: string;
  }> {
    // Anchor a backfill date at 10:00 PT — the scheduled dispatch time — so the
    // replayed window closes where the real run would have closed it.
    let now = new Date();
    if (weekOf) {
      const [year, month, day] = weekOf.split('-').map(Number);
      if (!year || !month || !day) {
        throw new BadRequestException(
          `Invalid week_of value "${weekOf}". Expected format YYYY-MM-DD.`,
        );
      }
      now = zonedWallClockToUtc(year, month, day, 10, 0, 0, 0, REPORT_TIMEZONE);
    }

    const { start, end, weekStartLabel, weekEndLabel } = getRollingReportWindow(
      now,
      REPORT_TIMEZONE,
    );
    const ranOnFridayPt = getZonedDateParts(now, REPORT_TIMEZONE).weekday === 5;

    const panels = await this.prisma.offerPanel.findMany({
      where: { createdAt: { gte: start, lte: end } },
      select: {
        id: true,
        title: true,
        business_unit: true,
        status: true,
        is_public: true,
        recipient_name: true,
        recipient_email: true,
        recipient_org_name: true,
        viewed_at: true,
        view_count: true,
        decided_at: true,
        createdAt: true,
        created_by_user_id: true,
        createdBy: {
          select: { id: true, first_name: true, last_name: true, email: true },
        },
        recipientCompany: { select: { name: true } },
        _count: { select: { candidates: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const statusTotals = { sent: 0, viewed: 0, accepted: 0, declined: 0 };
    const sectionsByCreator = new Map<string, OfferPanelReportSection>();

    for (const panel of panels) {
      if (panel.status in statusTotals) {
        statusTotals[panel.status as keyof typeof statusTotals] += 1;
      }

      const creator = panel.createdBy;
      const creatorId = panel.created_by_user_id;

      let section = sectionsByCreator.get(creatorId);
      if (!section) {
        section = {
          creatorId,
          creatorName:
            [creator?.first_name, creator?.last_name]
              .filter(Boolean)
              .join(' ')
              .trim() ||
            creator?.email ||
            'Unknown user',
          creatorEmail: creator?.email ?? '',
          panels: [],
        };
        sectionsByCreator.set(creatorId, section);
      }

      const createdMs = panel.createdAt.getTime();
      // recipient_org_name is null for recipient_type 'email' and often for
      // client_user panels, so fall through to the contact then the address.
      const recipientLabel =
        panel.recipient_org_name ||
        panel.recipientCompany?.name ||
        panel.recipient_name ||
        panel.recipient_email ||
        '—';
      const row: OfferPanelReportRow = {
        panelId: panel.id,
        title: panel.title,
        recipientLabel,
        // Omit the sub-line when the label already is the email address,
        // otherwise the recipient cell shows the same email twice.
        recipientSub:
          recipientLabel === panel.recipient_email
            ? ''
            : (panel.recipient_email ?? ''),
        businessUnit: panel.business_unit ?? '—',
        status: panel.status,
        isPublic: panel.is_public,
        candidateCount: panel._count.candidates,
        createdAtLabel: this.formatEtTimestamp(panel.createdAt),
        viewedAtLabel: panel.viewed_at
          ? this.formatEtTimestamp(panel.viewed_at)
          : null,
        decidedAtLabel: panel.decided_at
          ? this.formatEtTimestamp(panel.decided_at)
          : null,
        timeToViewLabel: panel.viewed_at
          ? formatDuration(createdMs, panel.viewed_at.getTime())
          : null,
        timeToDecisionLabel: panel.decided_at
          ? formatDuration(createdMs, panel.decided_at.getTime())
          : null,
        viewCount: panel.view_count,
      };

      section.panels.push(row);
    }

    const sections = [...sectionsByCreator.values()].sort(
      (a, b) =>
        b.panels.length - a.panels.length ||
        a.creatorName.localeCompare(b.creatorName),
    );

    const theme = await getBusinessUnitEmailTheme(this.prisma, 'MedVirtual');

    // Subject and body are intentionally hardcoded: this is an internal
    // maintenance report, not client-facing copy, so it is not an EmailTemplate.
    const html = offerPanelWeeklyReport(
      {
        weekStartLabel,
        weekEndLabel,
        generatedAtLabel: this.formatEtTimestamp(new Date()),
        totalPanels: panels.length,
        totalCreators: sections.length,
        statusTotals,
        sections,
        offScheduleNote: ranOnFridayPt
          ? null
          : 'This report ran outside the usual Friday schedule, so the 8-day window it covers is not aligned with the regular Friday-to-Friday period.',
      },
      theme,
    );

    const result = {
      totalPanels: panels.length,
      totalCreators: sections.length,
      weekStart: start.toISOString(),
      weekEnd: end.toISOString(),
      ranOnFridayPt,
    };

    try {
      await this.mailService.sendMail({
        from: 'MedVirtual <noreply@medvirtual.ai>',
        to: getOfferPanelReportRecipients(),
        subject: `Offer Panel Report — ${weekStartLabel} to ${weekEndLabel}`,
        html,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('weeklyOfferPanelReport: failed to send email', error);
      return { sent: false, ...result, error };
    }

    console.log(
      `weeklyOfferPanelReport: window=${weekStartLabel}..${weekEndLabel} panels=${panels.length} creators=${sections.length}`,
    );

    return { sent: true, ...result };
  }

  async reconcileAffiliateContacts(): Promise<{
    updated: number;
    noContactInHubspot: number;
    noContactInDb: number;
    errors: string[];
  }> {
    /*
    const affiliates = await this.prisma.$queryRaw<
      { id: string; hubspot_id: string }[]
    >`SELECT id, hubspot_id FROM "AffiliateProfile" WHERE hubspot_id IS NOT NULL AND contact_id IS NULL`;
    */

    const affiliates = await this.prisma.affiliateProfile.findMany({
      where: { hubspot_id: { not: null }, contact_id: null },
      select: { id: true, hubspot_id: true },
    });
    let updated = 0;
    let noContactInHubspot = 0;
    let noContactInDb = 0;
    const errors: string[] = [];

    for (const affiliate of affiliates) {
      try {
        const { data } = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/${process.env.HUBSPOT_GROWTH_PARTNER_CUSTOM_OBJECT}/${affiliate.hubspot_id}?associations=contacts`,
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            },
          },
        );

        const associatedContact = data.associations?.contacts?.results?.[0];
        if (!associatedContact) {
          noContactInHubspot++;
          continue;
        }

        const contact = await this.prisma.contact.findUnique({
          where: { hubspot_id: String(associatedContact.id) },
          select: { id: true },
        });
        if (!contact) {
          noContactInDb++;
          continue;
        }

        await this.prisma.affiliateProfile.update({
          where: { id: affiliate.id },
          data: { contact: { connect: { id: contact.id } } },
        });
        updated++;
      } catch (err) {
        errors.push(
          `GP ${affiliate.hubspot_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    console.log(
      `reconcileAffiliateContacts: total=${affiliates.length} updated=${updated} noContactInHubspot=${noContactInHubspot} noContactInDb=${noContactInDb} errors=${errors.length}`,
    );

    return { updated, noContactInHubspot, noContactInDb, errors };
  }

  async sweepStaleContactIds(): Promise<{
    checkedContacts: number;
    checkedUsers: number;
    cleared: number;
    errors: string[];
  }> {
    const contacts = await this.prisma.contact.findMany({
      where: { hubspot_id: { not: null } },
      select: { hubspot_id: true },
    });
    const orphanUsers = await this.prisma.uSER.findMany({
      where: { hubspot_contact_id: { not: null } },
      select: { hubspot_contact_id: true },
    });

    // The same HubSpot id can live on both a Contact and a USER row — dedupe
    // so we only hit HubSpot once per id even if the two pointers agree.
    const idsToCheck = new Set<string>([
      ...contacts.map((c) => c.hubspot_id as string),
      ...orphanUsers.map((u) => u.hubspot_contact_id as string),
    ]);

    let cleared = 0;
    const errors: string[] = [];

    for (const hubspotId of idsToCheck) {
      try {
        await axios.get(
          `https://api.hubapi.com/crm/v3/objects/contacts/${hubspotId}`,
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            },
          },
        );
        // 200 → still exists in HubSpot, nothing to do.
      } catch (err) {
        if (err.response?.status === 404) {
          await this.contactDeletion.execute(
            { objectId: hubspotId },
            HubspotAuditSource.cron,
          );
          cleared++;
        } else {
          errors.push(`hubspot_id=${hubspotId}: ${err.message}`);
        }
      }
    }

    console.log(
      `sweepStaleContactIds: checkedContacts=${contacts.length} checkedUsers=${orphanUsers.length} cleared=${cleared} errors=${errors.length}`,
    );

    return {
      checkedContacts: contacts.length,
      checkedUsers: orphanUsers.length,
      cleared,
      errors,
    };
  }

  private buildHireRequestTitle(hr: {
    hubspot_pairing_request_type?: string | null;
    hubspot_numberVA?: number | null;
    hubspot_role_type?: string | null;
    availability?: string | null;
    organization: { name: string };
  }): string {
    const isProduction = process.env.ENVIRONMENT === 'PROD';
    const basePrefix = isProduction ? 'HR' : 'TEST HR';
    const requestType = hr.hubspot_pairing_request_type || '';
    const firstPrefix =
      requestType === 'Upsell Agent'
        ? 'UPS '
        : requestType === 'Agent Replacement'
          ? 'REP '
          : '';

    const parts: string[] = [(firstPrefix + basePrefix).trim()];

    if (hr.organization?.name?.trim()) {
      parts.push(hr.organization.name);
    }

    if (hr.hubspot_numberVA) {
      parts.push(String(hr.hubspot_numberVA));
    }

    if (hr.hubspot_role_type?.trim()) {
      parts.push(hr.hubspot_role_type);
    }

    if (hr.availability?.trim()) {
      const formatted = hr.availability
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join('-');
      if (formatted.trim()) {
        parts.push(formatted);
      }
    }

    return parts.filter((p) => p?.trim()).join(' - ');
  }

  async syncHireRequestTitles(): Promise<{
    updated: number;
    skipped: number;
    errors: number;
    preview: { id: string; currentTitle: string | null; newTitle: string }[];
  }> {
    const hireRequests = await this.prisma.hireRequest.findMany({
      where: {
        hubspot_role_type: { not: null },
        hubspot_ticket_id: { not: null },
      },
      select: {
        id: true,
        title: true,
        hubspot_ticket_id: true,
        hubspot_pairing_request_type: true,
        hubspot_numberVA: true,
        hubspot_role_type: true,
        availability: true,
        organization: { select: { name: true } },
      },
    });

    let updated = 0;
    let skipped = 0;
    let errors = 0;
    const preview: {
      id: string;
      currentTitle: string | null;
      newTitle: string;
    }[] = [];

    for (const hr of hireRequests) {
      if (hr.title && hr.title.split(' - ').length >= 5) {
        skipped++;
        continue;
      }

      const newTitle = this.buildHireRequestTitle(hr);
      preview.push({ id: hr.id, currentTitle: hr.title, newTitle });

      try {
        await this.prisma.hireRequest.update({
          where: { id: hr.id },
          data: { title: newTitle },
        });
        await axios.patch(
          `https://api.hubapi.com/crm/v3/objects/tickets/${hr.hubspot_ticket_id}`,
          { properties: { subject: newTitle } },
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          },
        );
        updated++;
      } catch (e) {
        errors++;
        console.error(
          `Error syncing HR ${hr.id}:`,
          e.response?.data ?? e.message,
        );
      }
    }

    return { updated, skipped, errors, preview };
  }

  /**
   * Daily cron (Task 05 — Multi Business Unit): reads the HubSpot `business_unit`
   * company property options and reconciles our `BusinessUnit` table against them.
   *
   * - Upsert (additions): every option becomes/stays a row in `BusinessUnit`. New
   *   options are created dormant (`is_visible=false`, `candidate_pool='medical'`).
   *   Existing rows are NEVER flipped visible/invisible here — only a super-admin
   *   (or the reconcile-removal branch below) changes `is_visible`.
   * - Reconcile (removals) WITH SAFEGUARD: a BU whose `hubspot_value` is no longer
   *   present among the HubSpot options is decommissioned — `is_visible=false` and
   *   every related Organization/USER/Candidate/AffiliateProfile row is tagged
   *   `deactivated_by_bu=<slug>` (and soft-deleted using each model's existing
   *   convention: Organization.status=deleted, USER.status=inactive,
   *   AffiliateProfile.status=inactive; Candidate has no status enum so it is only
   *   tagged). This step ONLY runs when the HubSpot GET returned HTTP 200 with a
   *   valid, non-empty `options` array — any other outcome aborts the reconcile
   *   (upserts still run) so a transient HubSpot outage can never wipe data.
   *
   * Idempotent (safe to re-run) and never hard-deletes a `BusinessUnit` row.
   */
  async syncBusinessUnits(): Promise<{
    upserted: string[];
    removed: string[];
    aborted: boolean;
    reason?: string;
  }> {
    const upserted: string[] = [];
    const removed: string[] = [];
    let aborted = false;
    let abortReason: string | undefined;

    let options: { label: string }[] | null = null;

    try {
      const response = await axios.get(
        'https://api.hubapi.com/crm/v3/properties/companies/business_unit',
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const isValidRead =
        response?.status === 200 &&
        Array.isArray(response?.data?.options) &&
        response.data.options.length > 0;

      if (isValidRead) {
        options = response.data.options as { label: string }[];
      } else {
        aborted = true;
        abortReason = `HubSpot business_unit property read was invalid (status=${response?.status}, options=${JSON.stringify(response?.data?.options)})`;
      }
    } catch (error) {
      aborted = true;
      abortReason = `HubSpot business_unit property read failed: ${(error as Error).message}`;
    }

    if (aborted || !options) {
      console.error(
        `syncBusinessUnits: ABORTING reconcile-removal step — ${abortReason}. No BusinessUnit visibility/cascade changes were made.`,
      );
      return { upserted, removed, aborted: true, reason: abortReason };
    }

    // ── Upsert (additions) — never flips visibility of an existing row ───────
    const existingRows = await this.prisma.businessUnit.findMany();

    for (const option of options) {
      const label = option.label;
      const slug = this.businessUnitContext.displayToSlug(label);
      if (!slug) continue;

      await this.prisma.businessUnit.upsert({
        where: { slug },
        create: {
          slug,
          name: label,
          hubspot_value: label,
          candidate_pool: 'medical',
          is_visible: false,
        },
        update: {
          // Keep hubspot_value in sync with HubSpot's current label spelling,
          // but never touch is_visible here.
          hubspot_value: label,
        },
      });

      // Guarantee the 1:1 BU↔EmailBranding invariant at intake. `create()` and
      // `seed.ts` create a companion branding row per BU; the cron is the ONLY
      // real intake path, so without this a HubSpot-discovered BU has no
      // branding row and editing its "Customize Design" would 404. Empty
      // `update: {}` makes this create-once and never clobbers later edits.
      await this.prisma.emailBranding.upsert({
        where: { business_unit: slug },
        create: {
          business_unit: slug,
          primary_color: '#01546B',
          secondary_color: '#013A4F',
          logo_url: 'https://staging.medvirtual.ai/logo.png',
          company_name: label,
          layout_preset: 'default',
          button_color: null,
          button_text_color: null,
          updated_by: 'system',
        },
        update: {},
      });

      upserted.push(slug);
    }

    // ── Reconcile (removals) — only reached when options is valid+non-empty ──
    // Compared by normalized hubspot_value (not slug) since a BU's slug can be
    // hyphenated/spelled differently than a straight lowercase of the label.
    const hubspotValuesNormalized = new Set(
      options.map((o) =>
        this.businessUnitContext.normalizeBusinessUnit(o.label),
      ),
    );

    const decommissioned = existingRows.filter(
      (row) =>
        row.hubspot_value &&
        !hubspotValuesNormalized.has(
          this.businessUnitContext.normalizeBusinessUnit(row.hubspot_value),
        ),
    );

    for (const bu of decommissioned) {
      const buValue = bu.hubspot_value ?? bu.name;

      // Shared cascade: flips is_visible=false, soft-deletes orgs, deactivates
      // their users, tags candidates, sets affiliates inactive — all tagged
      // deactivated_by_bu=slug — and busts the BU context cache.
      await this.businessUnitsService.deactivateByBu(bu.slug, buValue);

      removed.push(bu.slug);
      console.log(
        `syncBusinessUnits: decommissioned BU "${bu.slug}" — is_visible=false, cascaded soft-delete tagged deactivated_by_bu="${bu.slug}"`,
      );
    }

    // Bust the BU context cache once at the end so upsert-only runs (which
    // never enter deactivateByBu) still invalidate the cache.
    this.businessUnitContext.bustCache();

    console.log(
      `syncBusinessUnits: done. upserted=${upserted.length}, removed=${removed.length}`,
    );

    return { upserted, removed, aborted: false };
  }
}
