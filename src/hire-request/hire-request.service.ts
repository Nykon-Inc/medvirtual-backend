import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as redis from 'redis';
import {
  HireRequestStatus,
  PanelCandidateStatus,
  PanelStatus,
  USER,
} from '@prisma/client';

import { keyPrefix } from '../common/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { HubspotService } from '../hubspot/hubspot.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OpenaiService } from '../openai/openai.service';

import { CreateHireRequestDto } from './dto/create-hire-request.dto';
import { UpdateHireRequestDto } from './dto/update-hire-request.dto';
import { changeStatusHireRequesDTO } from './dto/changeStatus-hire-request.dto';
import { reassignDTO } from './dto/reassign-hire-request.dto';
import { ConfirmPanelHireRequestDto } from './dto/confirm-panel-hire-request.dto';
import { panelReadyDTO } from './dto/panelReady-hire-request.dto';
import { returnGetPanelDto } from './dto/return-getPanel.dto';
import { scheduleInterviewDTO } from './dto/schedule-interview.dto';
import { awaitingDecisionDTO } from './dto/awaiting-decision.dto';
import { changeWinnerDTO } from './dto/change-winner.dto';
import { dbToStageDictionary } from '../common/dictionaries/stage-dictionary';
import {
  buildConfigMap,
  computeCandidateRates,
  findHourlyPerRate,
  CandidatePool,
} from '../common/utils/salary.util';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { OfferPanelsService } from '../offer-panels/offer-panels.service';
import {
  changeLabelAvailability,
  mapHRTicketToDb,
} from '../common/utils/hubspot.util';
import axios from 'axios';
import { HRTicketStatus } from '../common/dictionaries/HRTicket-dicionary';
import { getApprovedPositionLabel } from '../common/dictionaries/approved-positions-pairing-dictionary';
import {
  isClientOriginatedRole,
  violatesMinLeadTime,
  INTERVIEW_MIN_LEAD_ERROR,
} from '../common/utils/interview-schedule-window';
import { dateToTimestamp, timestampToUSDate } from '../common/utils/formatDate';
import {
  CANDIDATE_AUDIT_EVENTS,
  CandidateAuditService,
} from '../candidate/candidate-audit.service';
import { CandidateAuditFieldGroup, CandidateAuditSource } from '@prisma/client';

