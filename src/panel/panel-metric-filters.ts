import {
  HireRequestStatus,
  OrganizationStatus,
  PanelCandidateStatus,
  Prisma,
} from '@prisma/client';
import { ACTIVE_PIPELINE_STAFF_WHERE } from '../common/constant/activeDealPipelines';
import {
  CANDIDATE_AUDIT_EVENTS,
  ENDORSED_VIA_PLATFORM_PIPELINE_STATUS,
} from '../candidate/candidate-audit.service';

/**
 * `where` builders for the period-filtered KPI cards of the Operational
 * Dashboard. Both the card count (`PanelService.getPanelData`) and the card's
 * drill-down list (`PanelMetricDetailsService`) read from these, so a card's
 * number and the rows behind it can never disagree.
 *
 * `range` is the output of `buildInclusiveDateRange`; undefined means "all time".
 */
export type MetricDateRange = { gte?: Date; lte?: Date } | undefined;

export const CLIENT_USER_ROLES = [
  'organization_admin',
  'organization_super_admin',
];

// Talent pipeline stages counted as "available" on the Talents tab.
export const AVAILABLE_TALENT_PIPELINE_STATUSES = ['261075105', '1087596819'];

export function newHireRequestsWhere(
  range: MetricDateRange,
): Prisma.HireRequestWhereInput {
  return {
    status: { not: HireRequestStatus.deleted },
    ...(range ? { createdAt: range } : {}),
  };
}

export function newStaffWhere(range: MetricDateRange): Prisma.StaffWhereInput {
  return {
    ...ACTIVE_PIPELINE_STAFF_WHERE,
    ...(range ? { created_at: range } : {}),
  };
}

/**
 * With a period: candidates whose FIRST entry into the available pool falls in
 * it, whatever stage they are in today — a return to the pool is not counted
 * again. Without one: the pool as it stands now.
 */
export function newAvailableCandidatesWhere(
  range: MetricDateRange,
): Prisma.CandidateWhereInput {
  return range
    ? { first_available_at: range }
    : { pipeline_status: { in: AVAILABLE_TALENT_PIPELINE_STATUSES } };
}

export function newClientsWithActiveStaffWhere(
  range: MetricDateRange,
): Prisma.OrganizationWhereInput {
  return {
    status: OrganizationStatus.active,
    staff: { some: ACTIVE_PIPELINE_STAFF_WHERE },
    ...(range ? { createdAt: range } : {}),
  };
}

export function clientUsersCreatedWhere(
  range: MetricDateRange,
): Prisma.USERWhereInput {
  return {
    role: { in: CLIENT_USER_ROLES },
    ...(range ? { createdAt: range } : {}),
  };
}

export function clientInvitesAcceptedWhere(
  range: MetricDateRange,
): Prisma.USERWhereInput {
  return {
    role: { in: CLIENT_USER_ROLES },
    status: 'active',
    verified: true,
    ...(range ? { activatedAt: range } : {}),
  };
}

/** Same population as the Overview "New Available Virtual Assistant" card. */
export function talentsCreatedWhere(
  range: MetricDateRange,
): Prisma.CandidateWhereInput {
  return newAvailableCandidatesWhere(range);
}

/** Rows must be de-duplicated by `candidate_id` (webhook retries can double-log). */
export function talentsEndorsedWhere(
  range: MetricDateRange,
): Prisma.CandidateAuditLogWhereInput {
  return {
    event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
    pipeline_status_new: ENDORSED_VIA_PLATFORM_PIPELINE_STATUS,
    ...(range ? { createdAt: range } : {}),
  };
}

export function talentsHiredWhere(
  range: MetricDateRange,
): Prisma.PanelCandidateWhereInput {
  return {
    status: PanelCandidateStatus.selected_by_client,
    ...(range ? { updatedAt: range } : {}),
  };
}

export function hrSubmittedByClientWhere(
  range: MetricDateRange,
): Prisma.HireRequestWhereInput {
  return {
    createdBy: { role: { in: CLIENT_USER_ROLES } },
    status: {
      notIn: [HireRequestStatus.deleted, HireRequestStatus.cancelled],
    },
    ...(range ? { createdAt: range } : {}),
  };
}
