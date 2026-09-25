import { Injectable } from '@nestjs/common';
import { OfferPanelAuditSource, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListOfferPanelAuditLogsDto } from './dto/list-offer-panel-audit-logs.dto';

// The actor-label rule is identical for every audit log in the codebase, so it is
// reused rather than duplicated. Re-exported here so offer-panel call sites can take
// everything they need from this module.
export { buildActorLabel } from '../ticket/ticket-audit.service';

/**
 * Offer panel lifecycle events. Kept as a const union rather than a Prisma enum so new
 * events do not require a migration — see the OfferPanelAuditLog model comment in
 * schema.prisma.
 */
export const OFFER_PANEL_AUDIT_EVENTS = {
  CREATED: 'created',
  /** First view only — see the note on volume in trackView/trackViewByToken. */
  VIEWED: 'viewed',
  UPDATED: 'updated',
  CANDIDATE_REMOVED: 'candidate_removed',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  DELETED: 'deleted',
  RESENT: 'resent',
  /** "Add as user": recipient invited as an org user and the panel relinked to them. */
  RECIPIENT_INVITED_AS_USER: 'recipient_invited_as_user',
  /** Recipient already had a user account; the panel was relinked to it. */
  RECIPIENT_LINKED_TO_USER: 'recipient_linked_to_user',
} as const;

export type OfferPanelAuditEvent =
  (typeof OFFER_PANEL_AUDIT_EVENTS)[keyof typeof OFFER_PANEL_AUDIT_EVENTS];

/**
 * Which surface an action came from. A panel can be acted on from three very different
 * places — the admin console, the authenticated client dashboard, and the
 * unauthenticated public token page — and only the last of those has no user attached.
 * Recording the origin makes "who did this and from where" answerable from the log alone.
 */
export const OFFER_PANEL_AUDIT_ORIGINS = {
  /** POST /offer-panels — the admin fan-out create. */
  ADMIN_CREATE: 'admin_create',
  /** Authenticated client dashboard (organization_admin / organization_super_admin). */
  CLIENT_DASHBOARD: 'client_dashboard',
  /** Unauthenticated public token page — no acting user. */
  PUBLIC_TOKEN: 'public_token',
  /** Cascade from a candidate being deleted (removeCandidateFromAllPanels). */
  CANDIDATE_CASCADE: 'candidate_cascade',
  /** POST /offer-panels/:id/resend. */
  ADMIN_RESEND: 'admin_resend',
  /** PATCH /offer-panels/:id or DELETE /offer-panels/:id from the admin console. */
  ADMIN_CONSOLE: 'admin_console',
  /** POST /offer-panels/:id/add-as-user or /link-recipient-user. */
  ADMIN_ADD_AS_USER: 'admin_add_as_user',
} as const;

export type OfferPanelAuditOrigin =
  (typeof OFFER_PANEL_AUDIT_ORIGINS)[keyof typeof OFFER_PANEL_AUDIT_ORIGINS];

export interface OfferPanelAuditLogParams {
  offerPanelId: string;
  actorUserId?: string | null;
  actorLabel?: string | null;
  event: OfferPanelAuditEvent;
  oldStatus?: string | null;
  newStatus?: string | null;
  reason?: string | null;
  source?: OfferPanelAuditSource;
  before?: Record<string, any> | null;
  after?: Record<string, any> | null;
  metadata?: Record<string, any> | null;
}

/**
 * Actor label for the unauthenticated token paths. Defined once so all three public
 * call sites (viewed / accepted / declined by token) agree on the wording.
 */
export function recipientActorLabel(recipientName?: string | null): string {
  const name = recipientName?.trim();
  return name ? `${name} (offer panel recipient)` : 'Offer panel recipient';
}

/**
 * Shared projection for both read paths. `actorUser` is joined for the live display name;
 * `actor_label` is the denormalized fallback for actors that have since been deleted.
 */
