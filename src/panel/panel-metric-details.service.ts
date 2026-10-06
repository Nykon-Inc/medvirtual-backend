import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVE_PIPELINE_STAFF_WHERE } from '../common/constant/activeDealPipelines';
import { buildInclusiveDateRange } from '../common/utils/date-range.util';
import { MetricDetailsQueryDto } from './dto/metric-details-query.dto';
import {
  ClientDetailRowDto,
  ClientUserDetailRowDto,
  EndorsedTalentDetailRowDto,
  HiredTalentDetailRowDto,
  HireRequestDetailRowDto,
  MetricDetailsResponse,
  NewAvailableTalentDetailRowDto,
  StaffDetailRowDto,
  TalentDetailRowDto,
} from './dto/metric-detail-rows.dto';
import {
  clientInvitesAcceptedWhere,
  clientUsersCreatedWhere,
  hrSubmittedByClientWhere,
  MetricDateRange,
  newAvailableCandidatesWhere,
  newClientsWithActiveStaffWhere,
  newHireRequestsWhere,
  newStaffWhere,
  talentsCreatedWhere,
  talentsEndorsedWhere,
  talentsHiredWhere,
} from './panel-metric-filters';
import {
  displayName,
  paginateInMemory,
  paginateMetricDetails,
  toIso,
} from './metric-details-paging';

const HIRE_REQUEST_DETAIL_SELECT = {
  id: true,
  title: true,
  status: true,
  createdAt: true,
  organization: { select: { name: true } },
  createdBy: { select: { first_name: true, last_name: true } },
} as const;

const CLIENT_USER_DETAIL_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  email: true,
  organization_name: true,
  status: true,
  createdAt: true,
  activatedAt: true,
} as const;

const TALENT_DETAIL_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  name: true,
  email: true,
  country: true,
  specialization: true,
  createdAt: true,
} as const;

function toTalentRow(
  candidate: Prisma.CandidateGetPayload<{
    select: typeof TALENT_DETAIL_SELECT;
  }>,
): TalentDetailRowDto {
  return {
    id: candidate.id,
    name: displayName(
      candidate.first_name,
      candidate.last_name,
      candidate.name,
    ),
    email: candidate.email,
    country: candidate.country ?? '—',
    specialization: candidate.specialization ?? '—',
    createdAt: candidate.createdAt.toISOString(),
  };
}

/**
 * Drill-down lists for the period-filtered KPI cards of the Operational
 * Dashboard. Each method pages the exact rows its card counts in
 * `PanelService.getPanelData` — both read the same `where` builder.
 */
@Injectable()
export class PanelMetricDetailsService {
  constructor(private readonly prisma: PrismaService) {}

  private range(query: MetricDetailsQueryDto): MetricDateRange {
    return buildInclusiveDateRange(query.dateFrom, query.dateTo);
  }

  // ── Overview ──────────────────────────────────────────────────────────────

