import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ReviewCasesService } from '../review-cases/review-cases.service';
import {
  extractNameCandidatesFromDealName,
  normalizeForComparison,
  scoreNameMatch,
  MIN_MATCH_THRESHOLD,
  STRONG_MATCH_THRESHOLD,
} from './staff-name-matching.util';

export interface StaffMatchStats {
  matched: number;
  unmatched: number;
  ambiguous: number;
}

interface StaffCandidate {
  id: string;
  normalizedNames: string[];
}

@Injectable()
export class StaffMatchingService {
  private readonly logger = new Logger(StaffMatchingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reviewCases: ReviewCasesService,
  ) {}

  /**
   * Phase B Step 1.5 (between invoice ingestion and commission detection):
   * for every un-matched HubspotLineItemSnapshot belonging to a paid invoice of this
   * organization, match its free-text `name` against the organization's own Staff pool.
   *
   * Matching is always organization-scoped — the candidate pool is never global, both
   * to avoid cross-company false positives and because the search space per org is small.
   *
   * Outcomes:
   *   0 matches → match_status='unmatched', opens an `unmatched_line_item` review case
   *   1 match   → match_status='matched', staff_id set, matched_by='auto'
   *   2+ matches → match_status='ambiguous', opens an `ambiguous_line_item` review case
   */
  async run(organizationId: string): Promise<StaffMatchStats> {
    const lineItems = await this.prisma.hubspotLineItemSnapshot.findMany({
      where: {
        match_status: null,
        invoice: { organization_id: organizationId },
        name: { not: null },
        removed_at: null,
      },
      select: { id: true, name: true, invoice_id: true },
    });

    const stats: StaffMatchStats = { matched: 0, unmatched: 0, ambiguous: 0 };

    if (lineItems.length === 0) {
      return stats;
    }

    const staffCandidates = await this.loadStaffCandidates(organizationId);

    for (const lineItem of lineItems) {
      const outcome = await this.matchLineItem(
        organizationId,
        lineItem,
        staffCandidates,
      );
      stats[outcome]++;
    }

    this.logger.log(
      `Staff matching for org ${organizationId}: matched=${stats.matched} unmatched=${stats.unmatched} ambiguous=${stats.ambiguous}`,
    );

    return stats;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Loads all Staff rows for the organization with a usable name — either from the
   * linked Candidate's structured first_name/last_name (source of truth), or as a
   * fallback, parsed from the raw hubspot_deal_name.
   */
  private async loadStaffCandidates(
    organizationId: string,
  ): Promise<StaffCandidate[]> {
    const staff = await this.prisma.staff.findMany({
      where: { organization_id: organizationId },
      select: {
        id: true,
        hubspot_deal_name: true,
        candidate: { select: { first_name: true, last_name: true } },
      },
    });

    const candidates: StaffCandidate[] = [];
    for (const s of staff) {
      const candidateName = [s.candidate?.first_name, s.candidate?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim();

      let normalizedNames: string[] = [];
      if (candidateName) {
        normalizedNames = [normalizeForComparison(candidateName)];
      } else if (s.hubspot_deal_name) {
        normalizedNames = extractNameCandidatesFromDealName(
          s.hubspot_deal_name,
        );
      }

      if (normalizedNames.length > 0) {
        candidates.push({ id: s.id, normalizedNames });
      }
    }

    return candidates;
  }

  private async matchLineItem(
    organizationId: string,
    lineItem: { id: string; name: string | null; invoice_id: string },
    staffCandidates: StaffCandidate[],
  ): Promise<'matched' | 'unmatched' | 'ambiguous'> {
    const lineItemNormalized = normalizeForComparison(lineItem.name ?? '');

    const scored = staffCandidates
      .map((candidate) => {
        const best = candidate.normalizedNames
          .map((name) => scoreNameMatch(lineItemNormalized, name))
          .reduce((a, b) => (b.combined > a.combined ? b : a));
        return { candidate, score: best };
      })
      .filter((s) => s.score.combined >= MIN_MATCH_THRESHOLD)
      .sort((a, b) => b.score.combined - a.score.combined);

    if (scored.length === 0) {
      await this.prisma.hubspotLineItemSnapshot.update({
        where: { id: lineItem.id },
        data: { match_status: 'unmatched' },
      });
      await this.reviewCases.openOrSkip(
        organizationId,
        'unmatched_line_item',
        { line_item_name: lineItem.name },
        lineItem.id,
      );
      return 'unmatched';
    }

    if (
      scored.length === 1 ||
      scored[0].score.combined >= STRONG_MATCH_THRESHOLD
    ) {
      // A single candidate, or a clear best match well above the ambiguity floor —
      // treat as a confident single match even if weaker second-place scores exist,
      // since real deal names often produce multiple weak partial-token overlaps.
      const strongEnoughOthers = scored.filter(
        (s) => s.score.combined >= scored[0].score.combined - 0.05,
      );
      if (strongEnoughOthers.length > 1) {
        return this.markAmbiguous(organizationId, lineItem, scored);
      }

      await this.prisma.hubspotLineItemSnapshot.update({
        where: { id: lineItem.id },
        data: {
          match_status: 'matched',
          staff_id: scored[0].candidate.id,
          matched_by: 'auto',
        },
      });
      return 'matched';
    }

    return this.markAmbiguous(organizationId, lineItem, scored);
  }

  private async markAmbiguous(
    organizationId: string,
    lineItem: { id: string; name: string | null },
    scored: Array<{ candidate: StaffCandidate; score: { combined: number } }>,
  ): Promise<'ambiguous'> {
    await this.prisma.hubspotLineItemSnapshot.update({
      where: { id: lineItem.id },
      data: { match_status: 'ambiguous' },
    });
    await this.reviewCases.openOrSkip(
      organizationId,
      'ambiguous_line_item',
      {
        line_item_name: lineItem.name,
        candidate_staff_ids: scored.map((s) => s.candidate.id),
      },
      lineItem.id,
    );
    return 'ambiguous';
  }
}