const OFFER_PANEL_AUDIT_SELECT = {
  id: true,
  offer_panel_id: true,
  actor_label: true,
  event: true,
  old_status: true,
  new_status: true,
  reason: true,
  source: true,
  before: true,
  after: true,
  metadata: true,
  createdAt: true,
  actorUser: {
    select: { id: true, first_name: true, last_name: true, email: true },
  },
} as const;

@Injectable()
export class OfferPanelsAuditService {
  constructor(private readonly prisma: PrismaService) {}

  private buildData(params: OfferPanelAuditLogParams) {
    return {
      offer_panel_id: params.offerPanelId,
      actor_user_id: params.actorUserId ?? null,
      actor_label: params.actorLabel ?? null,
      event: params.event,
      old_status: params.oldStatus ?? null,
      new_status: params.newStatus ?? null,
      reason: params.reason ?? null,
      source: params.source ?? OfferPanelAuditSource.user,
      before: (params.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (params.after ?? undefined) as Prisma.InputJsonValue | undefined,
      metadata: (params.metadata ?? undefined) as
        | Prisma.InputJsonValue
        | undefined,
    };
  }

  /**
   * Observability events (created / viewed / updated / candidate_removed / accepted /
   * declined / resent). Swallows failures so a broken audit write never fails a working
   * panel operation.
   *
   * MUST be called after the main write has committed, and MUST NOT receive a transaction
   * client: a swallowed failure inside a Postgres transaction leaves it aborted, so the
   * later commit fails anyway — in a far more confusing way. Use logOrThrow for that.
   */
  async log(params: OfferPanelAuditLogParams): Promise<void> {
    try {
      await this.prisma.offerPanelAuditLog.create({
        data: this.buildData(params),
      });
    } catch (err) {
      console.error('[OfferPanelAudit] Failed to write audit log:', err);
    }
  }

  /**
   * Compliance events (deleted). Propagates failures.
   *
   * Offer panels are HARD deleted, so the audit row is the only surviving evidence that
   * the panel ever existed. Pass the transaction client and call this BEFORE the delete
   * statement: either both the tombstone and the deletion commit, or neither does.
   */
  async logOrThrow(
    params: OfferPanelAuditLogParams,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.offerPanelAuditLog.create({ data: this.buildData(params) });
  }

  /**
   * Paginated, filterable read across all panels.
   *
   * No route exposes this yet — the shipped UI is the per-panel timeline only. It is
   * built now because it is the same query `findByOfferPanel` already needs with filters
   * bolted on, so the deferred global audit page later costs a controller method and a
   * page, with no service churn.
   */
  async findAllLogs(dto: ListOfferPanelAuditLogsDto) {
    const {
      page = 1,
      limit = 20,
      offer_panel_id,
      event,
      source,
      actor_user_id,
      origin,
      date_from,
      date_to,
      search,
      sortOrder = 'desc',
    } = dto;

    const where: Prisma.OfferPanelAuditLogWhereInput = {
      ...(offer_panel_id && { offer_panel_id }),
      ...(event && { event }),
      ...(source && { source }),
      ...(actor_user_id && { actor_user_id }),
      // origin lives inside the metadata JSON rather than its own column.
      ...(origin && { metadata: { path: ['origin'], equals: origin } }),
      ...(date_from || date_to
        ? {
            createdAt: {
              ...(date_from && { gte: new Date(date_from) }),
              ...(date_to && {
                lte: new Date(new Date(date_to).setHours(23, 59, 59, 999)),
              }),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { offer_panel_id: { contains: search, mode: 'insensitive' } },
              { actor_label: { contains: search, mode: 'insensitive' } },
              { reason: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, data] = await Promise.all([
      this.prisma.offerPanelAuditLog.count({ where }),
      this.prisma.offerPanelAuditLog.findMany({
        where,
        orderBy: { createdAt: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
        select: OFFER_PANEL_AUDIT_SELECT,
      }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Full timeline for one panel, oldest first. */
  async findByOfferPanel(offerPanelId: string) {
    return this.prisma.offerPanelAuditLog.findMany({
      where: { offer_panel_id: offerPanelId },
      orderBy: { createdAt: 'asc' },
      select: OFFER_PANEL_AUDIT_SELECT,
    });
  }
}
