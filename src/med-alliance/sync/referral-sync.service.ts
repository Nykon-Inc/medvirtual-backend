import { Injectable, Logger } from '@nestjs/common';
import { HubspotMatchingService } from './hubspot-matching.service';
import { InvoiceIngestionService } from './invoice-ingestion.service';
import { StaffMatchingService } from './staff-matching.service';
import { CommissionDetectionService } from './commission-detection.service';
import { PrismaService } from '../../prisma/prisma.service';

export interface SyncResult {
  organizationId: string;
  phaseA: {
    outcome: string;
    hubspotCompanyId?: string;
    error?: string;
  };
  phaseB?: {
    invoices: { created: number; updated: number; skipped: number };
    lineItems: {
      created: number;
      matched: number;
      unmatched: number;
      ambiguous: number;
    };
    commissions: { created: number; skipped: number };
  };
}

@Injectable()
export class ReferralSyncService {
  private readonly logger = new Logger(ReferralSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubspotMatching: HubspotMatchingService,
    private readonly invoiceIngestion: InvoiceIngestionService,
    private readonly staffMatching: StaffMatchingService,
    private readonly commissionDetection: CommissionDetectionService,
  ) {}

  /**
   * Full sync pipeline for a referred organization.
   *
   * Phase A — HubSpot company matching:
   *   Resolves hubspot_id for the referred org.
   *   Skipped if hubspot_id is already set (idempotent).
   *   Halts pipeline if multiple matches are found.
   *
   * Phase B — Invoice ingestion + commission detection:
   *   Runs only if the org is not blocked and not needs_admin_review.
   *   Idempotent: sync_hash guards invoice re-processing,
   *   idempotency_key guards commission re-creation.
   */
  async run(organizationId: string): Promise<SyncResult> {
    this.logger.log(`Starting sync for organization ${organizationId}`);

    // Deleted organizations must never re-enter the pipeline — the deletion hook
    // already voided their commissions; syncing would re-detect them.
    const orgStatus = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { status: true },
    });
    if (orgStatus?.status === 'deleted') {
      this.logger.warn(
        `Sync skipped for org ${organizationId} — organization is deleted`,
      );
      return {
        organizationId,
        phaseA: { outcome: 'skipped_deleted' },
      };
    }

    // -------------------------------------------------------------------------
    // Phase A: HubSpot company matching
    // -------------------------------------------------------------------------
    const matchResult = await this.hubspotMatching.run(organizationId);

    const result: SyncResult = {
      organizationId,
      phaseA: {
        outcome: matchResult.outcome,
        hubspotCompanyId: matchResult.hubspotCompanyId,
        error: matchResult.error,
      },
    };

    // Multiple matches or hard error — halt pipeline
    if (
      matchResult.outcome === 'multiple_matches' ||
      matchResult.outcome === 'error'
    ) {
      this.logger.warn(
        `Sync halted for org ${organizationId} — Phase A outcome: ${matchResult.outcome}`,
      );
      return result;
    }

    // -------------------------------------------------------------------------
    // Phase B: Invoice ingestion + commission detection
    // -------------------------------------------------------------------------

    // Reload org to get the latest state (hubspot_id may have just been set by Phase A)
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        hubspot_id: true,
        med_alliance_referral_status: true,
        med_alliance_block_reason: true,
      },
    });

    // Guard: do not run Phase B for blocked referrals
    // Active-client block is permanent — skip Phase B entirely.
    // Other not_eligible states (no first invoice yet, expired window) are handled
    // inside CommissionDetectionService with the full eligibility lifecycle logic.
    if (org?.med_alliance_block_reason?.startsWith('active_client_block')) {
      this.logger.log(
        `Phase B skipped for org ${organizationId} — active-client block`,
      );
      return result;
    }

    // Phase B requires a hubspot_id to query invoices
    if (!org?.hubspot_id) {
      this.logger.log(
        `Phase B skipped for org ${organizationId} — no hubspot_id (no_match outcome)`,
      );
      return {
        ...result,
        phaseB: {
          invoices: { created: 0, updated: 0, skipped: 0 },
          lineItems: { created: 0, matched: 0, unmatched: 0, ambiguous: 0 },
          commissions: { created: 0, skipped: 0 },
        },
      };
    }

    const invoiceStats = await this.invoiceIngestion.run(
      organizationId,
      org.hubspot_id,
    );

    // Phase B Step 1.5: match newly-ingested line items to Staff before commission
    // detection runs, so it can query by match_status='matched' this same pass.
    const staffMatchStats = await this.staffMatching.run(organizationId);

    //commented only for populate databse
    const commissionStats = await this.commissionDetection.run(organizationId);
    //const commissionStats = { created: 0, skipped: 0 };

    result.phaseB = {
      invoices: invoiceStats,
      lineItems: {
        created: invoiceStats.lineItems.created,
        matched: staffMatchStats.matched,
        unmatched: staffMatchStats.unmatched,
        ambiguous: staffMatchStats.ambiguous,
      },
      commissions: commissionStats,
    };

    this.logger.log(
      `Sync complete for org ${organizationId} — ` +
        `invoices: +${invoiceStats.created} ~${invoiceStats.updated} =${invoiceStats.skipped} | ` +
        `line items: +${invoiceStats.lineItems.created} matched=${staffMatchStats.matched} unmatched=${staffMatchStats.unmatched} ambiguous=${staffMatchStats.ambiguous} | ` +
        `commissions: +${commissionStats.created} =${commissionStats.skipped}`,
    );

    return result;
  }
}
