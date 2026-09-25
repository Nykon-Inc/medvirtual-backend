import { Injectable, Logger } from '@nestjs/common';
import { InvoiceSource, InvoiceStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ReviewCasesService } from '../review-cases/review-cases.service';
import { StaffMatchingService } from './staff-matching.service';
import { InvoicePaidCommissionService } from './invoice-paid-commission.service';

export type InternalSnapshotOutcome = 'created' | 'updated' | 'skipped';

export interface InternalInvoiceSyncStats {
  created: number;
  updated: number;
  skipped: number;
}

// Commissions in these statuses no longer carry money, so an invoice change under them
// needs no admin review — same rule InvoiceIngestionService applies to HubSpot invoices.
const DEAD_COMMISSION_STATUSES: Array<'void' | 'rejected'> = [
  'void',
  'rejected',
];

interface InternalLine {
  id: string;
  worker_id: string | null;
  worker_name_snapshot: string | null;
  category: string;
  description: string;
  final_total: Decimal;
}

/**
 * Mirrors our own (Stripe/Hubstaff) invoices into HubspotInvoiceSnapshot /
 * HubspotLineItemSnapshot with source='internal', so the approved HubSpot commission flow
 * (staff matching, review cases, CommissionDetectionService, payouts) runs unchanged on them.
 *
 * Equivalent of HandlerInvoiceCreation + HandlerInvoicePropertyChange for the internal source:
 * syncFromInvoice() is the "invoice created/changed" half, onInvoicePaid() the "paid" half.
 */
@Injectable()
export class InternalInvoiceSnapshotService {
  private readonly logger = new Logger(InternalInvoiceSnapshotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reviewCases: ReviewCasesService,
    private readonly staffMatching: StaffMatchingService,
    private readonly invoicePaid: InvoicePaidCommissionService,
  ) {}

  /**
   * Maps our InvoiceStatus onto the HubSpot hs_invoice_status vocabulary every snapshot
   * consumer already understands (draft | open | paid | voided).
   */
  static mapInvoiceStatus(status: InvoiceStatus): string {
    switch (status) {
      case InvoiceStatus.paid:
        return 'paid';
      case InvoiceStatus.published:
      case InvoiceStatus.partially_paid:
        return 'open';
      case InvoiceStatus.voided:
      case InvoiceStatus.cancelled:
        return 'voided';
      default:
        return 'draft';
    }
  }

  /**
   * Stable identity of an internal line across invoice versions. InvoiceService.createVersion
   * recreates every line with a new id, so the id can't be the key — the ordinal among lines of
   * the same worker + category (in display order) is what stays constant between versions.
   */
  static buildLineKeys(lines: InternalLine[]): Map<string, string> {
    const counters = new Map<string, number>();
    const keys = new Map<string, string>();
    for (const line of lines) {
      const base = `${line.worker_id ?? 'org'}|${line.category}`;
      const n = counters.get(base) ?? 0;
      counters.set(base, n + 1);
      keys.set(line.id, `${base}|${n}`);
    }
    return keys;
  }

