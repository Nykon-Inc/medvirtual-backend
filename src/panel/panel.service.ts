import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  HireRequestStatus,
  OrganizationStatus,
  PanelCandidateStatus,
  PanelStatus,
} from '@prisma/client';
import {
  buildConfigMap,
  computeCandidateRates,
  CandidatePool,
} from '../common/utils/salary.util';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { changeLabelAvailability } from '../common/utils/hubspot.util';
import { getApprovedPositionLabel } from '../common/dictionaries/approved-positions-pairing-dictionary';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import { dbToStageDictionary } from '../common/dictionaries/stage-dictionary';
import { activePipelines } from '../common/constant/activeDealPipelines';
import { TalentAvailabilityByRoleDto } from './dto/talent-availability-by-role.dto';
import { ClientSelectedCandidatesQueryDto } from './dto/client-selected-candidates-query.dto';
import { ClientSelectedCandidatesResponseDto } from './dto/client-selected-candidate-row.dto';
import { CandidateEndorsementsQueryDto } from './dto/candidate-endorsements-query.dto';
import {
  CandidateEndorsementRowDto,
  CandidateEndorsementsResponseDto,
} from './dto/candidate-endorsement-row.dto';
import { ClientLoginsQueryDto } from './dto/client-logins-query.dto';
import {
  ClientLoginRowDto,
  ClientLoginsResponseDto,
} from './dto/client-login-row.dto';
import { AdminLoginsQueryDto } from './dto/admin-logins-query.dto';
import {
  AdminLoginRowDto,
  AdminLoginsResponseDto,
} from './dto/admin-login-row.dto';
import {
  TalentAgingReportDto,
  TalentAgingBucketDto,
  TalentAgingCandidateRowDto,
} from './dto/talent-aging-report.dto';
import { HireRequestsByClientsQueryDto } from './dto/hire-requests-by-clients-query.dto';
import {
  HireRequestByClientRowDto,
  HireRequestsByClientsResponseDto,
} from './dto/hire-request-by-client-row.dto';
import {
  CANDIDATE_AUDIT_EVENTS,
  CANDIDATE_LOST_STAGE_ID,
  ENDORSED_VIA_PLATFORM_PIPELINE_STATUS,
} from '../candidate/candidate-audit.service';

// Bound how far back an unfiltered client-selected-candidates query can scan, matching
// the default window getPanelData() uses when no date range is provided.
const DEFAULT_CLIENT_SELECTED_LOOKBACK_MONTHS = 12;

const CLIENT_ROLES = [
  'organization_super_admin',
  'organization_admin',
  'affiliate',
];
const ADMIN_ROLES = ['system_admin', 'system_super_admin'];
const ADMIN_ROLE_LABELS: Record<string, string> = {
  system_admin: 'System Admin',
  system_super_admin: 'System Owner',
};

// Same-request writes in changeWinner() land well under a second apart in practice;
// widened to 5 minutes to tolerate slow requests without risking cross-candidate matches.
const DEPLOYMENT_CORRELATION_WINDOW_MS = 5 * 60 * 1000;

// Aging Report on Talent 30/60/90 — bucket upper bounds in days (last bucket is open-ended).
const AGING_BUCKET_THRESHOLDS = [30, 60, 90] as const;
const AGING_BUCKET_LABELS = ['0-30', '31-60', '61-90', '90+'] as const;
type AgingBucketLabel = (typeof AGING_BUCKET_LABELS)[number];

interface DeploymentAuditRow {
  candidate_id: string;
  createdAt: Date;
  actorUser: {
    id: string;
    role: string;
    first_name: string | null;
    last_name: string | null;
  } | null;
  actor_label: string | null;
}

interface DeploymentActor {
  role: string | null;
  actorUserId: string | null;
  actorLabel: string | null;
}

