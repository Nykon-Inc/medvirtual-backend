import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AdminReviewReasonCode, AdminReviewStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListReviewCasesDto } from './dto/list-review-cases.dto';
import { ResolveReviewCaseDto } from './dto/resolve-review-case.dto';

const CASE_INCLUDE = {
  organization: {
    select: {
      id: true,
      name: true,
      email: true,
      hubspot_id: true,
      med_alliance_referral_status: true,
      hubspot_sync_status: true,
      referredByAffiliate: {
        select: { id: true, first_name: true, last_name: true, email: true },
      },
    },
  },
  resolvedBy: {
    select: { id: true, first_name: true, last_name: true, email: true },
  },
  lineItem: {
    select: { id: true, name: true, amount: true, invoice_id: true },
  },
};

@Injectable()
export class ReviewCasesService {
  private readonly logger = new Logger(ReviewCasesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Opens a review case for the given org and reason.
   * Idempotent: if an open case for the same (org, reason[, line item]) already exists,
   * the duplicate is silently ignored (catches Prisma P2002).
   *
   * `hubspotLineItemSnapshotId` scopes the dedup to a specific line item — required for
   * unmatched_line_item/ambiguous_line_item, where a single organization can have several
   * distinct open cases at once (one per unmatched line item). Omit it for org-scoped
   * reason codes (multiple_hubspot_matches, etc.), which keep the original one-open-case
   * per (org, reason) behavior.
   */
  async openOrSkip(
    organizationId: string,
    reasonCode: AdminReviewReasonCode,
    metadata?: Record<string, any>,
    hubspotLineItemSnapshotId?: string,
  ): Promise<{ opened: boolean }> {
    try {
      await this.prisma.medAllianceAdminReviewCase.create({
        data: {
          organization_id: organizationId,
          reason_code: reasonCode,
          status: AdminReviewStatus.open,
          metadata: metadata ?? undefined,
          hubspot_line_item_snapshot_id: hubspotLineItemSnapshotId ?? undefined,
        },
      });
      this.logger.log(
        `Opened review case: org=${organizationId} reason=${reasonCode}` +
          (hubspotLineItemSnapshotId
            ? ` lineItem=${hubspotLineItemSnapshotId}`
            : ''),
      );
      return { opened: true };
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // An open case already exists for this (org, reason[, line item]) — skip silently
        return { opened: false };
      }
      throw err;
    }
  }

