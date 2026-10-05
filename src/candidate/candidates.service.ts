import {
  BadGatewayException,
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  HireRequestStatus,
  PanelStatus,
  Prisma,
  ProcessingStatus,
  USER,
} from '@prisma/client';
import * as path from 'path';
import * as fs from 'fs';

import { isInClientOpenPanel } from '../common/constant/panel-availability.constant';
import {
  dbToStageDictionary,
  stageToDbDictionary,
} from '../common/dictionaries/stage-dictionary';
import { PrismaService } from '../prisma/prisma.service';
import {
  changeLabelAvailability,
  extractDriveFileId,
} from '../common/utils/hubspot.util';
import { parseQueryList } from '../common/utils/query.util';
import { GoogledriveService } from '../googledrive/googledrive.service';
import { S3Service } from '../s3/s3.service';
import { OpenaiService } from '../openai/openai.service';
import { UpdateCandidateDto } from './dto/update-candidate.dto';
import { updateStatusHubspotDTO } from './dto/updateStatus-candidate.dto';
import axios from 'axios';
import { EndorseCandidateDto } from './dto/endorse-candidate.dto';
import { HubspotService } from '../hubspot/hubspot.service';
import { MailService } from '../mail/mail.service';
import { HireRequestService } from '../hire-request/hire-request.service';
import {
  buildConfigMap,
  computeCandidateRates,
  findHourlyPerRate,
  CandidatePool,
} from '../common/utils/salary.util';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import { RemoveCandidateDto } from './dto/remove-candidate.dto';
import { RemoveCandidateAndCancelDto } from './dto/remove-candidate-and-cancel.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { latinAmericaCountries } from '../common/constant/latin-america-countries';
import { getApprovedPositionLabel } from '../common/dictionaries/approved-positions-pairing-dictionary';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import {
  CANDIDATE_AUDIT_EVENTS,
  CandidateAuditService,
} from './candidate-audit.service';
import { CandidateAuditFieldGroup, CandidateAuditSource } from '@prisma/client';
import { isClientOriginatedRole } from '../common/utils/interview-schedule-window';
import {
  violatesPanelCandidateMinLead,
  PANEL_CANDIDATE_MIN_LEAD_ERROR,
} from '../common/utils/panel-candidate-lead-time';

const NON_MEDICAL_POOL = 'non_medical';

// Filter-option fields served from the HubSpot properties API rather than the
// database. getProperties() must not run its generic `distinct` query for these:
// the result would be discarded and overwritten by the HubSpot response below.
const HUBSPOT_SOURCED_PROPERTY_FIELDS = new Set([
  'specialization',
  'shift_block',
  'tools',
  'medical_tools',
]);

// Deactivated in favor of the new Core Skills filter (CORE_SKILLS_FIELDS
// below). Kept as reference/rollback — the underlying data/sync is untouched,
// only the `scorecard_fields` filter/endpoint param was disabled.
// const VA_SCORECARD_FIELDS = new Set([
//   'active_listening_and_comprehension_demonstrated',
//   'adaptability_to_different_client_personalities_and_workflows',
//   'can_articulate_experience_clearly_to_clients',
//   'can_multitask_between_systems_or_windows_efficiently',
//   'client_readiness___fit_evaluator_notes',
//   'comfortable_with_basic_tools__google_workspace__zoom__ehr_software_',
//   'comfortable_with_camera_on_setup',
//   'communication_skills_evaluator_notes',
//   'confident_on_video_and_phone_calls',
//   'cultural_alignment_with_us_healthcare_environment',
//   'demonstrates_problem_solving_and_tech_adaptability',
//   'demonstrates_stability_and_commitment',
//   'demonstrates_understanding_of_medical_terminology_and_procedures',
//   'exhibits_confidence_and_empathy_in_roleplay_scenarios',
//   'familiarity_with_emr_ehr_systems__kareo__athena__eclinicalworks__etc__',
//   'for_bilinguals__fluent_and_accurate_in_both_english_and_spanish',
//   'grammar__vocabulary__and_tone_are_appropriate_for_us_clients',
//   'handles_feedback_constructively',
//   'has_functioning_headset__webcam__and_backup_device',
//   'knowledge_of_hipaa_compliance_and_confidentiality',
//   'medical_knowledge_evaluator_notes',
//   'no_medical_industry_experience',
//   'positive_attitude_and_professional_demeanor',
//   'prior_experience_in_healthcare_or_medical_va_roles',
//   'professionalism___work_readiness_evaluator_notes',
//   'punctual_and_responsive_during_recruitment_stages',
//   'remote_work_discipline_and_time_management',
//   'speaks_clearly_and_professionally',
//   'stable_internet_connection__min__20_mbps_',
//   'technical_competence_evaluator_notes',
//   'tier_level',
//   'total_points',
//   'understands_workflow_in_medical_offices___telehealth_environments',
// ]);

// System-role-only Core Skills filter (`core_skills_fields` query param).
// Mirrors the 6 HubSpot VA Score Card extended sections (Bookkeeping,
// Medical/Dental Admin, Medical/Dental Biller, Sales Executive, SDR, Sales &
// Account Manager). Values are compared with EXACT equality (not "≥"), and
// role-gated to system_admin/system_super_admin in findAll/findAllForAlliance.
const CORE_SKILLS_FIELDS = new Set([
  // Bookkeeping Core Skills
  'quickbooks',
  'other_accounting_software',
  'chart_of_accounts_setup___maintenance',
  'transaction_categorization',
  'bank__credit_card_reconciliations',
  'accounts_payable_ap',
  'accounts_receivable_ar',
  'payroll_posting__reconciliation_not_processing_unless_required',
  'payroll_posting',
  'monthend_close',
  'journal_entries__adjustments',
  'balance_sheet',
  'pl',
  'accrual_vs_cash_understanding',
  'prepare_books_for_cpatax_handoff',
  'client_communication',
  'account_reconciliation',
  'financial_analysis',
  'financial_reporting',
  // Medical/Dental Core Skills (Admin)
  'patient_scheduling__calendar_management',
  'insurance_verification_eligibility__benefits',
  'prior_authorizations__referrals',
  'inbound_call_handling__patient_support',
  'outbound_calls_recalls_noshows_followups',
  'emrehr_data_entry__chart_updating',
  'patient_intake__demographics_documentation_accuracy',
  'referrals_sending_receiving_tracking',
  // Medical/Dental Core Skills (Biller) — rating (0-10) fields only; the
  // non-rating fields (role_type, patient_phone_communication, etc.) are
  // synced/read but intentionally excluded from this filter set.
  'cpt__icd10_coding',
  'charge_entry',
  'claim_generation',
  'claim_submission',
  'denial_management',
  'insurance_followup',
  'ar_management',
  'payment_posting',
  'identifying_underpayments',
  // Sales Core Skills (Sales Executive)
  'consultative_selling',
  'fullcycle_sales',
  'objection_handling__negotiation',
  'virtual_demos__presentations',
  'pipeline_management',
  'closing_sales',
  // Sales Core Skills (SDR)
  'lead_research__qualification',
  'crm_proficiency',
  'outbound_prospecting_emaillvcalls',
  'cold_calling',
  'appointment_setting',
  'kpi_awareness__tracking',
  // Sales Core Skills (Sales & Account Manager)
  'client_relationship_management',
  'retention_strategy',
  'upsell__crosssell',
  'account_onboarding',
  'issue_resolution',
  // Medical/Dental Core Skills (Biller) — non-rating fields. HubSpot types
  // these as booleancheckbox/select/number rather than a 0-10 rating, but the
  // filter mechanism is identical (exact string equality), so they share this
  // Set. `notes_*` fields are the only Core Skills properties intentionally
  // excluded from filtering (free text). See docs/hubspot-core-skills-fields.md.
  'n2_years_healthcare_billing_experience',
  'total_years_on_healthcare_billing_experience',
  'patient_phone_communication',
  'role_type',
  'insurance_verification_knowledge',
  'prior_authorizations_experience',
]);

// All ~92 Core Skills properties synced from HubSpot (superset of
// CORE_SKILLS_FIELDS above — also includes gates, totals, notes and the
// non-rating fields that are read-only/sync-only in this first entry).
const CORE_SKILLS_SYNC_FIELDS = [
  // Bookkeeping Core Skills (gate: bookkeeping)
  'quickbooks',
  'other_accounting_software',
  'chart_of_accounts_setup___maintenance',
  'transaction_categorization',
  'bank__credit_card_reconciliations',
  'accounts_payable_ap',
  'accounts_receivable_ar',
  'payroll_posting__reconciliation_not_processing_unless_required',
  'payroll_posting',
  'monthend_close',
  'journal_entries__adjustments',
  'balance_sheet',
  'pl',
  'accrual_vs_cash_understanding',
  'prepare_books_for_cpatax_handoff',
  'client_communication',
  'account_reconciliation',
  'financial_analysis',
  'financial_reporting',
  'total_score_bookkeeping',
  'notes_bookkeeping',
  // Medical/Dental Core Skills (Admin) (gate: medical__dental_admin)
  'patient_scheduling__calendar_management',
  'insurance_verification_eligibility__benefits',
  'prior_authorizations__referrals',
  'inbound_call_handling__patient_support',
  'outbound_calls_recalls_noshows_followups',
  'emrehr_data_entry__chart_updating',
  'patient_intake__demographics_documentation_accuracy',
  'referrals_sending_receiving_tracking',
  'total_score_medical__dental_admin',
  'notes_medical__dental_admin',
  // Medical/Dental Core Skills (Biller) (gate: medical__dental_biller)
  'n2_years_healthcare_billing_experience',
  'total_years_on_healthcare_billing_experience',
  'patient_phone_communication',
  'role_type',
  'insurance_verification_knowledge',
  'prior_authorizations_experience',
  'cpt__icd10_coding',
  'charge_entry',
  'claim_generation',
  'claim_submission',
  'denial_management',
  'insurance_followup',
  'ar_management',
  'payment_posting',
  'identifying_underpayments',
  'medicaldental_biller_total_percentage_score',
  'notes_medical__dental_biller',
  // Sales Core Skills (Sales Executive) (gate: sales_executive)
  'consultative_selling',
  'fullcycle_sales',
  'objection_handling__negotiation',
  'virtual_demos__presentations',
  'pipeline_management',
  'closing_sales',
  'total_score_sales_executive',
  'notes_sales_executive',
  // Sales Core Skills (SDR) (gate: sales_development_representative_sdr)
  'lead_research__qualification',
  'crm_proficiency',
  'outbound_prospecting_emaillvcalls',
  'cold_calling',
  'appointment_setting',
  'kpi_awareness__tracking',
  'total_score_sales_development_representative_sdr',
  'notes_sales_development_representative_sdr',
  // Sales Core Skills (Sales & Account Manager) (gate: sales__account_manager)
  'client_relationship_management',
  'retention_strategy',
  'upsell__crosssell',
  'account_onboarding',
  'issue_resolution',
  'total_score_sales__account_manager',
  'notes_sales__account_manager',
];

// Roles allowed to use the `core_skills_fields` filter — mirrors the
// frontend's `showAdminFilters` gate (UserRoles.SYSTEM_ADMIN / SYSTEM_OWNER).
const CORE_SKILLS_FILTER_ROLES = new Set([
  'system_admin',
  'system_super_admin',
]);

/**
 * Card-level candidate projection used by list endpoints (e.g. the admin offer
 * panels list). Deliberately narrow: it holds exactly what `TalentPoolCard`
 * renders plus the fields `computeCandidateRates` needs, and nothing else.
 *
 * It must NOT grow to include the VA scorecard columns, `about_me`,
 * `educations` or `experiences` — the candidate read modal lazy-fetches
 * `GET /candidates/talent-pool/:id` when opened, so list payloads never need
 * the full record. Widening this select is what made the offer panels list
 * slow enough to freeze the page.
 */
const CANDIDATE_LIST_CARD_SELECT = {
  id: true,
  hubspot_vaid: true,
  first_name: true,
  last_name: true,
  name: true,
  country: true,
  employment_type: true,
  hourly_pay_rate: true,
  years_of_experience: true,
  specialization: true,
  tools: true,
  // The card reads `avatar || avatar_url`, but `avatar` is not a Candidate
  // column — only `avatar_url` exists, and it is what renders today.
  avatar_url: true,
  gender: true,
  shift_block: true,
  business_unit: true,
  approved_positions_pairing: true,
  languages: { select: { name: true } },
  skills: { select: { skill_name: true, skill_type: true } },
} satisfies Prisma.CandidateSelect;

@Injectable()
export class CandidatesService {
  private readonly logger = new Logger(CandidatesService.name);

