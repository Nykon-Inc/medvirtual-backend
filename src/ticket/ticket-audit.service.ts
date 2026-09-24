import { Injectable } from '@nestjs/common';
import { Prisma, TicketAuditSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListTicketAuditLogsDto } from './dto/list-ticket-audit-logs.dto';

/**
 * Ticket lifecycle events. Kept as a const union rather than a Prisma enum so new events
 * do not require a migration — see the TicketAuditLog model comment in schema.prisma.
 */
export const TICKET_AUDIT_EVENTS = {
  CREATED: 'created',
  UPDATED: 'updated',
  STATUS_CHANGED: 'status_changed',
  REASSIGNED: 'reassigned',
  DELETED: 'deleted',
  RESTORED: 'restored',
  NOTE_ADDED: 'note_added',
} as const;

export type TicketAuditEvent =
  (typeof TICKET_AUDIT_EVENTS)[keyof typeof TICKET_AUDIT_EVENTS];

/**
 * Where a ticket came from. Tickets are created from five different code paths, only one of
 * which is the tickets endpoint itself — this records which one, so "who created it and from
 * where" is answerable from the log alone.
 */
export const TICKET_AUDIT_ORIGINS = {
  /** POST /tickets — a user filing a ticket directly. */
  TICKET_ENDPOINT: 'ticket_endpoint',
  /** POST /staff/bonus — bonus granted to a staff member. */
  STAFF_BONUS: 'staff_bonus',
  /** POST /staff/termination — termination requested for a staff member. */
  STAFF_TERMINATION: 'staff_termination',
  /** Public talent-pool form — no authenticated user. */
  TALENT_POOL_FORM: 'talent_pool_form',
  /** Offer panel accepted via public token — no authenticated user. */
  OFFER_PANEL_ACCEPTED: 'offer_panel_accepted',
} as const;

export type TicketAuditOrigin =
  (typeof TICKET_AUDIT_ORIGINS)[keyof typeof TICKET_AUDIT_ORIGINS];

export interface TicketAuditLogParams {
  ticketId: string;
  actorUserId?: string | null;
  actorLabel?: string | null;
  event: TicketAuditEvent;
  oldStatus?: string | null;
  newStatus?: string | null;
  reason?: string | null;
  source?: TicketAuditSource;
  before?: Record<string, any> | null;
  after?: Record<string, any> | null;
  metadata?: Record<string, any> | null;
}

export { buildActorLabel } from '../common/utils/actor-label';

@Injectable()
export class TicketAuditService {
  constructor(private readonly prisma: PrismaService) {}

  private buildData(params: TicketAuditLogParams) {
    return {
      ticket_id: params.ticketId,
      actor_user_id: params.actorUserId ?? null,
      actor_label: params.actorLabel ?? null,
      event: params.event,
      old_status: params.oldStatus ?? null,
      new_status: params.newStatus ?? null,
      reason: params.reason ?? null,
      source: params.source ?? TicketAuditSource.user,
      before: (params.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (params.after ?? undefined) as Prisma.InputJsonValue | undefined,
      metadata: (params.metadata ?? undefined) as
        | Prisma.InputJsonValue
        | undefined,
    };
  }

  /**
   * Observability events (created / updated / status_changed / reassigned / note_added).
   * Swallows failures so a broken audit write never fails a working ticket operation.
   *
   * MUST be called after the main write has committed, and MUST NOT receive a transaction
   * client: a swallowed failure inside a Postgres transaction leaves it aborted, so the
   * later commit fails anyway — in a far more confusing way. Use logOrThrow for that.
   */
  async log(params: TicketAuditLogParams): Promise<void> {
    try {
      await this.prisma.ticketAuditLog.create({ data: this.buildData(params) });
    } catch (err) {
      console.error('[TicketAudit] Failed to write audit log:', err);
    }
  }

  /**
   * Compliance events (deleted / restored). Propagates failures.
   *
   * Pass the transaction client so the audit row and the state change commit atomically:
   * either both the tombstone and its log entry exist, or neither does.
   */
  async logOrThrow(
    params: TicketAuditLogParams,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.ticketAuditLog.create({ data: this.buildData(params) });
  }

  async findAllLogs(dto: ListTicketAuditLogsDto) {
    const {
      page = 1,
      limit = 20,
      ticket_id,
      event,
      source,
      actor_user_id,
      origin,
      date_from,
      date_to,
      search,
      sortOrder = 'desc',
    } = dto;

    const where: Prisma.TicketAuditLogWhereInput = {
      ...(ticket_id && { ticket_id }),
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
              { ticket_id: { contains: search, mode: 'insensitive' } },
              { actor_label: { contains: search, mode: 'insensitive' } },
              { reason: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, data] = await Promise.all([
      this.prisma.ticketAuditLog.count({ where }),
      this.prisma.ticketAuditLog.findMany({
        where,
        orderBy: { createdAt: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          ticket_id: true,
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
            select: {
              id: true,
              first_name: true,
              last_name: true,
              email: true,
            },
          },
        },
      }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findByTicket(ticketId: string) {
    return this.prisma.ticketAuditLog.findMany({
      where: { ticket_id: ticketId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        ticket_id: true,
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
      },
    });
  }

  /**
   * Most recent `deleted` event for a ticket. Used by restore() to recover the exact
   * bonus/note ids that the delete soft-deleted, so restore never resurrects rows that
   * were already soft-deleted beforehand.
   */
  async findLastDeletedEvent(ticketId: string) {
    return this.prisma.ticketAuditLog.findFirst({
      where: { ticket_id: ticketId, event: TICKET_AUDIT_EVENTS.DELETED },
      orderBy: { createdAt: 'desc' },
      select: { id: true, metadata: true, createdAt: true },
    });
  }
}