  async findAll(dto: ListReviewCasesDto) {
    const { page = 1, limit = 20, status, reason_code, search } = dto;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (reason_code) where.reason_code = reason_code;
    if (search) {
      where.organization = {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      };
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.medAllianceAdminReviewCase.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: CASE_INCLUDE,
      }),
      this.prisma.medAllianceAdminReviewCase.count({ where }),
    ]);

    return { data, pagination: { page, limit, total } };
  }

  async findOne(id: string) {
    const item = await this.prisma.medAllianceAdminReviewCase.findUnique({
      where: { id },
      include: CASE_INCLUDE,
    });
    if (!item) throw new NotFoundException('Review case not found');
    return item;
  }

  /**
   * Resolves an open review case.
   *
   * Resolution side-effects by reason_code:
   * - multiple_hubspot_matches + hubspot_company_id: sets org.hubspot_id and resets sync state
   * - reconciliation_invoice_changed + action=void_and_recreate: voids the linked commission
   *   and clears snapshot.sync_hash so next sync re-evaluates the invoice
   * - unmatched_line_item / ambiguous_line_item + action=manual_link: sets the line item's
   *   staff_id, match_status='matched', matched_by='admin_manual' — the commission that was
   *   on hold is generated retroactively on the next CommissionDetectionService run.
   * - unmatched_line_item / ambiguous_line_item + action=not_applicable: sets match_status
   *   ='not_applicable', permanently excluding the line item from the commission flow.
   * - invoice_reassociated_in_hubspot + action=reassociate_and_void: reassigns the snapshot's
   *   organization_id and voids the commission still attached to the old organization.
   * - invoice_reassociated_in_hubspot + action=reassociate_keep_commission: reassigns the
   *   snapshot's organization_id but leaves the existing commission untouched.
   * - all other cases: close only
   *
   * Every resolution writes a medAllianceAuditLog entry (entity_type='review_case') — this
   * closes a coverage gap where only the void_and_recreate path used to be logged.
   */
  async resolve(id: string, resolvedById: string, dto: ResolveReviewCaseDto) {
    const item = await this.findOne(id);

    if (item.status !== AdminReviewStatus.open) {
      throw new BadRequestException('Review case is already resolved');
    }

    let auditEvent = `resolved_${item.reason_code}`;

    // --- Side-effect: multiple HubSpot matches — admin assigns the correct company ---
    if (
      item.reason_code === AdminReviewReasonCode.multiple_hubspot_matches &&
      dto.hubspot_company_id
    ) {
      const currentStatus = item.organization?.med_alliance_referral_status;
      // Never overwrite a sticky manual/terminal decision (eligible or expired) — resolving
      // this review case is a MA-005 sync-correctness fix, not a new eligibility decision.
      // From pending or not_eligible (blocked), moving to pending is a legitimate un-block.
      const statusUpdate =
        currentStatus === 'eligible' || currentStatus === 'expired'
          ? {}
          : { med_alliance_referral_status: 'pending_confirmation' as any };

      await this.prisma.organization.update({
        where: { id: item.organization_id },
        data: {
          hubspot_id: dto.hubspot_company_id,
          hubspot_sync_status: 'synced',
          hubspot_sync_error: null,
          hubspot_synced_at: new Date(),
          ...statusUpdate,
        },
      });
      this.logger.log(
        `Admin set hubspot_id=${dto.hubspot_company_id} for org ${item.organization_id}`,
      );
    }

    // --- Side-effect: reconciliation — invoice changed after commission was detected ---
    if (
      item.reason_code === AdminReviewReasonCode.reconciliation_invoice_changed
    ) {
      if (dto.action === 'void_and_recreate') {
        await this.handleVoidAndRecreate(item);
      }
      // keep_existing: no side-effect, just close the case
    }

    // --- Side-effect: invoice was re-associated to a different Company in HubSpot ---
    if (
      item.reason_code === AdminReviewReasonCode.invoice_reassociated_in_hubspot
    ) {
      if (
        dto.action === 'reassociate_and_void' ||
        dto.action === 'reassociate_keep_commission'
      ) {
        await this.handleInvoiceReassociation(item, dto.action);
      }
      // keep_existing: no side-effect, just close the case (snapshot stays on old org)
    }

    // --- Side-effect: unmatched/ambiguous line item — admin links a Staff or excludes it ---
    if (
      (item.reason_code === AdminReviewReasonCode.unmatched_line_item ||
        item.reason_code === AdminReviewReasonCode.ambiguous_line_item) &&
      item.hubspot_line_item_snapshot_id
    ) {
      if (dto.action === 'manual_link' && dto.staff_id) {
        await this.prisma.hubspotLineItemSnapshot.update({
          where: { id: item.hubspot_line_item_snapshot_id },
          data: {
            staff_id: dto.staff_id,
            match_status: 'matched',
            matched_by: 'admin_manual',
          },
        });
        auditEvent = 'resolved_manual_link';
        this.logger.log(
          `Admin manually linked line item ${item.hubspot_line_item_snapshot_id} to staff ${dto.staff_id}`,
        );
      } else if (dto.action === 'not_applicable') {
        await this.prisma.hubspotLineItemSnapshot.update({
          where: { id: item.hubspot_line_item_snapshot_id },
          data: { match_status: 'not_applicable', matched_by: 'admin_manual' },
        });
        auditEvent = 'resolved_not_applicable';
        this.logger.log(
          `Admin marked line item ${item.hubspot_line_item_snapshot_id} as not a collaborator`,
        );
      }
    }

    const resolved = await this.prisma.medAllianceAdminReviewCase.update({
      where: { id },
      data: {
        status: AdminReviewStatus.resolved,
        resolved_by_id: resolvedById,
        resolved_at: new Date(),
        resolution: dto.resolution,
      },
      include: CASE_INCLUDE,
    });

    await this.prisma.medAllianceAuditLog.create({
      data: {
        entity_type: 'review_case',
        entity_id: id,
        event: auditEvent,
        old_status: 'open',
        new_status: 'resolved',
        reason: dto.resolution,
        source: 'admin_action',
        actor_user_id: resolvedById,
        metadata: {
          organization_id: item.organization_id,
          reason_code: item.reason_code,
          hubspot_line_item_snapshot_id:
            item.hubspot_line_item_snapshot_id ?? undefined,
        } as any,
      },
    });

    return resolved;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Voids the commission linked to the changed invoice and clears the snapshot's
   * sync_hash so the next sync call re-evaluates the invoice and re-detects
   * the commission at the updated amount.
   *
   * Expected metadata shape: { commission_id, snapshot_id, hubspot_invoice_id }
   */
  private async handleVoidAndRecreate(item: {
    id: string;
    organization_id: string;
    metadata: any;
  }) {
    const meta = item.metadata as {
      commission_id?: string;
      snapshot_id?: string;
    } | null;

    if (meta?.commission_id) {
      await this.prisma.affiliateCommission.update({
        where: { id: meta.commission_id },
        data: { status: 'void' },
      });

      await this.prisma.medAllianceAuditLog.create({
        data: {
          entity_type: 'commission',
          entity_id: meta.commission_id,
          event: 'voided_by_reconciliation',
          old_status: 'eligible',
          new_status: 'void',
          source: 'admin_action',
          metadata: {
            review_case_id: item.id,
            organization_id: item.organization_id,
          },
        },
      });

      this.logger.log(
        `Voided commission ${meta.commission_id} via reconciliation review case ${item.id}`,
      );
    }

    if (meta?.snapshot_id) {
      // Clear sync_hash so InvoiceIngestionService re-processes this snapshot on next sync
      await this.prisma.hubspotInvoiceSnapshot.update({
        where: { id: meta.snapshot_id },
        data: { sync_hash: '' },
      });
    }
  }

  /**
   * Applies the organization reassignment an admin confirmed for a snapshot whose HubSpot
   * company association changed. Optionally voids the commission still pointing at the old
   * organization (never automatic — always an explicit admin choice). Clears sync_hash so
   * the next InvoiceIngestionService run (cron or manual "Sync with HubSpot") re-evaluates
   * this snapshot under the new organization_id and CommissionDetectionService picks it up.
   *
   * Expected metadata shape: { snapshot_id, old_organization_id, commission_id }
   */
  private async handleInvoiceReassociation(
    item: { id: string; organization_id: string; metadata: any },
    action: 'reassociate_and_void' | 'reassociate_keep_commission',
  ) {
    const meta = item.metadata as {
      snapshot_id?: string;
      old_organization_id?: string;
      commission_id?: string;
    } | null;

    if (!meta?.snapshot_id) return;

    const snapshot = await this.prisma.hubspotInvoiceSnapshot.findUnique({
      where: { id: meta.snapshot_id },
      select: { organization_id: true, hubspot_id: true },
    });
    if (!snapshot) return;

    // Guard against a stale/double-resolved case: only act if the snapshot still points
    // at the org recorded when the conflict was detected.
    if (snapshot.organization_id !== meta.old_organization_id) {
      this.logger.warn(
        `Skipping reassociation for review case ${item.id} — snapshot already moved`,
      );
      return;
    }

    await this.prisma.hubspotInvoiceSnapshot.update({
      where: { id: meta.snapshot_id },
      data: { organization_id: item.organization_id, sync_hash: '' },
    });

    await this.prisma.medAllianceAuditLog.create({
      data: {
        entity_type: 'referred_company',
        entity_id: item.organization_id,
        event: 'invoice_reassociated',
        old_status: meta.old_organization_id ?? null,
        new_status: item.organization_id,
        reason: `Invoice ${snapshot.hubspot_id} moved from org ${meta.old_organization_id} to ${item.organization_id} per HubSpot`,
        source: 'admin_action',
        metadata: {
          review_case_id: item.id,
          hubspot_invoice_snapshot_id: meta.snapshot_id,
          hubspot_invoice_id: snapshot.hubspot_id,
          action,
        } as any,
      },
    });

    if (action === 'reassociate_and_void' && meta.commission_id) {
      await this.prisma.affiliateCommission.update({
        where: { id: meta.commission_id },
        data: { status: 'void' },
      });

      await this.prisma.medAllianceAuditLog.create({
        data: {
          entity_type: 'commission',
          entity_id: meta.commission_id,
          event: 'voided_by_invoice_reassociation',
          old_status: 'eligible',
          new_status: 'void',
          source: 'admin_action',
          metadata: {
            review_case_id: item.id,
            organization_id: item.organization_id,
          },
        },
      });
    }

    this.logger.log(
      `Reassociated snapshot ${meta.snapshot_id} to org ${item.organization_id} via review case ${item.id} (action=${action})`,
    );
  }
}