  getNewHireRequests(
    query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<HireRequestDetailRowDto>> {
    return this.hireRequestDetails(
      query,
      newHireRequestsWhere(this.range(query)),
    );
  }

  getNewAvailableCandidates(
    query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<NewAvailableTalentDetailRowDto>> {
    const where = newAvailableCandidatesWhere(this.range(query));
    return paginateMetricDetails(
      query,
      () => this.prisma.candidate.count({ where }),
      (paging) =>
        this.prisma.candidate.findMany({
          where,
          select: { ...TALENT_DETAIL_SELECT, first_available_at: true },
          orderBy: { first_available_at: 'desc' },
          ...paging,
        }),
      (candidate) => ({
        ...toTalentRow(candidate),
        firstAvailableAt: toIso(candidate.first_available_at),
      }),
    );
  }

  getNewStaff(
    query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<StaffDetailRowDto>> {
    const where = newStaffWhere(this.range(query));
    return paginateMetricDetails(
      query,
      () => this.prisma.staff.count({ where }),
      (paging) =>
        this.prisma.staff.findMany({
          where,
          select: {
            id: true,
            start_date: true,
            created_at: true,
            hubspot_deal_name: true,
            hubspot_company_name: true,
            candidate: {
              select: { first_name: true, last_name: true, name: true },
            },
            hireRequest: { select: { title: true } },
            organization: { select: { name: true } },
          },
          orderBy: { created_at: 'desc' },
          ...paging,
        }),
      (staff) => ({
        id: staff.id,
        name: displayName(
          staff.candidate?.first_name,
          staff.candidate?.last_name,
          staff.candidate?.name ?? staff.hubspot_deal_name,
        ),
        position: staff.hireRequest?.title ?? '—',
        companyName:
          staff.organization?.name ?? staff.hubspot_company_name ?? '—',
        startDate: toIso(staff.start_date),
        createdAt: staff.created_at.toISOString(),
      }),
    );
  }

  getNewClientsWithActiveStaff(
    query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<ClientDetailRowDto>> {
    const where = newClientsWithActiveStaffWhere(this.range(query));
    return paginateMetricDetails(
      query,
      () => this.prisma.organization.count({ where }),
      (paging) =>
        this.prisma.organization.findMany({
          where,
          select: {
            id: true,
            name: true,
            business_unit: true,
            createdAt: true,
            _count: {
              select: { staff: { where: ACTIVE_PIPELINE_STAFF_WHERE } },
            },
          },
          orderBy: { createdAt: 'desc' },
          ...paging,
        }),
      (org) => ({
        id: org.id,
        name: org.name,
        businessUnit: org.business_unit ?? '—',
        activeStaffCount: org._count.staff,
        createdAt: org.createdAt.toISOString(),
      }),
    );
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  getUsersCreated(
    query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<ClientUserDetailRowDto>> {
    const where = clientUsersCreatedWhere(this.range(query));
    return this.clientUserDetails(query, where, 'createdAt');
  }

  getInvitesAccepted(
    query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<ClientUserDetailRowDto>> {
    const where = clientInvitesAcceptedWhere(this.range(query));
    return this.clientUserDetails(query, where, 'activatedAt');
  }

  // ── Talents ───────────────────────────────────────────────────────────────

  getTalentsCreated(
    query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<TalentDetailRowDto>> {
    const where = talentsCreatedWhere(this.range(query));
    return paginateMetricDetails(
      query,
      () => this.prisma.candidate.count({ where }),
      (paging) =>
        this.prisma.candidate.findMany({
          where,
          select: TALENT_DETAIL_SELECT,
          orderBy: { createdAt: 'desc' },
          ...paging,
        }),
      toTalentRow,
    );
  }

  /**
   * Endorsement events are de-duplicated by candidate, exactly like the card
   * count, so this pages in memory over the distinct rows (one small column
   * set) and only loads candidate details for the returned page.
   */
  async getTalentsEndorsed(
    query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<EndorsedTalentDetailRowDto>> {
    const events = await this.prisma.candidateAuditLog.findMany({
      where: talentsEndorsedWhere(this.range(query)),
      select: { candidate_id: true, actor_label: true, createdAt: true },
      distinct: ['candidate_id'],
      orderBy: { createdAt: 'desc' },
    });

    const { page, meta } = paginateInMemory(query, events);
    const candidates = await this.prisma.candidate.findMany({
      where: { id: { in: page.map((event) => event.candidate_id) } },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        name: true,
        email: true,
      },
    });
    const byId = new Map(candidates.map((c) => [c.id, c]));

    const data = page.map((event) => {
      const candidate = byId.get(event.candidate_id);
      return {
        id: event.candidate_id,
        name: displayName(
          candidate?.first_name,
          candidate?.last_name,
          candidate?.name,
        ),
        email: candidate?.email ?? '—',
        endorsedBy: event.actor_label ?? '—',
        endorsedAt: event.createdAt.toISOString(),
      };
    });

    return meta ? { data, meta } : { data };
  }

  getTalentsHired(
    query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<HiredTalentDetailRowDto>> {
    const where = talentsHiredWhere(this.range(query));
    return paginateMetricDetails(
      query,
      () => this.prisma.panelCandidate.count({ where }),
      (paging) =>
        this.prisma.panelCandidate.findMany({
          where,
          select: {
            id: true,
            updatedAt: true,
            createdAt: true,
            candidate: {
              select: { first_name: true, last_name: true, name: true },
            },
            panel: {
              select: {
                hireRequest: {
                  select: {
                    title: true,
                    organization: { select: { name: true } },
                  },
                },
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
          ...paging,
        }),
      (row) => ({
        id: row.id,
        name: displayName(
          row.candidate.first_name,
          row.candidate.last_name,
          row.candidate.name,
        ),
        hireRequestTitle: row.panel.hireRequest.title,
        organizationName: row.panel.hireRequest.organization.name,
        hiredAt: (row.updatedAt ?? row.createdAt).toISOString(),
      }),
    );
  }

  // ── HR Report ─────────────────────────────────────────────────────────────

  getHrSubmittedByClient(
    query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<HireRequestDetailRowDto>> {
    return this.hireRequestDetails(
      query,
      hrSubmittedByClientWhere(this.range(query)),
    );
  }

  // ── Shared ────────────────────────────────────────────────────────────────

  private hireRequestDetails(
    query: MetricDetailsQueryDto,
    where: ReturnType<typeof newHireRequestsWhere>,
  ): Promise<MetricDetailsResponse<HireRequestDetailRowDto>> {
    return paginateMetricDetails(
      query,
      () => this.prisma.hireRequest.count({ where }),
      (paging) =>
        this.prisma.hireRequest.findMany({
          where,
          select: HIRE_REQUEST_DETAIL_SELECT,
          orderBy: { createdAt: 'desc' },
          ...paging,
        }),
      (hr) => ({
        id: hr.id,
        title: hr.title,
        organizationName: hr.organization.name,
        status: hr.status,
        createdByName: displayName(
          hr.createdBy?.first_name,
          hr.createdBy?.last_name,
        ),
        createdAt: hr.createdAt.toISOString(),
      }),
    );
  }

  private clientUserDetails(
    query: MetricDetailsQueryDto,
    where: ReturnType<typeof clientUsersCreatedWhere>,
    sortBy: 'createdAt' | 'activatedAt',
  ): Promise<MetricDetailsResponse<ClientUserDetailRowDto>> {
    return paginateMetricDetails(
      query,
      () => this.prisma.uSER.count({ where }),
      (paging) =>
        this.prisma.uSER.findMany({
          where,
          select: CLIENT_USER_DETAIL_SELECT,
          orderBy: { [sortBy]: 'desc' },
          ...paging,
        }),
      (user) => ({
        id: user.id,
        name: displayName(user.first_name, user.last_name),
        email: user.email,
        organizationName: user.organization_name || '—',
        status: user.status,
        createdAt: user.createdAt.toISOString(),
        activatedAt: toIso(user.activatedAt),
      }),
    );
  }
}