@Injectable()
export class HireRequestService {
  private readonly keyPrefix: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => HubspotService))
    private readonly hubspot: HubspotService,
    private readonly notifications: NotificationsService,
    private readonly openai: OpenaiService,
    private readonly positionRateConfigService: PositionRateConfigService,
    @Inject(forwardRef(() => OfferPanelsService))
    private readonly offerPanelsService: OfferPanelsService,
    private readonly candidateAudit: CandidateAuditService,
    private readonly configService: ConfigService,
    @Inject('REDIS_CLIENT') private readonly redisClient: redis.RedisClientType,
    private readonly businessUnitContext: BusinessUnitContext,
  ) {
    this.keyPrefix = keyPrefix(this.configService);
  }

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

  /** Redis-like getter using actual Redis client (mirrors HubstaffService). */
  private async redisGet(key: string): Promise<string | null> {
    return await this.redisClient.get(key);
  }

  /** Redis-like setter using actual Redis client (mirrors HubstaffService). */
  private async redisSet(
    key: string,
    value: string,
    options?: { EX: number },
  ): Promise<void> {
    if (options?.EX) {
      await this.redisClient.set(key, value, { EX: options.EX });
    } else {
      await this.redisClient.set(key, value);
    }
  }

  private toFixedDate(dateStr: string): Date {
    const [datePart, timePart] = dateStr.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, second] = timePart.split(':').map(Number);

    return new Date(year, month - 1, day, hour, minute, second || 0);
  }

  private readonly availablePipelineStatuses = [
    '1172847191', // endorsed
    '261075105', // available full-time
    '1087596819', // available part-time
  ];

  /**
   * candidate_id -> panel_id -> hireRequest.title, for every panel candidate
   * currently selected_by_client or blocked in ANY panel. A single global
   * query, reused by callers that previously ran one findFirst per candidate.
   */
  private async buildCrossPanelSelectedMap(): Promise<
    Map<string, Map<string, string>>
  > {
    const crossPanelSelected = await this.prisma.panelCandidate.findMany({
      where: { status: { in: ['selected_by_client', 'blocked'] } },
      select: {
        candidate_id: true,
        panel_id: true,
        panel: { select: { hireRequest: { select: { title: true } } } },
      },
    });

    const map = new Map<string, Map<string, string>>();
    for (const pc of crossPanelSelected) {
      if (!map.has(pc.candidate_id)) {
        map.set(pc.candidate_id, new Map());
      }
      map.get(pc.candidate_id)!.set(pc.panel_id, pc.panel.hireRequest.title);
    }
    return map;
  }

  private selectPanels = {
    id: true,
    scheduled_date: true,
    decided_date: true,
    status: true,
    readable: true,
    panelCandidates: {
      select: {
        id: true,
        status: true,
        createdAt: true,
        createdBy: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            role: true,
          },
        },
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
            pipeline_status: true,
            avatar_url: true,
            gender: true,
            approved_positions_pairing: true,
            business_unit: true,
            video_link: true,
            languages: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    },
    interviews: {
      select: {
        scheduled_date: true,
        link: true,
      },
    },
    hireRequest: {
      include: {
        tickets: { where: { deleted_at: null } },
      },
    },
  };

  private async verifyAssignUser(statusTo, hireRequest_id): Promise<boolean> {
    const hireRequest = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequest_id },
      select: {
        assign_user_id: true,
      },
    });

    if (
      statusTo === 'pending_signature' ||
      statusTo === 'new' ||
      statusTo === 'cancelled'
    ) {
      return true;
    } else {
      if (hireRequest?.assign_user_id) {
        return true;
      } else {
        throw new BadRequestException(
          `Status ${statusTo} requires an assigned user`,
        );
      }
    }
  }

  private async updateHireRequestStatus(
    id: string,
    status: HireRequestStatus,
  ): Promise<boolean> {
    const updatedRequest = await this.prisma.hireRequest.update({
      where: {
        id: id,
      },
      data: {
        status: status,
      },
    });
    return true;
  }

  private assertNoHiredCandidatesInPanel(
    panelCandidates: Array<{
      candidate: {
        id: string;
        pipeline_status: string | null;
        panelCandidates: Array<{ status: string }>;
      };
    }>,
  ): void {
    const hired = panelCandidates
      .map((pc) => pc.candidate)
      .filter(
        (c) =>
          dbToStageDictionary[Number(c.pipeline_status)] === 'Hired' ||
          c.panelCandidates.some((pcc) => pcc.status === 'selected_by_client'),
      );

    if (hired.length > 0) {
      throw new BadRequestException(
        `Cannot proceed: You must remove the hired candidate(s) from the panel before changing the status.`,
      );
    }
  }

  async verifyUnavailableCandidates(
    hireRequestId: string,
    user: USER,
  ): Promise<any> {
    const hireRequest = await this.findOne(hireRequestId, user);
    if (!hireRequest) throw new NotFoundException(`Hire request not found`);

    const candidatesInPanels = hireRequest.panels.flatMap(
      (p) => p.panelCandidates,
    );

    const candidatesSelectedInOtherPanels = candidatesInPanels.filter((pc) => {
      // pc = panelCandidate on the current Panel
      const otherPanels = pc.candidate.panelCandidates;

      if (!otherPanels || !otherPanels.length) return false;

      return otherPanels.some((pcc) => pcc.status === 'selected_by_client');
    });

    const allCandidatesBlocked =
      candidatesInPanels.length > 0 &&
      candidatesSelectedInOtherPanels.length === candidatesInPanels.length;

    /*
    console.log({
      totalCandidates: candidatesInPanels.length,
      candidatesSelectedInOtherPanels,
      allCandidatesBlocked,
    });
    */

    return allCandidatesBlocked;
  }

  async create(data: CreateHireRequestDto, user?: USER): Promise<any> {
    //user is option because the webhook use this function without user
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );

    const {
      skills,
      client_id,
      selectedCandidates,
      staff_to_be_replaced_id,
      ...hireRequestData
    } = data;

    if (user.role.includes('system') && !client_id)
      throw new BadRequestException('Client ID is required for system users');

    let whereCondition;
    if (user.role.includes('organization')) {
      //get organization_id from user
      whereCondition = { id: user.organization_id };
    } else if (user.role.includes('system')) {
      //the frontend send me the client_id
      whereCondition = { id: data.client_id };
    }

    const organizationSQL = await this.prisma.organization.findUnique({
      where: whereCondition,
      select: {
        status: true,
        organization_role: true,
        admin_id: true,
        name: true,
        industry: true,
        website_url: true,
        phone: true,
        business_unit: true,
      },
    });
    if (!organizationSQL)
      throw new NotFoundException(`Organization from client not found`);

    const hubspotMappedFields = mapHRTicketToDb({
      hs_pipeline: '0',
      hs_pipeline_stage: Object.keys(HRTicketStatus).find(
        (key) => HRTicketStatus[key] === 'New Agent Request',
      ), //=> New agent Request
      pairing_request_type:
        hireRequestData.hubspot_pairing_request_type || 'New Client',
      ticket_type: 'Agent Pairing Request',
      business_unit: organizationSQL.business_unit || 'Not Specified',
      company_name: organizationSQL.name,
      client_name: organizationSQL.name,
      company_url: organizationSQL.website_url || 'Not Specified',
      va_type: hireRequestData.position,
      contract_amount: hireRequestData.contract_amount,
      language: hireRequestData.language,
      number_of_vas: Number(hireRequestData.numberVA),
    });

    const sanitizeDecimal = (value?: string | null) => {
      return value && value.trim() !== '' ? value : null;
    };

    // Note: The title is now received from the frontend with the required format
    // Previously used: const hubspotTitle = `HR - ${organizationSQL.name} - ${hireRequestData.numberVA.toString()} - ${hireRequestData.position} - ${data.availability.toUpperCase()}`;
    // The title from hireRequestData (which comes from the frontend) is used directly

    const hireRequest = {
      ...hireRequestData,
      ...hubspotMappedFields,
      organization: user.role.includes('organization')
        ? { connect: { id: user.organization_id || undefined } }
        : { connect: { id: client_id } },
      status: HireRequestStatus.new,
      assign_user_id: user.role.includes('system')
        ? user.id
        : organizationSQL.admin_id
          ? organizationSQL.admin_id
          : undefined,
      assigned_sourcing: user.role.includes('organization')
        ? { connect: { id: organizationSQL.admin_id } }
        : selectedCandidates && selectedCandidates.length > 0
          ? { connect: { id: user.id } }
          : undefined,
      createdBy: { connect: { id: user.id } },
      position: undefined,
      contract_amount: undefined,
      language: undefined,
      numberVA: undefined,
      salary_range_from: sanitizeDecimal(hireRequestData.salary_range_from),
      salary_range_to: sanitizeDecimal(hireRequestData.salary_range_to),
      hubspot_contract_amount: sanitizeDecimal(
        hubspotMappedFields.hubspot_contract_amount,
      ),
      hubspot_pairing_date:
        dateToTimestamp(hireRequestData.hubspot_pairing_date) || null,
      hubspot_pairing_time: hireRequestData.hubspot_pairing_time
        ? hireRequestData.hubspot_pairing_time
        : null,
      staff_to_be_replaced: staff_to_be_replaced_id
        ? { connect: { id: staff_to_be_replaced_id } }
        : undefined,
    };

    const newHireRequest = await this.prisma.hireRequest.create({
      data: hireRequest,
    });
    if (!newHireRequest)
      throw new BadRequestException(`Hire request not created`);

    if (data.description && data.description.length >= 500) {
      try {
        const summary = await this.openai.generateTextSummary(data.description);
        await this.prisma.hireRequest.update({
          where: { id: newHireRequest.id },
          data: {
            description_summary: summary,
            summary_generated_at: new Date(),
          },
        });
        newHireRequest.description_summary = summary;
        newHireRequest.summary_generated_at = new Date();
      } catch (err) {
        console.warn(
          '[HireRequest] AI summary generation failed on create:',
          err?.message || err,
        );
      }
    }

    if (
      hireRequestData.hubspot_tasks &&
      hireRequestData.hubspot_tasks.length >= 500
    ) {
      try {
        const tasksSummary = await this.openai.generateTextSummary(
          hireRequestData.hubspot_tasks,
        );
        await this.prisma.hireRequest.update({
          where: { id: newHireRequest.id },
          data: {
            hubspot_tasks_summary: tasksSummary,
            hubspot_tasks_summary_generated_at: new Date(),
          },
        });
        newHireRequest.hubspot_tasks_summary = tasksSummary;
        newHireRequest.hubspot_tasks_summary_generated_at = new Date();
      } catch (err) {
        console.warn(
          '[HireRequest] AI tasks summary generation failed on create:',
          err?.message || err,
        );
      }
    }

    if (skills && skills.length > 0) {
      const newHireRequestSkills =
        await this.prisma.hireRequestSkill.createMany({
          data: skills.map((skill) => ({
            skill_name: skill.name,
            required_level: skill.level,
            hire_request_id: newHireRequest.id,
          })),
        });
      if (!newHireRequestSkills)
        throw new BadRequestException(`Hire request skills not created`);
    }

    //create Panel with default user_id
    const panel = await this.prisma.candidatePanel.create({
      data: {
        hire_request_id: newHireRequest.id,
        readable:
          data.selectedCandidates &&
          data.selectedCandidates.length > 0 &&
          user.role.includes('organization')
            ? true
            : false,
        status: PanelStatus.created,
      },
    });
    if (!panel) throw new BadRequestException(`Hire request panel not created`);

    if (data.selectedCandidates && data.selectedCandidates.length > 0) {
      //Create a panel with the selected candidates
      const panelCandidates = await this.prisma.panelCandidate.createMany({
        data: data.selectedCandidates.map((candidate) => ({
          candidate_id: candidate.id,
          panel_id: panel.id,
          status: PanelCandidateStatus.selected,
          createdByUserId: user.id,
        })),
      });
      if (!panelCandidates)
        throw new BadRequestException(`Panel candidates not created`);

      if (user.role.includes('organization')) {
        await this.panelReady(
          {
            hireRequest_id: newHireRequest.id,
            readable: true,
          },
          user,
        );
      } else {
        //Current user as the Sourcing assignee
        await this.prisma.hireRequest.update({
          where: { id: newHireRequest.id },
          data: {
            assigned_sourcing: { connect: { id: user.id } },
          },
        });

        //if the system user create the HR, just change the status for "sourcing"
        await this.updateHireRequestStatus(newHireRequest.id, 'sourcing');
      }
    }

    const hireRequestWithSkills = await this.findOne(
      newHireRequest.id,
      user,
      'hubspot',
    );
    //send request for the hubspot to create the ticket
    try {
      await this.hubspot.createHireRequestInHubspot(
        hireRequestWithSkills,
        user?.id,
        `New hire request created by organization ${organizationSQL.name}`,
      );
    } catch (err) {
      console.warn(
        '[hubspot] createHireRequestTicket failed',
        err?.message || err,
      );
    }

    // Notify assigned user via email (non-blocking)
    if (newHireRequest.assign_user_id) {
      console.log(
        `[notifications] Attempting to send hire request created notification for HR ${newHireRequest.id} to user ${newHireRequest.assign_user_id}`,
      );
      try {
        const result = await this.notifications.notifyHireRequestCreated(
          newHireRequest.id,
          '',
          'panel_request_flow',
        );
        console.log(
          `[notifications] Hire request created notification sent successfully:`,
          result,
        );
      } catch (err) {
        console.error(
          '[notifications] hire-request-created email failed',
          err?.message || err,
        );
      }
    } else {
      console.log(
        `[notifications] No assigned user for hire request ${newHireRequest.id}, skipping notification`,
      );
    }

    const hireRequestWithHubspotID = await this.findOne(
      newHireRequest.id,
      user,
    );
    return hireRequestWithHubspotID;
  }

  async findAll(
    user: USER,
    search?: string,
    page: number = 1,
    perPage: number = 10,
    businessUnit?: string,
    status?: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<any> {
    if (
      !user ||
      (user.role.includes('organization') && !user.organization_id)
    ) {
      throw new NotFoundException(
        'User not found or not part of an organization',
      );
    }
    if (!user.role) throw new NotFoundException('User role not found');

    const listCacheKey =
      `${this.keyPrefix}hire-request-list:${user.role}:` +
      `${user.role.includes('organization') ? user.organization_id : 'all'}:` +
      `${search ?? ''}:${page}:${perPage}:${businessUnit ?? ''}:${status ?? ''}:` +
      `${dateFrom ?? ''}:${dateTo ?? ''}`;

    const cachedList = await this.redisGet(listCacheKey);
    if (cachedList) {
      return JSON.parse(cachedList);
    }

    let baseWhere = {};
    switch (user.role) {
      case 'organization_super_admin':
      case 'organization_admin':
        baseWhere = { organization: { id: user.organization_id } };
        break;

      /* => https://regenta-company.monday.com/boards/9328303960/pulses/18312697982/posts/4649194899?reply=reply-4651095908
      case 'system_admin':
        baseWhere={ OR: [
          { organization: { admin_id: user.id }},
          { assigned_user: {id: user.id}}
        ]}
        break;
      */
      case 'system_super_admin':
      case 'system_admin':
        baseWhere = {};
        break;
    }

    if (status) {
      baseWhere = { ...baseWhere, status: status };
    } else {
      baseWhere = { ...baseWhere, status: { not: 'deleted' } };
    }

    //this code was updated for the switch above
    // baseWhere = user.role.includes('organization') ? { organization: { id: user.organization_id } } : {};
    const searchWhere = search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' as const } },
            {
              hubspot_ticket_id: {
                contains: search,
                mode: 'insensitive' as const,
              },
            },
          ],
        }
      : {};

    // Add business unit filter if provided
    const businessUnitWhere = businessUnit
      ? {
          OR: [
            {
              organization: {
                business_unit: {
                  contains: businessUnit,
                  mode: 'insensitive' as const,
                },
              },
            },
            {
              hubspot_business_unit: {
                contains: businessUnit,
                mode: 'insensitive' as const,
              },
            },
          ],
        }
      : {};

    const dateWhere =
      dateFrom || dateTo
        ? {
            createdAt: {
              ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
              ...(dateTo ? { lte: new Date(`${dateTo}T23:59:59.999Z`) } : {}),
            },
          }
        : {};

    const whereClause = {
      ...baseWhere,
      ...searchWhere,
      ...businessUnitWhere,
      ...dateWhere,
    };

    //console.log('HireRequestService.findAll - whereClause:', whereClause);

    const skip = (page - 1) * perPage;
    const take = perPage;

    const [hireRequests, total] = await this.prisma.$transaction([
      this.prisma.hireRequest.findMany({
        where: {
          ...whereClause,
        },
        include: {
          skills: true,
          organization: {
            select: {
              id: true,
              name: true,
              business_unit: true,
              email: true,
              hubspot_id: true,
            },
          },
          createdBy: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              role: true,
            },
          },
          assigned_sourcing: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
            },
          },
          assigned_staffing: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
            },
          },
          panels: {
            select: {
              id: true,
              status: true,
              scheduled_date: true,
              readable: true,
              panelCandidates: {
                select: {
                  id: true,
                  status: true,
                  candidate: {
                    select: {
                      id: true,
                      first_name: true,
                      last_name: true,
                      pipeline_status: true,
                      name: true,
                      email: true,
                      country: true,
                      languages: true,
                      specialization: true,
                      about_me: true,
                      hourly_pay_rate: true,
                      avatar_url: true,
                      approved_positions_pairing: true,
                      business_unit: true,
                      video_link: true,
                      employment_type: true,

                      //Va score cards fields
                      active_listening_and_comprehension_demonstrated: true,
                      adaptability_to_different_client_personalities_and_workflows: true,
                      can_articulate_experience_clearly_to_clients: true,
                      can_multitask_between_systems_or_windows_efficiently: true,
                      client_readiness___fit_evaluator_notes: true,
                      comfortable_with_basic_tools__google_workspace__zoom__ehr_software_: true,
                      comfortable_with_camera_on_setup: true,
                      communication_skills_evaluator_notes: true,
                      confident_on_video_and_phone_calls: true,
                      cultural_alignment_with_us_healthcare_environment: true,
                      demonstrates_problem_solving_and_tech_adaptability: true,
                      demonstrates_stability_and_commitment: true,
                      demonstrates_understanding_of_medical_terminology_and_procedures: true,
                      exhibits_confidence_and_empathy_in_roleplay_scenarios: true,
                      familiarity_with_emr_ehr_systems__kareo__athena__eclinicalworks__etc__: true,
                      for_bilinguals__fluent_and_accurate_in_both_english_and_spanish: true,
                      grammar__vocabulary__and_tone_are_appropriate_for_us_clients: true,
                      handles_feedback_constructively: true,
                      has_functioning_headset__webcam__and_backup_device: true,
                      knowledge_of_hipaa_compliance_and_confidentiality: true,
                      medical_knowledge_evaluator_notes: true,
                      no_medical_industry_experience: true,
                      positive_attitude_and_professional_demeanor: true,
                      prior_experience_in_healthcare_or_medical_va_roles: true,
                      professionalism___work_readiness_evaluator_notes: true,
                      punctual_and_responsive_during_recruitment_stages: true,
                      remote_work_discipline_and_time_management: true,
                      speaks_clearly_and_professionally: true,
                      stable_internet_connection__min__20_mbps_: true,
                      technical_competence_evaluator_notes: true,
                      tier_level: true,
                      total_points: true,
                      understands_workflow_in_medical_offices___telehealth_environments: true,

                      skills: {
                        select: {
                          skill_name: true,
                          proficiency_level: true,
                        },
                      },
                      educations: {
                        orderBy: { year: 'desc' },
                        select: {
                          institution: true,
                          degree: true,
                          year: true,
                        },
                      },
                      experiences: {
                        orderBy: { start_date: 'desc' },
                        select: {
                          company: true,
                          position: true,
                          responsabilities: true,
                          start_date: true,
                          end_date: true,
                        },
                      },
                      panelCandidates: {
                        select: {
                          id: true,
                          status: true,
                          panel: {
                            select: {
                              id: true,
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
                            },
                          },
                        },
                      },
                    },
                  },
                  createdAt: true,
                  createdBy: {
                    select: {
                      id: true,
                      first_name: true,
                      last_name: true,
                      role: true,
                    },
                  },
                },
              },
              interviews: {
                select: {
                  scheduled_date: true,
                  link: true,
                },
              },
            },
          },
          tickets: { where: { deleted_at: null } },
          staff_to_be_replaced: true,
          offerPanel: {
            select: {
              id: true,
              title: true,
              status: true,
              createdAt: true,
              decided_at: true,
            },
          },
        },
        skip,
        take,
        orderBy: {
          createdAt: 'desc',
        },
      }),
      this.prisma.hireRequest.count({ where: whereClause }),
    ]);

    if (!hireRequests || hireRequests.length === 0) {
      const emptyResult = {
        data: [],
        meta: {
          total: 0,
          page,
          perPage,
          totalPages: 0,
        },
      };
      await this.redisSet(listCacheKey, JSON.stringify(emptyResult), {
        EX: 20,
      });
      return emptyResult;
    }

    //Get all users from hirerequests assign_user_id to optimize the next steps

    const _pCfgs_A = await this.positionRateConfigService.findAllUnpaginated();
    const _cfgMap_A = buildConfigMap(_pCfgs_A);
    const _poolMap_A = await this.buildCandidatePoolMap(
      hireRequests.flatMap((hr) =>
        hr.panels.flatMap((panel) =>
          panel.panelCandidates.map((pc) => pc.candidate),
        ),
      ),
    );

    const isOrgUser = user.role.includes('organization');
    const crossPanelMap = await this.buildCrossPanelSelectedMap();

    const formatted = await Promise.all(
      hireRequests.map(async (hr) => ({
        ...hr,

        hubspot_pairing_date: hr.hubspot_pairing_date
          ? timestampToUSDate(hr.hubspot_pairing_date)
          : null,

        hasAvailableCandidates: hr.panels.some((panel) =>
          panel.panelCandidates.some((pc) => {
            if (
              !this.availablePipelineStatuses.includes(
                pc.candidate.pipeline_status,
              )
            ) {
              return false;
            }
            const panelMap = crossPanelMap.get(pc.candidate.id);
            if (
              panelMap &&
              !(panelMap.size === 1 && panelMap.has(panel.id))
            ) {
              return false;
            }
            return true;
          }),
        ),

        panels: hr.panels.map((panel) => ({
          ...panel,
          interview_date: panel.interviews[0]?.scheduled_date || null,
          interview_link: panel.interviews[0]?.link || null,
          interviews: undefined,
          panelCandidates: panel.panelCandidates
            .filter((pc) => {
              if (!isOrgUser) return true;
              const panelMap = crossPanelMap.get(pc.candidate.id);
              if (panelMap) {
                const onlyInCurrentPanel =
                  panelMap.size === 1 && panelMap.has(panel.id);
                if (!onlyInCurrentPanel) return false;
              }
              return true;
            })
            .map((pc) => {
              const rates_A = computeCandidateRates(
                pc.candidate,
                _cfgMap_A,
                _poolMap_A.get(pc.candidate.business_unit ?? '') ?? 'medical',
              );
              return {
                ...pc,
                candidate: {
                  ...pc.candidate,
                  employment_type:
                    changeLabelAvailability(
                      dbToStageDictionary[Number(pc.candidate.employment_type)],
                    ) || pc.candidate.employment_type,
                  ...rates_A,
                  avatar: pc.candidate.avatar_url
                    ? `${process.env.AVATAR_URL}${pc.candidate.avatar_url}`
                    : null,
                  panelCandidates:
                    pc.candidate.panelCandidates?.map((pcc) => ({
                      panel_id: pcc.panel.id,
                      title: pcc.panel.hireRequest.title,
                      organization_name:
                        pcc.panel.hireRequest.organization.name,
                      status: pcc.status,
                    })) || [],
                },
              };
            }),
        })),

        assign_user_id: hr.assign_user_id
          ? await this.prisma.uSER.findMany({
              where: {
                id: {
                  in: hr.assign_user_id
                    .split(',')
                    .filter(Boolean)
                    .map((id) => id.trim()),
                },
              },
              select: {
                id: true,
                first_name: true,
                last_name: true,
                email: true,
              },
            })
          : [],
      })),
    );

    const result = {
      data: formatted,
      meta: {
        total,
        page,
        perPage,
        totalPages: Math.ceil(total / perPage),
      },
    };

    await this.redisSet(listCacheKey, JSON.stringify(result), { EX: 20 });

    return result;
  }

  async findOne(id: string, user: USER, source?: string): Promise<any> {
    if (
      !user ||
      (user.role.includes('organization') && !user.organization_id)
    ) {
      throw new NotFoundException(
        'User not found or not part of an organization',
      );
    }

    const hireRequest = await this.prisma.hireRequest.findUnique({
      where: {
        id: id,
        organization: user.role.includes('organization')
          ? { id: user.organization_id || undefined }
          : undefined,
      },
      include: {
        skills: true,
        organization: {
          include: {
            admin: {
              select: { id: true, first_name: true, last_name: true },
            },
          },
        },
        createdBy: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            role: true,
          },
        },
        assigned_sourcing: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
          },
        },
        assigned_staffing: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
          },
        },
        panels: {
          select: {
            id: true,
            status: true,
            scheduled_date: true,
            readable: true,
            panelCandidates: {
              select: {
                id: true,
                status: true,
                candidate: {
                  select: {
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
                    processing_status: true,
                    processing_error: true,
                    organization_id: true,
                    avatar_url: true,
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
                        proficiency_level: true,
                      },
                    },
                    educations: {
                      orderBy: { year: 'desc' },
                      select: {
                        institution: true,
                        degree: true,
                        year: true,
                      },
                    },
                    experiences: {
                      orderBy: { start_date: 'desc' },
                      select: {
                        company: true,
                        position: true,
                        responsabilities: true,
                        start_date: true,
                        end_date: true,
                      },
                    },
                    selectedInInterviews: {
                      select: {
                        scheduled_date: true,
                      },
                    },
                    panelCandidates: {
                      select: {
                        id: true,
                        status: true,
                        panel: {
                          select: {
                            id: true,
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
                          },
                        },
                      },
                    },
                  },
                },
                createdAt: true,
                createdBy: {
                  select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    role: true,
                  },
                },
              },
            },
            interviews: {
              select: {
                scheduled_date: true,
                link: true,
              },
            },
          },
        },
        tickets: { where: { deleted_at: null } },
        staff_to_be_replaced: true,
        offerPanel: {
          select: {
            id: true,
            title: true,
            status: true,
            createdAt: true,
            decided_at: true,
          },
        },
      },
    });
    if (!hireRequest) throw new NotFoundException(`Hire request not found`);

    const usersFromAssignUserId = await this.prisma.uSER.findMany({
      where: {
        id: {
          in: hireRequest.assign_user_id
            ? hireRequest.assign_user_id
                .split(',')
                .filter(Boolean)
                .map((id) => id.trim())
            : [],
        },
      },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
      },
    });

    //Add salary with automatic calculation
    const _pCfgs_B = await this.positionRateConfigService.findAllUnpaginated();
    const _cfgMap_B = buildConfigMap(_pCfgs_B);
    const _poolMap_B = await this.buildCandidatePoolMap(
      (hireRequest.panels ?? []).flatMap((panel) =>
        panel.panelCandidates.map((pc) => pc.candidate as any),
      ),
    );

    const formatted = {
      ...hireRequest,
      hubspot_pairing_date:
        source === 'hubspot'
          ? hireRequest.hubspot_pairing_date
          : hireRequest.hubspot_pairing_date
            ? timestampToUSDate(hireRequest.hubspot_pairing_date)
            : null,
      panels: (hireRequest.panels ?? []).map((panel) => ({
        ...panel,
        interview_date: panel.interviews[0]?.scheduled_date || null,
        interview_link: panel.interviews[0]?.link || null,
        interviews: undefined,
        panelCandidates: panel.panelCandidates.map((pc) => {
          const startDate = pc.candidate.experiences[0]?.start_date;
          const years_of_experience = startDate
            ? new Date().getFullYear() - new Date(startDate).getFullYear()
            : 0;
          const rates_B = computeCandidateRates(
            pc.candidate as any,
            _cfgMap_B,
            _poolMap_B.get(pc.candidate.business_unit ?? '') ?? 'medical',
          );
          return {
            ...pc,
            candidate: {
              ...pc.candidate,
              ...rates_B,
              years_of_experience: years_of_experience,
              approved_positions_pairing:
                pc.candidate.approved_positions_pairing?.map(
                  getApprovedPositionLabel,
                ) || [],
              avatar: pc.candidate.avatar_url
                ? `${process.env.AVATAR_URL}${pc.candidate.avatar_url}`
                : null,
              panelCandidates: pc.candidate.panelCandidates
                ? pc.candidate.panelCandidates.map((pcc) => ({
                    panel_id: pcc.panel.id,
                    title: pcc.panel.hireRequest.title,
                    organization_name: pcc.panel.hireRequest.organization.name,
                    status: pcc.status,
                  }))
                : [],
            },
          };
        }),
      })),
      assign_user_id: usersFromAssignUserId,
    };
    //console.log('HireRequestService.findOne - formatted hire request:', formatted);
    return formatted;
  }

  async getOpenedHireRequests(user: USER): Promise<any> {
    if (
      !user ||
      (user.role.includes('organization') && !user.organization_id)
    ) {
      throw new NotFoundException(
        'User not found or not part of an organization',
      );
    }
    if (!user.role) throw new NotFoundException('User role not found');

    let baseWhere = {};
    switch (user.role) {
      case 'organization_super_admin':
      case 'organization_admin':
        baseWhere = {
          organization: { id: user.organization_id },
          //this condition is to avoid showing hire requests that have a cancellation ticket that is not resolved yet
          // deleted_at belongs INSIDE the `none` predicate: it narrows what counts as a
          // blocking ticket. Outside it, a soft-deleted cancellation ticket would keep the
          // hire request hidden forever with no way to diagnose it.
          tickets: {
            none: {
              type: 'hire_request_cancellation',
              status: { not: 'resolved' },
              deleted_at: null,
            },
          },
          OR: [
            {
              status: {
                in: [
                  HireRequestStatus.new,
                  HireRequestStatus.pending_signature,
                  HireRequestStatus.sourcing,
                  HireRequestStatus.for_review,
                  HireRequestStatus.panel_ready,
                ],
              },
            },
            {
              status: HireRequestStatus.interview_scheduled,
              panels: {
                some: {
                  interviews: {
                    some: {
                      scheduled_date: {
                        gt: new Date(),
                      },
                      status: 'scheduled',
                    },
                  },
                },
              },
            },
          ],
        };
        break;

      case 'system_super_admin':
      case 'system_admin':
        baseWhere = {
          status: { in: ['sourcing', 'for_review'] },
          //this condition is to avoid showing hire requests that have a cancellation ticket that is not resolved yet
          // deleted_at belongs INSIDE the `none` predicate — see the org-admin branch above.
          tickets: {
            none: {
              type: 'hire_request_cancellation',
              status: { not: 'resolved' },
              deleted_at: null,
            },
          },
        };
        break;
    }

    const hireRequests = await this.prisma.hireRequest.findMany({
      where: {
        ...baseWhere,
      },
      include: {
        skills: true,
        organization: {
          select: {
            id: true,
            name: true,
            business_unit: true,
            email: true,
            hubspot_id: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            role: true,
          },
        },
        assigned_sourcing: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
          },
        },
        panels: {
          select: {
            id: true,
            status: true,
            scheduled_date: true,
            readable: true,
            panelCandidates: {
              select: {
                id: true,
                createdBy: {
                  select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    role: true,
                  },
                },
                candidate: {
                  select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    name: true,
                    email: true,
                    country: true,
                    languages: true,
                    specialization: true,
                    about_me: true,
                    hourly_pay_rate: true,
                    avatar_url: true,
                    approved_positions_pairing: true,
                    business_unit: true,
                    video_link: true,
                    employment_type: true,
                    skills: {
                      select: {
                        skill_name: true,
                        proficiency_level: true,
                      },
                    },
                    educations: {
                      orderBy: { year: 'desc' },
                      select: {
                        institution: true,
                        degree: true,
                        year: true,
                      },
                    },
                    experiences: {
                      orderBy: { start_date: 'desc' },
                      select: {
                        company: true,
                        position: true,
                        responsabilities: true,
                        start_date: true,
                        end_date: true,
                      },
                    },
                    panelCandidates: {
                      select: {
                        id: true,
                        status: true,
                        panel: {
                          select: {
                            id: true,
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
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            // Scoped to the active (`status: 'scheduled'`) interview only,
            // earliest first, so the client can evaluate the 48h
            // panel-candidate lead-time rule
            // (`common/utils/panel-candidate-lead-time.ts`) before
            // submitting. `id`/`status` are additive alongside the
            // pre-existing `scheduled_date`/`link` fields — no consumer of
            // this payload breaks. No new PII enters the payload.
            interviews: {
              where: { status: 'scheduled' },
              orderBy: { scheduled_date: 'asc' },
              select: {
                id: true,
                scheduled_date: true,
                status: true,
                link: true,
              },
            },
          },
        },
        staff_to_be_replaced: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const _pCfgs_C = await this.positionRateConfigService.findAllUnpaginated();
    const _cfgMap_C = buildConfigMap(_pCfgs_C);
    const _poolMap_C = await this.buildCandidatePoolMap(
      hireRequests.flatMap((hr) =>
        hr.panels.flatMap((panel) =>
          panel.panelCandidates.map((pc) => pc.candidate),
        ),
      ),
    );

    const formatted = await Promise.all(
      hireRequests.map(async (hr) => ({
        ...hr,

        hubspot_pairing_date: hr.hubspot_pairing_date
          ? timestampToUSDate(hr.hubspot_pairing_date)
          : null,

        panels: hr.panels.map((panel) => ({
          ...panel,
          interview_date: panel.interviews[0]?.scheduled_date || null,
          interview_link: panel.interviews[0]?.link || null,
          interviews: undefined,
          panelCandidates: panel.panelCandidates.map((pc) => {
            const rates_C = computeCandidateRates(
              pc.candidate,
              _cfgMap_C,
              _poolMap_C.get(pc.candidate.business_unit ?? '') ?? 'medical',
            );
            return {
              ...pc,
              candidate: {
                ...pc.candidate,
                ...rates_C,
                approved_positions_pairing:
                  pc.candidate.approved_positions_pairing?.map(
                    getApprovedPositionLabel,
                  ) || [],
                avatar: pc.candidate.avatar_url
                  ? `${process.env.AVATAR_URL}${pc.candidate.avatar_url}`
                  : null,
                panelCandidates:
                  pc.candidate.panelCandidates?.map((pcc) => ({
                    panel_id: pcc.panel.id,
                    title: pcc.panel.hireRequest.title,
                    organization_name: pcc.panel.hireRequest.organization.name,
                    status: pcc.status,
                  })) || [],
              },
            };
          }),
        })),

        assign_user_id: hr.assign_user_id
          ? await this.prisma.uSER.findMany({
              where: {
                id: {
                  in: hr.assign_user_id
                    .split(',')
                    .filter(Boolean)
                    .map((id) => id.trim()),
                },
              },
              select: {
                id: true,
                first_name: true,
                last_name: true,
                email: true,
              },
            })
          : [],
      })),
    );

    console.log('result:', formatted);
    return formatted;
  }

  async update(
    id: string,
    data: UpdateHireRequestDto,
    user: USER,
  ): Promise<object> {
    let result;
    if (
      !user ||
      (user.role.includes('organization') && !user.organization_id)
    ) {
      throw new NotFoundException(
        'User not found or not part of an organization',
      );
    }

    const sanitizeDecimal = (value?: string | null) => {
      return value && value.trim() !== '' ? value : null;
    };

    const { skills, ...hireRequestData } = data;

    const currentHireRequest =
      data.description !== undefined || data.hubspot_tasks !== undefined
        ? await this.prisma.hireRequest.findUnique({
            where: { id },
            select: { description: true, hubspot_tasks: true },
          })
        : null;

    const sanitizeData = {
      ...hireRequestData,
      hubspot_pairing_date:
        dateToTimestamp(hireRequestData.hubspot_pairing_date) || null,
      hubspot_contract_amount: sanitizeDecimal(
        hireRequestData.hubspot_contract_amount,
      ),
      staff_to_be_replaced_id: hireRequestData.staff_to_be_replaced_id || null,
    };
    const requestUpdated = await this.prisma.hireRequest.update({
      where: {
        id: id,
      },
      data: sanitizeData,
    });
    if (!requestUpdated)
      throw new BadRequestException(`Hire request not updated`);

    result = requestUpdated;

    // Sync interview scheduled_date when pairing date/time is edited
    if (
      hireRequestData.hubspot_pairing_date !== undefined ||
      hireRequestData.hubspot_pairing_time !== undefined
    ) {
      try {
        const pairingDateTs = requestUpdated.hubspot_pairing_date; // stored as timestamp string
        const pairingTimeStr = requestUpdated.hubspot_pairing_time;

        if (pairingDateTs && pairingTimeStr) {
          const ts = Number(pairingDateTs);
          const d = new Date(ts);
          const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

          // Convert time to 24h format if it contains AM/PM (e.g. '03:10 AM' → '03:10:00')
          const timeMatch = pairingTimeStr.match(
            /^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i,
          );
          let time24h: string | null = null;
          if (timeMatch) {
            let hours = parseInt(timeMatch[1], 10);
            const minutes = timeMatch[2];
            const meridiem = timeMatch[3]?.toUpperCase();
            if (meridiem === 'AM') {
              hours = hours === 12 ? 0 : hours;
            } else if (meridiem === 'PM') {
              hours = hours === 12 ? 12 : hours + 12;
            }
            time24h = `${String(hours).padStart(2, '0')}:${minutes}:00`;
          }

          if (time24h) {
            const panel = await this.prisma.candidatePanel.findFirst({
              where: { hire_request_id: id },
              select: { id: true },
            });

            if (panel) {
              const interviewCount = await this.prisma.interview.count({
                where: { panel_id: panel.id, status: 'scheduled' },
              });

              if (interviewCount > 0) {
                const scheduledDate = new Date(`${dateStr}T${time24h}Z`);
                await this.prisma.interview.updateMany({
                  where: { panel_id: panel.id, status: 'scheduled' },
                  data: { scheduled_date: scheduledDate },
                });
              }
            }
          }
        }
      } catch (err) {
        console.warn(
          '[HireRequest] Failed to sync interview scheduled_date on update:',
          err?.message || err,
        );
      }
    }

    //console.log('Hire Request updated in database with data:', data.description);
    const descriptionChanged =
      currentHireRequest && data.description !== currentHireRequest.description;
    //console.log('Description changed:', descriptionChanged);
    if (
      descriptionChanged &&
      data.description &&
      data.description.length >= 500
    ) {
      try {
        const summary = await this.openai.generateTextSummary(data.description);
        await this.prisma.hireRequest.update({
          where: { id },
          data: {
            description_summary: summary,
            summary_generated_at: new Date(),
          },
        });
      } catch (err) {
        console.warn(
          '[HireRequest] AI summary generation failed on update:',
          err?.message || err,
        );
      }
    }

    const hubspotTasksChanged =
      currentHireRequest &&
      data.hubspot_tasks !== currentHireRequest.hubspot_tasks;
    if (
      hubspotTasksChanged &&
      data.hubspot_tasks &&
      data.hubspot_tasks.length >= 500
    ) {
      try {
        const tasksSummary = await this.openai.generateTextSummary(
          data.hubspot_tasks,
        );
        await this.prisma.hireRequest.update({
          where: { id },
          data: {
            hubspot_tasks_summary: tasksSummary,
            hubspot_tasks_summary_generated_at: new Date(),
          },
        });
      } catch (err) {
        console.warn(
          '[HireRequest] AI tasks summary generation failed on update:',
          err?.message || err,
        );
      }
    }

    //delete all skills independently if the array is empty or not
    await this.prisma.hireRequestSkill.deleteMany({
      where: {
        hire_request_id: id,
      },
    });

    if (skills && skills.length > 0) {
      const skillsUpdated = await this.prisma.hireRequestSkill.createMany({
        data: skills.map((skill) => ({
          skill_name: skill.name,
          required_level: skill.level,
          hire_request_id: id,
        })),
      });
      if (!skillsUpdated)
        throw new BadRequestException(`Hire request skills not updated`);

      const newSkills = await this.prisma.hireRequestSkill.findMany({
        where: { hire_request_id: id },
      });
      result.skills = newSkills;
    }

    //console.log('Hire Request updated in database with data:', result);

    const newHr = await this.findOne(id, user, 'hubspot');

    //removing the fields that are not necessary for the update on hubspot and can cause issues if they are sent to hubspot
    const { hubspot_pipeline_stage, ...hubspotData } = newHr;
    await this.hubspot.updateHireRequestInHubspot(
      hubspotData,
      undefined,
      user?.id,
      `Hire request ${id} updated by user`,
    );

    // Notify assignee via email when hire request is edited (non-blocking)
    try {
      if (user.role.includes('organization')) {
        await this.notifications.notifyHireRequestClientChange(id, 'edited');
      }
    } catch (err) {
      console.warn(
        '[notifications] hire-request-edited email failed',
        err?.message || err,
      );
    }

    return newHr;
  }

  async updateStatus(
    id: string,
    data: changeStatusHireRequesDTO,
    user: USER,
  ): Promise<boolean> {
    if (
      !user ||
      (user.role.includes('organization') && !user.organization_id)
    ) {
      throw new NotFoundException(
        'User not found or not part of an organization',
      );
    }

    //allow user cancell or star sourcing HireRequest even if all candidates are blocked
    if (
      data.status !== 'cancelled' &&
      data.status !== 'sourcing' &&
      data.status !== 'new'
    ) {
      const verifyCandidates = await this.verifyUnavailableCandidates(id, user);
      if (verifyCandidates) {
        throw new BadRequestException(
          `Cannot move forward. All candidates are no longer available`,
        );
      }
    }

    const assign_user = await this.verifyAssignUser(data.status, id);
    if (!assign_user) {
      throw new BadRequestException(
        `Status ${data.status} requires an assigned user`,
      );
    }

    if (!data || !data.status)
      throw new BadRequestException('Data for status change is required');

    const hireRequest = await this.findOne(id, user);
    if (!hireRequest) throw new NotFoundException(`Hire request not found`);

    const candidates = await this.prisma.panelCandidate.findMany({
      where: {
        panel: {
          hire_request_id: id,
        },
      },
      select: {
        panel_id: true,
        candidate: {
          select: {
            id: true,
            hubspot_id: true,
            pipeline_status: true,
            pipeline_status_origin: true,
          },
        },
      },
    });

    const panelExists = await this.prisma.candidatePanel.findFirst({
      where: {
        hire_request_id: id,
      },
      include: {
        panelCandidates: true,
        interviews: true,
      },
    });

    if (data.status === 'cancelled') {
      if (candidates.length > 0) {
        const pipelineStatus = Object.keys(dbToStageDictionary).find((key) => {
          return dbToStageDictionary[key] === 'Available Candidates';
        });
        if (!pipelineStatus)
          throw new NotFoundException(
            `Pipeline status not found for Available Candidates`,
          );

        //update candidates for their original status or 'Available Candidates' on database and hubspot
        await Promise.all(
          candidates.map(async (c) => {
            const thereOtherPanels = await this.prisma.panelCandidate.findMany({
              where: {
                candidate_id: c.candidate.id,
                status: {
                  in: ['selected_by_client', 'blocked'],
                },
                panel: {
                  hire_request_id: {
                    not: id,
                  },
                },
              },
              select: {
                id: true,
              },
            });
            if (c.candidate.pipeline_status === '261173428') return; //if candidate is in Lost status, dont update his status to Available Candidates, because he is not available anyway
            if (thereOtherPanels.length === 0) {
              //only update candidate if he is not in other panels
              const pipeline_treated =
                c.candidate.pipeline_status_origin || pipelineStatus;
              await this.prisma.candidate.update({
                where: { id: c.candidate.id },
                data: { pipeline_status: pipeline_treated },
              });
              await this.candidateAudit.log({
                candidateId: c.candidate.id,
                hubspotId: c.candidate.hubspot_id,
                actorUserId: user?.id ?? null,
                event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
                fieldGroup: CandidateAuditFieldGroup.pipeline_status,
                before: { pipeline_status: c.candidate.pipeline_status },
                after: { pipeline_status: pipeline_treated },
                source: CandidateAuditSource.user,
              });
              await this.hubspot.updateOneCandidateFromHireRequest(
                c.candidate.hubspot_id,
                pipeline_treated,
                user?.id,
                undefined,
                `Hire request ${id} was cancelled — candidate reverted to previous pipeline status`,
              );
            }
          }),
        );
      }

      //remove all candidates from the panel
      await this.prisma.candidatePanel.deleteMany({
        where: {
          hire_request_id: id,
        },
      });

      //update cancel_date and cancel_reason on database
      await this.prisma.hireRequest.update({
        where: { id },
        data: {
          cancel_date: new Date().toISOString(),
          cancel_reason: data.reason || 'No reason provided',
          assigned_staffing: {
            connect: data.staffing_coordinator
              ? { id: data.staffing_coordinator }
              : undefined,
          },
          client_signed_contract_closing_ticket:
            data.client_signed_contract_closing_ticket || undefined,
        },
      });

      //close possible tickets from this HireRequest
      await this.prisma.ticket.updateMany({
        where: {
          hireRequest_id: id,
          status: { not: 'resolved' },
          type: 'hire_request_cancellation',
          deleted_at: null,
        },
        data: {
          status: 'resolved',
        },
      });

      const updatedRequest = await this.updateHireRequestStatus(
        id,
        data.status as HireRequestStatus,
      );
      if (!updatedRequest)
        throw new BadRequestException(`Hire request status not updated`);

      //update hr ticket on hubspot
      try {
        const dataForHubspot = {
          hubspot_ticket_id: hireRequest.hubspot_ticket_id,
          hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
            (key) => HRTicketStatus[key] === 'Pairing Lost',
          ), //=> Pairing Lost
          cancel_reason: data.reason || 'No reason provided',
          assign_sourcing_id: hireRequest.assigned_sourcing
            ? hireRequest.assigned_sourcing.id
            : undefined,
          staffing_coordinator: data.staffing_coordinator || undefined,
          pairing_session_conducted:
            data.pairing_session_conducted || undefined,
          pairing_session_outcome_reason:
            data.pairing_session_outcome_reason || undefined,
          count_of_candidates_invited_:
            data.count_of_candidates_invited_ || undefined,
          count_of_candidates_attended_:
            data.count_of_candidates_attended_ || undefined,
          count_of_candidates_interviewed_:
            data.count_of_candidates_interviewed_ || undefined,
          //Removed on 02/12/2026 regarding this task: https://regenta-company.monday.com/boards/9328303960/pulses/11225813994?doc_id=18399284084
          //client_signed_contract: data.client_signed_contract || undefined,
          client_signed_contract_closing_ticket:
            data.client_signed_contract_closing_ticket || undefined,
        };
        await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          undefined,
          user?.id,
          `Hire request ${id} status changed to cancelled`,
        );

        //Update cancel_date in hubspot
        await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          'cancel_date',
          user?.id,
          `Hire request ${id} status changed to cancelled — cancel_date synced`,
        );
      } catch (err) {
        console.warn(
          '[hubspot] updateHireRequestInHubspot to Cancelled failed',
          err?.message || err,
        );
      }

      // Notify assignee via email when hire request is canceled (non-blocking)
      try {
        if (user.role.includes('organization')) {
          //just notify if this action is from client
          await this.notifications.notifyHireRequestClientChange(
            id,
            'canceled',
          );
        }
      } catch (err) {
        console.warn(
          '[notifications] hire-request-canceled email failed',
          err?.message || err,
        );
      }

      return this.findOne(id, user);
    } else if (
      (hireRequest.status == 'sourcing' && data.status === 'new') ||
      (hireRequest.status == 'cancelled' && data.status === 'new') ||
      (hireRequest.status == 'placement_completed' && data.status === 'new')
    ) {
      //REOPEN AS NEW
      const pipelineStatus = Object.keys(dbToStageDictionary).find((key) => {
        return dbToStageDictionary[key] === 'Available Candidates';
      });
      if (!pipelineStatus)
        throw new NotFoundException(
          `Pipeline status not found for Available Candidates`,
        );

      //remove all candidates from the panel
      await this.prisma.candidatePanel.deleteMany({
        where: {
          hire_request_id: id,
        },
      });

      if (candidates.length > 0) {
        //update candidates for their original status or 'Available Candidates' on database and hubspot
        await Promise.all(
          candidates.map(async (c) => {
            const pipeline_treated =
              c.candidate.pipeline_status_origin || pipelineStatus;
            await this.prisma.candidate.update({
              where: { id: c.candidate.id },
              data: { pipeline_status: pipeline_treated },
            });
            await this.candidateAudit.log({
              candidateId: c.candidate.id,
              hubspotId: c.candidate.hubspot_id,
              actorUserId: user?.id ?? null,
              event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
              fieldGroup: CandidateAuditFieldGroup.pipeline_status,
              before: { pipeline_status: c.candidate.pipeline_status },
              after: { pipeline_status: pipeline_treated },
              source: CandidateAuditSource.user,
            });
            await this.hubspot.updateOneCandidateFromHireRequest(
              c.candidate.hubspot_id,
              pipeline_treated,
              user?.id,
              undefined,
              `Hire request ${id} was reopened as new — candidate reverted to previous pipeline status`,
            );
          }),
        );
      }

      const updatedRequest = await this.updateHireRequestStatus(
        id,
        data.status as HireRequestStatus,
      );
      if (!updatedRequest)
        throw new BadRequestException(`Hire request status not updated`);

      //update hr ticket on hubspot
      try {
        const dataForHubspot = {
          hubspot_ticket_id: hireRequest.hubspot_ticket_id,
          hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
            (key) => HRTicketStatus[key] === 'New Agent Request',
          ), //=> New
        };
        await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          undefined,
          user?.id,
          `Hire request ${id} reopened as new`,
        );

        await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          'reopen_as_new',
          user?.id,
          `Hire request ${id} reopened as new — reopen fields cleared`,
        );
        console.log('Hubspot hire request updated to New status');
      } catch (err) {
        console.warn(
          '[hubspot] updateHireRequestInHubspot to Cancelled failed',
          err?.message || err,
        );
      }

      return this.findOne(id, user);
    } else if (
      (hireRequest.status == 'panel_ready' && data.status === 'sourcing') ||
      (hireRequest.status == 'for_review' && data.status === 'sourcing') ||
      (hireRequest.status == 'cancelled' && data.status === 'sourcing') ||
      (hireRequest.status == 'interview_scheduled' &&
        data.status === 'sourcing')
    ) {
      //update panel to readable=false
      //update the hireRequest Status to sourcing

      // Leaving interview_scheduled must also reset CandidatePanel.status
      // and clear the stale Interview rows — otherwise GET
      // /hire-request/get-panels/all (which buckets by CandidatePanel.status,
      // not HireRequest.status) keeps showing the card under "Interview
      // Scheduled" on the client side even though the hire request itself
      // moved back to sourcing.
      if (hireRequest.status == 'interview_scheduled' && panelExists) {
        await this.prisma.interview.deleteMany({
          where: {
            panel_id: panelExists.id,
          },
        });
      }

      const panelUpdated = await this.prisma.candidatePanel.updateMany({
        where: {
          hire_request_id: id,
        },
        data: {
          readable: false,
          ...(hireRequest.status == 'interview_scheduled'
            ? { status: 'created' as PanelStatus, scheduled_date: null }
            : {}),
        },
      });
      const updatedRequest = await this.updateHireRequestStatus(
        id,
        data.status as HireRequestStatus,
      );
      if (!updatedRequest)
        throw new BadRequestException(`Hire request status not updated`);

      //update hr ticket on hubspot
      try {
        const dataForHubspot = {
          hubspot_ticket_id: hireRequest.hubspot_ticket_id,
          hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
            (key) => HRTicketStatus[key] === 'Sourcing Candidates',
          ),
        };
        await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          undefined,
          user?.id,
          `Hire request ${id} moved back to sourcing`,
        );
      } catch (err) {
        console.warn(
          '[hubspot] updateHireRequestInHubspot to Cancelled failed',
          err?.message || err,
        );
      }

      try {
        await this.notifications.notifyHireRequestBackToSourcing(id);
      } catch (err) {
        console.warn(
          '[notifications] hire-request Back to sourcing',
          err?.message || err,
        );
      }
      return this.findOne(id, user);
    } else if (
      hireRequest.status == 'panel_ready' &&
      data.status === 'for_review'
    ) {
      const updatedRequest = await this.updateHireRequestStatus(
        id,
        data.status as HireRequestStatus,
      );
      if (!updatedRequest)
        throw new BadRequestException(`Hire request status not updated`);

      try {
        const dataForHubspot = {
          hubspot_ticket_id: hireRequest.hubspot_ticket_id,
          hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
            (key) => HRTicketStatus[key] === 'Sourcing Candidates',
          ),
        };
        await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          undefined,
          user?.id,
          `Hire request ${id} moved to for_review`,
        );
      } catch (err) {
        console.warn(
          '[hubspot] updateHireRequestInHubspot in Panel ready failed',
          err?.message || err,
        );
      }

      return this.findOne(id, user);
    } else if (hireRequest.status == 'new' && data.status === 'sourcing') {
      //verify if there panel created with this hire_request_id

      if (!panelExists) {
        //create Panel with default user_id
        await this.prisma.candidatePanel.create({
          data: {
            hire_request_id: id,
            readable: false,
          },
        });
      }

      const updatedRequest = await this.updateHireRequestStatus(
        id,
        data.status as HireRequestStatus,
      );
      if (!updatedRequest)
        throw new BadRequestException(`Hire request status not updated`);

      try {
        const dataForHubspot = {
          hubspot_ticket_id: hireRequest.hubspot_ticket_id,
          hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
            (key) => HRTicketStatus[key] === 'Sourcing Candidates',
          ),
        };
        const hrTicket = await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          undefined,
          user?.id,
          `Hire request ${id} moved from new to sourcing`,
        );
      } catch (err) {
        console.warn(
          '[hubspot] updateHireRequestInHubspot to Cancelled failed',
          err?.message || err,
        );
      }

      //notify the sourcing assigned user
      try {
        await this.notifications.notifyHireRequestSourcingAssignee(
          id,
          'sourcing',
        );
      } catch (err) {
        console.warn(
          '[notifications] hire-request-canceled email failed',
          err?.message || err,
        );
      }

      return this.findOne(id, user);
    } else if (
      hireRequest.status == 'sourcing' &&
      data.status === 'for_review'
    ) {
      if (!panelExists)
        throw new NotFoundException(`Panel for this hire request not found`);

      //Pauli asked to remove this rule: https://regenta-company.monday.com/boards/9328303960/pulses/18070949162?notification=6971131519
      if (panelExists.panelCandidates.length < 1) {
        throw new BadRequestException(`Panel must have at least 1 candidates`);
      }
      const updatedRequest = await this.updateHireRequestStatus(
        id,
        data.status as HireRequestStatus,
      );
      if (!updatedRequest)
        throw new BadRequestException(`Hire request status not updated`);

      //notify the sourcing assigned user
      try {
        await this.notifications.notifyHireRequestConciergeAssigned(
          id,
          'for_review',
        );
      } catch (err) {
        console.warn(
          '[notifications] hire-request-canceled email failed',
          err?.message || err,
        );
      }

      return this.findOne(id, user);
    } else if (
      hireRequest.status == 'for_review' &&
      data.status === 'panel_ready'
    ) {
      if (!panelExists)
        throw new NotFoundException(`Panel for this hire request not found`);

      const updatedRequest = await this.updateHireRequestStatus(
        id,
        data.status as HireRequestStatus,
      );
      if (!updatedRequest)
        throw new BadRequestException(`Hire request status not updated`);

      try {
        const dataForHubspot = {
          hubspot_ticket_id: hireRequest.hubspot_ticket_id,
          hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
            (key) => HRTicketStatus[key] === 'Candidates Endorsed',
          ),
        };
        await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          undefined,
          user?.id,
          `Hire request ${id} moved from for_review to panel_ready`,
        );
      } catch (err) {
        console.warn(
          '[hubspot] updateHireRequestInHubspot in Panel ready failed',
          err?.message || err,
        );
      }

      return this.findOne(id, user);
    } else if (
      (hireRequest.status == 'panel_ready' &&
        data.status === 'placement_completed') ||
      (hireRequest.status == 'interview_scheduled' &&
        data.status === 'placement_completed') ||
      (hireRequest.status == 'awaiting_decision' &&
        data.status === 'placement_completed')
    ) {
      if (!panelExists)
        throw new NotFoundException(`Panel for this hire request not found`);
      const winnerCandidate = panelExists.panelCandidates.find(
        (pc) => pc.status === 'selected_by_client',
      );
      if (!winnerCandidate)
        throw new BadRequestException(
          `You need to select a candidate as winner before before moving to ${data.status.replace('_', ' ').toUpperCase()}`,
        );

      const updatedRequest = await this.updateHireRequestStatus(
        id,
        data.status as HireRequestStatus,
      );
      if (!updatedRequest)
        throw new BadRequestException(`Hire request status not updated`);

      const updatedPanel = await this.prisma.candidatePanel.update({
        where: {
          id: panelExists.id,
        },
        data: {
          status: 'decision_made',
        },
      });
      if (!updatedPanel) throw new BadRequestException(`Panel not updated`);

      try {
        const dataForHubspot = {
          hubspot_ticket_id: hireRequest.hubspot_ticket_id,
          hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
            (key) => HRTicketStatus[key] === 'For Onboarding (Paired)',
          ),
        };
        const hrTicket = await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          undefined,
          user?.id,
          `Hire request ${id} moved to placement_completed`,
        );
      } catch (err) {
        console.warn(
          '[hubspot] updateHireRequestInHubspot in Awaiting decision failed',
          err?.message || err,
        );
      }

      // Fire placement completed notification (non-blocking)
      try {
        await this.notifications.notifyHireRequestPlacementCompleted(id);
      } catch (err) {
        console.warn(
          '[notifications] placement-completed email failed',
          err?.message || err,
        );
      }

      // Fire select winner notification to organization admins (non-blocking)
      try {
        await this.notifications.notifyHireRequestSelectWinner(id);
      } catch (err) {
        console.warn(
          '[notifications] select-winner email failed',
          err?.message || err,
        );
      }

      return this.findOne(id, user);
    } else if (
      hireRequest.status == 'interview_scheduled' &&
      data.status === 'panel_ready'
    ) {
      if (!panelExists)
        throw new NotFoundException(`Panel for this hire request not found`);

      //remove the interview_scheduled panel
      const removeInterview = await this.prisma.interview.deleteMany({
        where: {
          panel_id: panelExists.id,
        },
      });
      if (!removeInterview)
        throw new BadRequestException(`Interview not removed`);

      const updatedRequest = await this.updateHireRequestStatus(
        id,
        data.status as HireRequestStatus,
      );
      if (!updatedRequest)
        throw new BadRequestException(`Hire request status not updated`);

      const updatePanel = await this.prisma.candidatePanel.update({
        where: {
          id: panelExists.id,
        },
        data: {
          scheduled_date: null,
        },
      });

      try {
        const dataForHubspot = {
          hubspot_ticket_id: hireRequest.hubspot_ticket_id,
          hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
            (key) => HRTicketStatus[key] === 'Candidates Endorsed',
          ),
        };
        await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          undefined,
          user?.id,
          `Hire request ${id} moved from interview_scheduled to panel_ready`,
        );
      } catch (err) {
        console.warn(
          '[hubspot] updateHireRequestInHubspot in Panel ready failed',
          err?.message || err,
        );
      }

      try {
        const dataForHubspot = {
          hubspot_ticket_id: hireRequest.hubspot_ticket_id,
          hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
            (key) => HRTicketStatus[key] === 'Candidates Endorsed',
          ),
        };
        const hrTicket = await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          undefined,
          user?.id,
          `Hire request ${id} moved from interview_scheduled to panel_ready`,
        );
      } catch (err) {
        console.warn(
          '[hubspot] updateHireRequestInHubspot in Panel ready failed',
          err?.message || err,
        );
      }

      return this.findOne(id, user);
    } else if (
      hireRequest.status == 'awaiting_decision' &&
      data.status === 'panel_ready'
    ) {
      if (!panelExists)
        throw new NotFoundException(`Panel for this hire request not found`);
      //remove the scheduled date => due date to decide
      const updatedPanel = await this.prisma.candidatePanel.update({
        where: {
          id: panelExists.id,
        },
        data: {
          status: 'created',
        },
      });
      if (!updatedPanel) throw new BadRequestException(`Panel not updated`);

      //remove the interview_scheduled panel
      const removeInterview = await this.prisma.interview.deleteMany({
        where: {
          panel_id: panelExists.id,
        },
      });

      const updatedRequest = await this.updateHireRequestStatus(
        id,
        data.status as HireRequestStatus,
      );
      if (!updatedRequest)
        throw new BadRequestException(`Hire request status not updated`);

      try {
        const dataForHubspot = {
          hubspot_ticket_id: hireRequest.hubspot_ticket_id,
          hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
            (key) => HRTicketStatus[key] === 'Candidates Endorsed',
          ),
        };
        await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          undefined,
          user?.id,
          `Hire request ${id} moved from awaiting_decision to panel_ready`,
        );
      } catch (err) {
        console.warn(
          '[hubspot] updateHireRequestInHubspot in Panel ready failed',
          err?.message || err,
        );
      }

      return this.findOne(id, user);

      /* It was removed on 10-17-2025 asked by Pauli and fouond by Liz - https://regenta-company.monday.com/boards/9328303960/pulses/18193994589
    } else if (hireRequest.status == 'placement_completed' && data.status === 'panel_ready' ){
      if (!panelExists) throw new NotFoundException(`Panel for this hire request not found`);

      await this.prisma.interview.deleteMany({
        where: {
          panel_id: panelExists.id,
        },
      });

      await this.prisma.panelCandidate.updateMany({
        where: {
          panel_id: panelExists.id,
        },
        data: {
          status: 'selected',
        },
      });

      const panelCandidates = await this.prisma.panelCandidate.findMany({
        where: {
          panel_id: panelExists.id,
        },
        select: {
          candidate: {
            select: {
              id: true,
              hubspot_id: true,
              pipeline_status: true,
            },
          },
        },
      });

      if (panelCandidates.length > 0) {
        const pipelineStatus = Object.keys(dbToStageDictionary).find(key => {
          return dbToStageDictionary[key] === 'Endorsed via Platform';
        });
        if (!pipelineStatus) throw new NotFoundException(`Pipeline status not found for Endorsed via platform`);

        const candidateIds = panelCandidates.map(pc => pc.candidate.id);
        await this.prisma.candidate.updateMany({
          where: {
            id: {
              in: candidateIds,
            },
          },
          data: {
            pipeline_status: pipelineStatus,
          },
        });

        await this.candidateAudit.logMany(
          panelCandidates.map(pc => ({
            candidateId: pc.candidate.id,
            hubspotId: pc.candidate.hubspot_id,
            actorUserId: user?.id ?? null,
            event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
            fieldGroup: CandidateAuditFieldGroup.pipeline_status,
            before: { pipeline_status: pc.candidate.pipeline_status },
            after: { pipeline_status: pipelineStatus },
            source: CandidateAuditSource.user,
          })),
        );

        const candidatesForHubspot = panelCandidates.map(pc => pc.candidate);
        const updateHubspot = await this.hubspot.updateManyCandidatesFromHireRequest(candidatesForHubspot, pipelineStatus, user?.id);
        if (!updateHubspot) throw new NotFoundException(`Candidates not updated on the hubspot`);
      }

      const updatedRequest = await this.updateHireRequestStatus(id, data.status as HireRequestStatus);
      if (!updatedRequest) throw new BadRequestException(`Hire request status not updated`);

      const updatedPanel = await this.prisma.candidatePanel.update({
        where: {
          id: panelExists.id,
        },
        data: {
          status: 'created',
          scheduled_date: null,
        }
      })
      if( !updatedPanel) throw new BadRequestException(`Panel not updated`);

      return this.findOne(id, user);

    */
    } else if (
      hireRequest.status == 'panel_ready' &&
      data.status === 'interview_scheduled'
    ) {
      if (!panelExists)
        throw new NotFoundException(`Panel for this hire request not found`);

      if (panelExists.interviews.length === 0) {
        throw new BadRequestException(
          `You need to schedule an interview before changing the status to ${data.status.replace('_', ' ').toUpperCase()}`,
        );
      }
      const updatedRequest = await this.updateHireRequestStatus(
        id,
        data.status as HireRequestStatus,
      );
      if (!updatedRequest)
        throw new BadRequestException(`Hire request status not updated`);

      const updatedPanel = await this.prisma.candidatePanel.update({
        where: {
          id: panelExists.id,
        },
        data: {
          status: 'interview_scheduled',
        },
      });
      if (!updatedPanel) throw new BadRequestException(`Panel not updated`);

      try {
        const dataForHubspot = {
          hubspot_ticket_id: hireRequest.hubspot_ticket_id,
          hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
            (key) => HRTicketStatus[key] === 'Candidates Interview Booked',
          ),
        };
        await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          undefined,
          user?.id,
          `Hire request ${id} moved to interview_scheduled`,
        );
      } catch (err) {
        console.warn(
          '[hubspot] updateHireRequestInHubspot in Panel ready failed',
          err?.message || err,
        );
      }

      return this.findOne(id, user);
    } else if (
      (hireRequest.status == 'panel_ready' &&
        data.status === 'awaiting_decision') ||
      (hireRequest.status == 'interview_scheduled' &&
        data.status === 'awaiting_decision')
    ) {
      if (!panelExists)
        throw new NotFoundException(`Panel for this hire request not found`);

      if (!panelExists.scheduled_date) {
        throw new BadRequestException(
          `You need to set a Deadline before changing the status to ${data.status.replace('_', ' ').toUpperCase()}`,
        );
      }
      const updatedRequest = await this.updateHireRequestStatus(
        id,
        data.status as HireRequestStatus,
      );
      if (!updatedRequest)
        throw new BadRequestException(`Hire request status not updated`);

      //change the status panel
      const updatedPanel = await this.prisma.candidatePanel.update({
        where: {
          id: panelExists.id,
        },
        data: {
          status: 'decision_pending',
        },
      });
      if (!updatedPanel) throw new BadRequestException(`Panel not updated`);

      try {
        const dataForHubspot = {
          hubspot_ticket_id: hireRequest.hubspot_ticket_id,
          hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
            (key) => HRTicketStatus[key] === 'Interview Done (For Follow-up)',
          ),
        };
        const hrTicket = await this.hubspot.updateHireRequestInHubspot(
          dataForHubspot,
          undefined,
          user?.id,
          `Hire request ${id} moved to awaiting_decision via status change`,
        );
      } catch (err) {
        console.warn(
          '[hubspot] updateHireRequestInHubspot in Awaiting decision failed',
          err?.message || err,
        );
      }

      return this.findOne(id, user);
    } else {
      throw new BadRequestException(
        `Status change from ${hireRequest.status.replace('_', ' ').toUpperCase()} to ${data.status.replace('_', ' ').toUpperCase()} is not allowed`,
      );
    }
  }

  async reassign(
    id: string,
    user: USER,
    data: reassignDTO,
    type: string,
  ): Promise<any> {
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );

    if (!type)
      throw new BadRequestException('Type of reassignment is required');

    let fieldToUpdate = {};
    if (type === 'concierge') {
      fieldToUpdate = {
        assign_user_id: data.user_id || null,
      };
    } else if (type === 'sourcing') {
      fieldToUpdate = {
        assigned_sourcing: data.user_id
          ? { connect: { id: data.user_id } }
          : { disconnect: true },
      };
    } else if (type === 'staffing_coordinator') {
      fieldToUpdate = {
        assigned_staffing: data.user_id
          ? { connect: { id: data.user_id } }
          : { disconnect: true },
      };
    }

    const hireRequest = await this.prisma.hireRequest.update({
      where: { id },
      data: fieldToUpdate,
    });
    if (!hireRequest) throw new NotFoundException(`Hire request not found`);

    const newHr = await this.findOne(id, user);
    await this.hubspot.updateHireRequestInHubspot(
      newHr,
      type === 'concierge'
        ? 'assign_user_id'
        : type === 'staffing_coordinator'
          ? 'assign_staffing_coordinator'
          : 'assign_sourcing_id',
      user?.id,
      `Hire request ${id} reassigned to new team member`,
    );

    // Notificação (não bloqueante)
    if (data.user_id) {
      console.log(
        `[notifications] Attempting to send hire request reassigned notification for HR ${id} to user(s) ${data.user_id}`,
      );
      try {
        const result = await this.notifications.notifyHireRequestCreated(
          id,
          type,
        );
        console.log(
          `[notifications] Hire request reassigned notification sent successfully:`,
          result,
        );
      } catch (err) {
        console.error(
          '[notifications] hire-request-reassigned email failed',
          err?.message || err,
        );
      }
    } else {
      console.log(
        `[notifications] No user_id provided for hire request reassignment ${id}, skipping notification`,
      );
    }

    return newHr;
  }

  async showMatchCandidates(id: string, user: USER): Promise<object> {
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );

    const hireRequest = await this.prisma.hireRequest.findUnique({
      where: { id },
      select: {
        id: true,
        specialization: true,
        location: true,
        availability: true,
        salary_range_from: true,
        salary_range_to: true,
        skills: {
          select: {
            skill_name: true,
            required_level: true,
          },
        },
      },
    });

    if (!hireRequest) throw new NotFoundException(`Hire request not found`);

    const requiredSkills = hireRequest.skills.map((s) => s.skill_name);

    const hourly_from = hireRequest.salary_range_from
      ? findHourlyPerRate(Number(hireRequest.salary_range_from))
      : undefined;

    const hourly_to = hireRequest.salary_range_to
      ? findHourlyPerRate(Number(hireRequest.salary_range_to))
      : undefined;

    const candidates = await this.prisma.candidate.findMany({
      where: {
        OR: [
          { pipeline_status: '261075105' },
          { pipeline_status: '1087596819' },
        ],
      },
      select: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        name: true,
        about_me: true,
        hourly_pay_rate: true,
        pipeline_status: true,
        country: true,
        specialization: true,
        employment_type: true,
        avatar_url: true,
        gender: true,
        approved_positions_pairing: true,
        business_unit: true,

        //Va score cards fields
        active_listening_and_comprehension_demonstrated: true,
        adaptability_to_different_client_personalities_and_workflows: true,
        can_articulate_experience_clearly_to_clients: true,
        can_multitask_between_systems_or_windows_efficiently: true,
        client_readiness___fit_evaluator_notes: true,
        comfortable_with_basic_tools__google_workspace__zoom__ehr_software_: true,
        comfortable_with_camera_on_setup: true,
        communication_skills_evaluator_notes: true,
        confident_on_video_and_phone_calls: true,
        cultural_alignment_with_us_healthcare_environment: true,
        demonstrates_problem_solving_and_tech_adaptability: true,
        demonstrates_stability_and_commitment: true,
        demonstrates_understanding_of_medical_terminology_and_procedures: true,
        exhibits_confidence_and_empathy_in_roleplay_scenarios: true,
        familiarity_with_emr_ehr_systems__kareo__athena__eclinicalworks__etc__: true,
        for_bilinguals__fluent_and_accurate_in_both_english_and_spanish: true,
        grammar__vocabulary__and_tone_are_appropriate_for_us_clients: true,
        handles_feedback_constructively: true,
        has_functioning_headset__webcam__and_backup_device: true,
        knowledge_of_hipaa_compliance_and_confidentiality: true,
        medical_knowledge_evaluator_notes: true,
        no_medical_industry_experience: true,
        positive_attitude_and_professional_demeanor: true,
        prior_experience_in_healthcare_or_medical_va_roles: true,
        professionalism___work_readiness_evaluator_notes: true,
        punctual_and_responsive_during_recruitment_stages: true,
        remote_work_discipline_and_time_management: true,
        speaks_clearly_and_professionally: true,
        stable_internet_connection__min__20_mbps_: true,
        technical_competence_evaluator_notes: true,
        tier_level: true,
        total_points: true,
        understands_workflow_in_medical_offices___telehealth_environments: true,

        languages: {
          select: {
            name: true,
          },
        },
        skills: {
          select: {
            skill_name: true,
            proficiency_level: true,
          },
        },
        experiences: {
          select: {
            company: true,
            position: true,
            responsabilities: true,
            start_date: true,
            end_date: true,
          },
        },
        educations: {
          select: {
            institution: true,
            degree: true,
            year: true,
          },
        },
        panelCandidates: {
          where: {
            panel: {
              hire_request_id: { not: id },
            },
          },
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
              },
            },
          },
        },
      },
    });

    const hireRequestSpecialization = hireRequest.specialization
      ? hireRequest.specialization.split(';').map((s) => s.trim())
      : [];

    //=> score
    const scoredCandidates = candidates.map((candidate) => {
      let score = 0;

      if (
        hireRequestSpecialization.length > 0 &&
        candidate.specialization &&
        hireRequestSpecialization.includes(candidate.specialization)
      ) {
        score += 1;
      }

      if (hireRequest.location && candidate.country === hireRequest.location)
        score += 1;

      //if (hireRequest.availability && candidate.employment_type === hireRequest.availability) score += 1;
      if (hireRequest.availability) {
        if (
          hireRequest.availability === 'full-time' &&
          candidate.employment_type === '261075105'
        )
          score += 1;
        if (
          hireRequest.availability === 'part-time' &&
          candidate.employment_type === '1087596819'
        )
          score += 1;
      }

      if (
        candidate.hourly_pay_rate !== null &&
        hourly_from !== undefined &&
        hourly_to !== undefined &&
        candidate.hourly_pay_rate.toNumber() >= hourly_from &&
        candidate.hourly_pay_rate.toNumber() <= hourly_to
      )
        score += 1;

      const candidateSkills = candidate.skills.map((s) => s.skill_name);
      const matchedSkills = candidateSkills.filter((skill) =>
        requiredSkills.includes(skill),
      );
      score += matchedSkills.length;

      return {
        ...candidate,
        matchedSkills,
        score,
      };
    });

    //order because I need to delivery the best candidates first
    scoredCandidates.sort((a, b) => b.score - a.score);

    //Add salary with automatic calculation
    const _pCfgs_D = await this.positionRateConfigService.findAllUnpaginated();
    const _cfgMap_D = buildConfigMap(_pCfgs_D);
    const _poolMap_D = await this.buildCandidatePoolMap(scoredCandidates);

    const candidatesWithSalary = scoredCandidates.map((c) => {
      const rates_D = computeCandidateRates(
        c,
        _cfgMap_D,
        _poolMap_D.get(c.business_unit ?? '') ?? 'medical',
      );
      return {
        ...c,
        ...rates_D,
        approved_positions_pairing:
          c.approved_positions_pairing?.map(getApprovedPositionLabel) || [],
        avatar: c.avatar_url
          ? `${process.env.AVATAR_URL}${c.avatar_url}`
          : null,
        panelCandidates: c.panelCandidates
          ? c.panelCandidates.map((pc) => ({
              title: pc.panel.hireRequest.title,
              organization_name: pc.panel.hireRequest.organization.name,
            }))
          : [],
      };
    });

    return candidatesWithSalary;
  }

  async confirmPanel(
    data: ConfirmPanelHireRequestDto,
    user: USER,
  ): Promise<boolean> {
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );
    if (!data || !data.candidates_id)
      throw new BadRequestException('Data is required to confirm panel');
    //if (data.candidates_id.length !== 5) throw new BadRequestException('Exactly 5 candidates must be selected to confirm panel');

    //check if panel exists
    const panelExists = await this.prisma.candidatePanel.findFirst({
      where: {
        hire_request_id: data.hireRequest_id,
      },
      select: {
        id: true,
        panelCandidates: {
          select: {
            candidate: {
              select: {
                id: true,
                pipeline_status: true,
                panelCandidates: { select: { status: true } },
              },
            },
          },
        },
      },
    });
    if (!panelExists)
      throw new NotFoundException(`Panel for this hire request not found`);

    this.assertNoHiredCandidatesInPanel(panelExists.panelCandidates);

    if (data.candidates_id.length > 0) {
      //add each candidate to the panel
      const addCandidates = await this.prisma.panelCandidate.createMany({
        data: data.candidates_id.map((candidateId) => ({
          candidate_id: candidateId,
          panel_id: panelExists.id,
        })),
      });
      if (!addCandidates)
        throw new BadRequestException(`Panel candidates not added`);
    }

    //update panel with status = 'sourcing'
    const panelUpdated = await this.prisma.hireRequest.update({
      where: {
        id: data.hireRequest_id,
      },
      data: {
        status: 'sourcing',
      },
    });
    if (!panelUpdated) throw new BadRequestException(`Panel not confirmed`);

    const pipelineStatus = Object.keys(dbToStageDictionary).find((key) => {
      return dbToStageDictionary[key] === 'Endorsed via Platform';
    });

    const candidatesBeforeEndorse = await this.prisma.candidate.findMany({
      where: {
        id: {
          in: data.candidates_id,
        },
      },
      select: {
        id: true,
        hubspot_id: true,
        pipeline_status: true,
      },
    });
    if (!candidatesBeforeEndorse) throw new NotFoundException(`Candidates not found`);

    //update candidates with pipelinestatus = 'Endorsed via Platform'
    const candidatesUpdated = await this.prisma.candidate.updateMany({
      where: {
        id: {
          in: data.candidates_id,
        },
      },
      data: {
        pipeline_status: pipelineStatus,
      },
    });
    if (!candidatesUpdated)
      throw new BadRequestException(`Candidates not updated to endorsed`);

    await this.candidateAudit.logMany(
      candidatesBeforeEndorse.map((c) => ({
        candidateId: c.id,
        hubspotId: c.hubspot_id,
        actorUserId: user?.id ?? null,
        event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
        fieldGroup: CandidateAuditFieldGroup.pipeline_status,
        before: { pipeline_status: c.pipeline_status },
        after: { pipeline_status: pipelineStatus },
        source: CandidateAuditSource.user,
      })),
    );

    //select candidates
    const candidates = candidatesBeforeEndorse.map((c) => ({
      id: c.id,
      hubspot_id: c.hubspot_id,
    }));

    //comunicate with hubspot to update status
    const updateHubspot =
      await this.hubspot.updateManyCandidatesFromHireRequest(
        candidates,
        pipelineStatus,
        user?.id,
        data.hireRequest_id,
        `Panel confirmed for hire request ${data.hireRequest_id} — candidates set to Endorsed via Platform`,
      );
    if (!updateHubspot)
      throw new NotFoundException(
        `Loser candidates not updated on the hubspot`,
      );

    return true;
  }

  async editPanel(
    data: ConfirmPanelHireRequestDto,
    user: USER,
  ): Promise<boolean> {
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );
    if (!data || !data.candidates_id)
      throw new BadRequestException('Data is required to confirm panel');

    const pipelineStatus = Object.keys(dbToStageDictionary).find((key) => {
      return dbToStageDictionary[key] === 'Endorsed via Platform';
    });
    if (!pipelineStatus)
      throw new BadRequestException(`Pipeline status mapping not found`);

    const pipelineStatusOldCandidates = Object.keys(dbToStageDictionary).find(
      (key) => {
        return dbToStageDictionary[key] === 'Available Candidates';
      },
    );
    if (!pipelineStatusOldCandidates)
      throw new NotFoundException(
        `Pipeline status mapping not found for Available Candidates`,
      );

    // === Transaction Prisma ===
    const { currentPanel } = await this.prisma.$transaction(async (tx) => {
      const existingPanel = await tx.candidatePanel.findFirst({
        where: { hire_request_id: data.hireRequest_id },
        select: {
          id: true,
          panelCandidates: {
            select: {
              candidate: {
                select: {
                  id: true,
                  pipeline_status: true,
                  panelCandidates: { select: { status: true } },
                },
              },
            },
          },
        },
      });

      if (existingPanel) {
        // Only block candidates that would still remain on the panel after
        // this edit — a hired candidate being removed (i.e. left out of
        // data.candidates_id) must be allowed through, since that's the
        // very action the guard's error message asks the user to take.
        const remainingPanelCandidates = existingPanel.panelCandidates.filter(
          (pc) => data.candidates_id.includes(pc.candidate.id),
        );
        this.assertNoHiredCandidatesInPanel(remainingPanelCandidates);
      }

      let panelId: string;

      if (!existingPanel) {
        const created = await tx.candidatePanel.create({
          data: {
            hire_request_id: data.hireRequest_id,
            readable: false,
          },
        });

        const updatedRequest = await this.updateHireRequestStatus(
          data.hireRequest_id,
          'sourcing',
        );
        if (!updatedRequest)
          throw new BadRequestException(`Hire request status not updated`);

        panelId = created.id;
      } else {
        panelId = existingPanel.id;
      }

      //check existing candidates on the panel
      const existingCandidates = await tx.panelCandidate.findMany({
        where: { panel_id: panelId },
        select: { candidate_id: true },
      });
      //filter data.candidates_id to find just candidates who will be add on the panel without duplicates
      const candidatesToAdd = data.candidates_id.filter(
        (candidateId) =>
          !existingCandidates.some((ec) => ec.candidate_id === candidateId),
      );
      //filter existing candidates to find candidates who will be removed from the panel
      const candidatesToRemove = existingCandidates
        .filter((ec) => !data.candidates_id.includes(ec.candidate_id))
        .map((ec) => ec.candidate_id);

      // Remove candidates from the panel
      if (candidatesToRemove.length > 0) {
        await tx.panelCandidate.deleteMany({
          where: {
            panel_id: panelId,
            candidate_id: { in: candidatesToRemove },
          },
        });
      }

      // Create new candidates on the panel
      await tx.panelCandidate.createMany({
        data: candidatesToAdd.map((candidateId) => ({
          candidate_id: candidateId,
          panel_id: panelId,
          createdByUserId: user.id,
        })),
      });

      return {
        currentPanel: { id: panelId },
      };
    });

    return this.findOne(data.hireRequest_id, user);
  }

  async panelReady(data: panelReadyDTO, user: USER): Promise<boolean> {
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );
    if (!data || !data.hireRequest_id)
      throw new BadRequestException('Data is required to confirm panel ready');

    const verifyCandidates = await this.verifyUnavailableCandidates(
      data.hireRequest_id,
      user,
    );
    if (verifyCandidates) {
      throw new BadRequestException(
        `Cannot move forward. All candidates are no longer available`,
      );
    }

    const panel = await this.prisma.candidatePanel.findFirst({
      where: {
        hire_request_id: data.hireRequest_id,
      },
      select: {
        id: true,
        panelCandidates: {
          select: {
            candidate_id: true,
            candidate: {
              select: {
                id: true,
                pipeline_status: true,
                panelCandidates: { select: { status: true } },
              },
            },
          },
        },
      },
    });

    if (!panel) {
      throw new NotFoundException(`Panel for this hire request not found`);
    }

    this.assertNoHiredCandidatesInPanel(panel.panelCandidates);

    //Pauli asked to remove this rule: https://regenta-company.monday.com/boards/9328303960/pulses/18070949162?notification=6971131519
    if (panel.panelCandidates.length < 1) {
      throw new BadRequestException(
        `Panel must have at least 1 candidates to be marked as ready`,
      );
    }

    await this.prisma.interview.deleteMany({
      where: {
        panel_id: panel.id,
      },
    });

    const candidateIds = panel.panelCandidates.map((pc) => pc.candidate_id);

    await this.prisma.ticket.updateMany({
      where: {
        type: 'interview',
        candidate_id: {
          in: candidateIds,
        },
        status: {
          in: ['new', 'in_progress'],
        },
        deleted_at: null,
      },
      data: {
        status: 'resolved',
      },
    });

    await this.prisma.panelCandidate.updateMany({
      where: {
        panel_id: panel.id,
      },
      data: {
        status: 'selected',
      },
    });

    const hireRequest = await this.prisma.hireRequest.update({
      where: {
        id: data.hireRequest_id,
      },
      data: {
        status: 'panel_ready',
      },
    });
    if (!hireRequest)
      throw new BadRequestException(`Hire request not updated to panel ready`);

    const panelUpdated = await this.prisma.candidatePanel.updateMany({
      where: {
        hire_request_id: data.hireRequest_id,
      },
      data: {
        readable: data.readable,
        scheduled_date: null,
        status: 'created',
      },
    });
    if (!panelUpdated)
      throw new BadRequestException(`Panel not updated to readable`);

    //Business logical changed on 2025-11-03 asked by Hanieh and did by Paulo
    const candidates = await this.prisma.candidate.findMany({
      where: { id: { in: candidateIds } },
      select: {
        id: true,
        hubspot_id: true,
        pipeline_status: true,
        pipeline_status_origin: true,
      },
    });
    candidates.forEach(async (c) => {
      const revertedPipelineStatus = c.pipeline_status_origin || c.pipeline_status;
      await this.prisma.candidate.update({
        where: { id: c.id },
        data: {
          pipeline_status: revertedPipelineStatus,
        },
      });
      await this.candidateAudit.log({
        candidateId: c.id,
        hubspotId: c.hubspot_id,
        actorUserId: user?.id ?? null,
        event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
        fieldGroup: CandidateAuditFieldGroup.pipeline_status,
        before: { pipeline_status: c.pipeline_status },
        after: { pipeline_status: revertedPipelineStatus },
        source: CandidateAuditSource.user,
      });
      await this.hubspot.updateOneCandidateFromHireRequest(
        c.hubspot_id,
        revertedPipelineStatus,
        user?.id,
        undefined,
        `Hire request ${data.hireRequest_id} marked as panel ready — candidate reverted to origin pipeline status`,
      );
    });

    try {
      const dataForHubspot = {
        hubspot_ticket_id: hireRequest.hubspot_ticket_id,
        hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
          (key) => HRTicketStatus[key] === 'Candidates Endorsed',
        ),
      };
      await this.hubspot.updateHireRequestInHubspot(
        dataForHubspot,
        undefined,
        user?.id,
        `Hire request ${data.hireRequest_id} panel marked as ready — candidates endorsed`,
      );
    } catch (err) {
      console.warn(
        '[hubspot] updateHireRequestInHubspot in Panel ready failed',
        err?.message || err,
      );
    }

    //Send email to the Sourcing Assignee that the panel is ready (non-blocking)
    try {
      const result = await this.notifications.notifyHireRequestPanelReady(
        data.hireRequest_id,
      );
      console.log(
        `[notifications] Hire request Panel Ready notification sent successfully:`,
        result,
      );
    } catch (err) {
      console.error(
        '[notifications] hire request Panel Ready failed',
        err?.message || err,
      );
    }

    //Send email to the client if the panel is marked as readable by the system or organization admin (non-blocking)
    if (data.readable) {
      try {
        const result = await this.notifications.notifyClientPanelReady(
          data.hireRequest_id,
        );
        console.log(
          `[notifications] Client Panel Ready notification sent successfully:`,
          result,
        );
      } catch (err) {
        console.error(
          '[notifications] client panel ready email failed',
          err?.message || err,
        );
      }
    }

    return this.findOne(data.hireRequest_id, user);
  }

  async getPanel(id: string, user: USER): Promise<returnGetPanelDto> {
    const result: any = {};
    if (!id) throw new BadRequestException('Hire request ID is required');
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );

    const hireRequest = await this.prisma.hireRequest.findUnique({
      where: {
        id: id,
        org_id: user.role.includes('organization')
          ? user.organization_id || undefined
          : undefined,
      },
    });
    if (!hireRequest) throw new NotFoundException(`Hire request not found`);

    const panel = await this.prisma.candidatePanel.findFirst({
      where: {
        hire_request_id: hireRequest.id,
      },
    });
    if (!panel)
      throw new NotFoundException(`Panel for this hire request not found`);
    result.hireRequest = hireRequest;
    result.panel = panel;

    const panelCandidates = await this.prisma.panelCandidate.findMany({
      where: {
        panel_id: panel.id,
      },
      include: {
        candidate: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            country: true,
            video_link: true,
            skills: {
              select: {
                skill_name: true,
              },
            },
            educations: {
              select: {
                institution: true,
                degree: true,
                year: true,
              },
            },
            experiences: {
              select: {
                company: true,
                position: true,
                responsabilities: true,
                end_date: true,
                start_date: true,
              },
            },
          },
        },
      },
    });
    if (!panelCandidates)
      throw new NotFoundException(`Panel candidates not found`);
    result.panelCandidates = panelCandidates;

    return result;
  }

  async getPanels(user: USER) {
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );

    /*select all hirerequests to show on the client page "My interview Panels"
    -awaiting_decision + readable = true
    -panel_ready
    */
    const panels = await this.prisma.candidatePanel.findMany({
      where: {
        AND: [
          {
            hireRequest: {
              org_id: user.organization_id || undefined,
            },
          },
          {
            hireRequest: {
              status: { not: HireRequestStatus.deleted },
            },
          },
          {
            OR: [
              //if is in awaiting_decision or placement_completed status, it should be retrieved
              {
                hireRequest: {
                  status: {
                    in: [
                      HireRequestStatus.awaiting_decision,
                      HireRequestStatus.placement_completed,
                    ],
                  },
                },
              },
              //if it was marked as readable by the system or organization admin, it should be retrieved
              {
                readable: true,
              },
              //if has at least one candidate created by organization user, it should be retrieved
              {
                panelCandidates: {
                  some: {
                    createdBy: {
                      role: {
                        in: user.role.includes('organization')
                          ? ['organization_admin', 'organization_super_admin']
                          : ['system_admin', 'system_super_admin'],
                      },
                    },
                  },
                },
              },
              //if the hireRequest was created by the client (organization), always show it regardless of readable
              {
                hireRequest: {
                  createdBy: {
                    role: {
                      in: ['organization_admin', 'organization_super_admin'],
                    },
                  },
                },
              },
            ],
          },
        ],
      },

      select: this.selectPanels,
    });

    const _pCfgs_E = await this.positionRateConfigService.findAllUnpaginated();
    const _cfgMap_E = buildConfigMap(_pCfgs_E);
    const _poolMap_E = await this.buildCandidatePoolMap(
      panels.flatMap((panel) => panel.panelCandidates.map((pc) => pc.candidate)),
    );

    const candidateSelectedInPanels = await this.buildCrossPanelSelectedMap();

    const result = panels.map((panel) => ({
      ...panel,
      interview_date: panel.interviews[0]?.scheduled_date || null,
      interview_link: panel.interviews[0]?.link || null,
      interviews: undefined,
      panelCandidates: panel.panelCandidates
        .filter((pc) => {
          if (
            !this.availablePipelineStatuses.includes(
              pc.candidate.pipeline_status,
            )
          )
            return false;
          const panelSet = candidateSelectedInPanels.get(pc.candidate.id);
          if (panelSet) {
            const onlyInCurrentPanel =
              panelSet.size === 1 && panelSet.has(panel.id);
            if (!onlyInCurrentPanel) return false;
          }
          return true;
        })
        .map((pc) => {
          const rates_E = computeCandidateRates(
            pc.candidate,
            _cfgMap_E,
            _poolMap_E.get(pc.candidate.business_unit ?? '') ?? 'medical',
          );
          return {
            ...pc,
            candidate: {
              ...pc.candidate,
              employment_type:
                changeLabelAvailability(
                  dbToStageDictionary[Number(pc.candidate.employment_type)],
                ) || pc.candidate.employment_type,
              ...rates_E,
              avatar: pc.candidate.avatar_url
                ? `${process.env.AVATAR_URL}${pc.candidate.avatar_url}`
                : null,
            },
          };
        }),
    }));

    return result;
  }

  async getPanelsByOrganization(user: USER) {
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );

    const panels = await this.prisma.candidatePanel.findMany({
      where: {
        hireRequest: {
          organization: {
            id: user.organization_id || undefined,
          },
        },
        OR: [
          {
            readable: true,
            status: 'decision_pending',
          },
          { status: 'interview_completed' },
          { status: 'interview_scheduled' },
          { status: 'created' },
        ],
      },
      select: {
        id: true,
        scheduled_date: true,
        status: true,
        panelCandidates: {
          select: {
            status: true,
            candidate: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                name: true,
                about_me: true,

                hourly_pay_rate: true,
                years_of_experience: true,
                country: true,
                specialization: true,
                employment_type: true,
                video_link: true,
                skills: {
                  select: {
                    id: true,
                    skill_name: true,
                    proficiency_level: true,
                    skill_type: true,
                  },
                },
                educations: {
                  orderBy: { year: 'desc' },
                  select: {
                    id: true,
                    degree: true,
                    institution: true,
                    year: true,
                  },
                },
                experiences: {
                  orderBy: { start_date: 'desc' },
                  select: {
                    id: true,
                    company: true,
                    position: true,
                    responsabilities: true,
                    start_date: true,
                    end_date: true,
                  },
                },
                languages: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
        interviews: {
          select: {
            scheduled_date: true,
          },
        },
        hireRequest: {
          select: {
            id: true,
            title: true,
            description: true,
            description_summary: true,
            summary_generated_at: true,
            status: true,
            priority: true,
            createdAt: true,
            availability: true,
            expected_start_date: true,
            salary_range_from: true,
            salary_range_to: true,
            specialization: true,
            location: true,
            assign_user_id: true,
            skills: {
              select: {
                skill_name: true,
                required_level: true,
              },
            },
          },
        },
      },
    });

    if (!panels || panels.length === 0)
      throw new NotFoundException(
        `Panels not found for this current organization`,
      );

    const result = panels.map((panel) => ({
      ...panel,
      interview_date: panel.interviews[0]?.scheduled_date || null,
      interviews: undefined,
      panelCandidates: panel.panelCandidates.map((pc) => {
        // Calculate years of experience from the earliest experience if not already set
        const validExperiences = pc.candidate.experiences.filter(
          (exp) => exp.start_date !== null,
        );
        const earliestExperience =
          validExperiences.length > 0
            ? validExperiences.sort(
                (a, b) =>
                  new Date(a.start_date!).getTime() -
                  new Date(b.start_date!).getTime(),
              )[0]
            : null;

        const calculatedYearsOfExperience = earliestExperience?.start_date
          ? new Date().getFullYear() -
            new Date(earliestExperience.start_date).getFullYear()
          : 0;

        return {
          ...pc,
          candidate: {
            ...pc.candidate,
            // Use the stored years_of_experience or calculate from experiences
            years_of_experience:
              pc.candidate.years_of_experience ?? calculatedYearsOfExperience,
            employment_type:
              changeLabelAvailability(
                dbToStageDictionary[Number(pc.candidate.employment_type)],
              ) || pc.candidate.employment_type,
          },
        };
      }),
    }));
    return result;
  }

  async scheduleInterview(id: string, data: scheduleInterviewDTO, user: USER) {
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );

    const verifyCandidates = await this.verifyUnavailableCandidates(id, user);
    if (verifyCandidates) {
      throw new BadRequestException(
        `Cannot move forward. All candidates are no longer available`,
      );
    }

    const hireRequest = await this.prisma.hireRequest.findUnique({
      where: {
        id: id,
        organization: user.role.includes('organization')
          ? { id: user.organization_id || undefined }
          : undefined,
      },
      select: {
        id: true,
        hubspot_ticket_id: true,
        createdBy: { select: { role: true } },
      },
    });
    if (!hireRequest) throw new NotFoundException(`Hire request not found`);

    if (
      isClientOriginatedRole(hireRequest.createdBy?.role) &&
      violatesMinLeadTime(data.date_time)
    ) {
      throw new BadRequestException(INTERVIEW_MIN_LEAD_ERROR);
    }

    const panel = await this.prisma.candidatePanel.findFirst({
      where: {
        hire_request_id: hireRequest.id,
      },
      select: {
        id: true,
        panelCandidates: {
          select: {
            candidate: {
              select: {
                id: true,
                pipeline_status: true,
                panelCandidates: { select: { status: true } },
              },
            },
          },
        },
      },
    });
    if (!panel)
      throw new NotFoundException(`Panel for this hire request not found`);

    this.assertNoHiredCandidatesInPanel(panel.panelCandidates);

    // Here, I'm using the date_time because I'll use the dateToTimestamp later
    // and this function should receive a date in the format YYYY-MM-DD
    const derivedDate = String(data.date_time).split('T')[0] || null;

    // Update fields hubspot_pairing_date and hubspot_pairing_time in hire request
    const updateHireRequest = await this.prisma.hireRequest.update({
      where: {
        id: hireRequest.id,
      },
      data: {
        hubspot_pairing_date: dateToTimestamp(derivedDate) || null,
        hubspot_pairing_time: data.time || null,
      },
    });
    if (!updateHireRequest)
      throw new BadRequestException(
        `Hire request pairing date and time not updated`,
      );

    // Treat date_time as UTC to avoid server timezone shift
    const dateTimeStr = String(data.date_time);
    const updatedDate = new Date(
      /Z$|[+-]\d{2}:\d{2}$/.test(dateTimeStr) ? dateTimeStr : `${dateTimeStr}Z`,
    );

    const interviewScheduled = await this.prisma.interview.create({
      data: {
        panel_id: panel.id,
        scheduled_date: updatedDate,
        link: data.interview_link,
        duration: 30, // default duration of 30 minutes
      },
    });
    if (!interviewScheduled)
      throw new BadRequestException(`Interview not scheduled`);

    const candidatePanelupdated = await this.prisma.candidatePanel.update({
      where: {
        id: panel.id,
      },
      data: {
        status: 'interview_scheduled',
      },
    });
    if (!candidatePanelupdated)
      throw new BadRequestException(
        `Candidate panel not updated to interview scheduled`,
      );

    //update hire request status to 'interview_scheduled'
    const hireRequestUpdated = await this.prisma.hireRequest.update({
      where: {
        id: hireRequest.id,
      },
      data: {
        status: 'interview_scheduled',
      },
    });
    if (!hireRequestUpdated)
      throw new BadRequestException(
        `Hire request status not updated to interview scheduled`,
      );

    try {
      const updateDateTime = {
        hubspot_ticket_id: hireRequest.hubspot_ticket_id,
        pairing_date: updatedDate.toISOString().split('T')[0],
        pairing_time: updatedDate.toTimeString().split(' ')[0],
        hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
          (key) => HRTicketStatus[key] === 'Candidates Interview Booked',
        ),
      };
      await this.hubspot.updateHireRequestInHubspot(
        updateDateTime,
        undefined,
        user?.id,
        `Interview scheduled for hire request — pairing date/time set`,
      );
    } catch (err) {
      console.error(
        '[hubspot] updateHireRequestInHubspot failed',
        err?.message || err,
      );
    }

    try {
      await this.notifications.notifyInterviewScheduled(hireRequest.id);
    } catch (err) {
      console.error(
        '[notifications] notifyInterviewScheduled email failed',
        err?.message || err,
      );
    }

    return this.findOne(id, user);
  }

  async editInterview(id: string, data: scheduleInterviewDTO, user: USER) {
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );

    const hireRequest = await this.prisma.hireRequest.findUnique({
      where: {
        id: id,
        organization: user.role.includes('organization')
          ? { id: user.organization_id || undefined }
          : undefined,
      },
      select: {
        id: true,
        hubspot_ticket_id: true,
        createdBy: { select: { role: true } },
      },
    });
    if (!hireRequest) throw new NotFoundException(`Hire request not found`);

    if (
      isClientOriginatedRole(hireRequest.createdBy?.role) &&
      violatesMinLeadTime(data.date_time)
    ) {
      throw new BadRequestException(INTERVIEW_MIN_LEAD_ERROR);
    }

    const panel = await this.prisma.candidatePanel.findFirst({
      where: {
        hire_request_id: hireRequest.id,
      },
      select: {
        id: true,
      },
    });
    if (!panel)
      throw new NotFoundException(`Panel for this hire request not found`);

    // Here, I'm using the date_time because I'll use the dateToTimestamp later
    // and this function should receive a date in the format YYYY-MM-DD
    const derivedDateEdit = String(data.date_time).split('T')[0] || null;

    // Update fields hubspot_pairing_date and hubspot_pairing_time in hire request
    const updateHireRequest = await this.prisma.hireRequest.update({
      where: {
        id: hireRequest.id,
      },
      data: {
        hubspot_pairing_date: dateToTimestamp(derivedDateEdit) || null,
        hubspot_pairing_time: data.time || null,
      },
    });
    if (!updateHireRequest)
      throw new BadRequestException(
        `Hire request pairing date and time not updated`,
      );

    // Treat date_time as UTC to avoid server timezone shift
    const dateTimeStrEdit = String(data.date_time);
    const updatedDate = new Date(
      /Z$|[+-]\d{2}:\d{2}$/.test(dateTimeStrEdit)
        ? dateTimeStrEdit
        : `${dateTimeStrEdit}Z`,
    );
    const editInterview = await this.prisma.interview.updateMany({
      where: {
        panel_id: panel.id,
      },
      data: {
        scheduled_date: updatedDate,
        link: data.interview_link,
      },
    });

    if (!editInterview) throw new BadRequestException(`Interview not updated`);

    try {
      const updateDateTime = {
        hubspot_ticket_id: hireRequest.hubspot_ticket_id,
        pairing_date: updatedDate.toISOString().split('T')[0],
        pairing_time: updatedDate.toTimeString().split(' ')[0],
      };
      await this.hubspot.updateHireRequestInHubspot(
        updateDateTime,
        undefined,
        user?.id,
        `Interview rescheduled for hire request — pairing date/time updated`,
      );
    } catch (err) {
      console.error(
        '[hubspot] updateHireRequestInHubspot failed',
        err?.message || err,
      );
    }

    try {
      await this.notifications.notifyInterviewScheduled(hireRequest.id);
    } catch (err) {
      console.error(
        '[notifications] notifyInterviewScheduled email failed',
        err?.message || err,
      );
    }

    return this.findOne(id, user);
  }

  async awaitingDecision(
    id: string,
    data: awaitingDecisionDTO,
    user: USER,
  ): Promise<boolean> {
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );

    const verifyCandidates = await this.verifyUnavailableCandidates(id, user);
    if (verifyCandidates) {
      throw new BadRequestException(
        `Cannot move forward. All candidates are no longer available`,
      );
    }

    const hireRequest = await this.prisma.hireRequest.findUnique({
      where: {
        id: id,
        organization: user.role.includes('organization')
          ? { id: user.organization_id || undefined }
          : undefined,
      },
      select: {
        id: true,
        hubspot_ticket_id: true,
      },
    });
    if (!hireRequest) throw new NotFoundException(`Hire request not found`);

    //check if panel exists
    const panelExists = await this.prisma.candidatePanel.findFirst({
      where: {
        hire_request_id: hireRequest.id,
      },
      select: {
        id: true,
        panelCandidates: {
          select: {
            candidate: {
              select: {
                id: true,
                hubspot_id: true,
                pipeline_status: true,
                pipeline_status_origin: true,
                panelCandidates: { select: { status: true } },
              },
            },
          },
        },
      },
    });
    if (!panelExists)
      throw new NotFoundException(`Panel for this hire request not found`);

    this.assertNoHiredCandidatesInPanel(panelExists.panelCandidates);

    const updatedDate = new Date(`${data.date_time}`);

    const hireRequestUpdated = await this.prisma.candidatePanel.update({
      where: {
        id: panelExists.id,
      },
      data: {
        status: 'decision_pending',
        scheduled_date: updatedDate,
      },
    });
    if (!hireRequestUpdated)
      throw new BadRequestException(`Panel not updated to decision_pending`);

    //update hire request status to 'awaiting_decision'
    const candidates = panelExists.panelCandidates.map((pc) => pc.candidate);
    const hireRequestStatusUpdated = await this.prisma.hireRequest.update({
      where: {
        id: hireRequest.id,
      },
      data: {
        status: 'awaiting_decision',
      },
    });
    if (!hireRequestStatusUpdated)
      throw new BadRequestException(
        `Hire request status not updated to awaiting decision`,
      );

    //Business logical changed on 2025-11-03 asked by Hanieh and did by Paulo
    const pipelineStatus = Object.keys(dbToStageDictionary).find((key) => {
      return dbToStageDictionary[key] === 'Endorsed via Platform';
    });
    if (!pipelineStatus)
      throw new BadRequestException(`Pipeline status mapping not found`);

    //update candidate as 'blocked' on Panel
    const panelCandidatesUpdated = await this.prisma.panelCandidate.updateMany({
      where: {
        panel_id: panelExists.id,
      },
      data: {
        status: 'blocked',
      },
    });

    const hubspotUpdated =
      await this.hubspot.updateManyCandidatesFromHireRequest(
        candidates,
        pipelineStatus,
        user?.id,
        hireRequest.id,
        `Hire request ${hireRequest.id} moved to awaiting decision — candidates blocked as Endorsed via Platform`,
      );

    try {
      const dataForHubspot = {
        hubspot_ticket_id: hireRequest.hubspot_ticket_id,
        hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
          (key) => HRTicketStatus[key] === 'Interview Done (For Follow-up)',
        ),
      };
      const hrTicket = await this.hubspot.updateHireRequestInHubspot(
        dataForHubspot,
        undefined,
        user?.id,
        `Hire request ${hireRequest.id} moved to awaiting decision`,
      );
    } catch (err) {
      console.warn(
        '[hubspot] updateHireRequestInHubspot in Awaiting decision failed',
        err?.message || err,
      );
    }

    // Fire awaiting decision notification to organization admins (non-blocking)
    try {
      await this.notifications.notifyHireRequestAwaitingDecision(
        hireRequest.id,
      );
    } catch (err) {
      console.warn(
        '[notifications] awaiting-decision email failed',
        err?.message || err,
      );
    }

    return this.findOne(id, user);
  }

  async allowMoreTime(
    id: string,
    data: awaitingDecisionDTO,
    user: USER,
  ): Promise<boolean> {
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );

    const hireRequest = await this.prisma.hireRequest.findUnique({
      where: {
        id: id,
        organization: user.role.includes('organization')
          ? { id: user.organization_id || undefined }
          : undefined,
      },
      select: {
        id: true,
      },
    });
    if (!hireRequest) throw new NotFoundException(`Hire request not found`);

    //check if panel exists
    const panelExists = await this.prisma.candidatePanel.findFirst({
      where: {
        hire_request_id: hireRequest.id,
      },
      select: {
        id: true,
      },
    });
    if (!panelExists)
      throw new NotFoundException(`Panel for this hire request not found`);

    const updatedDate = new Date(`${data.date_time}`);

    const panelUpdated = await this.prisma.candidatePanel.update({
      where: {
        id: panelExists.id,
      },
      data: {
        scheduled_date: updatedDate,
      },
    });
    if (!panelUpdated)
      throw new BadRequestException(`Panel not updated to allow more time`);

    return this.findOne(id, user);
  }

  async changeWinner(
    id: string,
    data: changeWinnerDTO,
    user: USER,
  ): Promise<any> {
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException(
        'User not found or not part of an organization',
      );

    const pipelineStatus = Object.keys(dbToStageDictionary).find((key) => {
      return dbToStageDictionary[key] === 'Endorsed via Platform';
    });
    if (!pipelineStatus)
      throw new NotFoundException(`Pipeline status not found for Hired`);

    const pipelineStatusLosers = Object.keys(dbToStageDictionary).find(
      (key) => {
        return dbToStageDictionary[key] === 'Available Candidates';
      },
    );
    if (!pipelineStatusLosers)
      throw new NotFoundException(
        `Pipeline status not found for Available Candidates`,
      );

    const pipelineStatusHired = Object.keys(dbToStageDictionary).find(
      (key) => dbToStageDictionary[key] === 'Hired',
    );

    const hireRequest = await this.prisma.hireRequest.findUnique({
      where: {
        id: id,
        organization: user.role.includes('organization')
          ? { id: user.organization_id || undefined }
          : undefined,
      },
      select: {
        id: true,
        hubspot_ticket_id: true,
      },
    });
    if (!hireRequest) throw new NotFoundException(`Hire request not found`);

    //check if panel exists
    const panelId = await this.prisma.candidatePanel.findFirst({
      where: { hire_request_id: hireRequest.id },
      select: { id: true },
    });
    if (!panelId)
      throw new NotFoundException(`Panel for this hire request not found`);

    const panelExists = await this.prisma.candidatePanel.findUnique({
      where: { id: panelId.id },
      select: {
        id: true,
        panelCandidates: {
          select: {
            candidate: {
              select: {
                id: true,
                pipeline_status: true,
                // Only check other panels — a candidate selected on THIS panel
                // is the winner being replaced, not a blocker.
                panelCandidates: {
                  where: { panel_id: { not: panelId.id } },
                  select: { status: true },
                },
              },
            },
          },
        },
      },
    });
    if (!panelExists)
      throw new NotFoundException(`Panel for this hire request not found`);

    this.assertNoHiredCandidatesInPanel(panelExists.panelCandidates);

    //check if winner exists inside the panel
    const winnerExists = await this.prisma.panelCandidate.findMany({
      where: {
        panel_id: panelExists.id,
        candidate_id: { in: data.winner_id },
      },
      select: {
        id: true,
        candidate_id: true,
        candidate: {
          select: {
            hubspot_id: true,
            pipeline_status: true,
          },
        },
      },
    });
    if (!winnerExists)
      throw new NotFoundException(`Winner candidate not found in the panel`);

    const loserExists = await this.prisma.panelCandidate.findMany({
      where: {
        panel_id: panelExists.id,
        NOT: {
          candidate_id: { in: data.winner_id },
        },
      },
      select: {
        id: true,
        candidate: {
          select: {
            id: true,
            hubspot_id: true,
            pipeline_status: true,
            pipeline_status_origin: true,
            panelCandidates: {
              where: {
                panel_id: { not: panelExists.id },
              },
              select: {
                status: true,
              },
            },
          },
        },
      },
    });
    //removed asked by Pauli because right now we can have just one candidate in the panel
    //if(!loserExists || loserExists.length === 0) throw new NotFoundException(`No other candidates found in the panel`);

    //change Panel status
    const panelUpdated = await this.prisma.candidatePanel.update({
      where: {
        id: panelExists.id,
      },
      data: {
        status: 'decision_made',
        decided_date: new Date(),
      },
    });
    if (!panelUpdated)
      throw new BadRequestException(`Panel not updated to decision made`);

    //change status of hire request to 'placement_completed'
    const hireRequestUpdated = await this.prisma.hireRequest.update({
      where: {
        id: hireRequest.id,
      },
      data: {
        status: 'placement_completed',
      },
    });
    if (!hireRequestUpdated)
      throw new BadRequestException(
        `Hire request not updated to placement completed`,
      );

    //update the winner candidate as selected_by_client
    const winner = await this.prisma.panelCandidate.updateMany({
      where: {
        panel_id: panelExists.id,
        candidate_id: { in: data.winner_id },
      },
      data: {
        status: 'selected_by_client',
      },
    });
    if (!winner)
      throw new BadRequestException(`Panel not updated to reset winners`);

    //update all other candidates as not_selected
    const others = await this.prisma.panelCandidate.updateMany({
      where: {
        panel_id: panelExists.id,
        NOT: {
          candidate_id: { in: data.winner_id },
        },
      },
      data: {
        status: 'returned_to_pool',
      },
    });
    if (!others)
      throw new BadRequestException(
        `Panel not updated to set other candidates as not selected`,
      );

    if (loserExists) {
      //update losers to 'available candidates' on database
      await Promise.all(
        loserExists.map(async (loser) => {
          const c = loser.candidate;

          // Only return to pool if the candidate is NOT in another active panel.
          // If they exist in another panel with any status other than 'returned_to_pool' or 'selected', keep their current pipeline_status.
          const canUpdate = c.panelCandidates.every((pc) =>
            ['returned_to_pool', 'selected'].includes(pc.status),
          );
          if (!canUpdate) return;

          const pipeline_treated =
            c.pipeline_status_origin || pipelineStatusLosers;
          await this.prisma.candidate.update({
            where: { id: c.id },
            data: { pipeline_status: pipeline_treated },
          });
          await this.candidateAudit.log({
            candidateId: c.id,
            hubspotId: c.hubspot_id,
            actorUserId: user?.id ?? null,
            event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
            fieldGroup: CandidateAuditFieldGroup.pipeline_status,
            before: { pipeline_status: c.pipeline_status },
            after: { pipeline_status: pipeline_treated },
            source: CandidateAuditSource.user,
          });
          await this.hubspot.updateOneCandidateFromHireRequest(
            c.hubspot_id,
            pipeline_treated,
            user?.id,
            undefined,
            `Hire request ${hireRequest.id} — winner selected, non-selected candidate returned to available status`,
          );
        }),
      );
    }

    if (winnerExists) {
      await Promise.all(
        winnerExists.map(async (c) => {
          // if the candidate is already marked as hired, skip updating to avoid conflicts
          if (c.candidate.pipeline_status === pipelineStatusHired) return;

          const previousPipelineStatus = c.candidate.pipeline_status;
          await this.prisma.candidate.update({
            where: { id: c.candidate_id },
            data: { pipeline_status: pipelineStatus },
          });
          await this.candidateAudit.log({
            candidateId: c.candidate_id,
            hubspotId: c.candidate.hubspot_id,
            actorUserId: user?.id ?? null,
            event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
            fieldGroup: CandidateAuditFieldGroup.pipeline_status,
            before: { pipeline_status: previousPipelineStatus },
            after: { pipeline_status: pipelineStatus },
            source: CandidateAuditSource.user,
          });
          await this.hubspot.updateOneCandidateFromHireRequest(
            c.candidate.hubspot_id,
            pipelineStatus,
            user?.id,
            undefined,
            `Hire request ${hireRequest.id} — candidate selected as winner and set to Endorsed via Platform`,
          );
          await this.offerPanelsService.removeCandidateFromAllPanels(
            c.candidate_id,
          );
        }),
      );
    }

    //removed by requested Pauli: https://regenta-company.monday.com/boards/9328303960/pulses/18069150933?notification=6971532371
    //change the Candidate pipeline status to 'Hired' and send it for the hubspot
    /*const candidateUpdated = await this.prisma.candidate.update({
      where: {
        id: data.winner_id,
      },
      data: {
        pipeline_status: pipelineStatus,
      },
    });
    if (!candidateUpdated) throw new BadRequestException(`Candidate not updated to endorsed`);
    

    
    try{
      //communication with hubspot to update status hired can be added here
      await this.hubspot.updateOneCandidateFromHireRequest(candidateUpdated.hubspot_id, pipelineStatus, user?.id);
    
    }catch (error) {
      console.error('Error updating candidate in HubSpot:', error);
      throw new BadRequestException(`Error updating candidate in HubSpot`);
    }
    */

    //update hire request in hubspot to 'For Onboarding (Paired)'
    const dataForHubspot = {
      hubspot_ticket_id: hireRequest.hubspot_ticket_id,
      hubspot_pipeline_stage: Object.keys(HRTicketStatus).find(
        (key) => HRTicketStatus[key] === 'For Onboarding (Paired)',
      ),
    };
    await this.hubspot.updateHireRequestInHubspot(
      dataForHubspot,
      undefined,
      user?.id,
      `Hire request ${hireRequest.id} — winner selected, placement completed`,
    );

    //Update closed_date in hubspot
    await this.hubspot.updateHireRequestInHubspot(
      dataForHubspot,
      'closed_date',
      user?.id,
      `Hire request ${hireRequest.id} — closed_date synced after winner selection`,
    );

    // Fire placement completed notification (non-blocking)
    try {
      await this.notifications.notifyHireRequestPlacementCompleted(
        hireRequest.id,
      ); //without second parameter to get all winner candidates
    } catch (err) {
      console.warn(
        '[notifications] placement-completed email failed',
        err?.message || err,
      );
    }

    // =========== return object requested by Lucas

    const panels = await this.prisma.candidatePanel.findMany({
      where: {
        id: panelExists.id,
      },
      select: this.selectPanels,
    });

    if (!panels || panels.length === 0)
      throw new NotFoundException(
        `Panels not found for this current organization`,
      );

    const _pCfgs_F = await this.positionRateConfigService.findAllUnpaginated();
    const _cfgMap_F = buildConfigMap(_pCfgs_F);
    const _poolMap_F = await this.buildCandidatePoolMap(
      panels.flatMap((panel) => panel.panelCandidates.map((pc) => pc.candidate)),
    );

    const result = panels.map((panel) => ({
      ...panel,
      panelCandidates: panel.panelCandidates.map((pc) => {
        const startDate = pc.candidate.experiences[0]?.start_date;
        const years_of_experience = startDate
          ? new Date().getFullYear() - new Date(startDate).getFullYear()
          : 0;
        const rates_F = computeCandidateRates(
          pc.candidate,
          _cfgMap_F,
          _poolMap_F.get(pc.candidate.business_unit ?? '') ?? 'medical',
        );
        return {
          ...pc,
          candidate: {
            ...pc.candidate,
            years_of_experience,
            ...rates_F,
            avatar: pc.candidate.avatar_url
              ? `${process.env.AVATAR_URL}${pc.candidate.avatar_url}`
              : null,
          },
        };
      }),
    }));

    return result;
  }

  async showMatchHireRequests(candidateId: string): Promise<any> {
    const candidate = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: {
        skills: true,
        panelCandidates: true,
      },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');

    const candidateSkills = candidate.skills.map((s) => s.skill_name);

    const hireRequests = await this.prisma.hireRequest.findMany({
      where: { status: 'sourcing' },
      include: {
        skills: true,
        panels: {
          include: {
            panelCandidates: true,
          },
        },
      },
    });

    const validHireRequests = hireRequests.filter((hr) =>
      hr.panels.every((panel) => panel.panelCandidates.length < 5),
    );

    const scoredHireRequests = validHireRequests.map((hr) => {
      let score = 0;

      if (hr.specialization && candidate.specialization === hr.specialization)
        score += 1;

      if (hr.location && candidate.country === hr.location) score += 1;

      if (hr.availability && candidate.employment_type === hr.availability)
        score += 1;

      const hourly_from = hr.salary_range_from
        ? findHourlyPerRate(Number(hr.salary_range_from))
        : undefined;
      const hourly_to = hr.salary_range_to
        ? findHourlyPerRate(Number(hr.salary_range_to))
        : undefined;

      if (
        candidate.hourly_pay_rate !== null &&
        hourly_from !== undefined &&
        hourly_to !== undefined &&
        candidate.hourly_pay_rate.toNumber() >= hourly_from &&
        candidate.hourly_pay_rate.toNumber() <= hourly_to
      )
        score += 1;

      const requiredSkills = hr.skills.map((s) => s.skill_name);
      const matchedSkills = candidateSkills.filter((skill) =>
        requiredSkills.includes(skill),
      );
      score += matchedSkills.length;

      return {
        ...hr,
        matchedSkills,
        score,
      };
    });

    scoredHireRequests.sort((a, b) => b.score - a.score);
    return scoredHireRequests;
  }

  async getAvailableCandidatesForSelection(
    hireRequestId: string,
    user: USER,
  ): Promise<any> {
    const availableCandidatesCacheKey = `${this.keyPrefix}available-candidates:${hireRequestId}`;
    const cachedResult = await this.redisGet(availableCandidatesCacheKey);
    if (cachedResult) {
      return JSON.parse(cachedResult);
    }

    const hireRequest = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        org_id: true,
        assign_user_id: true,
      },
    });

    if (!hireRequest) {
      throw new NotFoundException('Hire request not found');
    }

    if (user.role.includes('organization')) {
      if (
        !user.organization_id ||
        user.organization_id !== hireRequest.org_id
      ) {
        throw new NotFoundException('Hire request not found');
      }
    } else if (user.role.includes('system')) {
    } else {
      throw new NotFoundException('Hire request not found');
    }

    const panel = await this.prisma.candidatePanel.findFirst({
      where: {
        hire_request_id: hireRequestId,
      },
      include: {
        panelCandidates: {
          include: {
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
                pipeline_status: true,
                hourly_pay_rate: true,
                years_of_experience: true,
                avatar_url: true,
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
                approved_positions_pairing: true,
                business_unit: true,
              },
            },
          },
        },
      },
    });

    if (!panel) {
      throw new NotFoundException('Panel for this hire request not found');
    }

    let unavailableCandidates: Record<string, any>[] = [];

    const panelCandidates = panel.panelCandidates;

    const filteredCandidates = panelCandidates.filter((pc) =>
      this.availablePipelineStatuses.includes(pc.candidate.pipeline_status),
    );

    unavailableCandidates = panelCandidates
      .filter(
        (pc) =>
          !this.availablePipelineStatuses.includes(
            pc.candidate.pipeline_status,
          ),
      )
      .map((pc) => ({
        ...pc.candidate,
        reason: 'Candidate is no longer available in Hubspot',
      }));

    const crossPanelMap = await this.buildCrossPanelSelectedMap();

    const availableCandidates = filteredCandidates.filter((pc) => {
      const panelMap = crossPanelMap.get(pc.candidate.id);
      if (!panelMap) return true;
      const otherPanelEntry = [...panelMap.entries()].find(
        ([panelId]) => panelId !== pc.panel_id,
      );
      if (otherPanelEntry) {
        unavailableCandidates.push({
          ...pc.candidate,
          reason: `Candidate is already selected in panel: ${otherPanelEntry[1]}`,
        });
        return false;
      }
      return true;
    });

    const selectedCandidate = panelCandidates.find(
      (pc) => pc.status === 'selected_by_client',
    );

    if (
      availableCandidates.length === 1 &&
      selectedCandidate &&
      availableCandidates[0].candidate.id === selectedCandidate.candidate_id
    ) {
      const emptyResult: any[] = [];
      await this.redisSet(
        availableCandidatesCacheKey,
        JSON.stringify(emptyResult),
        { EX: 300 },
      );
      return emptyResult;
    }

    const _pCfgs_G = await this.positionRateConfigService.findAllUnpaginated();
    const _cfgMap_G = buildConfigMap(_pCfgs_G);
    const _poolMap_G = await this.buildCandidatePoolMap(
      availableCandidates.map((pc) => pc.candidate),
    );

    const mappedCandidates = availableCandidates.map((pc) => {
      const rates_G = computeCandidateRates(
        pc.candidate,
        _cfgMap_G,
        _poolMap_G.get(pc.candidate.business_unit ?? '') ?? 'medical',
      );
      return {
        ...pc.candidate,
        panelStatus: pc.status,
        panelId: panel.id,
        panelScheduledDate: panel.scheduled_date,
        isCurrentSelection: selectedCandidate
          ? pc.candidate.id === selectedCandidate.candidate_id
          : false,
        ...rates_G,
        approved_positions_pairing:
          pc.candidate.approved_positions_pairing?.map(
            getApprovedPositionLabel,
          ) || [],
        avatar: pc.candidate.avatar_url
          ? `${process.env.AVATAR_URL}${pc.candidate.avatar_url}`
          : null,
        employment_type:
          changeLabelAvailability(
            dbToStageDictionary[Number(pc.candidate.employment_type)],
          ) || pc.candidate.employment_type,
      };
    });

    //Here I dont need to delivery a mappedObject because it'll be only showed on frontend
    const mappedUnavailableCandidates = unavailableCandidates.map((c) => ({
      ...c,
      panelId: panel.id,
      panelScheduledDate: panel.scheduled_date,
    }));

    const result = {
      availableCandidates: mappedCandidates,
      unavailableCandidates: mappedUnavailableCandidates,
    };

    await this.redisSet(
      availableCandidatesCacheKey,
      JSON.stringify(result),
      { EX: 300 },
    );

    return result;
  }

  async getVATypes(): Promise<any> {
    try {
      const url = 'https://api.hubapi.com/crm/v3/properties/tickets';
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      const vaTypeProperty = response.data.results.find(
        (prop) => prop.name === 'va_type',
      );

      //filter only options that doesnt have 'do not use' in the label
      if (vaTypeProperty) {
        vaTypeProperty.options = vaTypeProperty.options.filter(
          (option) => !option.label.toLowerCase().includes('do not use'),
        );
      }

      if (!vaTypeProperty) {
        return [];
      }

      return vaTypeProperty.options || [];
    } catch (error) {
      console.error(
        'Failed to find types:',
        error.response?.data || error.message,
      );
      throw new Error('Failed to find VA types');
    }
  }

  async getVAShiftHours(): Promise<any> {
    try {
      const url = 'https://api.hubapi.com/crm/v3/properties/tickets';
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      const vaTypeProperty = response.data.results.find(
        (prop) => prop.name === 'va_shift_hours',
      );

      if (!vaTypeProperty) {
        return [];
      }

      return vaTypeProperty.options || [];
    } catch (error) {
      console.error(
        'Failed to find Shift Hours:',
        error.response?.data || error.message,
      );
      throw new Error('Failed to find VA Shift Hours');
    }
  }

  async getPairingRequestType(): Promise<any> {
    try {
      const url = 'https://api.hubapi.com/crm/v3/properties/tickets';
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      const vaTypeProperty = response.data.results.find(
        (prop) => prop.name === 'pairing_request_type',
      );

      if (!vaTypeProperty) {
        return [];
      }

      return vaTypeProperty.options || [];
    } catch (error) {
      console.error(
        'Failed to find Pairing Request Type:',
        error.response?.data || error.message,
      );
      throw new Error('Failed to find Pairing Request Type');
    }
  }

  async getCancelReasonOptions(): Promise<any> {
    try {
      const url = 'https://api.hubapi.com/crm/v3/properties/tickets';
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      const vaTypeProperty = response.data.results.find(
        (prop) => prop.name === 'cancel_reason',
      );

      if (!vaTypeProperty) {
        return [];
      }

      return vaTypeProperty.options || [];
    } catch (error) {
      console.error(
        'Failed to find Cancel Reason:',
        error.response?.data || error.message,
      );
      throw new Error('Failed to find Cancel Reason');
    }
  }

  async getPairingSessionOutcomeReasonOptions(): Promise<any> {
    try {
      const url = 'https://api.hubapi.com/crm/v3/properties/tickets';
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      const vaTypeProperty = response.data.results.find(
        (prop) => prop.name === 'pairing_outcome_reason',
      );

      if (!vaTypeProperty) {
        return [];
      }

      return vaTypeProperty.options || [];
    } catch (error) {
      console.error(
        'Failed to find Pairing Session Outcome Reason:',
        error.response?.data || error.message,
      );
      throw new Error('Failed to find Pairing Session Outcome Reason');
    }
  }
}
