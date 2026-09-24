import { Injectable } from '@nestjs/common';
import { Prisma, UserAuditSource, USER } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildActorLabel } from '../common/utils/actor-label';
import { ListUserAuditLogsDto } from './dto/list-user-audit-logs.dto';
import { USER_AUDIT_EVENTS, UserAuditEvent } from './user-audit.events';

export { USER_AUDIT_EVENTS } from './user-audit.events';
export type { UserAuditEvent } from './user-audit.events';

/**
 * The only USER columns ever written to `before`/`after`. Anything not listed here — password,
 * workos_id, bill.com session data — never reaches the audit table.
 */
export const USER_AUDIT_TRACKED_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'phone',
  'job_title',
  'avatar',
  'role',
  'status',
  'status_before_deactivation',
  'deactivated_by_bu',
  'verified',
  'organization_id',
  'organization_name',
  'is_organization_owner',
  'hubspot_id',
  'hubspot_contact_id',
  'activatedAt',
] as const satisfies readonly (keyof USER)[];

type TrackedField = (typeof USER_AUDIT_TRACKED_FIELDS)[number];
type TrackedSnapshot = Partial<Record<TrackedField, unknown>>;

const PROFILE_FIELDS: TrackedField[] = [
  'first_name',
  'last_name',
  'phone',
  'job_title',
  'avatar',
  'verified',
  'activatedAt',
];
const ORGANIZATION_FIELDS: TrackedField[] = [
  'organization_id',
  'organization_name',
  'is_organization_owner',
];
const STATUS_FIELDS: TrackedField[] = [
  'status',
  'status_before_deactivation',
  'deactivated_by_bu',
];
const HUBSPOT_FIELDS: TrackedField[] = ['hubspot_id', 'hubspot_contact_id'];

/** The subject of an audit row. Only `email` is required — everything else is best-effort. */
export type UserAuditSubject = Partial<
  Pick<
    USER,
    | 'id'
    | 'email'
    | 'first_name'
    | 'last_name'
    | 'role'
    | 'organization_id'
    | 'organization_name'
  >
> & { email: string };

