import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { EligibilityCheckService } from '../referred-companies/eligibility-check.service';
import { ReviewCasesService } from '../review-cases/review-cases.service';
import { EmailTemplatesService } from '../../email-templates/email-templates.service';
import { getBusinessUnitEmailTheme } from '../../common/utils/email-templates/theme-helper';
import { FRONTEND_ROUTES } from '../../common/utils/frontend-routes';

export type MatchOutcome =
  | 'already_matched' // hubspot_id was already set — Phase A skipped
  | 'synced' // exactly 1 match found and stored
  | 'no_match' // 0 matches — Phase B will run without hubspot_id
  | 'multiple_matches' // 2+ matches — pipeline halted, admin review required
  | 'error'; // HubSpot API failure

export interface MatchResult {
  outcome: MatchOutcome;
  hubspotCompanyId?: string;
  error?: string;
}

@Injectable()
export class HubspotMatchingService {
  private readonly logger = new Logger(HubspotMatchingService.name);
  private readonly baseUrl = 'https://api.hubapi.com';

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly eligibilityCheck: EligibilityCheckService,
    private readonly reviewCases: ReviewCasesService,
    private readonly emailTemplates: EmailTemplatesService,
  ) {}

  /**
   * Phase A: resolve which HubSpot company corresponds to the referred organization.
   *
   * Matching strategy (in order of confidence):
   *   1. domain extracted from website_url
   *   2. company name
   *   3. email domain
   *
   * Outcomes:
   *   - 0 results → no_match (pipeline continues without hubspot_id)
   *   - 1 result  → stores hubspot_id, re-runs MA-004, returns 'synced'
   *   - 2+ results → sets needs_admin_review, sends admin email, halts pipeline
   */
  async run(organizationId: string): Promise<MatchResult> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        email: true,
        website_url: true,
        hubspot_id: true,
        referred_by_affiliate_id: true,
        referredByAffiliate: {
          select: { first_name: true, last_name: true, email: true },
        },
      },
    });

    if (!org) return { outcome: 'error', error: 'Organization not found' };

    // Idempotency: skip if already matched
    if (org.hubspot_id) {
      return { outcome: 'already_matched', hubspotCompanyId: org.hubspot_id };
    }

    try {
      const results = await this.searchHubspotCompany(org);

      if (results.length === 0) {
        await this.persistSyncState(organizationId, {
          hubspot_sync_status: 'no_match',
          hubspot_sync_error: null,
          hubspot_synced_at: new Date(),
        });
        return { outcome: 'no_match' };
      }

      if (results.length > 1) {
        await this.handleMultipleMatches(
          organizationId,
          org,
          !!org.referred_by_affiliate_id,
        );
        return { outcome: 'multiple_matches' };
      }

      // Exactly one match
      const hubspotCompanyId = results[0].id;
      await this.persistSyncState(organizationId, {
        hubspot_id: hubspotCompanyId,
        hubspot_sync_status: 'synced',
        hubspot_sync_error: null,
        hubspot_synced_at: new Date(),
      });

      // DISABLED (per-collaborator commission plan, company-eligibility-manual-only change,
      // spec doc §4.6): this was a sync-triggered (source='sync') automatic call — MA-004
      // (active-client duplicate detection) still only ever writes not_eligible/clears a
      // block and never touches pending_confirmation/eligible/expired, but running it here
      // with no user/admin actor is exactly the automatic, unattended pattern the plan
      // removes. MA-004 remains available via the admin-triggered
      // `POST admin/referred-companies/:id/eligibility-check` endpoint (referred-companies
      // .controller.ts, source='admin_action') and the user-triggered check at referral
      // submission time (referred-companies.service.ts, source='user') — both kept, since
      // those are actor-driven, not background.
      //
      // if (org.referred_by_affiliate_id) {
      //   await this.eligibilityCheck.runAndPersist(
      //     organizationId,
      //     'system',
      //     'sync',
      //   );
      // }

      return { outcome: 'synced', hubspotCompanyId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `HubSpot matching failed for org ${organizationId}: ${message}`,
      );

      await this.persistSyncState(organizationId, {
        hubspot_sync_status: 'error',
        hubspot_sync_error: message,
      });

      return { outcome: 'error', error: message };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Searches HubSpot for companies matching the referred organization.
   * Uses domain, name, and email as filter criteria combined with OR logic.
   */
  private async searchHubspotCompany(org: {
    name: string;
    email?: string | null;
    website_url?: string | null;
  }): Promise<Array<{ id: string }>> {
    const filters: any[] = [];

    // Build filter groups — each group is an OR candidate
    const domain = this.extractDomain(org.website_url);
    if (domain) {
      filters.push({
        filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }],
      });
    }

    if (org.name) {
      filters.push({
        filters: [{ propertyName: 'name', operator: 'EQ', value: org.name }],
      });
    }

    if (org.email) {
      const emailDomain = org.email.split('@')[1];
      if (emailDomain) {
        filters.push({
          filters: [
            { propertyName: 'domain', operator: 'EQ', value: emailDomain },
          ],
        });
      }
    }

    if (filters.length === 0) return [];

    const response = await axios.post(
      `${this.baseUrl}/crm/v3/objects/companies/search`,
      {
        filterGroups: filters,
        properties: ['hs_object_id', 'name', 'domain'],
        limit: 10,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    );

    return (response.data?.results ?? []).map((r: any) => ({ id: r.id }));
  }

  /**
   * Handles the multiple-matches outcome:
   * - Sets referral status to needs_admin_review
   * - Stores sync status
   * - Sends notification email to admin
   */
  private async handleMultipleMatches(
    organizationId: string,
    org: {
      name: string;
      referredByAffiliate?: {
        first_name: string;
        last_name: string;
        email: string;
      } | null;
    },
    isReferred: boolean,
  ) {
    const updateData: Record<string, any> = {
      hubspot_sync_status: 'multiple_matches',
      hubspot_sync_error:
        'Multiple HubSpot company records matched. Manual review required.',
      hubspot_synced_at: null,
    };

    // DISABLED (per-collaborator commission plan, company-eligibility-manual-only change,
    // spec doc §4.6): this used to auto-set med_alliance_referral_status='not_eligible' for
    // referred orgs on an ambiguous HubSpot company match — a status pre-decision with no
    // admin involvement. Company eligibility status is now exclusively a manual admin
    // decision via the Confirm/Block endpoints; an ambiguous match should only halt sync
    // (hubspot_sync_status above) and open the review case below, not touch eligibility.
    //
    // if (isReferred) {
    //   updateData.med_alliance_referral_status = 'not_eligible';
    // }

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: updateData,
    });

    if (!isReferred) {
      return;
    }

    // MA-006: open an admin review case so it appears in the review queue
    await this.reviewCases.openOrSkip(
      organizationId,
      'multiple_hubspot_matches',
      {
        company_name: org.name,
      },
    );

    const affiliateName = org.referredByAffiliate
      ? `${org.referredByAffiliate.first_name} ${org.referredByAffiliate.last_name} (${org.referredByAffiliate.email})`
      : 'Unknown affiliate';

    const reviewLink = `${process.env.FRONTEND_URL ?? ''}${FRONTEND_ROUTES.allianceAdminPipeline}?company=${organizationId}`;

    const fallbackSubject = `[Med Alliance] Multiple HubSpot Matches — Review Required`;
    const fallbackHtml = `
        <h2>Med Alliance — Admin Review Required</h2>
        <p>A referral requires manual review because multiple HubSpot company records were found.</p>
        <table>
          <tr><td><strong>Company:</strong></td><td>${org.name}</td></tr>
          <tr><td><strong>Organization ID:</strong></td><td>${organizationId}</td></tr>
          <tr><td><strong>Referred by:</strong></td><td>${affiliateName}</td></tr>
        </table>
        <p>
          <a href="${reviewLink}">
            Review this referral
          </a>
        </p>
      `;

    let tpl: { subject: string; html: string } | null = null;
    try {
      tpl = await this.emailTemplates.getTemplateContent(
        'med-alliance-multiple-hubspot-matches',
        {
          '{{orgName}}': org.name ?? '',
          '{{organizationId}}': organizationId,
          '{{affiliateName}}': affiliateName,
          '{{reviewLink}}': reviewLink,
        },
        await getBusinessUnitEmailTheme(this.prisma, 'MedVirtual'),
      );
    } catch {
      tpl = null;
    }

    await this.mailService.sendMail({
      from: 'med-alliance@medvirtual.com',
      to: 'paulo@regenta.ai',
      subject: tpl?.subject ?? fallbackSubject,
      html: tpl?.html ?? fallbackHtml,
    });
  }

  /** Extracts the base domain from a URL string. */
  private extractDomain(url?: string | null): string | null {
    if (!url) return null;
    try {
      const normalized = url.startsWith('http') ? url : `https://${url}`;
      return new URL(normalized).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  /** Applies a partial update to Organization sync fields. */
  private async persistSyncState(
    organizationId: string,
    data: Record<string, any>,
  ) {
    await this.prisma.organization.update({
      where: { id: organizationId },
      data,
    });
  }
}