  /**
   * Idempotent create-or-update of the snapshot for one internal invoice, always reflecting
   * the invoice's CURRENT version. Safe to call from any billing event, any number of times.
   */
  async syncFromInvoice(
    invoiceId: string,
    opts: { pdfLink?: string | null } = {},
  ): Promise<{ outcome: InternalSnapshotOutcome; snapshotId?: string }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        organization_id: true,
        status: true,
        invoice_number: true,
        reference: true,
        currentVersion: {
          select: {
            id: true,
            version_number: true,
            total: true,
            currency: true,
            due_date: true,
            line_items: {
              select: {
                id: true,
                worker_id: true,
                worker_name_snapshot: true,
                category: true,
                description: true,
                final_total: true,
              },
              orderBy: [{ sort_order: 'asc' }, { createdAt: 'asc' }],
            },
          },
        },
        payments: {
          where: { status: 'paid' },
          orderBy: { paid_at: 'desc' },
          take: 1,
          select: { paid_at: true },
        },
      },
    });

    if (!invoice?.currentVersion) {
      return { outcome: 'skipped' };
    }

    const version = invoice.currentVersion;
    const invoiceStatus = InternalInvoiceSnapshotService.mapInvoiceStatus(
      invoice.status,
    );
    const fields = {
      organization_id: invoice.organization_id,
      invoice_status: invoiceStatus,
      payment_status: invoiceStatus === 'paid' ? 'succeeded' : null,
      invoice_amount: new Decimal(version.total),
      currency: (version.currency || 'USD').slice(0, 3),
      paid_at: invoice.payments[0]?.paid_at ?? null,
      due_date: version.due_date ?? null,
      invoice_number: invoice.invoice_number ?? invoice.reference ?? null,
    };
    const syncHash = this.computeSyncHash(invoice.id, fields);

    let existing = await this.findExisting(invoice.id);
    let outcome: InternalSnapshotOutcome = 'skipped';

    if (!existing) {
      // Same rule as HandlerInvoiceCreation: a zero-amount invoice gets no snapshot. A later
      // sync creates it once the invoice carries a real amount.
      if (fields.invoice_amount.lte(0)) {
        return { outcome: 'skipped' };
      }

      try {
        const created = await this.prisma.hubspotInvoiceSnapshot.create({
          data: {
            ...fields,
            source: InvoiceSource.internal,
            internal_invoice_id: invoice.id,
            sync_hash: syncHash,
            hubspot_pdf_link: opts.pdfLink ?? null,
            raw_payload: {
              invoice_id: invoice.id,
              version_id: version.id,
              version_number: version.version_number,
              status: invoice.status,
            },
          },
          select: { id: true },
        });
        await this.syncLineItems(
          created.id,
          invoice.organization_id,
          invoice.id,
          version.line_items,
        );
        return { outcome: 'created', snapshotId: created.id };
      } catch (err: any) {
        // Concurrent billing events (Stripe webhook + reconciliation worker) can race on the
        // unique internal_invoice_id — the loser just continues as an update.
        if (err?.code !== 'P2002') throw err;
        existing = await this.findExisting(invoice.id);
        if (!existing) throw err;
      }
    }

    if (existing.sync_hash !== syncHash) {
      await this.prisma.hubspotInvoiceSnapshot.update({
        where: { id: existing.id },
        data: {
          ...fields,
          sync_hash: syncHash,
          raw_payload: {
            invoice_id: invoice.id,
            version_id: version.id,
            version_number: version.version_number,
            status: invoice.status,
          },
        },
      });
      outcome = 'updated';

      // MA-006 equivalent: money already attached to this invoice → the admin decides.
      const linkedCommission = existing.commissions[0];
      if (linkedCommission) {
        await this.reviewCases.openOrSkip(
          invoice.organization_id,
          'reconciliation_invoice_changed',
          {
            snapshot_id: existing.id,
            commission_id: linkedCommission.id,
            internal_invoice_id: invoice.id,
            old_amount: existing.invoice_amount?.toString(),
            new_amount: fields.invoice_amount.toString(),
          },
        );
      }
    }

    if (opts.pdfLink && opts.pdfLink !== existing.hubspot_pdf_link) {
      await this.prisma.hubspotInvoiceSnapshot.update({
        where: { id: existing.id },
        data: { hubspot_pdf_link: opts.pdfLink },
      });
    }

    const linesChanged = await this.syncLineItems(
      existing.id,
      invoice.organization_id,
      invoice.id,
      version.line_items,
    );
    if (linesChanged && outcome === 'skipped') outcome = 'updated';

    return { outcome, snapshotId: existing.id };
  }

  /**
   * Internal-invoice equivalent of the hs_invoice_status → 'paid' branch of
   * HandlerInvoicePropertyChange, in the same order: snapshot refresh → deployed
   * transition → staff matching → per-line commission creation.
   */
  async onInvoicePaid(
    invoiceId: string,
    opts: { pdfLink?: string | null } = {},
  ): Promise<void> {
    const { snapshotId } = await this.syncFromInvoice(invoiceId, opts);
    if (!snapshotId) return;

    const snapshot = await this.prisma.hubspotInvoiceSnapshot.findUnique({
      where: { id: snapshotId },
      select: { paid_at: true, organization: { select: { id: true } } },
    });

    if (snapshot?.organization?.id) {
      await this.invoicePaid.markOrganizationDeployedFromFirstPaidInvoice({
        organizationId: snapshot.organization.id,
        firstInvoiceDate: snapshot.paid_at ?? new Date(),
        internalInvoiceId: invoiceId,
      });

      // Lines left unresolved by the deterministic Hubstaff → Staff match fall back to the
      // same name matching (and review cases) HubSpot line items go through.
      await this.staffMatching.run(snapshot.organization.id);
    }

    await this.invoicePaid.createCommissionsForPaidSnapshot(
      { id: snapshotId },
      `internal:${invoiceId}`,
    );
  }

  /**
   * Billing-side entry points. Med Alliance must never break invoicing, so failures are only
   * logged — the next "Sync invoices" run / daily sync re-mirrors the invoice and
   * CommissionDetectionService creates any commission this call missed.
   */
  async safeSync(
    invoiceId: string,
    opts: { pdfLink?: string | null } = {},
  ): Promise<void> {
    try {
      await this.syncFromInvoice(invoiceId, opts);
    } catch (err) {
      this.logger.error(
        `Med Alliance snapshot sync failed for internal invoice ${invoiceId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async safeOnPaid(
    invoiceId: string,
    opts: { pdfLink?: string | null } = {},
  ): Promise<void> {
    try {
      await this.onInvoicePaid(invoiceId, opts);
    } catch (err) {
      this.logger.error(
        `Med Alliance commission creation failed for paid internal invoice ${invoiceId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Re-syncs every internal invoice of an organization — the internal-invoice step of the
   * manual "Sync invoices" button / daily sync. Recovers from any billing hook that failed
   * and backfills invoices created before this integration existed.
   */
  async syncAllForOrganization(
    organizationId: string,
  ): Promise<InternalInvoiceSyncStats> {
    const invoices = await this.prisma.invoice.findMany({
      where: { organization_id: organizationId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    const stats: InternalInvoiceSyncStats = {
      created: 0,
      updated: 0,
      skipped: 0,
    };

    for (const invoice of invoices) {
      try {
        const { outcome } = await this.syncFromInvoice(invoice.id);
        stats[outcome]++;
      } catch (err) {
        this.logger.error(
          `Failed to sync internal invoice ${invoice.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return stats;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private findExisting(invoiceId: string) {
    return this.prisma.hubspotInvoiceSnapshot.findUnique({
      where: { internal_invoice_id: invoiceId },
      select: {
        id: true,
        sync_hash: true,
        invoice_amount: true,
        hubspot_pdf_link: true,
        commissions: {
          where: { status: { notIn: DEAD_COMMISSION_STATUSES } },
          select: { id: true, status: true },
          take: 1,
        },
      },
    });
  }

  /**
   * One snapshot line per internal line (each can become its own commission). Returns true
   * when anything was created, updated or marked removed.
   */
  private async syncLineItems(
    snapshotId: string,
    organizationId: string,
    invoiceId: string,
    lines: InternalLine[],
  ): Promise<boolean> {
    const keys = InternalInvoiceSnapshotService.buildLineKeys(lines);

    const existingRows = await this.prisma.hubspotLineItemSnapshot.findMany({
      where: { invoice_id: snapshotId },
      select: {
        id: true,
        internal_line_key: true,
        internal_line_item_id: true,
        name: true,
        description: true,
        amount: true,
        line_category: true,
        removed_at: true,
        commissions: {
          where: { status: { notIn: DEAD_COMMISSION_STATUSES } },
          select: { id: true },
          take: 1,
        },
      },
    });
    const existingByKey = new Map(
      existingRows
        .filter((r) => r.internal_line_key)
        .map((r) => [r.internal_line_key as string, r]),
    );

    const resolveStaff = await this.buildStaffResolver(
      organizationId,
      lines.map((l) => l.worker_id).filter((id): id is string => !!id),
    );

    let changed = false;
    const currentKeys = new Set<string>();

    for (const line of lines) {
      const key = keys.get(line.id)!;
      currentKeys.add(key);
      const amount = new Decimal(line.final_total);
      const name = line.worker_name_snapshot ?? line.description;
      const row = existingByKey.get(key);

      try {
        if (!row) {
          const staffId = line.worker_id ? resolveStaff(line.worker_id) : null;
          await this.prisma.hubspotLineItemSnapshot.create({
            data: {
              source: InvoiceSource.internal,
              invoice_id: snapshotId,
              internal_line_key: key,
              internal_line_item_id: line.id,
              line_category: line.category,
              name,
              description: line.description,
              amount,
              // Account-level lines (fees, tax) are not a collaborator payment. Worker lines
              // the deterministic match can't resolve stay null for StaffMatchingService.
              ...(line.worker_id
                ? staffId
                  ? {
                      staff_id: staffId,
                      match_status: 'matched',
                      matched_by: 'auto',
                    }
                  : {}
                : { match_status: 'not_applicable', matched_by: 'auto' }),
            },
          });
          changed = true;
          continue;
        }

        const amountChanged = !new Decimal(row.amount ?? 0).eq(amount);
        const rowChanged =
          amountChanged ||
          row.name !== name ||
          row.description !== line.description ||
          row.line_category !== line.category ||
          row.internal_line_item_id !== line.id ||
          row.removed_at !== null;
        if (!rowChanged) continue;

        await this.prisma.hubspotLineItemSnapshot.update({
          where: { id: row.id },
          data: {
            name,
            description: line.description,
            amount,
            line_category: line.category,
            internal_line_item_id: line.id,
            removed_at: null,
          },
        });
        changed = true;

        if (amountChanged && row.commissions[0]) {
          await this.openInvoiceChangedCase(organizationId, {
            snapshotId,
            invoiceId,
            lineItemSnapshotId: row.id,
            commissionId: row.commissions[0].id,
            oldAmount: row.amount?.toString() ?? null,
            newAmount: amount.toString(),
          });
        }
      } catch (err: any) {
        if (err?.code === 'P2002') continue;
        this.logger.error(
          `Failed to sync line ${line.id} of internal invoice ${invoiceId}: ${err?.message ?? err}`,
        );
      }
    }

    for (const row of existingRows) {
      if (
        !row.internal_line_key ||
        currentKeys.has(row.internal_line_key) ||
        row.removed_at
      ) {
        continue;
      }
      await this.prisma.hubspotLineItemSnapshot.update({
        where: { id: row.id },
        data: { removed_at: new Date() },
      });
      changed = true;

      if (row.commissions[0]) {
        await this.openInvoiceChangedCase(organizationId, {
          snapshotId,
          invoiceId,
          lineItemSnapshotId: row.id,
          commissionId: row.commissions[0].id,
          oldAmount: row.amount?.toString() ?? null,
          newAmount: null,
        });
      }
    }

    return changed;
  }

  private async openInvoiceChangedCase(
    organizationId: string,
    p: {
      snapshotId: string;
      invoiceId: string;
      lineItemSnapshotId: string;
      commissionId: string;
      oldAmount: string | null;
      newAmount: string | null;
    },
  ): Promise<void> {
    await this.reviewCases.openOrSkip(
      organizationId,
      'reconciliation_invoice_changed',
      {
        snapshot_id: p.snapshotId,
        commission_id: p.commissionId,
        internal_invoice_id: p.invoiceId,
        hubspot_line_item_snapshot_id: p.lineItemSnapshotId,
        old_amount: p.oldAmount,
        new_amount: p.newAmount,
      },
    );
  }

  /**
   * Hubstaff user id (InvoiceLineItem.worker_id) → this organization's Staff row. Uses the
   * same identity widening as InvoiceWorker.buildStaffResolver (hubstaff id → candidate →
   * hubspot_vaid → every candidate sharing it), but WITHOUT its cross-organization fallback:
   * a commission must only ever point at a placement at the invoiced organization. Returns
   * null when there is no match or more than one plausible row, leaving the decision to the
   * name-based StaffMatchingService and its review cases.
   */
  private async buildStaffResolver(
    organizationId: string,
    workerIds: string[],
  ): Promise<(workerId: string) => string | null> {
    if (workerIds.length === 0) return () => null;

    const uniqueWorkerIds = Array.from(new Set(workerIds));
    const directCandidates = await this.prisma.candidate.findMany({
      where: { hubstaff_id: { in: uniqueWorkerIds } },
      select: { hubstaff_id: true, hubspot_vaid: true },
    });
    const vaIdByHubstaffId = new Map<string, string>();
    for (const c of directCandidates) {
      if (c.hubstaff_id && c.hubspot_vaid) {
        vaIdByHubstaffId.set(c.hubstaff_id, c.hubspot_vaid);
      }
    }
    const vaIds = Array.from(new Set(vaIdByHubstaffId.values()));

    const staff = await this.prisma.staff.findMany({
      where: {
        organization_id: organizationId,
        candidate: {
          OR: [
            { hubstaff_id: { in: uniqueWorkerIds } },
            ...(vaIds.length > 0 ? [{ hubspot_vaid: { in: vaIds } }] : []),
          ],
        },
      },
      select: {
        id: true,
        status: true,
        candidate: { select: { hubstaff_id: true, hubspot_vaid: true } },
      },
    });

    return (workerId: string) => {
      const vaId = vaIdByHubstaffId.get(workerId) ?? null;
      const pool = staff.filter(
        (s) =>
          s.candidate?.hubstaff_id === workerId ||
          (!!vaId && s.candidate?.hubspot_vaid === vaId),
      );
      const active = pool.filter((s) => s.status === 'active');
      const candidates = active.length > 0 ? active : pool;
      return candidates.length === 1 ? candidates[0].id : null;
    };
  }

  private computeSyncHash(
    invoiceId: string,
    f: {
      invoice_status: string;
      payment_status: string | null;
      invoice_amount: Decimal;
      currency: string;
      paid_at: Date | null;
      due_date: Date | null;
      invoice_number: string | null;
      organization_id: string;
    },
  ): string {
    const payload = [
      `internal:${invoiceId}`,
      f.organization_id,
      f.invoice_status,
      f.payment_status ?? '',
      f.invoice_amount.toString(),
      f.currency,
      f.paid_at ? f.paid_at.toISOString() : '',
      f.due_date ? f.due_date.toISOString() : '',
      f.invoice_number ?? '',
    ].join('|');

    return createHash('sha256').update(payload).digest('hex');
  }
}
