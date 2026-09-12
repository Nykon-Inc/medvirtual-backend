import { Injectable } from '@nestjs/common';
import {
  CandidateAuditFieldGroup,
  CandidateAuditSource,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Candidate lifecycle events. Kept as a const union rather than a Prisma enum so new events
 * do not require a migration — see the CandidateAuditLog model comment in schema.prisma.
 */
export const CANDIDATE_AUDIT_EVENTS = {
  PIPELINE_STATUS_CHANGED: 'pipeline_status_changed',
  PROFILE_UPDATED: 'profile_updated',
  PROCESSING_STATUS_CHANGED: 'processing_status_changed',
  AVATAR_GENERATED: 'avatar_generated',
  BUSINESS_UNIT_SYNCED: 'business_unit_synced',
  VA_SCORECARD_SYNCED: 'va_scorecard_synced',
  DEACTIVATED_BY_BU: 'deactivated_by_bu',
  REACTIVATED_BY_BU: 'reactivated_by_bu',
  HUBSPOT_ID_MERGED: 'hubspot_id_merged',
  CANDIDATE_CREATED: 'candidate_created',
  CANDIDATE_DELETED: 'candidate_deleted',
  CANDIDATE_MERGED_AWAY: 'candidate_merged_away',
} as const;

export type CandidateAuditEvent =
  (typeof CANDIDATE_AUDIT_EVENTS)[keyof typeof CANDIDATE_AUDIT_EVENTS];

/** DB code for the "Endorsed via Platform" pipeline stage — see stage-dictionary.ts. */
export const ENDORSED_VIA_PLATFORM_PIPELINE_STATUS = '1172847191';

/** DB code for the "Lost" pipeline stage — see stage-dictionary.ts. */
export const CANDIDATE_LOST_STAGE_ID = '261173428';

export interface CandidateAuditLogParams {
  candidateId: string;
  hubspotId?: string | null;
  actorUserId?: string | null;
  actorLabel?: string | null;
  event: CandidateAuditEvent;
  fieldGroup: CandidateAuditFieldGroup;
  before?: Record<string, any> | null;
  after?: Record<string, any> | null;
  source?: CandidateAuditSource;
  metadata?: Record<string, any> | null;
}

@Injectable()
export class CandidateAuditService {
  constructor(private readonly prisma: PrismaService) {}

  private buildData(params: CandidateAuditLogParams) {
    return {
      candidate_id: params.candidateId,
      hubspot_id: params.hubspotId ?? null,
      actor_user_id: params.actorUserId ?? null,
      actor_label: params.actorLabel ?? null,
      event: params.event,
      field_group: params.fieldGroup,
      pipeline_status_new:
        params.event === CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED
          ? ((params.after?.pipeline_status as string | undefined) ?? null)
          : null,
      source: params.source ?? CandidateAuditSource.system,
      before: (params.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (params.after ?? undefined) as Prisma.InputJsonValue | undefined,
      metadata: (params.metadata ?? undefined) as
        | Prisma.InputJsonValue
        | undefined,
    };
  }

  /**
   * Fire-and-forget observability write. Swallows failures so a broken audit write never
   * fails a working candidate operation. Use for every site except hard-delete/merge.
   */
  async log(params: CandidateAuditLogParams): Promise<void> {
    try {
      await this.prisma.candidateAuditLog.create({
        data: this.buildData(params),
      });
    } catch (err) {
      console.error('[CandidateAudit] Failed to write audit log:', err);
    }
  }

  /**
   * Propagating write for hard-delete/merge sites. Pass the transaction client so the
   * tombstone and its log entry commit atomically: either both exist, or neither does.
   */
  async logOrThrow(
    params: CandidateAuditLogParams,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.candidateAuditLog.create({ data: this.buildData(params) });
  }

  /**
   * Bulk helper for updateMany/deleteMany sites, where the affected records must be
   * fetched before the bulk write (updateMany/deleteMany return only a count).
   */
  async logMany(paramsList: CandidateAuditLogParams[]): Promise<void> {
    if (paramsList.length === 0) return;
    try {
      await this.prisma.candidateAuditLog.createMany({
        data: paramsList.map((p) => this.buildData(p)),
      });
    } catch (err) {
      console.error('[CandidateAudit] Failed to write bulk audit log:', err);
    }
  }
}