export interface UserAuditLogParams {
  subject: UserAuditSubject;
  event: UserAuditEvent;
  source?: UserAuditSource;
  actorUserId?: string | null;
  actorLabel?: string | null;
  oldStatus?: string | null;
  newStatus?: string | null;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface UserAuditUpdateParams {
  before: Partial<USER>;
  after: Partial<USER>;
  source?: UserAuditSource;
  actorUserId?: string | null;
  actorLabel?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

type ActorInput = Pick<USER, 'id' | 'first_name' | 'last_name' | 'email'>;

/** Spreads into log params: `{ ...auditActor(user), ... }`. */
export function auditActor(user?: ActorInput | null): {
  actorUserId: string | null;
  actorLabel: string | null;
} {
  return { actorUserId: user?.id ?? null, actorLabel: buildActorLabel(user) };
}

const isRecord = (value: unknown): value is Partial<USER> =>
  typeof value === 'object' && value !== null;

function normalize(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** Allowlisted, JSON-safe copy of the tracked USER columns present on `user`. */
export function pickTrackedFields(user: Partial<USER>): TrackedSnapshot {
  const out: TrackedSnapshot = {};
  if (!isRecord(user)) return out;
  for (const field of USER_AUDIT_TRACKED_FIELDS) {
    if (field in user) out[field] = normalize(user[field]);
  }
  return out;
}

/**
 * Full point-in-time picture of a user, stored on removal events so the log alone proves the
 * user existed, how they were created, and what state they were in when removed.
 */
export function snapshotUser(user: Partial<USER>): Record<string, unknown> {
  return {
    id: user.id,
    ...pickTrackedFields(user),
    createdAt: normalize(user.createdAt),
    createdByMethod: user.createdByMethod,
    createdByUserId: user.createdByUserId,
  };
}

/** Tracked fields whose value differs between `before` and `after` (only fields present on `after`). */
export function diffUser(
  before: Partial<USER>,
  after: Partial<USER>,
): TrackedField[] {
  // Audit must never break the operation it observes — tolerate odd shapes.
  if (!isRecord(after)) return [];
  if (!isRecord(before)) before = {};
  return USER_AUDIT_TRACKED_FIELDS.filter(
    (field) =>
      field in after &&
      JSON.stringify(normalize(before[field]) ?? null) !==
        JSON.stringify(normalize(after[field]) ?? null),
  );
}

/** `{ before, after }` restricted to the tracked fields that actually changed — or null. */
export function changedSlice(
  before: Partial<USER>,
  after: Partial<USER>,
): { before: TrackedSnapshot; after: TrackedSnapshot } | null {
  const changed = diffUser(before, after);
  if (changed.length === 0) return null;
  const pick = (src: Partial<USER>) =>
    Object.fromEntries(changed.map((f) => [f, normalize(src[f]) ?? null]));
  return { before: pick(before), after: pick(after) };
}

export interface AuditRequestContext {
  ip: string | null;
  user_agent: string | null;
}

type RequestLike = {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
};

/**
 * Caller IP + user agent for auth events. The API sits behind a load balancer, so the first
 * X-Forwarded-For hop is the client; `req.ip` is only the fallback.
 */
export function auditRequestContext(
  req?: RequestLike | null,
): AuditRequestContext {
  const header = (name: string) => {
    const value = req?.headers?.[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const forwarded = header('x-forwarded-for')?.split(',')[0]?.trim();
  return {
    ip: forwarded || req?.ip || null,
    user_agent: header('user-agent') ?? null,
  };
}

function statusEvent(oldStatus: unknown, newStatus: unknown): UserAuditEvent {
  if (newStatus === 'inactive') return USER_AUDIT_EVENTS.DEACTIVATED;
  if (oldStatus === 'inactive' && newStatus === 'active')
    return USER_AUDIT_EVENTS.REACTIVATED;
  return USER_AUDIT_EVENTS.STATUS_CHANGED;
}

function subjectFrom(user: Partial<USER>): UserAuditSubject {
  return {
    id: user.id,
    email: user.email ?? '',
    first_name: user.first_name,
    last_name: user.last_name,
    role: user.role,
    organization_id: user.organization_id,
    organization_name: user.organization_name,
  };
}

@Injectable()
export class UserAuditService {
  constructor(private readonly prisma: PrismaService) {}

  private buildData(
    params: UserAuditLogParams,
  ): Prisma.UserAuditLogUncheckedCreateInput {
    const { subject } = params;
    const label =
      `${subject.first_name ?? ''} ${subject.last_name ?? ''}`.trim();
    return {
      subject_user_id: subject.id ?? null,
      subject_email: subject.email,
      subject_label: label || null,
      subject_role: subject.role ?? null,
      organization_id: subject.organization_id ?? null,
      organization_name: subject.organization_name ?? null,
      event: params.event,
      old_status: params.oldStatus ?? null,
      new_status: params.newStatus ?? null,
      reason: params.reason ?? null,
      source: params.source ?? UserAuditSource.user,
      actor_user_id: params.actorUserId ?? null,
      actor_label: params.actorLabel ?? null,
      before: (params.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (params.after ?? undefined) as Prisma.InputJsonValue | undefined,
      metadata: (params.metadata ?? undefined) as
        | Prisma.InputJsonValue
        | undefined,
    };
  }

  /**
   * Observability events. Swallows failures so a broken audit write never fails a working
   * user operation.
   *
   * MUST be called after the main write has committed, and MUST NOT receive a transaction
   * client: a swallowed failure inside a Postgres transaction leaves it aborted. Use
   * logOrThrow for that.
   */
  async log(params: UserAuditLogParams): Promise<void> {
    try {
      await this.prisma.userAuditLog.create({ data: this.buildData(params) });
    } catch (err) {
      console.error('[UserAudit] Failed to write audit log:', err);
    }
  }

  /**
   * Removal events. Propagates failures — pass the transaction client so the audit row and the
   * delete commit atomically: a user can never disappear without leaving its tombstone.
   */
  async logOrThrow(
    params: UserAuditLogParams,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.userAuditLog.create({ data: this.buildData(params) });
  }

  /** Bulk writes (updateMany / raw SQL). Read the affected users before writing. */
  async logMany(paramsList: UserAuditLogParams[]): Promise<void> {
    if (paramsList.length === 0) return;
    try {
      await this.prisma.userAuditLog.createMany({
        data: paramsList.map((p) => this.buildData(p)),
      });
    } catch (err) {
      console.error('[UserAudit] Failed to write bulk audit log:', err);
    }
  }

  /**
   * Splits a USER update into one row per concern (email / role / status / organization /
   * HubSpot link / profile), each carrying only its own fields, so the log reads as
   * "role_changed: organization_admin → organization_super_admin" rather than one opaque diff.
   */
  buildUpdateEntries(params: UserAuditUpdateParams): UserAuditLogParams[] {
    const changed = diffUser(params.before, params.after);
    if (changed.length === 0) return [];

    const merged: Partial<USER> = { ...params.before, ...params.after };
    const subject = subjectFrom(merged);
    const common = {
      subject,
      source: params.source,
      actorUserId: params.actorUserId,
      actorLabel: params.actorLabel,
      reason: params.reason,
      metadata: params.metadata,
    };
    const slice = (fields: TrackedField[]) => {
      const present = changed.filter((f) => fields.includes(f));
      if (present.length === 0) return null;
      const pick = (src: Partial<USER>) =>
        Object.fromEntries(present.map((f) => [f, normalize(src[f]) ?? null]));
      return { before: pick(params.before), after: pick(merged) };
    };

    const entries: UserAuditLogParams[] = [];
    const email = slice(['email']);
    if (email)
      entries.push({
        ...common,
        event: USER_AUDIT_EVENTS.EMAIL_CHANGED,
        ...email,
      });
    const role = slice(['role']);
    if (role)
      entries.push({
        ...common,
        event: USER_AUDIT_EVENTS.ROLE_CHANGED,
        ...role,
      });
    const status = slice(STATUS_FIELDS);
    if (status) {
      const oldStatus = params.before.status ?? null;
      const newStatus = merged.status ?? null;
      entries.push({
        ...common,
        event:
          oldStatus === newStatus
            ? USER_AUDIT_EVENTS.STATUS_CHANGED
            : statusEvent(oldStatus, newStatus),
        oldStatus,
        newStatus,
        ...status,
      });
    }
    const organization = slice(ORGANIZATION_FIELDS);
    if (organization)
      entries.push({
        ...common,
        event: USER_AUDIT_EVENTS.ORGANIZATION_CHANGED,
        ...organization,
      });
    const hubspot = slice(HUBSPOT_FIELDS);
    if (hubspot)
      entries.push({
        ...common,
        event: USER_AUDIT_EVENTS.HUBSPOT_LINK_CHANGED,
        ...hubspot,
      });
    const profile = slice(PROFILE_FIELDS);
    if (profile)
      entries.push({
        ...common,
        event: USER_AUDIT_EVENTS.PROFILE_UPDATED,
        ...profile,
      });
    return entries;
  }

  /** Diffs `before` → `after` and logs one row per changed concern. Swallows failures. */
  async logUpdate(params: UserAuditUpdateParams): Promise<void> {
    await this.logMany(this.buildUpdateEntries(params));
  }

  /**
   * Bulk variant of logUpdate for updateMany / raw SQL: `users` are the rows read BEFORE the
   * write, `patch` is what was applied to every one of them.
   */
  async logBulkUpdate(
    users: Partial<USER>[],
    patch: Partial<USER>,
    params: Omit<UserAuditUpdateParams, 'before' | 'after'>,
  ): Promise<void> {
    await this.logMany(
      users.flatMap((before) =>
        this.buildUpdateEntries({ ...params, before, after: patch }),
      ),
    );
  }

  async findAllLogs(dto: ListUserAuditLogsDto) {
    const {
      page = 1,
      limit = 20,
      event,
      source,
      subject_user_id,
      organization_id,
      date_from,
      date_to,
      search,
      sortOrder = 'desc',
    } = dto;

    const where: Prisma.UserAuditLogWhereInput = {
      ...(event && { event }),
      ...(source && { source }),
      ...(subject_user_id && { subject_user_id }),
      ...(organization_id && { organization_id }),
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
              { subject_email: { contains: search, mode: 'insensitive' } },
              { subject_label: { contains: search, mode: 'insensitive' } },
              { subject_user_id: { contains: search, mode: 'insensitive' } },
              { organization_name: { contains: search, mode: 'insensitive' } },
              { actor_label: { contains: search, mode: 'insensitive' } },
              { reason: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, data] = await Promise.all([
      this.prisma.userAuditLog.count({ where }),
      this.prisma.userAuditLog.findMany({
        where,
        orderBy: { createdAt: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
        include: {
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
}
