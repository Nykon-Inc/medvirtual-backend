import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  buildConfigMap,
  computeCandidateRates,
  CandidatePool,
} from '../../common/utils/salary.util';
import { HireRequestService } from '../../hire-request/hire-request.service';
import { dbToStageDictionary } from '../../common/dictionaries/stage-dictionary';
import { changeLabelAvailability } from '../../common/utils/hubspot.util';
import { getApprovedPositionLabel } from '../../common/dictionaries/approved-positions-pairing-dictionary';
import { PositionRateConfigService } from '../../position-rate-config/position-rate-config.service';
import { BusinessUnitContext } from '../../business-units/business-unit-context.service';

@Injectable()
export class HandlerOrganization {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hireRequestService: HireRequestService,
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

  async execute(user, page: number = 1, perPage: number = 10): Promise<object> {
    const result: any = {};

    const loggedCompany = await this.prisma.organization.findUnique({
      where: {
        id: user.organization_id,
      },
      select: {
        business_unit: true,
      },
    });
    //this variable will be used to otherTalents
    const select = {
      id: true,
      first_name: true,
      last_name: true,
      name: true,
      email: true,
      country: true,
      employment_type: true,
      hourly_pay_rate: true,
      years_of_experience: true,
      pipeline_status: true, // This will be converted to name later
      about_me: true,
      specialization: true,
      tools: true,
      medical_tools: true,
      avatar_url: true,
      gender: true,
      approved_positions_pairing: true,
      business_unit: true,
      video_link: true,
      languages: {
        select: {
          name: true,
        },
      },
      skills: {
        select: {
          skill_name: true,
        },
      },
      experiences: {
        select: {
          id: true,
          company: true,
          position: true,
          responsabilities: true,
          end_date: true,
          start_date: true,
        },
      },
      educations: {
        select: {
          degree: true,
          institution: true,
          year: true,
        },
      },
    };

    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new BadRequestException('User or organization not found');

    const hiredStaff = await this.prisma.staff.findMany({
      where: {
        status: {
          not: { in: ['terminated', 'inactive'] },
        },
        OR: [
          {
            hireRequest: {
              org_id: user.organization_id,
            },
          },
          {
            organization_id: user.organization_id,
          },
        ],
      },
      select: {
        id: true,
        hirerequest_id: true,
        status: true,
        salary: true,
        start_date: true,
        created_at: true,
        updated_at: true,
        hubspot_id: true,
        hubspot_close_date: true,
        hubspot_deal_name: true,
        hubspot_dealstage: true,
        hubspot_dealtype: true,
        hubspot_deployment_type: true,
        hubspot_description: true,
        hubspot_hs_acv: true,
        hubspot_pipeline: true,
        hubspot_business_unit: true,
        hubspot_candidate_id: true,
        hubspot_organization_id: true,
        candidate: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            name: true,
            email: true,
            specialization: true,
            employment_type: true,
            country: true,
            about_me: true,
            hourly_pay_rate: true,
            avatar_url: true,
            gender: true,
            languages: {
              select: {
                name: true,
              },
            },
            skills: {
              select: {
                skill_name: true,
              },
            },
            createdAt: true,
          },
        },
        hireRequest: {
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            priority: true,
            availability: true,
            contract_length: true,
            expected_start_date: true,
            salary_range_from: true,
            salary_range_to: true,
            specialization: true,
            location: true,
          },
        },
        bonus: {
          where: { deleted_at: null },
          select: {
            id: true,
            amount: true,
            description: true,
            created_at: true,
            created_by: true,
          },
        },
      },
    });

    const hiredStaffWithAvatar = hiredStaff.map((staff) => ({
      ...staff,
      candidate: {
        ...staff.candidate,
        avatar: staff.candidate?.avatar_url
          ? `${process.env.AVATAR_URL}${staff.candidate.avatar_url}`
          : null,
      },
    }));

    result.hiredStaff = hiredStaffWithAvatar;

    // New: use HireRequestService to bring the same shape as /hire-request (includes specialization and skills)
    const hireRequestsResult = await this.hireRequestService.findAll(
      user,
      undefined,
      page,
      perPage,
    );
    result.hireRequests = hireRequestsResult;

    const awaitingDecision = await this.prisma.candidatePanel.findMany({
      where: {
        status: 'decision_pending',
        hireRequest: {
          org_id: user.organization_id,
        },
      },
      select: {
        id: true,
        scheduled_date: true,
        status: true,

        panelCandidates: {
          select: {
            id: true,
            status: true,
            createdAt: true,
            candidate: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                name: true,
                email: true,
                specialization: true,
                country: true,
                employment_type: true,
                about_me: true,
                years_of_experience: true,
                hourly_pay_rate: true,
                organization_id: true,
                processing_status: true,
                processing_error: true,
                educations: true,
                experiences: true,
                skills: true,
                languages: true,
                approved_positions_pairing: true,
                business_unit: true,
                avatar_url: true,
              },
            },
          },
        },
        hireRequest: {
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            priority: true,
            createdAt: true,
            availability: true,
            contract_length: true,
            expected_start_date: true,
            salary_range_from: true,
            salary_range_to: true,
            specialization: true,
            location: true,
            hubspot_role_type: true,
            hubspot_language: true,
            hubspot_numberVA: true,
            request_role: true,
            hubspot_tasks: true,
            hubspot_company_name: true,
            hubspot_ticket_id: true,
            hubspot_tools_familiarization: true,
            hubspot_va_shift_hours: true,
            hubspot_n2_monitors_required: true,
            hubspot_special_sourcing_needed: true,
            hubspot_special_requirements: true,
            hubspot_additional_training_requested: true,
            hubspot_pairing_date: true,
            hubspot_pairing_time: true,
            hubspot_pairing_request_type: true,
            hubspot_contract_amount: true,
            hubspot_training_request_notes: true,
            hubspot_camera_on_during_shift: true,
            skills: true,
          },
        },
      },
    });

    const crossPanelSelected = await this.prisma.panelCandidate.findMany({
      where: { status: { in: ['selected_by_client'] } },
      select: { candidate_id: true, panel_id: true },
    });

    const candidateSelectedInPanels = new Map<string, Set<string>>();
    for (const pc of crossPanelSelected) {
      if (!candidateSelectedInPanels.has(pc.candidate_id)) {
        candidateSelectedInPanels.set(pc.candidate_id, new Set());
      }
      candidateSelectedInPanels.get(pc.candidate_id)!.add(pc.panel_id);
    }

    //change candidate employment_type and calculate salary
    const _pCfgsA = await this.positionRateConfigService.findAllUnpaginated();
    const _cfgMapA = buildConfigMap(_pCfgsA);
    const _poolMapA = await this.buildCandidatePoolMap(
      awaitingDecision.flatMap((item) =>
        item.panelCandidates.map((pc) => pc.candidate),
      ),
    );
    const awaitingDecisionSanitized = awaitingDecision.map((item) => ({
      ...item,
      panelCandidates: item.panelCandidates
        .filter((pc) => {
          const panelSet = candidateSelectedInPanels.get(pc.candidate.id);
          if (panelSet) {
            const onlyInCurrentPanel =
              panelSet.size === 1 && panelSet.has(item.id);
            if (!onlyInCurrentPanel) return false;
          }
          return true;
        })
        .map((pc) => {
          const rates = computeCandidateRates(
            pc.candidate,
            _cfgMapA,
            _poolMapA.get(pc.candidate.business_unit ?? '') ?? 'medical',
          );
          return {
            ...pc,
            candidate: {
              ...pc.candidate,
              employment_type:
                changeLabelAvailability(
                  dbToStageDictionary[Number(pc.candidate.employment_type)],
                ) || pc.candidate.employment_type,
              approved_positions_pairing:
                pc.candidate.approved_positions_pairing?.map(
                  getApprovedPositionLabel,
                ) || [],
              ...rates,
              avatar: pc.candidate?.avatar_url
                ? `${process.env.AVATAR_URL}${pc.candidate.avatar_url}`
                : null,
            },
          };
        }),
    }));

    result.awaitingDecision = awaitingDecisionSanitized;

    const otherTalents = await this.prisma.candidate.findMany({
      where: {
        organization_id: null,
        business_unit:
          loggedCompany?.business_unit == 'Berry Virtual'
            ? 'Berry Virtual'
            : undefined,
        OR: [
          {
            pipeline_status: '261075105',
          },
          {
            pipeline_status: '1087596819',
          },
        ],
      },
      select,
      take: 9,
    });
    const lastTimeofDay = new Date();
    lastTimeofDay.setHours(23, 59, 59, 999);

    const interviews = await this.prisma.interview.findMany({
      where: {
        panel: {
          hireRequest: {
            org_id: user.organization_id,
          },
        },
        scheduled_date: {
          gte: new Date(),
          lte: lastTimeofDay,
        },
        alert_closed: false,
      },
      select: {
        id: true,
        scheduled_date: true,
        link: true,
        alert_closed: true,
        panel: {
          select: {
            hireRequest: {
              select: {
                title: true,
              },
            },
          },
        },
      },
    });
    const interviewSanitized = interviews.map((interview) => ({
      ...interview,
      hireRequestTitle: interview.panel.hireRequest.title,
    }));

    result.interviews = interviewSanitized;

    const _pCfgsB = await this.positionRateConfigService.findAllUnpaginated();
    const _cfgMapB = buildConfigMap(_pCfgsB);
    const _poolMapB = await this.buildCandidatePoolMap(otherTalents);
    const otherTalentsSalary = otherTalents.map((talent) => {
      const rates = computeCandidateRates(
        talent,
        _cfgMapB,
        _poolMapB.get(talent.business_unit ?? '') ?? 'medical',
      );
      return {
        ...talent,
        employment_type:
          changeLabelAvailability(
            dbToStageDictionary[Number(talent.employment_type)],
          ) || talent.employment_type,
        approved_positions_pairing:
          talent.approved_positions_pairing?.map(getApprovedPositionLabel) ||
          [],
        ...rates,
        avatar: talent?.avatar_url
          ? `${process.env.AVATAR_URL}${talent.avatar_url}`
          : null,
      };
    });
    result.otherTalents = otherTalentsSalary;

    return result;
  }
}