  static readonly UNAVAILABLE_PIPELINE_STATUSES = [
    '261214844', // Hired
    '261173428', // Lost
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogledriveService,
    private readonly s3: S3Service,
    private readonly openai: OpenaiService,
    @Inject(forwardRef(() => HubspotService))
    private readonly hubspot: HubspotService,
    private readonly mailService: MailService,

    private readonly hireRequest: HireRequestService,
    private readonly notifications: NotificationsService,
    private readonly positionRateConfigService: PositionRateConfigService,
    private readonly businessUnitContext: BusinessUnitContext,
    private readonly candidateAudit: CandidateAuditService,
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
   * Resolves the candidate-visibility restriction for a given business unit
   * (identified by its hubspot_value, e.g. "MedVirtual", "Berry Virtual", "MMVA").
   *
   * Preserves today's behavior exactly:
   * - `non_medical` pool (Berry today) → restrict to the hubspot_values of every
   *   visible BU that shares the non_medical pool.
   * - any other pool (or unknown BU) → no restriction (see all candidates).
   *   This is what keeps MedVirtual AND MMVA seeing everything.
   */
  private async getBusinessUnitFilterValues(
    businessUnitHubspotValue?: string | null,
  ): Promise<string[] | undefined> {
    if (!businessUnitHubspotValue) return undefined;

    const pool = await this.businessUnitContext.poolFor(
      businessUnitHubspotValue,
    );
    if (pool !== NON_MEDICAL_POOL) return undefined;

    const visibleValues =
      await this.businessUnitContext.getVisibleHubspotValues();
    const nonMedicalValues: string[] = [];
    for (const value of visibleValues) {
      const valuePool = await this.businessUnitContext.poolFor(value);
      if (valuePool === NON_MEDICAL_POOL) nonMedicalValues.push(value);
    }
    return nonMedicalValues.length > 0 ? nonMedicalValues : undefined;
  }

  async findAll(
    user: USER,
    country?: string,
    shift_block?: string,
    availability?: string | string[],
    monthly_compensation_from?: string,
    monthly_compensation_to?: string,
    years_of_experience?: string,
    specializations?: string | string[],
    positions?: string | string[],
    skills?: string | string[],
    languages?: string | string[],
    page?: number,
    perPage?: number,
    search?: string,
    all?: string,
    scorecard_fields?: string,
    tools?: string | string[],
    medical_tools?: string | string[],
    core_skills_fields?: string | string[],
  ): Promise<any> {
    // Check if all parameter is set to true
    const getAllCandidates = all === 'true';

    page = page ? Number(page) : 1;
    perPage = perPage ? Number(perPage) : 10;

    // If all=true, skip pagination (set skip=0, take=undefined)
    const skip = getAllCandidates ? 0 : (page - 1) * perPage;
    const take = getAllCandidates ? undefined : perPage;

    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new BadRequestException(
        'The current user doent have an organization_id',
      );

    //if (!user.organization_id) throw new BadRequestException('Organization ID is required for fetching candidates');

    let loggedCompany;
    if (user.organization_id) {
      loggedCompany = await this.prisma.organization.findUnique({
        where: {
          id: user.organization_id,
        },
        select: {
          business_unit: true,
        },
      });
    }

    // Pool-based candidate visibility (preserves today's behavior exactly):
    // non_medical BUs (Berry today) are restricted to non_medical BUs' hubspot
    // values; every other BU (MedVirtual, MMVA, future medical BUs) sees all
    // candidates — i.e. no business_unit filter is applied.
    const businessUnitFilterValues = await this.getBusinessUnitFilterValues(
      loggedCompany?.business_unit,
    );

    const { organization_id } = user;

    const hourly_from = monthly_compensation_from
      ? findHourlyPerRate(Number(monthly_compensation_from))
      : undefined;
    const hourly_to = monthly_compensation_to
      ? findHourlyPerRate(Number(monthly_compensation_to))
      : undefined;

    const combinedFilters: Record<string, any>[] = [];
    let positionsFilter: Record<string, any> | null = null;

    // VA Scorecard filter deactivated in favor of Core Skills (see
    // VA_SCORECARD_FIELDS above). `scorecard_fields` is accepted but ignored.
    // const scorecardFilters: Record<string, any>[] = scorecard_fields
    //   ? scorecard_fields
    //       .split(',')
    //       .map((f) => f.trim())
    //       .filter((f) => VA_SCORECARD_FIELDS.has(f))
    //       .flatMap((f) => [{ [f]: { not: null } }, { [f]: { not: 'false' } }])
    //   : [];
    void scorecard_fields;
    const scorecardFilters: Record<string, any>[] = [];

    // Core Skills filter — system_admin/system_super_admin only, exact-value
    // match per field (e.g. "quickbooks:5" -> candidates with quickbooks === "5").
    const isCoreSkillsFilterAllowed = CORE_SKILLS_FILTER_ROLES.has(user.role);
    const coreSkillsFilters: Record<string, any>[] =
      core_skills_fields && isCoreSkillsFilterAllowed
        ? parseQueryList(core_skills_fields)
            .map((pair) => {
              const [field, value] = pair.split(':').map((p) => p.trim());
              return { field, value };
            })
            .filter(
              ({ field, value }) =>
                field && value !== undefined && CORE_SKILLS_FIELDS.has(field),
            )
            .map(({ field, value }) => ({
              [field]: { equals: String(value) },
            }))
        : [];

    const availabilityArray = parseQueryList(availability);
    const availabilityNumbers = availabilityArray
      .map((a) => stageToDbDictionary[a])
      .filter(Boolean)
      .map((av) => String(av));

    const languagesArray = parseQueryList(languages);
    const skillsArray = parseQueryList(skills);
    const specializationArray = parseQueryList(specializations);
    const positionsArray = parseQueryList(positions);

    if (languagesArray.length) {
      combinedFilters.push(
        ...languagesArray.map((lang) => ({
          languages: { some: { name: lang } },
        })),
      );
    }

    if (skillsArray.length) {
      combinedFilters.push(
        ...skillsArray.map((skill) => ({
          skills: {
            some: { skill_name: { contains: skill, mode: 'insensitive' } },
          },
        })),
      );
    }
    // OR semantics: a candidate matching ANY selected practice area qualifies.
    if (specializationArray.length) {
      combinedFilters.push({
        OR: specializationArray.map((spec) => ({
          specialization: { contains: spec, mode: 'insensitive' as const },
        })),
      });
    }
    if (positionsArray.length) {
      positionsFilter = {
        OR: positionsArray.map((position) => ({
          approved_positions_pairing: {
            has: position,
          },
        })),
      };
    }

    const toolsArray = parseQueryList(tools);
    if (toolsArray.length) {
      combinedFilters.push({
        OR: toolsArray.map((tool) => ({
          tools: { contains: tool, mode: 'insensitive' as const },
        })),
      });
    }

    // medical_tools is a semicolon-delimited text column, so it is matched with
    // `contains` (OR semantics), mirroring the `tools` filter above.
    const medicalToolsArray = parseQueryList(medical_tools);
    if (medicalToolsArray.length) {
      combinedFilters.push({
        OR: medicalToolsArray.map((tool) => ({
          medical_tools: { contains: tool, mode: 'insensitive' as const },
        })),
      });
    }

    // Calculate limit date
    let experienceFilter = {};
    if (years_of_experience) {
      const years = Number(years_of_experience);
      const today = new Date();
      const cutoffDate = new Date(
        today.setFullYear(today.getFullYear() - years),
      );

      experienceFilter = {
        experiences: {
          some: {
            start_date: { lte: cutoffDate },
          },
        },
      };
    }

    const searchFilter = search
      ? {
          OR: [
            {
              first_name: {
                contains: search,
                mode: 'insensitive' as Prisma.QueryMode,
              },
            },
            {
              last_name: {
                contains: search,
                mode: 'insensitive' as Prisma.QueryMode,
              },
            },
            {
              name: {
                contains: search,
                mode: 'insensitive' as Prisma.QueryMode,
              },
            },
            {
              email: {
                contains: search,
                mode: 'insensitive' as Prisma.QueryMode,
              },
            },
          ],
        }
      : {};

    const where = {
      OR: [
        {
          ...(country && country === 'latinAmerica'
            ? { country: { in: latinAmericaCountries } }
            : country === 'otherCountries'
              ? { country: { notIn: latinAmericaCountries } }
              : { country }),
          ...(availabilityNumbers.length > 0
            ? { employment_type: { in: availabilityNumbers.map(String) } }
            : typeof availability === 'string' && availability
              ? { employment_type: String(stageToDbDictionary[availability]) }
              : {}),
          ...(hourly_from !== undefined || hourly_to !== undefined
            ? {
                hourly_pay_rate: {
                  ...(hourly_from !== undefined && { gte: hourly_from }),
                  ...(hourly_to !== undefined && { lte: hourly_to }),
                },
              }
            : {}),
          organization_id: organization_id,
          pipeline_status: '261075105',
          business_unit: businessUnitFilterValues
            ? { in: businessUnitFilterValues }
            : undefined,
          ...(shift_block ? { shift_block: shift_block } : {}),
          AND: [
            ...(combinedFilters.length > 0 ? combinedFilters : []),
            ...(positionsFilter ? [positionsFilter] : []),
            ...scorecardFilters,
            ...coreSkillsFilters,
          ],
          ...experienceFilter,
          ...searchFilter,
        },
        {
          ...(country && country === 'latinAmerica'
            ? { country: { in: latinAmericaCountries } }
            : country === 'otherCountries'
              ? { country: { notIn: latinAmericaCountries } }
              : { country }),
          ...(availabilityNumbers.length > 0
            ? { employment_type: { in: availabilityNumbers.map(String) } }
            : typeof availability === 'string' && availability
              ? { employment_type: String(stageToDbDictionary[availability]) }
              : {}),
          ...(hourly_from !== undefined || hourly_to !== undefined
            ? {
                hourly_pay_rate: {
                  ...(hourly_from !== undefined && { gte: hourly_from }),
                  ...(hourly_to !== undefined && { lte: hourly_to }),
                },
              }
            : {}),
          organization_id: null, // This allows candidates without an organization_id to be included
          pipeline_status: '261075105',
          business_unit: businessUnitFilterValues
            ? { in: businessUnitFilterValues }
            : undefined,
          ...(shift_block ? { shift_block: shift_block } : {}),
          AND: [
            ...(combinedFilters.length > 0 ? combinedFilters : []),
            ...(positionsFilter ? [positionsFilter] : []),
            ...scorecardFilters,
            ...coreSkillsFilters,
          ],
          ...experienceFilter,
          ...searchFilter,
        },
        {
          ...(country && country === 'latinAmerica'
            ? { country: { in: latinAmericaCountries } }
            : country === 'otherCountries'
              ? { country: { notIn: latinAmericaCountries } }
              : { country }),
          ...(availabilityNumbers.length > 0
            ? { employment_type: { in: availabilityNumbers.map(String) } }
            : typeof availability === 'string' && availability
              ? { employment_type: String(stageToDbDictionary[availability]) }
              : {}),
          ...(hourly_from !== undefined || hourly_to !== undefined
            ? {
                hourly_pay_rate: {
                  ...(hourly_from !== undefined && { gte: hourly_from }),
                  ...(hourly_to !== undefined && { lte: hourly_to }),
                },
              }
            : {}),
          organization_id: organization_id,
          pipeline_status: '1087596819',
          business_unit: businessUnitFilterValues
            ? { in: businessUnitFilterValues }
            : undefined,
          ...(shift_block ? { shift_block: shift_block } : {}),
          AND: [
            ...(combinedFilters.length > 0 ? combinedFilters : []),
            ...(positionsFilter ? [positionsFilter] : []),
            ...scorecardFilters,
            ...coreSkillsFilters,
          ],
          ...experienceFilter,
          ...searchFilter,
        },
        {
          ...(country && country === 'latinAmerica'
            ? { country: { in: latinAmericaCountries } }
            : country === 'otherCountries'
              ? { country: { notIn: latinAmericaCountries } }
              : { country }),
          ...(availabilityNumbers.length > 0
            ? { employment_type: { in: availabilityNumbers.map(String) } }
            : typeof availability === 'string' && availability
              ? { employment_type: String(stageToDbDictionary[availability]) }
              : {}),
          ...(hourly_from !== undefined || hourly_to !== undefined
            ? {
                hourly_pay_rate: {
                  ...(hourly_from !== undefined && { gte: hourly_from }),
                  ...(hourly_to !== undefined && { lte: hourly_to }),
                },
              }
            : {}),
          organization_id: null, // This allows candidates without an organization_id to be included
          pipeline_status: '1087596819',
          business_unit: businessUnitFilterValues
            ? { in: businessUnitFilterValues }
            : undefined,
          ...(shift_block ? { shift_block: shift_block } : {}),
          AND: [
            ...(combinedFilters.length > 0 ? combinedFilters : []),
            ...(positionsFilter ? [positionsFilter] : []),
            ...scorecardFilters,
            ...coreSkillsFilters,
          ],
          ...experienceFilter,
          ...searchFilter,
        },
      ],
    };
    const select = {
      id: true,
      hubspot_vaid: true,
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
      processing_status: true,
      processing_error: true,
      avatar_url: true,
      gender: true,
      shift_block: true,
      video_link: true,
      // VA Score Card fields
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
      // Core Skills fields (HubSpot VA Score Card extended)
      quickbooks: true,
      other_accounting_software: true,
      chart_of_accounts_setup___maintenance: true,
      transaction_categorization: true,
      bank__credit_card_reconciliations: true,
      accounts_payable_ap: true,
      accounts_receivable_ar: true,
      payroll_posting__reconciliation_not_processing_unless_required: true,
      payroll_posting: true,
      monthend_close: true,
      journal_entries__adjustments: true,
      balance_sheet: true,
      pl: true,
      accrual_vs_cash_understanding: true,
      prepare_books_for_cpatax_handoff: true,
      client_communication: true,
      account_reconciliation: true,
      financial_analysis: true,
      financial_reporting: true,
      total_score_bookkeeping: true,
      notes_bookkeeping: true,
      patient_scheduling__calendar_management: true,
      insurance_verification_eligibility__benefits: true,
      prior_authorizations__referrals: true,
      inbound_call_handling__patient_support: true,
      outbound_calls_recalls_noshows_followups: true,
      emrehr_data_entry__chart_updating: true,
      patient_intake__demographics_documentation_accuracy: true,
      referrals_sending_receiving_tracking: true,
      total_score_medical__dental_admin: true,
      notes_medical__dental_admin: true,
      n2_years_healthcare_billing_experience: true,
      total_years_on_healthcare_billing_experience: true,
      patient_phone_communication: true,
      role_type: true,
      insurance_verification_knowledge: true,
      prior_authorizations_experience: true,
      cpt__icd10_coding: true,
      charge_entry: true,
      claim_generation: true,
      claim_submission: true,
      denial_management: true,
      insurance_followup: true,
      ar_management: true,
      payment_posting: true,
      identifying_underpayments: true,
      medicaldental_biller_total_percentage_score: true,
      notes_medical__dental_biller: true,
      consultative_selling: true,
      fullcycle_sales: true,
      objection_handling__negotiation: true,
      virtual_demos__presentations: true,
      pipeline_management: true,
      closing_sales: true,
      total_score_sales_executive: true,
      notes_sales_executive: true,
      lead_research__qualification: true,
      crm_proficiency: true,
      outbound_prospecting_emaillvcalls: true,
      cold_calling: true,
      appointment_setting: true,
      kpi_awareness__tracking: true,
      total_score_sales_development_representative_sdr: true,
      notes_sales_development_representative_sdr: true,
      client_relationship_management: true,
      retention_strategy: true,
      upsell__crosssell: true,
      account_onboarding: true,
      issue_resolution: true,
      total_score_sales__account_manager: true,
      notes_sales__account_manager: true,
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
      educations: {
        select: {
          institution: true,
          degree: true,
          year: true,
        },
      },
      experiences: {
        orderBy: { start_date: Prisma.SortOrder.desc },
        select: {
          company: true,
          position: true,
          start_date: true,
          end_date: true,
          responsabilities: true,
        },
      },
      approved_positions_pairing: true,
      business_unit: true,
      selectedInInterviews: {
        select: {
          scheduled_date: true,
        },
      },
      panelCandidates: {
        // Client roles must only ever see panels belonging to their own
        // organization. Without this filter the payload leaks other clients'
        // hire request titles and organization names, and the frontend cannot
        // distinguish "in MY panel" from "in SOMEONE ELSE'S panel". System
        // roles (no organization_id) still receive every panel, which the
        // admin conflict disclaimers depend on.
        where: organization_id
          ? { panel: { hireRequest: { org_id: organization_id } } }
          : undefined,
        select: {
          id: true,
          status: true,
          panel: {
            select: {
              hire_request_id: true,
              hireRequest: {
                select: {
                  id: true,
                  title: true,
                  status: true,
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
    };

    try {
      const [candidates, total] = await this.prisma.$transaction([
        this.prisma.candidate.findMany({
          where,
          skip,
          take,
          select,
          orderBy: [
            {
              first_name: {
                sort: 'asc',
                nulls: 'last',
              },
            },
            {
              last_name: {
                sort: 'asc',
                nulls: 'last',
              },
            },
          ],
        }),
        this.prisma.candidate.count({ where }),
      ]);

      candidates.forEach((candidate) => {
        if (candidate.pipeline_status) {
          const stageName =
            dbToStageDictionary[Number(candidate.pipeline_status)];
          candidate.pipeline_status = stageName || 'Unknown Stage';
        }
      });

      const candidateIds = candidates.map((candidate) => candidate.id);

      const interviewRequestTickets = await this.prisma.ticket.findMany({
        where: {
          organization: { is: { id: organization_id || undefined } },
          type: 'interview',
          status: {
            in: ['new', 'in_progress'],
          },
          candidate_id: {
            in: candidateIds,
          },
          deleted_at: null,
        },
        select: {
          candidate_id: true,
        },
      });

      const candidatesWithInterviewScheduled = new Set(
        interviewRequestTickets.map((ticket) => ticket.candidate_id),
      );

      const _pConfigs1 =
        await this.positionRateConfigService.findAllUnpaginated();
      const _configMap1 = buildConfigMap(_pConfigs1);
      const _poolMap1 = await this.buildCandidatePoolMap(candidates);

      const candidatesWithScheduledInterview = candidates.map((candidate) => {
        const rates = computeCandidateRates(
          candidate,
          _configMap1,
          _poolMap1.get(candidate.business_unit ?? '') ?? 'medical',
        );
        return {
          ...candidate,
          vaid: candidate.hubspot_vaid,
          approved_positions_pairing:
            (candidate.approved_positions_pairing &&
              candidate.approved_positions_pairing.map((position) =>
                getApprovedPositionLabel(position),
              )) ||
            [],
          employment_type:
            changeLabelAvailability(
              dbToStageDictionary[Number(candidate.employment_type)],
            ) || candidate.employment_type,
          scheduledInterviewDate:
            candidate.selectedInInterviews[0]?.scheduled_date || null,
          hasInterviewScheduled: candidatesWithInterviewScheduled.has(
            candidate.id,
          ),
          selectedInInterviews: undefined,
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
          existingInOtherClientPanel: isInClientOpenPanel(
            candidate.panelCandidates,
            organization_id,
          ),
        };
      });

      return {
        data: candidatesWithScheduledInterview,
        meta: getAllCandidates
          ? {
              total,
              page: 1,
              perPage: total,
              totalPages: 1,
              all: true,
            }
          : {
              total,
              page,
              perPage,
              totalPages: Math.ceil(Number(total) / perPage),
              all: false,
            },
      };
    } catch (error) {
      throw new BadGatewayException(
        'Failed to fetch candidates',
        error.message,
      );
    }
  }

  //Function that should be used only for alliance module
  async findAllForAlliance(
    user: USER,
    country?: string,
    shift_block?: string,
    availability?: string | string[],
    monthly_compensation_from?: string,
    monthly_compensation_to?: string,
    years_of_experience?: string,
    specializations?: string | string[],
    positions?: string | string[],
    skills?: string | string[],
    languages?: string | string[],
    page?: number,
    perPage?: number,
    search?: string,
    all?: string,
    scorecard_fields?: string,
    tools?: string | string[],
    medical_tools?: string | string[],
    core_skills_fields?: string | string[],
  ): Promise<any> {
    // Check if all parameter is set to true
    const getAllCandidates = all === 'true';

    page = page ? Number(page) : 1;
    perPage = perPage ? Number(perPage) : 10;

    // If all=true, skip pagination (set skip=0, take=undefined)
    const skip = getAllCandidates ? 0 : (page - 1) * perPage;
    const take = getAllCandidates ? undefined : perPage;

    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new BadRequestException(
        'The current user doent have an organization_id',
      );

    //if (!user.organization_id) throw new BadRequestException('Organization ID is required for fetching candidates');

    const { organization_id } = user;

    const hourly_from = monthly_compensation_from
      ? findHourlyPerRate(Number(monthly_compensation_from))
      : undefined;
    const hourly_to = monthly_compensation_to
      ? findHourlyPerRate(Number(monthly_compensation_to))
      : undefined;

    const combinedFilters: Record<string, any>[] = [];
    let positionsFilter: Record<string, any> | null = null;

    // VA Scorecard filter deactivated in favor of Core Skills (see
    // VA_SCORECARD_FIELDS above). `scorecard_fields` is accepted but ignored.
    // const scorecardFilters: Record<string, any>[] = scorecard_fields
    //   ? scorecard_fields
    //       .split(',')
    //       .map((f) => f.trim())
    //       .filter((f) => VA_SCORECARD_FIELDS.has(f))
    //       .flatMap((f) => [{ [f]: { not: null } }, { [f]: { not: 'false' } }])
    //   : [];
    void scorecard_fields;
    const scorecardFilters: Record<string, any>[] = [];

    // Core Skills filter — system_admin/system_super_admin only, exact-value
    // match per field (e.g. "quickbooks:5" -> candidates with quickbooks === "5").
    const isCoreSkillsFilterAllowed = CORE_SKILLS_FILTER_ROLES.has(user.role);
    const coreSkillsFilters: Record<string, any>[] =
      core_skills_fields && isCoreSkillsFilterAllowed
        ? parseQueryList(core_skills_fields)
            .map((pair) => {
              const [field, value] = pair.split(':').map((p) => p.trim());
              return { field, value };
            })
            .filter(
              ({ field, value }) =>
                field && value !== undefined && CORE_SKILLS_FIELDS.has(field),
            )
            .map(({ field, value }) => ({
              [field]: { equals: String(value) },
            }))
        : [];

    const availabilityArray = parseQueryList(availability);
    const availabilityNumbers = availabilityArray
      .map((a) => stageToDbDictionary[a])
      .filter(Boolean)
      .map((av) => String(av));

    const languagesArray = parseQueryList(languages);
    const skillsArray = parseQueryList(skills);
    const specializationArray = parseQueryList(specializations);
    const positionsArray = parseQueryList(positions);

    if (languagesArray.length) {
      combinedFilters.push(
        ...languagesArray.map((lang) => ({
          languages: { some: { name: lang } },
        })),
      );
    }

    if (skillsArray.length) {
      combinedFilters.push(
        ...skillsArray.map((skill) => ({
          skills: {
            some: { skill_name: { contains: skill, mode: 'insensitive' } },
          },
        })),
      );
    }
    // OR semantics: a candidate matching ANY selected practice area qualifies.
    if (specializationArray.length) {
      combinedFilters.push({
        OR: specializationArray.map((spec) => ({
          specialization: { contains: spec, mode: 'insensitive' as const },
        })),
      });
    }
    if (positionsArray.length) {
      positionsFilter = {
        OR: positionsArray.map((position) => ({
          approved_positions_pairing: {
            has: position,
          },
        })),
      };
    }

    const toolsArray = parseQueryList(tools);
    if (toolsArray.length) {
      combinedFilters.push({
        OR: toolsArray.map((tool) => ({
          tools: { contains: tool, mode: 'insensitive' as const },
        })),
      });
    }

    // medical_tools is a semicolon-delimited text column, so it is matched with
    // `contains` (OR semantics), mirroring the `tools` filter above.
    const medicalToolsArray = parseQueryList(medical_tools);
    if (medicalToolsArray.length) {
      combinedFilters.push({
        OR: medicalToolsArray.map((tool) => ({
          medical_tools: { contains: tool, mode: 'insensitive' as const },
        })),
      });
    }

    // Calculate limit date
    let experienceFilter = {};
    if (years_of_experience) {
      const years = Number(years_of_experience);
      const today = new Date();
      const cutoffDate = new Date(
        today.setFullYear(today.getFullYear() - years),
      );

      experienceFilter = {
        experiences: {
          some: {
            start_date: { lte: cutoffDate },
          },
        },
      };
    }

    const searchFilter = search
      ? {
          OR: [
            {
              first_name: {
                contains: search,
                mode: 'insensitive' as Prisma.QueryMode,
              },
            },
            {
              last_name: {
                contains: search,
                mode: 'insensitive' as Prisma.QueryMode,
              },
            },
            {
              name: {
                contains: search,
                mode: 'insensitive' as Prisma.QueryMode,
              },
            },
            {
              email: {
                contains: search,
                mode: 'insensitive' as Prisma.QueryMode,
              },
            },
          ],
        }
      : {};

    const where = {
      OR: [
        {
          ...(country && country === 'latinAmerica'
            ? { country: { in: latinAmericaCountries } }
            : country === 'otherCountries'
              ? { country: { notIn: latinAmericaCountries } }
              : { country }),
          ...(availabilityNumbers.length > 0
            ? { employment_type: { in: availabilityNumbers.map(String) } }
            : typeof availability === 'string' && availability
              ? { employment_type: String(stageToDbDictionary[availability]) }
              : {}),
          ...(hourly_from !== undefined || hourly_to !== undefined
            ? {
                hourly_pay_rate: {
                  ...(hourly_from !== undefined && { gte: hourly_from }),
                  ...(hourly_to !== undefined && { lte: hourly_to }),
                },
              }
            : {}),
          organization_id: organization_id,
          pipeline_status: '261075105',
          ...(shift_block ? { shift_block: shift_block } : {}),
          AND: [
            ...(combinedFilters.length > 0 ? combinedFilters : []),
            ...(positionsFilter ? [positionsFilter] : []),
            ...scorecardFilters,
            ...coreSkillsFilters,
          ],
          ...experienceFilter,
          ...searchFilter,
        },
        {
          ...(country && country === 'latinAmerica'
            ? { country: { in: latinAmericaCountries } }
            : country === 'otherCountries'
              ? { country: { notIn: latinAmericaCountries } }
              : { country }),
          ...(availabilityNumbers.length > 0
            ? { employment_type: { in: availabilityNumbers.map(String) } }
            : typeof availability === 'string' && availability
              ? { employment_type: String(stageToDbDictionary[availability]) }
              : {}),
          ...(hourly_from !== undefined || hourly_to !== undefined
            ? {
                hourly_pay_rate: {
                  ...(hourly_from !== undefined && { gte: hourly_from }),
                  ...(hourly_to !== undefined && { lte: hourly_to }),
                },
              }
            : {}),
          organization_id: null, // This allows candidates without an organization_id to be included
          pipeline_status: '261075105',
          ...(shift_block ? { shift_block: shift_block } : {}),
          AND: [
            ...(combinedFilters.length > 0 ? combinedFilters : []),
            ...(positionsFilter ? [positionsFilter] : []),
            ...scorecardFilters,
            ...coreSkillsFilters,
          ],
          ...experienceFilter,
          ...searchFilter,
        },
        {
          ...(country && country === 'latinAmerica'
            ? { country: { in: latinAmericaCountries } }
            : country === 'otherCountries'
              ? { country: { notIn: latinAmericaCountries } }
              : { country }),
          ...(availabilityNumbers.length > 0
            ? { employment_type: { in: availabilityNumbers.map(String) } }
            : typeof availability === 'string' && availability
              ? { employment_type: String(stageToDbDictionary[availability]) }
              : {}),
          ...(hourly_from !== undefined || hourly_to !== undefined
            ? {
                hourly_pay_rate: {
                  ...(hourly_from !== undefined && { gte: hourly_from }),
                  ...(hourly_to !== undefined && { lte: hourly_to }),
                },
              }
            : {}),
          organization_id: organization_id,
          pipeline_status: '1087596819',
          ...(shift_block ? { shift_block: shift_block } : {}),
          AND: [
            ...(combinedFilters.length > 0 ? combinedFilters : []),
            ...(positionsFilter ? [positionsFilter] : []),
            ...scorecardFilters,
            ...coreSkillsFilters,
          ],
          ...experienceFilter,
          ...searchFilter,
        },
        {
          ...(country && country === 'latinAmerica'
            ? { country: { in: latinAmericaCountries } }
            : country === 'otherCountries'
              ? { country: { notIn: latinAmericaCountries } }
              : { country }),
          ...(availabilityNumbers.length > 0
            ? { employment_type: { in: availabilityNumbers.map(String) } }
            : typeof availability === 'string' && availability
              ? { employment_type: String(stageToDbDictionary[availability]) }
              : {}),
          ...(hourly_from !== undefined || hourly_to !== undefined
            ? {
                hourly_pay_rate: {
                  ...(hourly_from !== undefined && { gte: hourly_from }),
                  ...(hourly_to !== undefined && { lte: hourly_to }),
                },
              }
            : {}),
          organization_id: null, // This allows candidates without an organization_id to be included
          pipeline_status: '1087596819',
          ...(shift_block ? { shift_block: shift_block } : {}),
          AND: [
            ...(combinedFilters.length > 0 ? combinedFilters : []),
            ...(positionsFilter ? [positionsFilter] : []),
            ...scorecardFilters,
            ...coreSkillsFilters,
          ],
          ...experienceFilter,
          ...searchFilter,
        },
      ],
    };
    const select = {
      id: true,
      hubspot_vaid: true,
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
      processing_status: true,
      processing_error: true,
      avatar_url: true,
      gender: true,
      shift_block: true,
      video_link: true,
      // VA Score Card fields
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
      // Core Skills fields (HubSpot VA Score Card extended)
      quickbooks: true,
      other_accounting_software: true,
      chart_of_accounts_setup___maintenance: true,
      transaction_categorization: true,
      bank__credit_card_reconciliations: true,
      accounts_payable_ap: true,
      accounts_receivable_ar: true,
      payroll_posting__reconciliation_not_processing_unless_required: true,
      payroll_posting: true,
      monthend_close: true,
      journal_entries__adjustments: true,
      balance_sheet: true,
      pl: true,
      accrual_vs_cash_understanding: true,
      prepare_books_for_cpatax_handoff: true,
      client_communication: true,
      account_reconciliation: true,
      financial_analysis: true,
      financial_reporting: true,
      total_score_bookkeeping: true,
      notes_bookkeeping: true,
      patient_scheduling__calendar_management: true,
      insurance_verification_eligibility__benefits: true,
      prior_authorizations__referrals: true,
      inbound_call_handling__patient_support: true,
      outbound_calls_recalls_noshows_followups: true,
      emrehr_data_entry__chart_updating: true,
      patient_intake__demographics_documentation_accuracy: true,
      referrals_sending_receiving_tracking: true,
      total_score_medical__dental_admin: true,
      notes_medical__dental_admin: true,
      n2_years_healthcare_billing_experience: true,
      total_years_on_healthcare_billing_experience: true,
      patient_phone_communication: true,
      role_type: true,
      insurance_verification_knowledge: true,
      prior_authorizations_experience: true,
      cpt__icd10_coding: true,
      charge_entry: true,
      claim_generation: true,
      claim_submission: true,
      denial_management: true,
      insurance_followup: true,
      ar_management: true,
      payment_posting: true,
      identifying_underpayments: true,
      medicaldental_biller_total_percentage_score: true,
      notes_medical__dental_biller: true,
      consultative_selling: true,
      fullcycle_sales: true,
      objection_handling__negotiation: true,
      virtual_demos__presentations: true,
      pipeline_management: true,
      closing_sales: true,
      total_score_sales_executive: true,
      notes_sales_executive: true,
      lead_research__qualification: true,
      crm_proficiency: true,
      outbound_prospecting_emaillvcalls: true,
      cold_calling: true,
      appointment_setting: true,
      kpi_awareness__tracking: true,
      total_score_sales_development_representative_sdr: true,
      notes_sales_development_representative_sdr: true,
      client_relationship_management: true,
      retention_strategy: true,
      upsell__crosssell: true,
      account_onboarding: true,
      issue_resolution: true,
      total_score_sales__account_manager: true,
      notes_sales__account_manager: true,
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
      educations: {
        select: {
          institution: true,
          degree: true,
          year: true,
        },
      },
      experiences: {
        orderBy: { start_date: Prisma.SortOrder.desc },
        select: {
          company: true,
          position: true,
          start_date: true,
          end_date: true,
          responsabilities: true,
        },
      },
      approved_positions_pairing: true,
      business_unit: true,
      selectedInInterviews: {
        select: {
          scheduled_date: true,
        },
      },
      panelCandidates: {
        // Client roles must only ever see panels belonging to their own
        // organization. Without this filter the payload leaks other clients'
        // hire request titles and organization names, and the frontend cannot
        // distinguish "in MY panel" from "in SOMEONE ELSE'S panel". System
        // roles (no organization_id) still receive every panel, which the
        // admin conflict disclaimers depend on.
        where: organization_id
          ? { panel: { hireRequest: { org_id: organization_id } } }
          : undefined,
        select: {
          id: true,
          status: true,
          panel: {
            select: {
              hire_request_id: true,
              hireRequest: {
                select: {
                  id: true,
                  title: true,
                  status: true,
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
    };

    try {
      const [candidates, total] = await this.prisma.$transaction([
        this.prisma.candidate.findMany({
          where,
          skip,
          take,
          select,
          orderBy: [
            {
              first_name: {
                sort: 'asc',
                nulls: 'last',
              },
            },
            {
              last_name: {
                sort: 'asc',
                nulls: 'last',
              },
            },
          ],
        }),
        this.prisma.candidate.count({ where }),
      ]);

      candidates.forEach((candidate) => {
        if (candidate.pipeline_status) {
          const stageName =
            dbToStageDictionary[Number(candidate.pipeline_status)];
          candidate.pipeline_status = stageName || 'Unknown Stage';
        }
      });

      const candidateIds = candidates.map((candidate) => candidate.id);

      const interviewRequestTickets = await this.prisma.ticket.findMany({
        where: {
          organization: { is: { id: organization_id || undefined } },
          type: 'interview',
          status: {
            in: ['new', 'in_progress'],
          },
          candidate_id: {
            in: candidateIds,
          },
          deleted_at: null,
        },
        select: {
          candidate_id: true,
        },
      });

      const candidatesWithInterviewScheduled = new Set(
        interviewRequestTickets.map((ticket) => ticket.candidate_id),
      );

      const _pConfigs1 =
        await this.positionRateConfigService.findAllUnpaginated();
      const _configMap1 = buildConfigMap(_pConfigs1);
      const _poolMap1 = await this.buildCandidatePoolMap(candidates);

      const candidatesWithScheduledInterview = candidates.map((candidate) => {
        const rates = computeCandidateRates(
          candidate,
          _configMap1,
          _poolMap1.get(candidate.business_unit ?? '') ?? 'medical',
        );
        return {
          ...candidate,
          vaid: candidate.hubspot_vaid,
          approved_positions_pairing:
            (candidate.approved_positions_pairing &&
              candidate.approved_positions_pairing.map((position) =>
                getApprovedPositionLabel(position),
              )) ||
            [],
          employment_type:
            changeLabelAvailability(
              dbToStageDictionary[Number(candidate.employment_type)],
            ) || candidate.employment_type,
          scheduledInterviewDate:
            candidate.selectedInInterviews[0]?.scheduled_date || null,
          hasInterviewScheduled: candidatesWithInterviewScheduled.has(
            candidate.id,
          ),
          selectedInInterviews: undefined,
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
          existingInOtherClientPanel: isInClientOpenPanel(
            candidate.panelCandidates,
            organization_id,
          ),
        };
      });

      return {
        data: candidatesWithScheduledInterview,
        meta: getAllCandidates
          ? {
              total,
              page: 1,
              perPage: total,
              totalPages: 1,
              all: true,
            }
          : {
              total,
              page,
              perPage,
              totalPages: Math.ceil(Number(total) / perPage),
              all: false,
            },
      };
    } catch (error) {
      throw new BadGatewayException(
        'Failed to fetch candidates',
        error.message,
      );
    }
  }

  async findOne(id: string, user: USER) {
    const { organization_id } = user;
    if (!id) throw new BadRequestException('Candidate ID is required');

    const select = {
      id: true,
      hubspot_vaid: true,
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
      gender: true,
      shift_block: true,
      video_link: true,
      // VA Score Card fields
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
      // Core Skills fields (HubSpot VA Score Card extended)
      quickbooks: true,
      other_accounting_software: true,
      chart_of_accounts_setup___maintenance: true,
      transaction_categorization: true,
      bank__credit_card_reconciliations: true,
      accounts_payable_ap: true,
      accounts_receivable_ar: true,
      payroll_posting__reconciliation_not_processing_unless_required: true,
      payroll_posting: true,
      monthend_close: true,
      journal_entries__adjustments: true,
      balance_sheet: true,
      pl: true,
      accrual_vs_cash_understanding: true,
      prepare_books_for_cpatax_handoff: true,
      client_communication: true,
      account_reconciliation: true,
      financial_analysis: true,
      financial_reporting: true,
      total_score_bookkeeping: true,
      notes_bookkeeping: true,
      patient_scheduling__calendar_management: true,
      insurance_verification_eligibility__benefits: true,
      prior_authorizations__referrals: true,
      inbound_call_handling__patient_support: true,
      outbound_calls_recalls_noshows_followups: true,
      emrehr_data_entry__chart_updating: true,
      patient_intake__demographics_documentation_accuracy: true,
      referrals_sending_receiving_tracking: true,
      total_score_medical__dental_admin: true,
      notes_medical__dental_admin: true,
      n2_years_healthcare_billing_experience: true,
      total_years_on_healthcare_billing_experience: true,
      patient_phone_communication: true,
      role_type: true,
      insurance_verification_knowledge: true,
      prior_authorizations_experience: true,
      cpt__icd10_coding: true,
      charge_entry: true,
      claim_generation: true,
      claim_submission: true,
      denial_management: true,
      insurance_followup: true,
      ar_management: true,
      payment_posting: true,
      identifying_underpayments: true,
      medicaldental_biller_total_percentage_score: true,
      notes_medical__dental_biller: true,
      consultative_selling: true,
      fullcycle_sales: true,
      objection_handling__negotiation: true,
      virtual_demos__presentations: true,
      pipeline_management: true,
      closing_sales: true,
      total_score_sales_executive: true,
      notes_sales_executive: true,
      lead_research__qualification: true,
      crm_proficiency: true,
      outbound_prospecting_emaillvcalls: true,
      cold_calling: true,
      appointment_setting: true,
      kpi_awareness__tracking: true,
      total_score_sales_development_representative_sdr: true,
      notes_sales_development_representative_sdr: true,
      client_relationship_management: true,
      retention_strategy: true,
      upsell__crosssell: true,
      account_onboarding: true,
      issue_resolution: true,
      total_score_sales__account_manager: true,
      notes_sales__account_manager: true,
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
        orderBy: { start_date: Prisma.SortOrder.desc },
        select: {
          company: true,
          position: true,
          start_date: true,
          end_date: true,
          responsabilities: true,
        },
      },
      panelCandidates: {
        // Org-scoped: see the note in `findAll`.
        where: organization_id
          ? { panel: { hireRequest: { org_id: organization_id } } }
          : undefined,
        select: {
          id: true,
          // Needed by `isInClientOpenPanel` to ignore candidates already
          // released back to the pool (`returned_to_pool`).
          status: true,
          panel: {
            select: {
              hire_request_id: true,
              hireRequest: {
                select: {
                  id: true,
                  title: true,
                  status: true,
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
    };

    const candidate = await this.prisma.candidate.findUnique({
      where: {
        id: id,
        organization_id: organization_id,
      },
      select,
    });
    if (!candidate) throw new NotFoundException('Candidate not found');

    //change pipeline_status to name
    if (candidate.pipeline_status) {
      const stageName = dbToStageDictionary[Number(candidate.pipeline_status)];
      candidate.pipeline_status = stageName || 'Unknown Stage';
    }
    candidate.employment_type =
      changeLabelAvailability(
        dbToStageDictionary[Number(candidate.employment_type)],
      ) || candidate.employment_type;

    const formattedCandidate = {
      ...candidate, // mantém os outros campos do candidato
      vaid: candidate.hubspot_vaid,
      approved_positions_pairing:
        (candidate.approved_positions_pairing &&
          candidate.approved_positions_pairing.map((position) =>
            getApprovedPositionLabel(position),
          )) ||
        [],
      panelCandidates:
        candidate.panelCandidates && candidate.panelCandidates.length > 0
          ? candidate.panelCandidates.map((pc) => ({
              title: pc.panel?.hireRequest?.title || '',
              organization_name:
                pc.panel?.hireRequest?.organization?.name || '',
            }))
          : [],
      existingInOtherClientPanel: isInClientOpenPanel(
        candidate.panelCandidates,
        organization_id,
      ),
    };
    return formattedCandidate;
  }

  async update(id: string, data: UpdateCandidateDto): Promise<any> {
    if (!id) throw new BadRequestException('Candidate ID is required');
    if (!data) throw new BadRequestException('Update data is required');

    if (data.pipeline_status) {
      const stageName = Object.entries(dbToStageDictionary).find(
        ([key, value]) =>
          value.toLowerCase() === data.pipeline_status?.toLowerCase(),
      )?.[0];
      data.pipeline_status = stageName || 'Unknown Stage';
    }

    const changedKeys = Object.keys(data) as (keyof UpdateCandidateDto)[];
    const beforeCandidate =
      changedKeys.length > 0
        ? await this.prisma.candidate.findUnique({
            where: { id },
            select: changedKeys.reduce<Record<string, true>>((acc, key) => {
              acc[key] = true;
              return acc;
            }, {}),
          })
        : null;

    const updatedCandidate = await this.prisma.candidate.update({
      where: { id: id },
      data: {
        ...data,
      },
    });
    if (!updatedCandidate)
      throw new BadGatewayException('Failed to update candidate');

    if (changedKeys.length > 0) {
      const isPipelineStatusChange = changedKeys.includes('pipeline_status');
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const key of changedKeys) {
        before[key] = (beforeCandidate as Record<string, unknown> | null)?.[
          key
        ];
        after[key] = (updatedCandidate as Record<string, unknown>)[key];
      }
      void this.candidateAudit.log({
        candidateId: updatedCandidate.id,
        hubspotId: updatedCandidate.hubspot_id,
        event: isPipelineStatusChange
          ? CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED
          : CANDIDATE_AUDIT_EVENTS.PROFILE_UPDATED,
        fieldGroup: isPipelineStatusChange
          ? CandidateAuditFieldGroup.pipeline_status
          : CandidateAuditFieldGroup.profile,
        before,
        after,
        source: CandidateAuditSource.user,
      });
    }

    // R9 — remove from all OfferPanels when candidate becomes unavailable
    if (
      data.pipeline_status &&
      CandidatesService.UNAVAILABLE_PIPELINE_STATUSES.includes(
        data.pipeline_status,
      )
    ) {
      await this.removeFromOfferPanels(id);
    }

    return { ...updatedCandidate, vaid: updatedCandidate.hubspot_vaid };
  }

  async removeFromOfferPanels(candidateId: string): Promise<void> {
    const affected = await this.prisma.offerPanelCandidate.findMany({
      where: { candidate_id: candidateId },
      select: { offer_panel_id: true },
    });

    if (affected.length === 0) return;

    const panelIds = [...new Set(affected.map((r) => r.offer_panel_id))];

    await this.prisma.offerPanelCandidate.deleteMany({
      where: { candidate_id: candidateId },
    });

    let deletedPanels = 0;
    for (const panelId of panelIds) {
      const remaining = await this.prisma.offerPanelCandidate.count({
        where: { offer_panel_id: panelId },
      });
      if (remaining === 0) {
        await this.prisma.offerPanel.delete({ where: { id: panelId } });
        deletedPanels++;
      }
    }

    this.logger.log(
      `R9: candidate ${candidateId} removed from ${panelIds.length} offer panel(s); ${deletedPanels} panel(s) deleted`,
    );
  }

  private async updateStatus(
    id: string,
    status: ProcessingStatus,
    error?: string,
  ): Promise<void> {
    const beforeCandidate = await this.prisma.candidate.findUnique({
      where: { id },
      select: {
        hubspot_id: true,
        processing_status: true,
        processing_error: true,
        processed_at: true,
      },
    });

    await this.prisma.candidate.update({
      where: { id },
      data: {
        processing_status: status,
        processing_error: error || null,
        processed_at: new Date(),
      },
    });

    void this.candidateAudit.log({
      candidateId: id,
      hubspotId: beforeCandidate?.hubspot_id ?? null,
      event: CANDIDATE_AUDIT_EVENTS.PROCESSING_STATUS_CHANGED,
      fieldGroup: CandidateAuditFieldGroup.processing,
      before: {
        processing_status: beforeCandidate?.processing_status,
        processing_error: beforeCandidate?.processing_error,
        processed_at: beforeCandidate?.processed_at,
      },
      after: {
        processing_status: status,
        processing_error: error || null,
        processed_at: new Date(),
      },
      source: CandidateAuditSource.system,
    });
  }

  async updateFromJson(id: string, jsonData: any): Promise<boolean> {
    //create function to get datas and populate different tables
    if (!id) throw new BadRequestException('Candidate ID is required');
    if (!jsonData) throw new BadRequestException('JSON data is required');

    //Clear database to avoid duplicates
    await this.prisma.candidateEducation.deleteMany({
      where: { candidate_id: id },
    });
    await this.prisma.candidateExperience.deleteMany({
      where: { candidate_id: id },
    });

    if (jsonData.education !== '' && jsonData.education !== undefined) {
      const educationData = jsonData.education;
      if (Array.isArray(educationData)) {
        await this.prisma.candidateEducation.createMany({
          data: educationData.map((item) => ({
            candidate_id: id,
            institution: item.institution || '',
            degree: item.degree || '',
            year: item.year || null,
          })),
        });
      }
    }

    if (jsonData.experience !== '' && jsonData.experience !== undefined) {
      const experienceData = jsonData.experience;

      if (Array.isArray(experienceData)) {
        await this.prisma.candidateExperience.createMany({
          data: experienceData.map((item) => ({
            candidate_id: id,
            company: item.company || '',
            position: item.role || '',
            start_date: item.start_date ? new Date(item.start_date) : null,
            end_date: item.end_date ? new Date(item.end_date) : null,
            responsabilities: item.description || '',
          })),
        });
      }
    }
    return true;
  }

  async processAvatar(id: string): Promise<boolean> {
    console.log('starting process Avatar for candidate ID:', id);
    if (!id) throw new BadRequestException('Candidate ID is required');

    const candidate = await this.prisma.candidate.findUnique({
      where: {
        id: id,
      },
      select: {
        id: true,
        headshot_url: true,
        hubspot_id: true,
        avatar_url: true,
        processing_cost: true,
      },
    });
    if (!candidate) throw new BadRequestException('Candidate not found');

    if (
      candidate &&
      candidate.headshot_url &&
      candidate.headshot_url.includes('http')
    ) {
      const idImage = extractDriveFileId(candidate.headshot_url);
      if (!idImage) {
        console.log('Error in extracting image ID from URL');
        return false;
      }

      const imageName = `${candidate.id}__image.png`;
      const downloadDir = path.resolve(__dirname, '/tmp');

      const imageDownloaded = await this.google.downloadImage(
        idImage,
        imageName,
        downloadDir,
      );
      if (!imageDownloaded) {
        console.log(
          'Failed to download image from Google Drive:',
          imageDownloaded,
        );
      }
      console.log(
        'Image downloaded successfully from Google Drive',
        imageDownloaded,
      );
      const { imagePath: avatarImage, cost: avatarCost } =
        await this.openai.generateAvatarWithScreenshoot(
          candidate,
          imageDownloaded,
        );
      console.log('Avatar generated successfully: ', avatarImage);

      const bucketFile = await this.s3.uploadFile(
        avatarImage,
        path.basename(avatarImage),
        'medvirtual-avatar',
      );
      if (!bucketFile) {
        console.log('Failed to upload avatar to S3');
        return false;
      }
      console.log('Avatar uploaded successfully to S3:', bucketFile);
      //Save Avatar on S3 and update candidate database

      //update database with new avatar URL
      const updatedCandidate = await this.prisma.candidate.update({
        where: { id: id },
        data: {
          avatar_url: bucketFile,
          processing_cost: { increment: avatarCost },
        },
      });

      void this.candidateAudit.log({
        candidateId: id,
        hubspotId: candidate.hubspot_id,
        event: CANDIDATE_AUDIT_EVENTS.AVATAR_GENERATED,
        fieldGroup: CandidateAuditFieldGroup.profile,
        before: {
          avatar_url: candidate.avatar_url,
          processing_cost: candidate.processing_cost,
        },
        after: {
          avatar_url: updatedCandidate.avatar_url,
          processing_cost: updatedCandidate.processing_cost,
        },
        source: CandidateAuditSource.system,
      });
    }
    return true;
  }

  async processData(id: string): Promise<boolean> {
    console.log('starting process data for candidate ID:', id);
    if (!id) throw new BadRequestException('Candidate ID is required');

    const candidate = await this.prisma.candidate.findUnique({
      where: {
        id: id,
      },
    });
    //console.log('Candidate data retrieved:', candidate);
    if (
      candidate &&
      candidate.resume_url &&
      candidate.resume_url.includes('http')
    ) {
      const idFile = extractDriveFileId(candidate.resume_url);
      const pdfName = `${candidate.id}_resume.pdf`;
      const downloadDir = path.resolve(__dirname, '/tmp'); // Ensuring temp dir usage

      if (!idFile) {
        await this.updateStatus(
          id,
          'failed',
          'Error in extracting file ID from URL',
        );
        console.log('Error in extracting file ID from URL');
        return false;
      }

      console.log('starting with download step...');
      //processing_downloadFile
      await this.updateStatus(id, 'processing_downloadFile');
      const fileDownloaded = await this.google.downloadFile(
        idFile,
        pdfName,
        downloadDir,
      );
      if (fileDownloaded !== 'Download successful') {
        //=> Send failed via email
        /*
        const candidateName = candidate.first_name ? `${candidate.first_name} ${candidate.last_name}` : `${candidate.name}`;
        const emailBody = googleDriveFailed(candidateName, fileDownloaded);
        const mailSent = await this.mailService.sendMail({
        from: 'MedVirtual <noreply@medvirtual.ai>',
        to: 'paulo@regenta.ai',
        subject: 'Google Drive Failed',
        html: emailBody,
        });
        if (!mailSent) {
          console.error('Failed to send google drive failed email.');
        }
        */

        await this.updateStatus(id, 'failed', `${fileDownloaded}`);
        return false;
      }

      // Prepare for processing: Split PDF and Convert to Images
      const tempDir = path.join(downloadDir, `temp_pages_${candidate.id}`);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      try {
        console.log(
          'Splitting PDF and converting to images with node-poppler...',
        );
        await this.updateStatus(id, 'processing_extractText');

        const pdfPath = path.join(downloadDir, pdfName);
        const outputPrefix = path.join(tempDir, 'page');

        const { Poppler } = require('node-poppler');
        const popplerPath =
          process.env.POPPLER_BIN_PATH ||
          (fs.existsSync('/opt/bin/pdftocairo') ? '/opt/bin' : undefined);
        const poppler = new Poppler(popplerPath);

        const options = {
          firstPageToConvert: 1,
          pngFile: true,
        };

        // This will generate files like page-1.png, page-2.png, etc. in the tempDir
        await poppler.pdfToCairo(pdfPath, outputPrefix, options);

        // Read the generated directory to find the images
        const files = fs.readdirSync(tempDir);
        const imagePaths = files
          .filter((file) => file.startsWith('page') && file.endsWith('.png'))
          .map((file) => path.join(tempDir, file))
          .sort((a, b) => {
            // Sort by page number if needed
            const numA = parseInt(a.match(/page-(\d+)\.png/)?.[1] || '0');
            const numB = parseInt(b.match(/page-(\d+)\.png/)?.[1] || '0');
            return numA - numB;
          });

        if (imagePaths.length === 0) {
          throw new Error('No images converted from PDF.');
        }

        console.log(`Converted ${imagePaths.length} images.`);

        console.log('Sending images to OpenAI...');
        await this.updateStatus(id, 'processing_organizeData');

        const { data: organizedData, cost: resumeCost } =
          await this.openai.extractDataFromResumeImages(imagePaths);

        // Transform data to match expectations (e.g. join array descriptions)
        const transformedData = {
          ...organizedData,
          experience:
            organizedData.experience?.map((exp) => ({
              ...exp,
              description: Array.isArray(exp.description)
                ? exp.description.join('; ')
                : exp.description,
            })) || [],
          education: organizedData.education || [],
        };

        if (!transformedData) {
          await this.updateStatus(
            id,
            'failed',
            'Failed to organize data from OpenAI',
          );
          return false;
        }

        console.log('Data extracted successfully by OpenAI');

        //processing_updateCandidate
        const processedAt = new Date();
        const updatedCandidate = await this.prisma.candidate.update({
          where: { id: id },
          data: {
            processing_status: 'processing_updateCandidate',
            processed_resume_data: transformedData,
            processed_at: processedAt,
            about_me: transformedData.bio,
            years_of_experience: transformedData.years_of_experience || 0,
            processing_cost: { increment: resumeCost },
          },
        });

        void this.candidateAudit.log({
          candidateId: id,
          hubspotId: candidate.hubspot_id,
          event: CANDIDATE_AUDIT_EVENTS.PROCESSING_STATUS_CHANGED,
          fieldGroup: CandidateAuditFieldGroup.processing,
          before: {
            processing_status: candidate.processing_status,
            processed_resume_data: candidate.processed_resume_data,
            processed_at: candidate.processed_at,
            about_me: candidate.about_me,
            years_of_experience: candidate.years_of_experience,
            processing_cost: candidate.processing_cost,
          },
          after: {
            processing_status: updatedCandidate.processing_status,
            processed_resume_data: updatedCandidate.processed_resume_data,
            processed_at: updatedCandidate.processed_at,
            about_me: updatedCandidate.about_me,
            years_of_experience: updatedCandidate.years_of_experience,
            processing_cost: updatedCandidate.processing_cost,
          },
          source: CandidateAuditSource.system,
        });

        //call function to populate skills, education, experience....
        const populateDatas = await this.updateFromJson(id, transformedData);
        if (!populateDatas) {
          await this.updateStatus(id, 'failed', 'Failed to populate from JSON');
          return false;
        }

        //completed
        await this.updateStatus(id, 'completed');
      } catch (error) {
        console.error('Error in processData:', error);
        await this.updateStatus(
          id,
          'failed',
          error.message || 'Unknown processing error',
        );
        return false;
      } finally {
        // Cleanup
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
        // Optionally remove the original downloaded PDF too?
        const pdfPath = path.join(downloadDir, pdfName);
        if (fs.existsSync(pdfPath)) {
          fs.unlinkSync(pdfPath);
        }
      }
    } else {
      await this.updateStatus(id, 'failed', 'Resume URL not found');
      return false;
    }

    return true;
  }

  async getPipelines() {
    const pipelines = Object.entries(dbToStageDictionary).map(
      ([key, value]) => ({
        name: value,
      }),
    );
    if (!pipelines || pipelines.length === 0)
      throw new NotFoundException('No pipelines found');
    return pipelines;
  }

  async getProperties(data): Promise<any> {
    try {
      const fields = data.fields
        ? data.fields.split(',').map((field) => field.trim())
        : [];
      const result: Record<string, any> = {};
      let returned;

      for (const field of fields) {
        if (field === 'languages') {
          returned = await this.prisma.candidateLanguage.findMany({
            where: {
              candidate: {
                pipeline_status: {
                  in: ['1087596819', '261075105'],
                },
              },
            },
            select: {
              name: true,
            },
            distinct: ['name'],
          });
        } else if (field === 'skills') {
          returned = await this.prisma.candidateSkill.findMany({
            where: {
              candidate: {
                pipeline_status: {
                  in: ['1087596819', '261075105'],
                },
              },
              skill_name: {
                not: 'N/A',
              },
            },
            select: {
              skill_name: true,
            },
            distinct: ['skill_name'],
          });
        } else if (field === 'approved_positions_pairing') {
          /* it was moved to get the options from hubspot instead of the database, because we want to have all the options available even if they are not used by any candidate yet, and also to avoid having to filter the options that have "do not use" in the name, because they are already filtered in hubspot and we don't want to have them in our options list. But I'm leaving this here just in case we want to revert this decision in the future.
          returned = await this.prisma.candidate.findMany({
            where: {
              OR: [
                { pipeline_status: '261075105' },
                { pipeline_status: '1087596819' }
              ],
              approved_positions_pairing: { isEmpty: false },
            },

            select: {
              [field]: true
            },
          })

          const uniquePositions = [
            ...new Set(
              returned.flatMap((c) => c.approved_positions_pairing || [])
            ),
          ] as string[];

          const filteredPositions = uniquePositions.filter(
            (pos) => !pos.toLowerCase().includes('do not use')
          );
          returned = filteredPositions.sort();
          */
        } else if (!HUBSPOT_SOURCED_PROPERTY_FIELDS.has(field)) {
          returned = await this.prisma.candidate.findMany({
            where: {
              OR: [
                { pipeline_status: '261075105' },
                { pipeline_status: '1087596819' },
              ],
              AND: [
                {
                  [field]: {
                    not: null,
                  },
                },
                {
                  [field]: {
                    not: 'N/A',
                  },
                },
              ],
            },
            distinct: [field],
            select: {
              [field]: true,
            },
          });
        }

        if (field === 'specialization') {
          try {
            const url = `https://api.hubapi.com/crm/v3/properties/${process.env.HUBSPOT_CUSTOM_OBJECT}`;
            const response = await axios.get(url, {
              headers: {
                Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
              },
            });

            // The `specialization` column is written from HubSpot's
            // `practice_area_experience` property (see candidadeToDbDictionary),
            // so the filter options must come from that same property. It used
            // to read `career_highlights_relevant_job_experiences` — a different
            // property that feeds CandidateSkill — which made the dropdown offer
            // values no candidate has, while hiding real ones like "Urgent Care".
            const vaTypeProperty = response.data.results.find(
              (prop) => prop.name === 'practice_area_experience',
            );

            if (!vaTypeProperty) {
              return [];
            }
            const returnedSpecializations = vaTypeProperty.options
              .filter((option) => !option.hidden && option.value?.trim())
              .map((option) => option.value.trim());
            result[field] = returnedSpecializations || [];
            //return vaTypeProperty.options || [];
          } catch (error) {
            console.error(
              'Failed to find types:',
              error.response?.data || error.message,
            );
            throw new Error('Failed to find VA types');
          }
        } else if (field === 'shift_block') {
          try {
            const url = `https://api.hubapi.com/crm/v3/properties/${process.env.HUBSPOT_CUSTOM_OBJECT}`;
            const response = await axios.get(url, {
              headers: {
                Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
              },
            });

            const vaTypeProperty = response.data.results.find(
              (prop) => prop.name === 'shift_block',
            );

            if (!vaTypeProperty) {
              return [];
            }
            const returnedShiftBlocks = vaTypeProperty.options.map(
              (option) => option.value,
            );
            result[field] = returnedShiftBlocks || [];
            //return vaTypeProperty.options || [];
          } catch (error) {
            console.error(
              'Failed to find types:',
              error.response?.data || error.message,
            );
            throw new Error('Failed to find VA types');
          }
        } else if (field === 'tools') {
          try {
            const url = `https://api.hubapi.com/crm/v3/properties/${process.env.HUBSPOT_CUSTOM_OBJECT}`;
            const response = await axios.get(url, {
              headers: {
                Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
              },
            });

            const vaTypeProperty = response.data.results.find(
              (prop) => prop.name === 'tools',
            );

            if (!vaTypeProperty) {
              return [];
            }
            const returnedTools = vaTypeProperty.options
              .filter((option) => !option.hidden && option.value?.trim())
              .map((option) => ({
                label: option.label?.trim(),
                value: option.value?.trim(),
              }));
            result[field] = returnedTools || [];
          } catch (error) {
            console.error(
              'Failed to find types:',
              error.response?.data || error.message,
            );
            throw new Error('Failed to find VA types');
          }
        } else if (field === 'medical_tools') {
          try {
            const url = `https://api.hubapi.com/crm/v3/properties/${process.env.HUBSPOT_CUSTOM_OBJECT}`;
            const response = await axios.get(url, {
              headers: {
                Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
              },
            });

            const vaTypeProperty = response.data.results.find(
              (prop) => prop.name === 'medical_tools',
            );

            if (!vaTypeProperty) {
              return [];
            }
            const returnedMedicalTools = vaTypeProperty.options
              .filter((option) => !option.hidden && option.value?.trim())
              .map((option) => ({
                label: option.label?.trim(),
                value: option.value?.trim(),
              }));
            result[field] = returnedMedicalTools || [];
          } catch (error) {
            console.error(
              'Failed to find types:',
              error.response?.data || error.message,
            );
            throw new Error('Failed to find VA types');
          }
        } else if (field === 'approved_positions_pairing') {
          try {
            const url = `https://api.hubapi.com/crm/v3/properties/${process.env.HUBSPOT_CUSTOM_OBJECT}`;
            const response = await axios.get(url, {
              headers: {
                Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
              },
            });

            const vaTypeProperty = response.data.results.find(
              (prop) => prop.name === 'va_role_s',
            );

            if (!vaTypeProperty) {
              return [];
            }
            const returnedPositions = vaTypeProperty.options
              .filter((option) => !option.hidden && option.value?.trim())
              .filter(
                (option) => !option.value.toLowerCase().includes('do not use'),
              )
              .map((option) => ({
                label: option.label?.trim(),
                value: option.value?.trim(),
              }));
            result[field] = returnedPositions || [];
          } catch (error) {
            console.error(
              'Failed to find types:',
              error.response?.data || error.message,
            );
            throw new Error('Failed to find VA types');
          }
        } else {
          result[field] = returned;
        }
      }
      return result;
    } catch (error) {
      throw new BadRequestException(
        `Error fetching countries: ${error.message}`,
      );
    }
  }

  async updateStatusHubspot(
    id: string,
    data: updateStatusHubspotDTO,
  ): Promise<any> {
    if (!id) throw new BadRequestException('Candidate ID is required');
    if (!data || !data.status)
      throw new BadRequestException('Status data is required');

    const stageName = Object.entries(dbToStageDictionary).find(
      ([key, value]) => value.toLowerCase() === data.status?.toLowerCase(),
    )?.[0];
    if (!stageName) throw new BadRequestException('Invalid status provided');

    const candidate = await this.prisma.candidate.findUnique({
      where: { id: id },
      select: { hubspot_id: true, pipeline_status: true },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');

    const body = {
      properties: {
        hs_pipeline_stage: stageName,
      },
    };

    //communication with hubspot to update status can be added here
    const response = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/${process.env.HUBSPOT_CUSTOM_OBJECT}/${candidate.hubspot_id}`,
      body,
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    );

    if (response.status !== 200) {
      throw new BadGatewayException(
        'Failed to update candidate status in HubSpot',
      );
    }
    const updatedCandidate = await this.prisma.candidate.update({
      where: { id: id },
      data: {
        pipeline_status: stageName,
      },
    });
    if (!updatedCandidate)
      throw new BadGatewayException('Failed to update candidate status');

    void this.candidateAudit.log({
      candidateId: id,
      hubspotId: candidate.hubspot_id,
      event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
      fieldGroup: CandidateAuditFieldGroup.pipeline_status,
      before: { pipeline_status: candidate.pipeline_status },
      after: { pipeline_status: updatedCandidate.pipeline_status },
      source: CandidateAuditSource.user,
    });

    // R9 — remove from all OfferPanels when candidate becomes unavailable
    if (CandidatesService.UNAVAILABLE_PIPELINE_STATUSES.includes(stageName)) {
      await this.removeFromOfferPanels(id);
    }

    return { ...updatedCandidate, vaid: updatedCandidate.hubspot_vaid };
  }

  async showMatchHireRequests(
    user: USER,
    candidateId: string,
  ): Promise<object[]> {
    if (
      !user ||
      (user.role.includes('organization') && !user.organization_id)
    ) {
      throw new NotFoundException(
        'User not found or not part of an organization',
      );
    }

    const candidate = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      select: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        hourly_pay_rate: true,
        pipeline_status: true,
        country: true,
        specialization: true,
        employment_type: true,
        skills: { select: { skill_name: true, proficiency_level: true } },
      },
    });

    if (!candidate) throw new NotFoundException('Candidate not found');

    const hireRequests = await this.prisma.hireRequest.findMany({
      where: {
        status: 'sourcing',
        //assigned_user: user.role === 'system_admin' ? { is: { id: user.id } } : undefined,
        panels: {
          some: {
            panelCandidates: {},
          },
        },
      },
      select: {
        id: true,
        title: true,
        description: true,
        specialization: true,
        location: true,
        availability: true,
        salary_range_from: true,
        salary_range_to: true,
        organization: { select: { id: true, name: true } },
        skills: { select: { skill_name: true, required_level: true } },
        panels: {
          select: { id: true, _count: { select: { panelCandidates: true } } },
        },
      },
    });

    const HOURS = Number(process.env.CANDIDATE_HOUR_PER_MONTH ?? 176);
    const PERCENT = Number(process.env.CANDIDATE_PERCENT ?? 1);

    const candidateSkills = candidate.skills.map((s) => s.skill_name);

    const scoredHireRequests = hireRequests.map((hr) => {
      let score = 0;
      const matchedCriteria: string[] = [];

      const hrSpecialization = hr.specialization
        ? hr.specialization.split(';').map((s) => s.trim())
        : [];
      if (
        hrSpecialization.length > 0 &&
        candidate.specialization &&
        hrSpecialization.includes(candidate.specialization)
      ) {
        score += 3;
        matchedCriteria.push(`${candidate.specialization}`);
      }

      if (hr.location && candidate.country === hr.location) {
        score += 2;
        matchedCriteria.push(`${hr.location}`);
      }

      if (hr.availability && candidate.employment_type === hr.availability) {
        score += 2;
        matchedCriteria.push(`${hr.availability}`);
      }

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
      ) {
        score += 3;
        matchedCriteria.push(`Salary between range`);
      }

      const requiredSkills = hr.skills.map((s) => s.skill_name);
      const matchedSkills = candidateSkills.filter((skill) =>
        requiredSkills.includes(skill),
      );

      const skillMatchPercent =
        requiredSkills.length > 0
          ? matchedSkills.length / requiredSkills.length
          : 0;

      if (matchedSkills.length > 0) {
        matchedCriteria.push(...matchedSkills);
      }

      score += skillMatchPercent * 10;

      return {
        ...hr,
        matchedSkills,
        matchedCriteria,
        score: Math.round(score * 100) / 100,
      };
    });

    scoredHireRequests.sort((a, b) => b.score - a.score);
    return scoredHireRequests;
  }

  async endorseCandidate(
    data: EndorseCandidateDto,
    user: USER,
  ): Promise<boolean> {
    //console.log('Starting endorsement process for candidates:', data.candidatesId, 'to hire request:', data.hireRequestId);

    if (!data.candidatesId)
      throw new BadRequestException('Candidates ID is required');
    if (!data.hireRequestId)
      throw new BadRequestException('Hire Request ID is required');

    let panel = await this.prisma.candidatePanel.findFirst({
      where: { hire_request_id: data.hireRequestId },
      select: { id: true },
    });
    const panelJustCreated = !panel;
    if (!panel) {
      panel = await this.prisma.candidatePanel.create({
        data: {
          hire_request_id: data.hireRequestId,
          status: PanelStatus.created,
          readable: true,
        },
      });
    }

    // 48h panel-candidate minimum lead-time rule (organization users only —
    // keys on the ACTING user's role, not the hire request's origin; see
    // `common/utils/panel-candidate-lead-time.ts`). A freshly created panel
    // can have no interview yet, so it is skipped without a query.
    if (isClientOriginatedRole(user.role) && !panelJustCreated) {
      const activeInterview = await this.prisma.interview.findFirst({
        where: { panel_id: panel.id, status: 'scheduled' },
        orderBy: { scheduled_date: 'asc' },
        select: { scheduled_date: true },
      });

      if (
        activeInterview &&
        violatesPanelCandidateMinLead(activeInterview.scheduled_date)
      ) {
        try {
          await this.notifications.notifyPanelCandidateBlocked(
            data.hireRequestId,
            user.id,
            data.candidatesId,
          );
        } catch (err) {
          console.error(
            '[notifications] panel-candidate-blocked email failed',
            err?.message || err,
          );
        }
        throw new BadRequestException(PANEL_CANDIDATE_MIN_LEAD_ERROR);
      }
    }

    const candidates = await this.prisma.candidate.findMany({
      where: { id: { in: data.candidatesId } },
      select: {
        id: true,
        hubspot_id: true,
        pipeline_status: true,
      },
    });
    if (!candidates) throw new NotFoundException('Candidate not found');

    //verify if the candidates is within the panel already. If so, skip this specific candidate
    for (const candidate of candidates) {
      const existingPanelCandidate = await this.prisma.panelCandidate.findFirst(
        {
          where: {
            panel_id: panel.id,
            candidate_id: candidate.id,
          },
        },
      );

      if (existingPanelCandidate) {
        data.candidatesId = data.candidatesId.filter(
          (id) => id !== candidate.id,
        );
      }
    }

    const endorsement = await this.prisma.panelCandidate.createMany({
      data: data.candidatesId.map((candidateId) => ({
        panel_id: panel.id,
        candidate_id: candidateId,
        status: 'selected',
        createdByUserId: user.id,
      })),
    });

    if (!endorsement)
      throw new BadGatewayException('Failed to endorse candidate');

    try {
      if (user.role.includes('organization')) {
        const result = await this.notifications.notifyEndorseCandidates(
          data.hireRequestId,
        );
        console.log(
          `[notifications] Hire request endorsement notification sent successfully:`,
          result,
        );
      } else {
        console.log(
          `[notifications] Hire request endorsement skipped for user role: ${user.role}`,
        );
      }
    } catch (err) {
      console.error(
        '[notifications] hire-request-endorsement email failed',
        err?.message || err,
      );
    }

    return true;
  }

  async removeCandidate(
    data: RemoveCandidateDto,
    user: USER,
  ): Promise<{ success: boolean; shouldPromptCancel: boolean }> {
    if (!data.candidateId)
      throw new BadRequestException('Candidate ID is required');
    if (!data.hireRequestId)
      throw new BadRequestException('Hire Request ID is required');

    const candidate = await this.prisma.candidate.findUnique({
      where: { id: data.candidateId },
      select: {
        hubspot_id: true,
        pipeline_status_origin: true,
      },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');

    const hireRequest = await this.prisma.hireRequest.findUnique({
      where: { id: data.hireRequestId },
      select: { status: true },
    });
    if (!hireRequest) throw new NotFoundException('Hire request not found');

    const PANEL_READY_OR_ABOVE: HireRequestStatus[] = [
      'panel_ready',
      'interview_scheduled',
      'awaiting_decision',
      'placement_completed',
    ];

    const currentCount = await this.prisma.panelCandidate.count({
      where: { panel: { hire_request_id: data.hireRequestId } },
    });
    const wouldBeLastCandidate = currentCount === 1;

    if (wouldBeLastCandidate) {
      if (PANEL_READY_OR_ABOVE.includes(hireRequest.status)) {
        throw new BadRequestException(
          'Cannot remove the last candidate from a panel at this stage of the hire request',
        );
      }
      // Status is below panel_ready — signal frontend to open cancel modal without removing
      return { success: true, shouldPromptCancel: true };
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.panelCandidate.deleteMany({
          where: {
            candidate_id: data.candidateId,
            panel: {
              hire_request_id: data.hireRequestId,
            },
          },
        });

        //check if the candidate is in other panels with status selected_by_client or blocked.
        //if not, change pipeline_status to Available Candidates and update in hubspot
        const thereOtherPanels = await tx.panelCandidate.findMany({
          where: {
            candidate_id: data.candidateId,
            status: { in: ['selected_by_client', 'blocked'] },
            panel: { hire_request_id: { not: data.hireRequestId } },
          },
          select: { id: true },
        });

        if (thereOtherPanels.length === 0) {
          const pipelineStatus = Object.keys(dbToStageDictionary).find(
            (key) => dbToStageDictionary[key] === 'Available Candidates',
          );
          const pipeline_treated =
            candidate.pipeline_status_origin || pipelineStatus || '';

          await tx.candidate.update({
            where: { id: data.candidateId },
            data: { pipeline_status: pipeline_treated },
          });

          await this.hubspot.updateOneCandidateFromHireRequest(
            candidate.hubspot_id,
            pipeline_treated,
            user?.id,
            undefined,
            `Candidate removed from hire request ${data.hireRequestId} panel`,
          );
        }
      });

      return { success: true, shouldPromptCancel: false };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error('Error removing candidate from panel:', error);
      return { success: false, shouldPromptCancel: false };
    }
  }

  async removeCandidateAndCancel(
    data: RemoveCandidateAndCancelDto,
    user: USER,
  ): Promise<boolean> {
    if (!data.candidateId)
      throw new BadRequestException('Candidate ID is required');
    if (!data.hireRequestId)
      throw new BadRequestException('Hire Request ID is required');

    const hireRequest = await this.prisma.hireRequest.findUnique({
      where: { id: data.hireRequestId },
      select: { status: true },
    });
    if (!hireRequest) throw new NotFoundException('Hire request not found');

    const PANEL_READY_OR_ABOVE: HireRequestStatus[] = [
      'panel_ready',
      'interview_scheduled',
      'awaiting_decision',
      'placement_completed',
    ];
    if (PANEL_READY_OR_ABOVE.includes(hireRequest.status)) {
      throw new BadRequestException(
        'Cannot remove the last candidate from a panel at this stage of the hire request',
      );
    }

    const currentCount = await this.prisma.panelCandidate.count({
      where: { panel: { hire_request_id: data.hireRequestId } },
    });
    if (currentCount !== 1) {
      throw new BadRequestException(
        'This action is only allowed when removing the last candidate from a panel',
      );
    }

    const candidate = await this.prisma.candidate.findUnique({
      where: { id: data.candidateId },
      select: { hubspot_id: true, pipeline_status_origin: true },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.panelCandidate.deleteMany({
          where: {
            candidate_id: data.candidateId,
            panel: { hire_request_id: data.hireRequestId },
          },
        });

        const thereOtherPanels = await tx.panelCandidate.findMany({
          where: {
            candidate_id: data.candidateId,
            status: { in: ['selected_by_client', 'blocked'] },
            panel: { hire_request_id: { not: data.hireRequestId } },
          },
          select: { id: true },
        });

        if (thereOtherPanels.length === 0) {
          const pipelineStatus = Object.keys(dbToStageDictionary).find(
            (key) => dbToStageDictionary[key] === 'Available Candidates',
          );
          const pipeline_treated =
            candidate.pipeline_status_origin || pipelineStatus || '';

          await tx.candidate.update({
            where: { id: data.candidateId },
            data: { pipeline_status: pipeline_treated },
          });

          await this.hubspot.updateOneCandidateFromHireRequest(
            candidate.hubspot_id,
            pipeline_treated,
            user?.id,
            undefined,
            `Last candidate removed from hire request ${data.hireRequestId} panel — cancellation initiated`,
          );
        }
      });

      await this.hireRequest.updateStatus(
        data.hireRequestId,
        {
          status: 'cancelled',
          reason: data.reason,
          staffing_coordinator: data.staffing_coordinator,
          pairing_session_conducted: data.pairing_session_conducted,
          pairing_session_outcome_reason: data.pairing_session_outcome_reason,
          count_of_candidates_invited_: data.count_of_candidates_invited_,
          count_of_candidates_attended_: data.count_of_candidates_attended_,
          count_of_candidates_interviewed_:
            data.count_of_candidates_interviewed_,
          client_signed_contract_closing_ticket:
            data.client_signed_contract_closing_ticket,
        },
        user,
      );

      return true;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(
        'Error removing last candidate and cancelling hire request:',
        error,
      );
      return false;
    }
  }

  async processAllAvatars(): Promise<boolean> {
    const candidates = await this.prisma.candidate.findMany({
      where: {
        headshot_url: {
          contains: 'http',
        },
        avatar_url: null,
        pipeline_status: {
          in: ['261075105', '1087596819'],
        },
      },
      select: {
        id: true,
        headshot_url: true,
      },
    });
    if (!candidates || candidates.length === 0) {
      console.log(
        'No candidates found with headshot_url and without avatar_url',
      );
      return true;
    }

    for (const candidate of candidates) {
      console.log(`Processing avatar for candidate ID: ${candidate.id}`);
      try {
        const result = await this.processAvatar(candidate.id);
        if (result) {
          console.log(
            `Successfully processed avatar for candidate ID: ${candidate.id}`,
          );
        } else {
          console.log(
            `Failed to process avatar for candidate ID: ${candidate.id}`,
          );
        }
      } catch (error) {
        console.error(
          `Error processing avatar for candidate ID: ${candidate.id}`,
          error,
        );
      }
    }
    return true;
  }

  async getRandomTalentPoolCandidates(business_unit: string): Promise<any> {
    // Pool-based candidate visibility (preserves today's behavior exactly):
    // non_medical BUs (Berry today) are restricted to non_medical BUs'
    // hubspot values; every other BU (MedVirtual, MMVA, future medical BUs)
    // sees all candidates — i.e. no business_unit filter is applied.
    const businessUnitFilterValues =
      await this.getBusinessUnitFilterValues(business_unit);

    // Base filter for "available" candidates in talent pool
    const pipelineStatusFilter = {
      pipeline_status: {
        in: ['261075105', '1087596819'],
      },
    };

    // Filtros adicionales solo para obtener los candidatos que se muestran
    const whereClauseForCandidates = {
      AND: [
        {
          avatar_url: { not: null },
        },
        {
          specialization: {
            not: null,
          },
        },
        {
          specialization: {
            not: 'N/A',
          },
        },
        {
          business_unit: businessUnitFilterValues
            ? { in: businessUnitFilterValues }
            : undefined,
        },
        {
          // Solo candidatos disponibles
          ...pipelineStatusFilter,
        },
      ],
    };

    // Para el conteo total de candidatos disponibles, solo usamos el filtro por pipeline_status
    const whereClauseForCount = {
      AND: [
        { ...pipelineStatusFilter },
        {
          business_unit: businessUnitFilterValues
            ? { in: businessUnitFilterValues }
            : undefined,
        },
      ],
    };

    // Get total count of available candidates (only by pipeline_status)
    const [candidates, totalTableCount] = await this.prisma.$transaction([
      this.prisma.candidate.findMany({
        where: whereClauseForCandidates,
        select: {
          id: true,
          hubspot_id: true,
          hubspot_vaid: true,
          first_name: true,
          last_name: true,
          name: true,
          country: true,
          employment_type: true,
          hourly_pay_rate: true,
          years_of_experience: true,
          about_me: true,
          specialization: true,
          tools: true,
          medical_tools: true,
          avatar_url: true,
          gender: true,
          shift_block: true,
          video_link: true,
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
          experiences: {
            orderBy: { start_date: Prisma.SortOrder.desc },
            select: {
              company: true,
              position: true,
              start_date: true,
              end_date: true,
              responsabilities: true,
            },
          },
          approved_positions_pairing: true,
          business_unit: true,
        },
      }),
      this.prisma.candidate.count({ where: whereClauseForCount }), // Count available candidates only by pipeline_status
    ]);

    // Shuffle array to get random candidates
    const shuffled = candidates.sort(() => 0.5 - Math.random());

    // Get first 25 candidates
    const randomCandidates = shuffled.slice(0, 25);

    // Map pipeline_status to readable format if needed
    // Note: We're not including pipeline_status in the select, so it won't be in the response

    // Construct full avatar URL for each candidate and calculate salary
    const AVATAR_BASE_URL =
      'https://medvirtual-avatar.s3.us-east-1.amazonaws.com/';
    const _pConfigs2 =
      await this.positionRateConfigService.findAllUnpaginated();
    const _configMap2 = buildConfigMap(_pConfigs2);
    const _poolMap2 = await this.buildCandidatePoolMap(randomCandidates);
    const candidatesWithFullAvatarUrl = randomCandidates.map((candidate) => {
      const rates = computeCandidateRates(
        candidate,
        _configMap2,
        _poolMap2.get(candidate.business_unit ?? '') ?? 'medical',
      );
      return {
        ...candidate,
        vaid: candidate.hubspot_vaid,
        avatar_url: candidate.avatar_url
          ? `${AVATAR_BASE_URL}${candidate.avatar_url}`
          : null,
        employment_type:
          changeLabelAvailability(
            dbToStageDictionary[Number(candidate.employment_type)],
          ) || candidate.employment_type,
        approved_positions_pairing:
          candidate.approved_positions_pairing?.map(getApprovedPositionLabel) ||
          [],
        ...rates,
      };
    });

    return {
      candidates: candidatesWithFullAvatarUrl,
      total: totalTableCount, // Return count of available candidates with filters
      totalTable: totalTableCount,
    };
  }

  async getTalentPoolCandidateById(id: string): Promise<any> {
    // Validate ID
    if (!id || id.trim() === '') {
      throw new BadRequestException('Invalid candidate ID');
    }

    // Search candidate by ID without any filters
    const candidate = await this.prisma.candidate.findUnique({
      where: { id: id.trim() },
      select: {
        id: true,
        hubspot_vaid: true,
        hubspot_id: true,
        first_name: true,
        last_name: true,
        name: true,
        country: true,
        employment_type: true,
        hourly_pay_rate: true,
        years_of_experience: true,
        about_me: true,
        specialization: true,
        tools: true,
        medical_tools: true,
        avatar_url: true,
        gender: true,
        shift_block: true,
        video_link: true,
        // VA Score Card fields
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
        // Core Skills fields (HubSpot VA Score Card extended)
        quickbooks: true,
        other_accounting_software: true,
        chart_of_accounts_setup___maintenance: true,
        transaction_categorization: true,
        bank__credit_card_reconciliations: true,
        accounts_payable_ap: true,
        accounts_receivable_ar: true,
        payroll_posting__reconciliation_not_processing_unless_required: true,
        payroll_posting: true,
        monthend_close: true,
        journal_entries__adjustments: true,
        balance_sheet: true,
        pl: true,
        accrual_vs_cash_understanding: true,
        prepare_books_for_cpatax_handoff: true,
        client_communication: true,
        account_reconciliation: true,
        financial_analysis: true,
        financial_reporting: true,
        total_score_bookkeeping: true,
        notes_bookkeeping: true,
        patient_scheduling__calendar_management: true,
        insurance_verification_eligibility__benefits: true,
        prior_authorizations__referrals: true,
        inbound_call_handling__patient_support: true,
        outbound_calls_recalls_noshows_followups: true,
        emrehr_data_entry__chart_updating: true,
        patient_intake__demographics_documentation_accuracy: true,
        referrals_sending_receiving_tracking: true,
        total_score_medical__dental_admin: true,
        notes_medical__dental_admin: true,
        n2_years_healthcare_billing_experience: true,
        total_years_on_healthcare_billing_experience: true,
        patient_phone_communication: true,
        role_type: true,
        insurance_verification_knowledge: true,
        prior_authorizations_experience: true,
        cpt__icd10_coding: true,
        charge_entry: true,
        claim_generation: true,
        claim_submission: true,
        denial_management: true,
        insurance_followup: true,
        ar_management: true,
        payment_posting: true,
        identifying_underpayments: true,
        medicaldental_biller_total_percentage_score: true,
        notes_medical__dental_biller: true,
        consultative_selling: true,
        fullcycle_sales: true,
        objection_handling__negotiation: true,
        virtual_demos__presentations: true,
        pipeline_management: true,
        closing_sales: true,
        total_score_sales_executive: true,
        notes_sales_executive: true,
        lead_research__qualification: true,
        crm_proficiency: true,
        outbound_prospecting_emaillvcalls: true,
        cold_calling: true,
        appointment_setting: true,
        kpi_awareness__tracking: true,
        total_score_sales_development_representative_sdr: true,
        notes_sales_development_representative_sdr: true,
        client_relationship_management: true,
        retention_strategy: true,
        upsell__crosssell: true,
        account_onboarding: true,
        issue_resolution: true,
        total_score_sales__account_manager: true,
        notes_sales__account_manager: true,
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
        experiences: {
          orderBy: { start_date: Prisma.SortOrder.desc },
          select: {
            company: true,
            position: true,
            start_date: true,
            end_date: true,
            responsabilities: true,
          },
        },
        approved_positions_pairing: true,
        business_unit: true,
        panelCandidates: {
          select: {
            id: true,
            status: true,
            panel: {
              select: {
                hire_request_id: true,
                hireRequest: {
                  select: {
                    id: true,
                    title: true,
                    status: true,
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

    if (!candidate) {
      throw new NotFoundException('Candidate not found');
    }

    // Construct full avatar URL and calculate salary
    const AVATAR_BASE_URL =
      'https://medvirtual-avatar.s3.us-east-1.amazonaws.com/';

    // Normalize employment_type: handle array or string with multiple values (similar to objectCreation.ts)
    let employmentTypeValue = candidate.employment_type;
    if (Array.isArray(employmentTypeValue)) {
      employmentTypeValue = employmentTypeValue[0];
    } else if (
      typeof employmentTypeValue === 'string' &&
      employmentTypeValue.includes(';')
    ) {
      employmentTypeValue = employmentTypeValue.split(';')[0].trim();
    }

    // Apply the same transformation as in findOne and other places
    const transformedEmploymentType =
      changeLabelAvailability(
        dbToStageDictionary[Number(employmentTypeValue)],
      ) || employmentTypeValue;

    const _pConfigs3 =
      await this.positionRateConfigService.findAllUnpaginated();
    const _configMap3 = buildConfigMap(_pConfigs3);
    const _candidatePool3 =
      (await this.businessUnitContext.poolFor(candidate.business_unit ?? '')) ??
      'medical';
    const rates3 = computeCandidateRates(
      candidate as any,
      _configMap3,
      _candidatePool3,
    );

    const candidateWithFullAvatarUrl = {
      ...candidate,
      vaid: candidate.hubspot_vaid,
      avatar_url: candidate.avatar_url
        ? `${AVATAR_BASE_URL}${candidate.avatar_url}`
        : null,
      employment_type: transformedEmploymentType,
      approved_positions_pairing:
        candidate.approved_positions_pairing?.map(getApprovedPositionLabel) ||
        [],
      ...rates3,
    };

    return candidateWithFullAvatarUrl;
  }

  /**
   * Card-level payload for many candidates in TWO queries, regardless of how
   * many ids are passed.
   *
   * This is the batch counterpart of `getTalentPoolCandidateById`, which list
   * endpoints must use instead of calling that method in a loop: each call
   * there re-reads the whole `PositionRateConfig` table, so a per-candidate
   * fan-out turned a single offer-panels request into thousands of queries.
   *
   * Unlike `getTalentPoolCandidateById`, unknown ids are simply absent from the
   * returned map rather than throwing — a list must not 404 because one row
   * references a deleted candidate.
   */
  async getTalentPoolCandidatesByIds(ids: string[]): Promise<Map<string, any>> {
    const uniqueIds = Array.from(
      new Set(ids.map((id) => id?.trim()).filter((id): id is string => !!id)),
    );
    if (uniqueIds.length === 0) return new Map();

    const [candidates, positionConfigs] = await Promise.all([
      this.prisma.candidate.findMany({
        where: { id: { in: uniqueIds } },
        select: CANDIDATE_LIST_CARD_SELECT,
      }),
      // Read once for the whole batch, not once per candidate.
      this.positionRateConfigService.findAllUnpaginated(),
    ]);

    const configMap = buildConfigMap(positionConfigs);
    const poolMap = await this.buildCandidatePoolMap(candidates);

    return new Map(
      candidates.map((candidate) => [
        candidate.id,
        this.toCardCandidate(
          candidate,
          configMap,
          poolMap.get(candidate.business_unit ?? '') ?? 'medical',
        ),
      ]),
    );
  }

  /**
   * Applies the same transformations as `getTalentPoolCandidateById` so a card
   * renders identically whether it came from the batch or the single-id path.
   *
   * Order matters: `computeCandidateRates` labels the positions itself and
   * reads the raw `employment_type`, so it MUST run before either field is
   * normalized for display. Reversing these steps yields wrong billing rates
   * without raising an error.
   */
  private toCardCandidate(
    candidate: Prisma.CandidateGetPayload<{
      select: typeof CANDIDATE_LIST_CARD_SELECT;
    }>,
    configMap: Parameters<typeof computeCandidateRates>[1],
    candidatePool: CandidatePool,
  ): any {
    const AVATAR_BASE_URL =
      'https://medvirtual-avatar.s3.us-east-1.amazonaws.com/';

    // 1. Rates first — needs the raw employment_type and unlabelled positions.
    const rates = computeCandidateRates(candidate, configMap, candidatePool);

    // 2. Then normalize employment_type for display (array, or ";"-joined).
    let employmentTypeValue: unknown = candidate.employment_type;
    if (Array.isArray(employmentTypeValue)) {
      employmentTypeValue = employmentTypeValue[0];
    } else if (
      typeof employmentTypeValue === 'string' &&
      employmentTypeValue.includes(';')
    ) {
      employmentTypeValue = employmentTypeValue.split(';')[0].trim();
    }
    const transformedEmploymentType =
      changeLabelAvailability(
        dbToStageDictionary[Number(employmentTypeValue)],
      ) || employmentTypeValue;

    // 3. And finally map the positions to their display labels.
    return {
      ...candidate,
      vaid: candidate.hubspot_vaid,
      avatar_url: candidate.avatar_url
        ? `${AVATAR_BASE_URL}${candidate.avatar_url}`
        : null,
      employment_type: transformedEmploymentType,
      approved_positions_pairing:
        candidate.approved_positions_pairing?.map(getApprovedPositionLabel) ||
        [],
      ...rates,
    };
  }

  async getTalentPoolCandidateByIdForLoggedUser(
    id: string,
    user: USER,
  ): Promise<any> {
    // Validate ID
    if (!id || id.trim() === '') {
      throw new BadRequestException('Invalid candidate ID');
    }

    console.log(`Fetching candidate with ID: ${user}`);
    const organizationId = user?.organization_id ?? null;

    // Search candidate by ID without any filters
    const candidate = await this.prisma.candidate.findUnique({
      where: { id: id.trim() },
      select: {
        id: true,
        hubspot_vaid: true,
        hubspot_id: true,
        first_name: true,
        last_name: true,
        name: true,
        country: true,
        employment_type: true,
        hourly_pay_rate: true,
        years_of_experience: true,
        about_me: true,
        specialization: true,
        tools: true,
        medical_tools: true,
        avatar_url: true,
        gender: true,
        shift_block: true,
        video_link: true,
        // VA Score Card fields
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
        // Core Skills fields (HubSpot VA Score Card extended)
        quickbooks: true,
        other_accounting_software: true,
        chart_of_accounts_setup___maintenance: true,
        transaction_categorization: true,
        bank__credit_card_reconciliations: true,
        accounts_payable_ap: true,
        accounts_receivable_ar: true,
        payroll_posting__reconciliation_not_processing_unless_required: true,
        payroll_posting: true,
        monthend_close: true,
        journal_entries__adjustments: true,
        balance_sheet: true,
        pl: true,
        accrual_vs_cash_understanding: true,
        prepare_books_for_cpatax_handoff: true,
        client_communication: true,
        account_reconciliation: true,
        financial_analysis: true,
        financial_reporting: true,
        total_score_bookkeeping: true,
        notes_bookkeeping: true,
        patient_scheduling__calendar_management: true,
        insurance_verification_eligibility__benefits: true,
        prior_authorizations__referrals: true,
        inbound_call_handling__patient_support: true,
        outbound_calls_recalls_noshows_followups: true,
        emrehr_data_entry__chart_updating: true,
        patient_intake__demographics_documentation_accuracy: true,
        referrals_sending_receiving_tracking: true,
        total_score_medical__dental_admin: true,
        notes_medical__dental_admin: true,
        n2_years_healthcare_billing_experience: true,
        total_years_on_healthcare_billing_experience: true,
        patient_phone_communication: true,
        role_type: true,
        insurance_verification_knowledge: true,
        prior_authorizations_experience: true,
        cpt__icd10_coding: true,
        charge_entry: true,
        claim_generation: true,
        claim_submission: true,
        denial_management: true,
        insurance_followup: true,
        ar_management: true,
        payment_posting: true,
        identifying_underpayments: true,
        medicaldental_biller_total_percentage_score: true,
        notes_medical__dental_biller: true,
        consultative_selling: true,
        fullcycle_sales: true,
        objection_handling__negotiation: true,
        virtual_demos__presentations: true,
        pipeline_management: true,
        closing_sales: true,
        total_score_sales_executive: true,
        notes_sales_executive: true,
        lead_research__qualification: true,
        crm_proficiency: true,
        outbound_prospecting_emaillvcalls: true,
        cold_calling: true,
        appointment_setting: true,
        kpi_awareness__tracking: true,
        total_score_sales_development_representative_sdr: true,
        notes_sales_development_representative_sdr: true,
        client_relationship_management: true,
        retention_strategy: true,
        upsell__crosssell: true,
        account_onboarding: true,
        issue_resolution: true,
        total_score_sales__account_manager: true,
        notes_sales__account_manager: true,
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
        experiences: {
          orderBy: { start_date: Prisma.SortOrder.desc },
          select: {
            company: true,
            position: true,
            start_date: true,
            end_date: true,
            responsabilities: true,
          },
        },
        approved_positions_pairing: true,
        business_unit: true,
        panelCandidates: {
          // Org-scoped: see the note in `findAll`.
          where: organizationId
            ? { panel: { hireRequest: { org_id: organizationId } } }
            : undefined,
          select: {
            id: true,
            status: true,
            panel: {
              select: {
                hire_request_id: true,
                hireRequest: {
                  select: {
                    id: true,
                    title: true,
                    status: true,
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

    if (!candidate) {
      throw new NotFoundException('Candidate not found');
    }

    // Construct full avatar URL and calculate salary
    const AVATAR_BASE_URL =
      'https://medvirtual-avatar.s3.us-east-1.amazonaws.com/';

    // Normalize employment_type: handle array or string with multiple values (similar to objectCreation.ts)
    let employmentTypeValue = candidate.employment_type;
    if (Array.isArray(employmentTypeValue)) {
      employmentTypeValue = employmentTypeValue[0];
    } else if (
      typeof employmentTypeValue === 'string' &&
      employmentTypeValue.includes(';')
    ) {
      employmentTypeValue = employmentTypeValue.split(';')[0].trim();
    }

    // Apply the same transformation as in findOne and other places
    const transformedEmploymentType =
      changeLabelAvailability(
        dbToStageDictionary[Number(employmentTypeValue)],
      ) || employmentTypeValue;

    const _pConfigs3 =
      await this.positionRateConfigService.findAllUnpaginated();
    const _configMap3 = buildConfigMap(_pConfigs3);
    const _candidatePool3 =
      (await this.businessUnitContext.poolFor(candidate.business_unit ?? '')) ??
      'medical';
    const rates3 = computeCandidateRates(
      candidate,
      _configMap3,
      _candidatePool3,
    );

    const candidateWithFullAvatarUrl = {
      ...candidate,
      vaid: candidate.hubspot_vaid,
      avatar_url: candidate.avatar_url
        ? `${AVATAR_BASE_URL}${candidate.avatar_url}`
        : null,
      employment_type: transformedEmploymentType,
      approved_positions_pairing:
        candidate.approved_positions_pairing?.map(getApprovedPositionLabel) ||
        [],
      ...rates3,
      existingInOtherClientPanel: isInClientOpenPanel(
        candidate.panelCandidates,
        organizationId,
      ),
    };

    return candidateWithFullAvatarUrl;
  }

  async syncBusinessUnits(): Promise<string> {
    const candidates = await this.prisma.candidate.findMany({
      where: {
        pipeline_status: {
          in: ['261075105', '1087596819'],
        },
      },
      select: {
        id: true,
        hubspot_id: true,
        business_unit: true,
      },
    });

    console.log(
      `Found ${candidates.length} candidates to sync business units.`,
    );
    let updatedCount = 0;
    let errorCount = 0;

    for (const candidate of candidates) {
      try {
        const response = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/${process.env.HUBSPOT_CUSTOM_OBJECT}/${candidate.hubspot_id}`,
          {
            params: {
              properties: 'business_units',
            },
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            },
          },
        );

        const businessUnit = response.data.properties.business_units;

        console.log(
          `Candidate ID: ${candidate.id}, HubSpot ID: ${candidate.hubspot_id}, Business Unit from HubSpot: ${businessUnit}`,
        );

        if (businessUnit) {
          await this.prisma.candidate.update({
            where: { id: candidate.id },
            data: {
              business_unit: businessUnit,
            },
          });

          void this.candidateAudit.log({
            candidateId: candidate.id,
            hubspotId: candidate.hubspot_id,
            event: CANDIDATE_AUDIT_EVENTS.BUSINESS_UNIT_SYNCED,
            fieldGroup: CandidateAuditFieldGroup.business_unit,
            before: { business_unit: candidate.business_unit },
            after: { business_unit: businessUnit },
            source: CandidateAuditSource.cron,
          });

          updatedCount++;
        }
      } catch (error) {
        console.error(
          `Failed to sync business unit for candidate ${candidate.id} (HubSpot ID: ${candidate.hubspot_id}):`,
          error.message,
        );
        errorCount++;
      }
    }

    return `Sync complete. Updated: ${updatedCount}, Errors: ${errorCount}`;
  }

  async syncVaScoreCardFields(): Promise<string> {
    const vaScoreCardProperties = [
      'active_listening_and_comprehension_demonstrated',
      'adaptability_to_different_client_personalities_and_workflows',
      'can_articulate_experience_clearly_to_clients',
      'can_multitask_between_systems_or_windows_efficiently',
      'client_readiness___fit_evaluator_notes',
      'comfortable_with_basic_tools__google_workspace__zoom__ehr_software_',
      'comfortable_with_camera_on_setup',
      'communication_skills_evaluator_notes',
      'confident_on_video_and_phone_calls',
      'cultural_alignment_with_us_healthcare_environment',
      'demonstrates_problem_solving_and_tech_adaptability',
      'demonstrates_stability_and_commitment',
      'demonstrates_understanding_of_medical_terminology_and_procedures',
      'exhibits_confidence_and_empathy_in_roleplay_scenarios',
      'familiarity_with_emr_ehr_systems__kareo__athena__eclinicalworks__etc__',
      'for_bilinguals__fluent_and_accurate_in_both_english_and_spanish',
      'grammar__vocabulary__and_tone_are_appropriate_for_us_clients',
      'handles_feedback_constructively',
      'has_functioning_headset__webcam__and_backup_device',
      'knowledge_of_hipaa_compliance_and_confidentiality',
      'medical_knowledge_evaluator_notes',
      'no_medical_industry_experience',
      'positive_attitude_and_professional_demeanor',
      'prior_experience_in_healthcare_or_medical_va_roles',
      'professionalism___work_readiness_evaluator_notes',
      'punctual_and_responsive_during_recruitment_stages',
      'remote_work_discipline_and_time_management',
      'speaks_clearly_and_professionally',
      'stable_internet_connection__min__20_mbps_',
      'technical_competence_evaluator_notes',
      'tier_level',
      'total_points',
      'understands_workflow_in_medical_offices___telehealth_environments',
    ];

    const candidates = await this.prisma.candidate.findMany({
      where: {
        pipeline_status: {
          in: ['261075105', '1087596819'],
        },
      },
      select: {
        id: true,
        hubspot_id: true,
        ...vaScoreCardProperties.reduce<Record<string, true>>((acc, prop) => {
          acc[prop] = true;
          return acc;
        }, {}),
      },
    });

    console.log(
      `Found ${candidates.length} available candidates to sync VA Score Card fields.`,
    );
    let updatedCount = 0;
    let errorCount = 0;

    for (const candidate of candidates) {
      try {
        const response = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/${process.env.HUBSPOT_CUSTOM_OBJECT}/${candidate.hubspot_id}`,
          {
            params: {
              properties: vaScoreCardProperties.join(','),
            },
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            },
          },
        );

        const properties = response.data.properties;
        console.log(
          'Properties fetched from HubSpot for candidate ID:',
          candidate.id,
          properties,
        );

        const updateData: Record<string, string | null> = {};
        for (const prop of vaScoreCardProperties) {
          updateData[prop] = properties[prop] || null;
        }

        const beforeScoreCard: Record<string, unknown> = {};
        for (const prop of vaScoreCardProperties) {
          beforeScoreCard[prop] = (candidate as Record<string, unknown>)[prop];
        }

        await this.prisma.candidate.update({
          where: { id: candidate.id },
          data: updateData,
        });

        void this.candidateAudit.log({
          candidateId: candidate.id,
          hubspotId: candidate.hubspot_id,
          event: CANDIDATE_AUDIT_EVENTS.VA_SCORECARD_SYNCED,
          fieldGroup: CandidateAuditFieldGroup.va_scorecard,
          before: beforeScoreCard,
          after: updateData,
          source: CandidateAuditSource.cron,
        });

        updatedCount++;
      } catch (error) {
        console.error(
          `Failed to sync VA Score Card fields for candidate ${candidate.id} (HubSpot ID: ${candidate.hubspot_id}):`,
          error.message,
        );
        errorCount++;
      }
    }

    return `Sync complete. Updated: ${updatedCount}, Errors: ${errorCount}`;
  }

  /**
   * One-way sync (HubSpot → Postgres) for the Core Skills fields — the 6
   * VA Score Card extended sections (Bookkeeping, Medical/Dental Admin,
   * Medical/Dental Biller, Sales Executive, SDR, Sales & Account Manager).
   * Mirrors `syncVaScoreCardFields()` above but for the newer property group.
   */
  async syncCoreSkillsFields(): Promise<string> {
    const coreSkillsProperties = CORE_SKILLS_SYNC_FIELDS;

    const candidates = await this.prisma.candidate.findMany({
      where: {
        pipeline_status: {
          in: ['261075105', '1087596819'],
        },
      },
      select: {
        id: true,
        hubspot_id: true,
        ...coreSkillsProperties.reduce<Record<string, true>>((acc, prop) => {
          acc[prop] = true;
          return acc;
        }, {}),
      },
    });

    console.log(
      `Found ${candidates.length} available candidates to sync Core Skills fields.`,
    );
    let updatedCount = 0;
    let errorCount = 0;

    for (const candidate of candidates) {
      try {
        const response = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/${process.env.HUBSPOT_CUSTOM_OBJECT}/${candidate.hubspot_id}`,
          {
            params: {
              properties: coreSkillsProperties.join(','),
            },
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            },
          },
        );

        const properties = response.data.properties;
        console.log(
          'Core Skills properties fetched from HubSpot for candidate ID:',
          candidate.id,
          properties,
        );

        const updateData: Record<string, string | null> = {};
        for (const prop of coreSkillsProperties) {
          updateData[prop] = properties[prop] || null;
        }

        const beforeCoreSkills: Record<string, unknown> = {};
        for (const prop of coreSkillsProperties) {
          beforeCoreSkills[prop] = (candidate as Record<string, unknown>)[prop];
        }

        await this.prisma.candidate.update({
          where: { id: candidate.id },
          data: updateData,
        });

        void this.candidateAudit.log({
          candidateId: candidate.id,
          hubspotId: candidate.hubspot_id,
          event: CANDIDATE_AUDIT_EVENTS.VA_SCORECARD_SYNCED,
          fieldGroup: CandidateAuditFieldGroup.va_scorecard,
          before: beforeCoreSkills,
          after: updateData,
          source: CandidateAuditSource.cron,
        });

        updatedCount++;
      } catch (error) {
        console.error(
          `Failed to sync Core Skills fields for candidate ${candidate.id} (HubSpot ID: ${candidate.hubspot_id}):`,
          error.message,
        );
        errorCount++;
      }
    }

    return `Sync complete. Updated: ${updatedCount}, Errors: ${errorCount}`;
  }
}