@Injectable()
export class PanelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly positionRateConfigService: PositionRateConfigService,
    private readonly businessUnitContext: BusinessUnitContext,
  ) {}

  /**
   * Resolves the `candidate_pool` for every distinct `business_unit` present in
   * `candidates`, in one batch — so a subsequent synchronous `.map()` calling
   * `computeCandidateRates` can look pools up without ever `await`-ing inside
   * the loop. Unknown/missing business units fall back to `'medical'`.
   */
  private async buildCandidatePoolMap(
    candidates: { business_unit: string | null }[],
  ): Promise<Map<string, CandidatePool>> {
    const distinctBUs = Array.from(
      new Set(
        candidates
          .map((c) => c.business_unit)
          .filter((bu): bu is string => !!bu),
      ),
    );
    const entries = await Promise.all(
      distinctBUs.map(
        async (bu) =>
          [bu, (await this.businessUnitContext.poolFor(bu)) ?? 'medical'] as [
            string,
            CandidatePool,
          ],
      ),
    );
    return new Map(entries);
  }

  /**
   * PanelCandidate has no field recording who moved it to `selected_by_client` — the
   * only signal is the CandidateAuditLog row `changeWinner()` writes in the same
   * request (event=pipeline_status_changed, pipeline_status_new=Endorsed via Platform).
   * This correlates a PanelCandidate row to that audit row by candidate_id + closest
   * timestamp within DEPLOYMENT_CORRELATION_WINDOW_MS. No match (e.g. candidates
   * deployed via the admin-only createStaffWithOptionalHireRequest tool, which writes
   * no audit row) defaults to 'admin' — see plan risks for why that default is safe.
   */
  private async buildDeploymentActorIndex(
    rangeStart: Date,
    rangeEndExclusive: Date,
  ): Promise<Map<string, DeploymentAuditRow[]>> {
    const auditRows = await this.prisma.candidateAuditLog.findMany({
      where: {
        event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
        pipeline_status_new: ENDORSED_VIA_PLATFORM_PIPELINE_STATUS,
        createdAt: {
          gte: new Date(
            rangeStart.getTime() - DEPLOYMENT_CORRELATION_WINDOW_MS,
          ),
          lt: new Date(
            rangeEndExclusive.getTime() + DEPLOYMENT_CORRELATION_WINDOW_MS,
          ),
        },
      },
      select: {
        candidate_id: true,
        createdAt: true,
        actor_label: true,
        actorUser: {
          select: { id: true, role: true, first_name: true, last_name: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const auditByCandidate = new Map<string, DeploymentAuditRow[]>();
    for (const row of auditRows) {
      const list = auditByCandidate.get(row.candidate_id) ?? [];
      list.push(row);
      auditByCandidate.set(row.candidate_id, list);
    }
    return auditByCandidate;
  }

  private correlateDeploymentActor(
    auditByCandidate: Map<string, DeploymentAuditRow[]>,
    candidateId: string,
    panelUpdatedAt: Date,
  ): DeploymentActor | null {
    const rows = auditByCandidate.get(candidateId) ?? [];
    let best: DeploymentAuditRow | undefined;
    let bestDelta = Infinity;
    for (const row of rows) {
      const delta = Math.abs(
        row.createdAt.getTime() - panelUpdatedAt.getTime(),
      );
      if (delta <= DEPLOYMENT_CORRELATION_WINDOW_MS && delta < bestDelta) {
        best = row;
        bestDelta = delta;
      }
    }
    if (!best) return null;
    return {
      role: best.actorUser?.role ?? null,
      actorUserId: best.actorUser?.id ?? null,
      actorLabel:
        best.actor_label ??
        (best.actorUser
          ? [best.actorUser.first_name, best.actorUser.last_name]
              .filter(Boolean)
              .join(' ') || null
          : null),
    };
  }

  private classifyDeploymentActor(
    actor: DeploymentActor | null,
  ): 'admin' | 'client' {
    if (!actor || !actor.role) return 'admin';
    return CLIENT_ROLES.includes(actor.role) ? 'client' : 'admin';
  }

  async getPanelData(dateFrom?: string, dateTo?: string): Promise<any> {
    const dateFilterCreated: any = {};
    if (dateFrom) dateFilterCreated.gte = new Date(dateFrom);
    if (dateTo) dateFilterCreated.lte = new Date(`${dateTo}T23:59:59.999Z`);
    const hasDateFilter = Object.keys(dateFilterCreated).length > 0;

    const selectCandidates = {
      id: true,
      first_name: true,
      last_name: true,
      name: true,
      email: true,
      country: true,
      employment_type: true,
      hourly_pay_rate: true,
      years_of_experience: true,
      pipeline_status: true,
      about_me: true,
      specialization: true,
      tools: true,
      medical_tools: true,
      gender: true,
      hubspot_id: true,
      headshot_url: true,
      processing_error: true,
      avatar_url: true,
      languages: {
        select: {
          name: true,
        },
      },
      skills: {
        select: {
          skill_name: true,
          skill_type: true,
        },
      },
      educations: {
        select: {
          institution: true,
          degree: true,
          year: true,
        },
      },
      approved_positions_pairing: true,
      business_unit: true,
      experiences: {
        orderBy: { start_date: 'desc' as const },
        select: {
          company: true,
          position: true,
          start_date: true,
          end_date: true,
          responsabilities: true,
        },
      },
      panelCandidates: {
        select: {
          id: true,
          panel: {
            select: {
              hire_request_id: true,
              hireRequest: {
                select: {
                  id: true,
                  title: true,
                  organization: {
                    select: {
                      id: true,
                      name: true,
                    },
                  },
                },
              },
              interviews: {
                select: {
                  id: true,
                },
              },
            },
          },
        },
      },
    };

    const result: any = {};

    // New Metrics Implementation

    // 1. Number of Active Client users (system users excluded)
    const activeClientUsers = await this.prisma.uSER.count({
      where: {
        role: {
          in: ['organization_admin', 'organization_super_admin'],
        },
        status: 'active',
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
      },
    });
    result.activeClientUsers = activeClientUsers;

    // 2. Number of Verified Client users
    const invitedClientUsers = await this.prisma.uSER.count({
      where: {
        role: {
          in: ['organization_admin', 'organization_super_admin'],
        },
        status: 'invited',
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
      },
    });
    result.invitedClientUsers = invitedClientUsers;

    // 3. Number of Verified Client users (subset of active users)

    const verifiedClientUsers = await this.prisma.uSER.count({
      where: {
        role: {
          in: ['organization_admin', 'organization_super_admin'],
        },
        status: 'active',
        verified: true,
        ...(hasDateFilter ? { activatedAt: dateFilterCreated } : {}),
      },
    });
    result.verifiedClientUsers = verifiedClientUsers;

    // 3b. Active client users split by whether their organization has at least one
    // active staff placement — "client with staff" (an active customer) vs.
    // "prospect" (signed up, no placement yet). Mirrors activeStaff's own
    // status/hubspot_dealstage filter so both counts agree on what "active" means.
    const activeStaffFilter = {
      status: 'active',
      hubspot_dealstage: { in: activePipelines.map(([key]) => String(key)) },
    };
    const activeClientUsersWithStaff = await this.prisma.uSER.count({
      where: {
        role: { in: ['organization_admin', 'organization_super_admin'] },
        status: 'active',
        organization: { staff: { some: activeStaffFilter } },
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
      },
    });
    result.activeClientUsersWithStaff = activeClientUsersWithStaff;

    const activeProspectUsersWithoutStaff = await this.prisma.uSER.count({
      where: {
        role: { in: ['organization_admin', 'organization_super_admin'] },
        status: 'active',
        organization: { staff: { none: activeStaffFilter } },
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
      },
    });
    result.activeProspectUsersWithoutStaff = activeProspectUsersWithoutStaff;

    // 4. Average Ticket Aging (Hire Request Created → Placement Completed)

    const decidedDateFilter: any = {};
    if (dateFrom) decidedDateFilter.gte = new Date(dateFrom);
    if (dateTo) decidedDateFilter.lte = new Date(dateTo);
    const hasDecidedDateFilter = Object.keys(decidedDateFilter).length > 0;

    const completedHireRequests = await this.prisma.hireRequest.findMany({
      where: {
        status: HireRequestStatus.placement_completed,
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
        panels: {
          some: {
            status: PanelStatus.decision_made,
            ...(hasDecidedDateFilter
              ? { decided_date: decidedDateFilter }
              : {}),
          },
        },
      },
      select: {
        createdAt: true,
        panels: {
          where: {
            status: PanelStatus.decision_made,
            ...(hasDecidedDateFilter
              ? { decided_date: decidedDateFilter }
              : {}),
          },
          select: {
            decided_date: true,
          },
          take: 1,
        },
      },
    });

    let totalAgingDays = 0;
    let validRequestsCount = 0;

    if (completedHireRequests.length > 0) {
      totalAgingDays = completedHireRequests.reduce((acc, req) => {
        const decisionDate = req.panels[0]?.decided_date;
        if (!decisionDate) return acc;

        const diffTime = Math.abs(
          decisionDate.getTime() - req.createdAt.getTime(),
        );
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        validRequestsCount++;
        return acc + diffDays;
      }, 0);

      result.averageTicketAging =
        validRequestsCount > 0
          ? Number((totalAgingDays / validRequestsCount).toFixed(2))
          : 0;
    } else {
      result.averageTicketAging = 0;
    }

    // 5. Number of Hire Requests submitted by Client users
    const hrSubmittedByClient = await this.prisma.hireRequest.count({
      where: {
        createdBy: {
          role: {
            in: ['organization_admin', 'organization_super_admin'],
          },
        },
        status: {
          not: { in: [HireRequestStatus.deleted, HireRequestStatus.cancelled] },
        },
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
      },
    });
    result.hrSubmittedByClient = hrSubmittedByClient;

    const organizationsCount = await this.prisma.organization.count({
      where: {
        status: OrganizationStatus.active,
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
      },
    });
    result.activeOrganizations = organizationsCount;

    const usersCount = await this.prisma.uSER.count({
      where: {
        status: 'active',
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
      },
    });
    result.activeUsers = usersCount;

    const HrCount = await this.prisma.hireRequest.count({
      where: {
        status: { not: HireRequestStatus.deleted },
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
      },
    });
    result.activeHireRequests = HrCount;

    const staffCount = await this.prisma.staff.count({
      where: {
        status: 'active',
        hubspot_dealstage: {
          in: activePipelines.map(([key, _value]) => String(key)),
        },
        ...(hasDateFilter ? { created_at: dateFilterCreated } : {}),
      },
    });
    result.activeStaff = staffCount;

    const clientsWithActiveStaff = await this.prisma.organization.count({
      where: {
        status: OrganizationStatus.active,
        staff: { some: activeStaffFilter },
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
      },
    });
    result.clientsWithActiveStaff = clientsWithActiveStaff;

    const candidatesAvailable = await this.prisma.candidate.count({
      where: {
        OR: [
          { pipeline_status: '261075105' },
          { pipeline_status: '1087596819' },
        ],
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
      },
    });
    result.candidatesAvailable = candidatesAvailable;

    // Candidates actually endorsed (moved to the "Endorsed via platform" pipeline
    // stage) within the searched date range. Deduped by candidate_id in case a
    // webhook retry logged the same transition twice.
    const endorsedRows = await this.prisma.candidateAuditLog.findMany({
      where: {
        event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
        pipeline_status_new: ENDORSED_VIA_PLATFORM_PIPELINE_STATUS,
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
      },
      select: { candidate_id: true },
      distinct: ['candidate_id'],
    });
    result.candidatesEndorsed = endorsedRows.length;

    // Candidates actually selected as winner within the searched date range.
    const candidatesHired = await this.prisma.panelCandidate.count({
      where: {
        status: PanelCandidateStatus.selected_by_client,
        ...(hasDateFilter ? { updatedAt: dateFilterCreated } : {}),
      },
    });

    result.candidatesHired = candidatesHired;

    const failedResumeParsing = await this.prisma.candidate.findMany({
      where: {
        pipeline_status: {
          in: ['261075105', '1087596819'],
        },
        processing_status: 'failed',
        resume_url: { not: null },
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
      },
      select: selectCandidates,
    });

    const positionConfigs =
      await this.positionRateConfigService.findAllUnpaginated();
    const configByPosition = buildConfigMap(positionConfigs);
    const candidatePoolMap =
      await this.buildCandidatePoolMap(failedResumeParsing);

    const failedResume = failedResumeParsing.map((candidate) => {
      const rates = computeCandidateRates(
        candidate,
        configByPosition,
        candidatePoolMap.get(candidate.business_unit ?? '') ?? 'medical',
      );
      return {
        ...candidate,
        employment_type:
          changeLabelAvailability(
            dbToStageDictionary[Number(candidate.employment_type)],
          ) || candidate.employment_type,
        approved_positions_pairing:
          candidate.approved_positions_pairing?.map(getApprovedPositionLabel) ||
          [],
        ...rates,
        avatar: candidate.avatar_url
          ? `${process.env.AVATAR_URL}${candidate.avatar_url}`
          : null,
        panelCandidates: candidate.panelCandidates
          ? candidate.panelCandidates.map((pc) => ({
              title: pc.panel.hireRequest.title,
              organization_name: pc.panel.hireRequest.organization.name,
              status: 'test',
            }))
          : [],
      };
    });
    result.failedResumeParsing = failedResume;

    const withoutHeadshot = await this.prisma.candidate.findMany({
      where: {
        pipeline_status: {
          in: ['261075105', '1087596819'],
        },
        OR: [
          { headshot_url: null },
          { headshot_url: 'n/a' },
          { headshot_url: 'N/A' },
        ],
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
      },
      select: selectCandidates,
    });

    const withoutHeadshotPoolMap =
      await this.buildCandidatePoolMap(withoutHeadshot);
    const CandwithoutHeadshot = withoutHeadshot.map((candidate) => {
      const rates = computeCandidateRates(
        candidate,
        configByPosition,
        withoutHeadshotPoolMap.get(candidate.business_unit ?? '') ?? 'medical',
      );
      return {
        ...candidate,
        employment_type:
          changeLabelAvailability(
            dbToStageDictionary[Number(candidate.employment_type)],
          ) || candidate.employment_type,
        approved_positions_pairing:
          candidate.approved_positions_pairing?.map(getApprovedPositionLabel) ||
          [],
        ...rates,
        avatar: candidate.avatar_url
          ? `${process.env.AVATAR_URL}${candidate.avatar_url}`
          : null,
        panelCandidates: candidate.panelCandidates
          ? candidate.panelCandidates.map((pc) => ({
              title: pc.panel.hireRequest.title,
              organization_name: pc.panel.hireRequest.organization.name,
              status: 'test',
            }))
          : [],
      };
    });
    result.withoutHeadshot = CandwithoutHeadshot;

    // Monthly data: dynamic range based on dateFrom/dateTo, defaults to last 12 months
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth();

    // Parse "YYYY-MM-DD" strings directly to avoid UTC-to-local timezone shift.
    // Using new Date("YYYY-MM-DD") parses as UTC midnight, and .getMonth()/.getFullYear()
    // return LOCAL values — on servers with negative UTC offset (e.g. UTC-3) this shifts
    // the date back one day, causing the wrong month to be used as loop start/end.
    const parseDateSafe = (
      dateStr: string,
    ): { year: number; month: number } => {
      const [y, m] = dateStr.split('-').map(Number);
      return { year: y, month: m - 1 }; // month is 0-indexed
    };

    const monthsToIterate: Date[] = [];
    if (dateFrom || dateTo) {
      const start = dateFrom
        ? (() => {
            const { year, month } = parseDateSafe(dateFrom);
            return new Date(year, month, 1);
          })()
        : new Date(currentYear, currentMonth - 11, 1);
      const end = dateTo
        ? (() => {
            const { year, month } = parseDateSafe(dateTo);
            return new Date(year, month, 1);
          })()
        : new Date(currentYear, currentMonth, 1);
      let cursor = new Date(start);
      while (cursor <= end) {
        monthsToIterate.push(new Date(cursor));
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      }
    } else {
      for (let i = 11; i >= 0; i--) {
        monthsToIterate.push(new Date(currentYear, currentMonth - i, 1));
      }
    }

    // Prefetch once for the whole range: PanelCandidate rows deployed to a client
    // (status=selected_by_client) plus the CandidateAuditLog rows that correlate to
    // them, so the admin/client split below doesn't re-query per month.
    const deploymentRangeStart = monthsToIterate[0];
    const deploymentRangeEndExclusive = new Date(
      monthsToIterate[monthsToIterate.length - 1].getFullYear(),
      monthsToIterate[monthsToIterate.length - 1].getMonth() + 1,
      1,
    );
    const deployedPanelCandidates = await this.prisma.panelCandidate.findMany({
      where: {
        status: PanelCandidateStatus.selected_by_client,
        updatedAt: {
          gte: deploymentRangeStart,
          lt: deploymentRangeEndExclusive,
        },
      },
      select: { candidate_id: true, updatedAt: true },
    });
    const deploymentAuditIndex = await this.buildDeploymentActorIndex(
      deploymentRangeStart,
      deploymentRangeEndExclusive,
    );

    for (const date of monthsToIterate) {
      const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
      const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 1);

      const candidatesCreated = await this.prisma.candidate.count({
        where: {
          createdAt: { gte: monthStart, lt: monthEnd },
          pipeline_status: { in: ['261075105', '1087596819'] },
        },
      });

      const hireRequestsCreated = await this.prisma.hireRequest.count({
        where: {
          createdAt: { gte: monthStart, lt: monthEnd },
        },
      });

      const hireRequestsEndorsed = await this.prisma.hireRequest.count({
        where: {
          status: HireRequestStatus.placement_completed,
          panels: {
            some: {
              status: PanelStatus.decision_made,
              decided_date: { gte: monthStart, lt: monthEnd },
            },
          },
        },
      });

      const interviewsScheduled = await this.prisma.interview.count({
        where: {
          scheduled_date: { gte: monthStart, lt: monthEnd },
        },
      });

      const talentsSelectedAsWinner = await this.prisma.panelCandidate.count({
        where: {
          status: PanelCandidateStatus.selected_by_client,
          updatedAt: { gte: monthStart, lt: monthEnd },
        },
      });

      // Dedupe by candidate_id in case a webhook retry logged the same removal twice.
      // "Removed" covers both a move to the Lost pipeline stage and a hard delete.
      const removalRows = await this.prisma.candidateAuditLog.findMany({
        where: {
          createdAt: { gte: monthStart, lt: monthEnd },
          OR: [
            {
              event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
              pipeline_status_new: CANDIDATE_LOST_STAGE_ID,
            },
            { event: CANDIDATE_AUDIT_EVENTS.CANDIDATE_DELETED },
          ],
        },
        select: { candidate_id: true },
        distinct: ['candidate_id'],
      });
      const talentsRemoved = removalRows.length;

      // Dedupe by candidate_id: a candidate may flip to Endorsed multiple times in a
      // month (e.g. re-endorsed after a hire request reopen) — count the talent once.
      const endorsementRows = await this.prisma.candidateAuditLog.findMany({
        where: {
          event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
          pipeline_status_new: ENDORSED_VIA_PLATFORM_PIPELINE_STATUS,
          createdAt: { gte: monthStart, lt: monthEnd },
        },
        select: { candidate_id: true },
        distinct: ['candidate_id'],
      });
      const talentsEndorsed = endorsementRows.length;

      const monthDeployed = deployedPanelCandidates.filter(
        (pc): pc is typeof pc & { updatedAt: Date } =>
          pc.updatedAt !== null &&
          pc.updatedAt >= monthStart &&
          pc.updatedAt < monthEnd,
      );
      let talentsDeployedByAdmin = 0;
      let talentsDeployedByClient = 0;
      for (const pc of monthDeployed) {
        const actor = this.correlateDeploymentActor(
          deploymentAuditIndex,
          pc.candidate_id,
          pc.updatedAt,
        );
        if (this.classifyDeploymentActor(actor) === 'client') {
          talentsDeployedByClient++;
        } else {
          talentsDeployedByAdmin++;
        }
      }

      if (!result.monthlyData) result.monthlyData = [];

      result.monthlyData.push({
        month: date.toLocaleString('default', {
          month: 'short',
          year: '2-digit',
        }),
        candidates: candidatesCreated,
        hireRequests_created: hireRequestsCreated,
        hireRequests_endorsed: hireRequestsEndorsed,
        interviews: interviewsScheduled,
        talentsSelectedAsWinner,
        talentsRemoved,
        talentsEndorsed,
        talentsDeployedByAdmin,
        talentsDeployedByClient,
      });
    }

    for (const date of monthsToIterate) {
      const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
      const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 1);

      const newClients = await this.prisma.organization.count({
        where: {
          createdAt: { gte: monthStart, lt: monthEnd },
        },
      });

      if (!result.newClients) result.newClients = [];

      result.newClients.push({
        month: date.toLocaleString('default', {
          month: 'short',
          year: '2-digit',
        }),
        newClients: newClients,
      });
    }

    for (const date of monthsToIterate) {
      const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
      const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 1);

      const accessUsers = await this.prisma.session.count({
        where: {
          createdAt: { gte: monthStart, lt: monthEnd },
        },
      });

      if (!result.userAccess) result.userAccess = [];
      result.userAccess.push({
        month: date.toLocaleString('default', {
          month: 'short',
          year: '2-digit',
        }),
        accessUsers: accessUsers,
      });
    }

    for (const date of monthsToIterate) {
      const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
      const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 1);
      const monthLabel = date.toLocaleString('default', {
        month: 'short',
        year: '2-digit',
      });

      const clientLogins = await this.prisma.session.count({
        where: {
          createdAt: { gte: monthStart, lt: monthEnd },
          user: { role: { in: CLIENT_ROLES } },
        },
      });

      const talentPoolDurationMinutes = await this.getScopedDurationMinutes(
        monthStart,
        monthEnd,
        'talent_pool',
        CLIENT_ROLES,
      );

      const clientPlatformDurationMinutes = await this.getScopedDurationMinutes(
        monthStart,
        monthEnd,
        'platform',
        CLIENT_ROLES,
      );

      if (!result.clientEngagement) result.clientEngagement = [];
      result.clientEngagement.push({
        month: monthLabel,
        clientLogins,
        talentPoolDurationMinutes,
        platformDurationMinutes: clientPlatformDurationMinutes,
      });

      const adminLogins = await this.prisma.session.count({
        where: {
          createdAt: { gte: monthStart, lt: monthEnd },
          user: { role: { in: ADMIN_ROLES } },
        },
      });

      const platformDurationMinutes = await this.getScopedDurationMinutes(
        monthStart,
        monthEnd,
        'platform',
        ADMIN_ROLES,
      );

      if (!result.adminUsage) result.adminUsage = [];
      result.adminUsage.push({
        month: monthLabel,
        adminLogins,
        platformDurationMinutes,
      });
    }

    const candidatesWithInterviews = await this.prisma.candidate.findMany({
      where: {
        ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
        panelCandidates: {
          some: {
            panel: {
              interviews: {
                some: {},
              },
            },
          },
        },
      },
      select: selectCandidates,
    });

    const candidatesWithInterviewsPoolMap = await this.buildCandidatePoolMap(
      candidatesWithInterviews,
    );
    const processed = candidatesWithInterviews.map((candidate) => {
      const rates = computeCandidateRates(
        candidate,
        configByPosition,
        candidatesWithInterviewsPoolMap.get(candidate.business_unit ?? '') ??
          'medical',
      );
      return {
        ...candidate,
        employment_type:
          changeLabelAvailability(
            dbToStageDictionary[Number(candidate.employment_type)],
          ) || candidate.employment_type,
        approved_positions_pairing:
          candidate.approved_positions_pairing?.map(getApprovedPositionLabel) ||
          [],
        ...rates,
        avatar: candidate.avatar_url
          ? `${process.env.AVATAR_URL}${candidate.avatar_url}`
          : null,
        panelCandidates: candidate.panelCandidates
          ? candidate.panelCandidates.map((pc) => ({
              title: pc.panel.hireRequest.title,
              organization_name: pc.panel.hireRequest.organization.name,
              status: 'test',
            }))
          : [],
        interviewCount: candidate.panelCandidates.reduce((total, pc) => {
          const count = pc.panel.interviews.length;
          return total + count;
        }, 0),
      };
    });

    result.moreThan5Interviews = processed.filter((c) => c.interviewCount > 5);

    return result;
  }

  async getTalentAvailabilityByRole(): Promise<TalentAvailabilityByRoleDto[]> {
    const candidates = await this.prisma.candidate.findMany({
      where: { pipeline_status: { in: ['261075105', '1087596819'] } },
      select: { pipeline_status: true, approved_positions_pairing: true },
    });

    const counts = new Map<string, { fullTime: number; partTime: number }>();
    for (const candidate of candidates) {
      const isFullTime = candidate.pipeline_status === '261075105';
      const positions = candidate.approved_positions_pairing?.length
        ? candidate.approved_positions_pairing
        : ['(Unspecified)'];
      for (const raw of positions) {
        const label = getApprovedPositionLabel(raw);
        const entry = counts.get(label) ?? { fullTime: 0, partTime: 0 };
        if (isFullTime) {
          entry.fullTime += 1;
        } else {
          entry.partTime += 1;
        }
        counts.set(label, entry);
      }
    }

    return Array.from(counts.entries())
      .map(([position, { fullTime, partTime }]) => ({
        position,
        fullTime,
        partTime,
        total: fullTime + partTime,
      }))
      .sort((a, b) => b.total - a.total);
  }

  private classifyAgingBucket(daysInPool: number): AgingBucketLabel {
    if (daysInPool <= AGING_BUCKET_THRESHOLDS[0]) return '0-30';
    if (daysInPool <= AGING_BUCKET_THRESHOLDS[1]) return '31-60';
    if (daysInPool <= AGING_BUCKET_THRESHOLDS[2]) return '61-90';
    return '90+';
  }

  async getTalentAgingReport(): Promise<TalentAgingReportDto> {
    const now = new Date();

    const candidates = await this.prisma.candidate.findMany({
      where: { pipeline_status: { in: ['261075105', '1087596819'] } },
      select: {
        id: true,
        hubspot_id: true,
        first_name: true,
        last_name: true,
        name: true,
        pipeline_status: true,
        approved_positions_pairing: true,
        createdAt: true,
      },
    });

    const bucketCounts = new Map<AgingBucketLabel, number>(
      AGING_BUCKET_LABELS.map((label) => [label, 0]),
    );

    const rows: TalentAgingCandidateRowDto[] = candidates.map((candidate) => {
      const daysInPool = Math.floor(
        (now.getTime() - candidate.createdAt.getTime()) / (1000 * 60 * 60 * 24),
      );
      const bucket = this.classifyAgingBucket(daysInPool);
      bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);

      const position = candidate.approved_positions_pairing?.length
        ? getApprovedPositionLabel(candidate.approved_positions_pairing[0])
        : '(Unspecified)';

      return {
        id: candidate.id,
        hubspot_id: candidate.hubspot_id,
        name: candidate.first_name
          ? `${candidate.first_name} ${candidate.last_name ?? ''}`.trim()
          : (candidate.name ?? '—'),
        position,
        employmentType:
          candidate.pipeline_status === '261075105' ? 'Full-Time' : 'Part-Time',
        pipeline_status: candidate.pipeline_status,
        daysInPool,
        bucket,
        createdAt: candidate.createdAt.toISOString(),
      };
    });

    rows.sort((a, b) => b.daysInPool - a.daysInPool);

    const buckets: TalentAgingBucketDto[] = AGING_BUCKET_LABELS.map(
      (bucket) => ({
        bucket,
        count: bucketCounts.get(bucket) ?? 0,
      }),
    );

    return { buckets, candidates: rows };
  }

  async getClientSelectedCandidates(
    query: ClientSelectedCandidatesQueryDto,
  ): Promise<ClientSelectedCandidatesResponseDto> {
    return this.getActorSelectedCandidates(query, 'client');
  }

  async getAdminSelectedCandidates(
    query: ClientSelectedCandidatesQueryDto,
  ): Promise<ClientSelectedCandidatesResponseDto> {
    return this.getActorSelectedCandidates(query, 'admin');
  }

  /**
   * Shared by getClientSelectedCandidates/getAdminSelectedCandidates — both list
   * PanelCandidate rows with status=selected_by_client (the only "hired" status;
   * there is no separate admin status), split by who actually made the hire per
   * classifyDeploymentActor.
   */
  private async getActorSelectedCandidates(
    query: ClientSelectedCandidatesQueryDto,
    actorType: 'admin' | 'client',
  ): Promise<ClientSelectedCandidatesResponseDto> {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 10;
    const sortBy = query.sortBy ?? 'selectedAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const rangeEnd = query.dateTo ? new Date(query.dateTo) : new Date();
    const rangeStart = query.dateFrom
      ? new Date(query.dateFrom)
      : new Date(
          rangeEnd.getFullYear(),
          rangeEnd.getMonth() - DEFAULT_CLIENT_SELECTED_LOOKBACK_MONTHS,
          rangeEnd.getDate(),
        );

    const panelCandidates = await this.prisma.panelCandidate.findMany({
      where: {
        status: PanelCandidateStatus.selected_by_client,
        updatedAt: { gte: rangeStart, lte: rangeEnd },
      },
      select: {
        id: true,
        candidate_id: true,
        updatedAt: true,
        candidate: {
          select: { id: true, first_name: true, last_name: true, name: true },
        },
        panel: {
          select: {
            hireRequest: {
              select: {
                id: true,
                title: true,
                organization: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
      orderBy: { updatedAt: sortOrder },
    });

    const auditIndex = await this.buildDeploymentActorIndex(
      rangeStart,
      new Date(rangeEnd.getTime() + 1),
    );

    const actorRows = panelCandidates
      // updatedAt is nullable in the schema, but every row here matched the
      // updatedAt-range where clause above, so it is always set in practice.
      .filter(
        (pc): pc is typeof pc & { updatedAt: Date } => pc.updatedAt !== null,
      )
      .map((pc) => {
        const actor = this.correlateDeploymentActor(
          auditIndex,
          pc.candidate_id,
          pc.updatedAt,
        );
        return { pc, actor };
      })
      .filter(({ actor }) => this.classifyDeploymentActor(actor) === actorType)
      .map(({ pc, actor }) => ({
        id: pc.id,
        candidateId: pc.candidate.id,
        candidateName:
          pc.candidate.name ||
          [pc.candidate.first_name, pc.candidate.last_name]
            .filter(Boolean)
            .join(' '),
        hireRequestId: pc.panel.hireRequest.id,
        hireRequestTitle: pc.panel.hireRequest.title,
        organizationId: pc.panel.hireRequest.organization.id,
        organizationName: pc.panel.hireRequest.organization.name,
        selectedAt: pc.updatedAt.toISOString(),
        selectedByUserId: actor?.actorUserId ?? null,
        selectedByName: actor?.actorLabel ?? null,
        selectedByRole: actor?.role ?? null,
      }));

    if (sortBy === 'candidateName') {
      actorRows.sort((a, b) =>
        sortOrder === 'asc'
          ? a.candidateName.localeCompare(b.candidateName)
          : b.candidateName.localeCompare(a.candidateName),
      );
    } else if (sortBy === 'organizationName') {
      actorRows.sort((a, b) =>
        sortOrder === 'asc'
          ? a.organizationName.localeCompare(b.organizationName)
          : b.organizationName.localeCompare(a.organizationName),
      );
    }
    // sortBy === 'selectedAt' is already applied via the pre-sorted panelCandidate query.

    if (query.export) {
      return { data: actorRows };
    }

    const total = actorRows.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const start = (page - 1) * perPage;
    const data = actorRows.slice(start, start + perPage);

    return { data, meta: { total, totalPages, page, perPage } };
  }

  /**
   * Row-level client login list backing the "Client Logins" table under the
   * Client Engagement chart — same CLIENT_ROLES + Session-table definition
   * the chart's clientLogins KPI already uses (getPanelData), just returned
   * per-row (user + organization + timestamp) instead of counted per month.
   * organization_name is read directly off USER (denormalized at signup/
   * invite time) rather than joined through Organization, matching how the
   * rest of the dashboard displays a user's org name.
   */
  async getClientLogins(
    query: ClientLoginsQueryDto,
  ): Promise<ClientLoginsResponseDto> {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 10;
    const sortBy = query.sortBy ?? 'loggedInAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const rangeEnd = query.dateTo ? new Date(query.dateTo) : new Date();
    const rangeStart = query.dateFrom
      ? new Date(query.dateFrom)
      : new Date(
          rangeEnd.getFullYear(),
          rangeEnd.getMonth() - DEFAULT_CLIENT_SELECTED_LOOKBACK_MONTHS,
          rangeEnd.getDate(),
        );

    const where = {
      createdAt: { gte: rangeStart, lte: rangeEnd },
      user: { role: { in: CLIENT_ROLES } },
    };

    const orderBy =
      sortBy === 'userName'
        ? [
            { user: { first_name: sortOrder } },
            { user: { last_name: sortOrder } },
          ]
        : sortBy === 'organizationName'
          ? [{ user: { organization_name: sortOrder } }]
          : [{ createdAt: sortOrder }];

    const select = {
      id: true,
      createdAt: true,
      user: {
        select: { first_name: true, last_name: true, organization_name: true },
      },
    };

    if (query.export) {
      const sessions = await this.prisma.session.findMany({
        where,
        select,
        orderBy,
      });
      return { data: sessions.map((s) => this.toClientLoginRow(s)) };
    }

    const [total, sessions] = await Promise.all([
      this.prisma.session.count({ where }),
      this.prisma.session.findMany({
        where,
        select,
        orderBy,
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / perPage));

    return {
      data: sessions.map((s) => this.toClientLoginRow(s)),
      meta: { total, totalPages, page, perPage },
    };
  }

  private toClientLoginRow(session: {
    id: string;
    createdAt: Date;
    user: {
      first_name: string;
      last_name: string;
      organization_name: string;
    };
  }): ClientLoginRowDto {
    return {
      id: session.id,
      userName:
        [session.user.first_name, session.user.last_name]
          .filter(Boolean)
          .join(' ') || '—',
      organizationName: session.user.organization_name || '—',
      loggedInAt: session.createdAt.toISOString(),
    };
  }

  /**
   * Row-level admin login list backing the "Admin Logins" table, sitting next
   * to "Client Logins" in the Users tab. Same Session-table + role-filter
   * definition as getClientLogins, just ADMIN_ROLES instead of CLIENT_ROLES —
   * admins have no organization, so the second column is a human-readable
   * role label (System Admin / System Owner) instead.
   */
  async getAdminLogins(
    query: AdminLoginsQueryDto,
  ): Promise<AdminLoginsResponseDto> {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 10;
    const sortBy = query.sortBy ?? 'loggedInAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const rangeEnd = query.dateTo ? new Date(query.dateTo) : new Date();
    const rangeStart = query.dateFrom
      ? new Date(query.dateFrom)
      : new Date(
          rangeEnd.getFullYear(),
          rangeEnd.getMonth() - DEFAULT_CLIENT_SELECTED_LOOKBACK_MONTHS,
          rangeEnd.getDate(),
        );

    const where = {
      createdAt: { gte: rangeStart, lte: rangeEnd },
      user: { role: { in: ADMIN_ROLES } },
    };

    const orderBy =
      sortBy === 'userName'
        ? [
            { user: { first_name: sortOrder } },
            { user: { last_name: sortOrder } },
          ]
        : sortBy === 'role'
          ? [{ user: { role: sortOrder } }]
          : [{ createdAt: sortOrder }];

    const select = {
      id: true,
      createdAt: true,
      user: {
        select: { first_name: true, last_name: true, role: true },
      },
    };

    if (query.export) {
      const sessions = await this.prisma.session.findMany({
        where,
        select,
        orderBy,
      });
      return { data: sessions.map((s) => this.toAdminLoginRow(s)) };
    }

    const [total, sessions] = await Promise.all([
      this.prisma.session.count({ where }),
      this.prisma.session.findMany({
        where,
        select,
        orderBy,
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / perPage));

    return {
      data: sessions.map((s) => this.toAdminLoginRow(s)),
      meta: { total, totalPages, page, perPage },
    };
  }

  private toAdminLoginRow(session: {
    id: string;
    createdAt: Date;
    user: { first_name: string; last_name: string; role: string };
  }): AdminLoginRowDto {
    return {
      id: session.id,
      userName:
        [session.user.first_name, session.user.last_name]
          .filter(Boolean)
          .join(' ') || '—',
      role: ADMIN_ROLE_LABELS[session.user.role] ?? session.user.role,
      loggedInAt: session.createdAt.toISOString(),
    };
  }

  /**
   * Per-candidate endorsement count ("endorsements per candidate" +
   * "endorsed to panel by client" reports). An endorsement is the same
   * CandidateAuditLog row buildDeploymentActorIndex reads elsewhere
   * (event=pipeline_status_changed, pipeline_status_new=Endorsed via
   * Platform) — unlike the monthly dashboard total, this does NOT dedupe by
   * candidate_id, since a candidate re-endorsed for a reopened/second hire
   * request should count as 2 endorsements here, not 1. The actor is read
   * directly off each row (no timestamp correlation needed, unlike the
   * selected-candidates reports): PanelCandidate has no actor field of its
   * own, but CandidateAuditLog does.
   */
  async getCandidateEndorsements(
    query: CandidateEndorsementsQueryDto,
  ): Promise<CandidateEndorsementsResponseDto> {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 10;
    const sortBy = query.sortBy ?? 'endorsementCount';
    const sortOrder = query.sortOrder ?? 'desc';

    const rangeEnd = query.dateTo ? new Date(query.dateTo) : new Date();
    const rangeStart = query.dateFrom
      ? new Date(query.dateFrom)
      : new Date(
          rangeEnd.getFullYear(),
          rangeEnd.getMonth() - DEFAULT_CLIENT_SELECTED_LOOKBACK_MONTHS,
          rangeEnd.getDate(),
        );

    const endorsementRows = await this.prisma.candidateAuditLog.findMany({
      where: {
        event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
        pipeline_status_new: ENDORSED_VIA_PLATFORM_PIPELINE_STATUS,
        createdAt: { gte: rangeStart, lte: rangeEnd },
      },
      select: {
        candidate_id: true,
        createdAt: true,
        actor_label: true,
        actorUser: {
          select: { id: true, role: true, first_name: true, last_name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const byCandidate = new Map<
      string,
      { count: number; client: number; admin: number; lastEndorsedAt: Date }
    >();
    for (const row of endorsementRows) {
      const actor: DeploymentActor | null = row.actorUser
        ? {
            role: row.actorUser.role,
            actorUserId: row.actorUser.id,
            actorLabel:
              row.actor_label ??
              [row.actorUser.first_name, row.actorUser.last_name]
                .filter(Boolean)
                .join(' ') ??
              null,
          }
        : null;
      const isClient = this.classifyDeploymentActor(actor) === 'client';

      const existing = byCandidate.get(row.candidate_id);
      if (existing) {
        existing.count += 1;
        if (isClient) existing.client += 1;
        else existing.admin += 1;
        if (row.createdAt > existing.lastEndorsedAt)
          existing.lastEndorsedAt = row.createdAt;
      } else {
        byCandidate.set(row.candidate_id, {
          count: 1,
          client: isClient ? 1 : 0,
          admin: isClient ? 0 : 1,
          lastEndorsedAt: row.createdAt,
        });
      }
    }

    const candidateIds = Array.from(byCandidate.keys());
    const candidates = candidateIds.length
      ? await this.prisma.candidate.findMany({
          where: { id: { in: candidateIds } },
          select: { id: true, first_name: true, last_name: true, name: true },
        })
      : [];
    const candidateNameById = new Map(
      candidates.map((c) => [
        c.id,
        c.first_name
          ? `${c.first_name} ${c.last_name ?? ''}`.trim()
          : (c.name ?? '—'),
      ]),
    );

    const rows: CandidateEndorsementRowDto[] = candidateIds.map(
      (candidateId) => {
        const agg = byCandidate.get(candidateId)!;
        return {
          candidateId,
          candidateName: candidateNameById.get(candidateId) ?? '—',
          endorsementCount: agg.count,
          endorsedByClientCount: agg.client,
          endorsedByAdminCount: agg.admin,
          lastEndorsedAt: agg.lastEndorsedAt.toISOString(),
        };
      },
    );

    if (sortBy === 'candidateName') {
      rows.sort((a, b) =>
        sortOrder === 'asc'
          ? a.candidateName.localeCompare(b.candidateName)
          : b.candidateName.localeCompare(a.candidateName),
      );
    } else if (sortBy === 'lastEndorsedAt') {
      rows.sort((a, b) =>
        sortOrder === 'asc'
          ? a.lastEndorsedAt.localeCompare(b.lastEndorsedAt)
          : b.lastEndorsedAt.localeCompare(a.lastEndorsedAt),
      );
    } else {
      rows.sort((a, b) =>
        sortOrder === 'asc'
          ? a.endorsementCount - b.endorsementCount
          : b.endorsementCount - a.endorsementCount,
      );
    }

    if (query.export) {
      return { data: rows };
    }

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const start = (page - 1) * perPage;
    const data = rows.slice(start, start + perPage);

    return { data, meta: { total, totalPages, page, perPage } };
  }

  /**
   * Hire requests created by client (organization) users, for the "Hire
   * requests submitted by clients" HR Report list. Uses the same
   * client-creator definition as the hrSubmittedByClient count above
   * (createdBy.role in organization_admin/organization_super_admin) and the
   * same deleted/cancelled exclusion, so the list total always matches that
   * dashboard count for the same date range.
   */
  async getHireRequestsByClients(
    query: HireRequestsByClientsQueryDto,
  ): Promise<HireRequestsByClientsResponseDto> {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 10;
    const sortBy = query.sortBy ?? 'createdAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const where = {
      createdBy: {
        role: { in: ['organization_admin', 'organization_super_admin'] },
      },
      status: {
        not: { in: [HireRequestStatus.deleted, HireRequestStatus.cancelled] },
      },
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
            },
          }
        : {}),
    };

    const hireRequests = await this.prisma.hireRequest.findMany({
      where,
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        createdByUserId: true,
        createdBy: { select: { first_name: true, last_name: true } },
        organization: { select: { id: true, name: true } },
      },
      orderBy: sortBy === 'createdAt' ? { createdAt: sortOrder } : undefined,
    });

    const rows: HireRequestByClientRowDto[] = hireRequests.map((hr) => ({
      hireRequestId: hr.id,
      title: hr.title,
      status: hr.status,
      createdAt: hr.createdAt.toISOString(),
      createdByUserId: hr.createdByUserId ?? '',
      createdByName: hr.createdBy
        ? [hr.createdBy.first_name, hr.createdBy.last_name]
            .filter(Boolean)
            .join(' ')
        : '—',
      organizationId: hr.organization?.id ?? '',
      organizationName: hr.organization?.name ?? '—',
    }));

    if (sortBy === 'clientName') {
      rows.sort((a, b) =>
        sortOrder === 'asc'
          ? a.createdByName.localeCompare(b.createdByName)
          : b.createdByName.localeCompare(a.createdByName),
      );
    } else if (sortBy === 'organizationName') {
      rows.sort((a, b) =>
        sortOrder === 'asc'
          ? a.organizationName.localeCompare(b.organizationName)
          : b.organizationName.localeCompare(a.organizationName),
      );
    }

    if (query.export) {
      return { data: rows };
    }

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const start = (page - 1) * perPage;
    const data = rows.slice(start, start + perPage);

    return { data, meta: { total, totalPages, page, perPage } };
  }

  /**
   * Heartbeat pings land roughly every 60s while a tab is visible. Consecutive
   * pings for the same user within IDLE_GAP_MS are treated as one continuous
   * active stretch; a larger gap means the tab was hidden/closed, so that gap
   * is excluded from the total. This avoids needing an explicit session-end
   * signal, which browsers can't reliably send on tab close.
   */
  private async getScopedDurationMinutes(
    monthStart: Date,
    monthEnd: Date,
    scope: 'talent_pool' | 'platform',
    roles: string[],
  ): Promise<number> {
    const HEARTBEAT_INTERVAL_MS = 60_000;
    const IDLE_GAP_MS = HEARTBEAT_INTERVAL_MS * 2;

    const pings = await this.prisma.sessionActivity.findMany({
      where: {
        scope,
        pingedAt: { gte: monthStart, lt: monthEnd },
        user: { role: { in: roles } },
      },
      select: { userId: true, pingedAt: true },
      orderBy: { pingedAt: 'asc' },
    });

    const pingsByUser = new Map<string, Date[]>();
    for (const ping of pings) {
      const existing = pingsByUser.get(ping.userId);
      if (existing) {
        existing.push(ping.pingedAt);
      } else {
        pingsByUser.set(ping.userId, [ping.pingedAt]);
      }
    }

    let totalMs = 0;
    for (const timestamps of pingsByUser.values()) {
      for (let i = 1; i < timestamps.length; i++) {
        const gap = timestamps[i].getTime() - timestamps[i - 1].getTime();
        if (gap <= IDLE_GAP_MS) totalMs += gap;
      }
    }

    return Math.round(totalMs / 60_000);
  }
}
