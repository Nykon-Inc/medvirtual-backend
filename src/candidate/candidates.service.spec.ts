import { Test, TestingModule } from '@nestjs/testing';
import { BadGatewayException, BadRequestException, Logger, NotFoundException } from '@nestjs/common';

import { CandidatesService } from './candidates.service';
import { HubspotService } from '../hubspot/hubspot.service';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { GoogledriveService } from '../googledrive/googledrive.service';
import { OpenaiService } from '../openai/openai.service';
import axios from 'axios';
import { MailService } from '../mail/mail.service';
import { HireRequestService } from '../hire-request/hire-request.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { CandidateAuditService } from './candidate-audit.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('node-poppler', () => {
  return {
    Poppler: jest.fn().mockImplementation(() => {
      return {
        pdfToCairo: jest.fn().mockResolvedValue('converted'),
      };
    }),
  };
});

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  rmSync: jest.fn(),
  unlinkSync: jest.fn(),
  readdirSync: jest.fn(),
}));
import * as fs from 'fs';


const mockPrisma = {
  candidate: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  candidateLanguage: {
    findMany: jest.fn(),
  },
  candidateSkill: {
    findMany: jest.fn(),
    groupBy: jest.fn(),
  },
  candidateExperience: {
    createMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  candidateEducation: {
    createMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  hireRequest: {
    findUnique: jest.fn(),
  },
  panelCandidate: {
    count: jest.fn(),
  },
  organization: {
    findUnique: jest.fn(),
  },
  ticket: {
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

const businessUnitContextMock = {
  getVisibleHubspotValues: jest.fn(),
  isAllowedHubspotValue: jest.fn(),
  resolveByHubspotValue: jest.fn(),
  poolFor: jest.fn(),
  displayToSlug: jest.fn(),
  normalizeBusinessUnit: jest.fn(),
  bustCache: jest.fn(),
};

const candidateAuditMock = {
  log: jest.fn(),
  logOrThrow: jest.fn(),
  logMany: jest.fn(),
};

const textractMock = {
  startTextractJob: jest.fn(),
  getTextractResult: jest.fn(),
}

const s3Mock = {
  uploadFile: jest.fn(),
  getFile: jest.fn(),
  deleteFile: jest.fn(),
}

const googleMock = {
  downloadFile: jest.fn(),
}

const openAIMock = {
  organizeText: jest.fn(),
}

const hubspotMock = {
  updateContact: jest.fn(),
  updateOneCandidateFromHireRequest: jest.fn(),
}

const MailMock = {
  sendEmail: jest.fn(),
}

const HireRequestMock = {
  updateStatus: jest.fn(),
}

const notificationsMock = {
  notifyEndorseCandidates: jest.fn(),
}

const positionRateConfigMock = {
  findAll: jest.fn().mockResolvedValue({ status: 200, data: [], meta: { total: 0, page: 1, perPage: 10, totalPages: 0 } }),
  findAllUnpaginated: jest.fn().mockResolvedValue([]),
}

describe('CandidatesService', () => {
  let service: CandidatesService;
  let prisma: PrismaService;


  const mockUser = {
    id: 'user-1',
    organization_id: 'org-1',
    role: 'organization_admin',
  } as any; // Cast as USER

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidatesService,
        { provide: PrismaService, useValue: mockPrisma, },
        { provide: S3Service, useValue: s3Mock },
        { provide: GoogledriveService, useValue: googleMock },
        { provide: OpenaiService, useValue: openAIMock },
        { provide: HubspotService, useValue: hubspotMock },
        { provide: MailService, useValue: MailMock },
        { provide: HireRequestService, useValue: HireRequestMock },
        { provide: NotificationsService, useValue: notificationsMock },
        { provide: PositionRateConfigService, useValue: positionRateConfigMock },
        { provide: BusinessUnitContext, useValue: businessUnitContextMock },
        { provide: CandidateAuditService, useValue: candidateAuditMock },
        { provide: Logger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } },
      ],
    }).compile();

    service = module.get<CandidatesService>(CandidatesService);
    prisma = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();

    // Default: no restriction (medical pool), mirrors current MedVirtual/MMVA behavior
    businessUnitContextMock.poolFor.mockResolvedValue('medical');
    businessUnitContextMock.getVisibleHubspotValues.mockResolvedValue([
      'MedVirtual',
      'Berry Virtual',
      'MMVA',
    ]);
  });

  describe.skip('findAll', () => {
    it('should return all candidates without filters and transform pipeline_status', async () => {
      const mockCandidates = [
        { id: '1', pipeline_status: '261075105' },
        { id: '2', pipeline_status: '1087596819' }
      ];
      const mockTotal = 2;

      mockPrisma.$transaction.mockResolvedValue([mockCandidates, mockTotal]);

      const result = await service.findAll(mockUser);

      expect(result).toEqual({
        data: [
          { id: '1', pipeline_status: 'Available Candidates' },
          { id: '2', pipeline_status: 'Available Candidates - Part Time' }
        ],
        meta: {
          total: mockTotal,
          page: 1,
          perPage: 10,
          totalPages: 1
        }
      });
    });


    it('should throw BadGatewayException when prisma fails', async () => {
      mockPrisma.$transaction.mockRejectedValue(new Error('DB error'));

      await expect(service.findAll(mockUser)).rejects.toThrow(BadGatewayException);
    });
  });

  describe('findAll — business_unit pool filtering (internal talent pool)', () => {
    beforeEach(() => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);
      mockPrisma.ticket.findMany.mockResolvedValue([]);
    });

    it('applies NO business_unit filter for a MedVirtual logged company (sees all candidates)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        business_unit: 'MedVirtual',
      });
      businessUnitContextMock.poolFor.mockResolvedValue('medical');

      await service.findAll(mockUser);

      expect(businessUnitContextMock.poolFor).toHaveBeenCalledWith(
        'MedVirtual',
      );
      const findManyCall = mockPrisma.candidate.findMany.mock.calls[0][0];
      for (const branch of findManyCall.where.OR) {
        expect(branch.business_unit).toBeUndefined();
      }
    });

    it('applies NO business_unit filter for an MMVA logged company (sees all candidates)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        business_unit: 'MMVA',
      });
      businessUnitContextMock.poolFor.mockResolvedValue('medical');

      await service.findAll(mockUser);

      expect(businessUnitContextMock.poolFor).toHaveBeenCalledWith('MMVA');
      const findManyCall = mockPrisma.candidate.findMany.mock.calls[0][0];
      for (const branch of findManyCall.where.OR) {
        expect(branch.business_unit).toBeUndefined();
      }
    });

    it('restricts to non_medical BU hubspot_values for a Berry Virtual logged company', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        business_unit: 'Berry Virtual',
      });
      businessUnitContextMock.poolFor.mockResolvedValue('non_medical');
      businessUnitContextMock.getVisibleHubspotValues.mockResolvedValue([
        'MedVirtual',
        'Berry Virtual',
        'MMVA',
      ]);
      businessUnitContextMock.poolFor.mockImplementation(async (v: string) => {
        if (v === 'Berry Virtual') return 'non_medical';
        return 'medical';
      });

      await service.findAll(mockUser);

      const findManyCall = mockPrisma.candidate.findMany.mock.calls[0][0];
      for (const branch of findManyCall.where.OR) {
        expect(branch.business_unit).toEqual({ in: ['Berry Virtual'] });
      }
    });

    it('does not query organization/pool when user has no organization_id', async () => {
      const userWithoutOrg = {
        id: 'user-2',
        organization_id: null,
        role: 'system_admin',
      } as any;

      await service.findAll(userWithoutOrg);

      expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
      expect(businessUnitContextMock.poolFor).not.toHaveBeenCalled();
    });
  });

  describe('findAll — talent pool filters', () => {
    // The filter block is built once and spread into every branch of the
    // four-way where.OR, so each assertion checks all branches.
    const branchesOf = () =>
      mockPrisma.candidate.findMany.mock.calls[0][0].where.OR;

    const andFiltersOf = (branch: any) => branch.AND ?? [];

    beforeEach(() => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);
      mockPrisma.ticket.findMany.mockResolvedValue([]);
      mockPrisma.candidate.findMany.mockClear();
      mockPrisma.candidateSkill.groupBy.mockReset();
    });

    it('applies medical_tools as an insensitive OR contains filter in every branch', async () => {
      await service.findAll(
        mockUser,
        undefined, // country
        undefined, // shift_block
        undefined, // availability
        undefined, // monthly_compensation_from
        undefined, // monthly_compensation_to
        undefined, // years_of_experience
        undefined, // specializations
        undefined, // positions
        undefined, // skills
        undefined, // languages
        undefined, // page
        undefined, // perPage
        undefined, // search
        undefined, // all
        undefined, // scorecard_fields
        undefined, // tools
        'Athena,eClinicalWorks',
      );

      const branches = branchesOf();
      expect(branches).toHaveLength(4);
      for (const branch of branches) {
        const medicalToolsFilter = andFiltersOf(branch).find(
          (f: any) => f.OR?.[0]?.medical_tools,
        );
        expect(medicalToolsFilter).toEqual({
          OR: [
            { medical_tools: { contains: 'Athena', mode: 'insensitive' } },
            {
              medical_tools: {
                contains: 'eClinicalWorks',
                mode: 'insensitive',
              },
            },
          ],
        });
      }
    });

    it('applies specializations with OR semantics (any selected practice area matches)', async () => {
      await service.findAll(
        mockUser,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'Cardiology,Oncology',
      );

      for (const branch of branchesOf()) {
        const specFilter = andFiltersOf(branch).find(
          (f: any) => f.OR?.[0]?.specialization,
        );
        expect(specFilter).toEqual({
          OR: [
            { specialization: { contains: 'Cardiology', mode: 'insensitive' } },
            { specialization: { contains: 'Oncology', mode: 'insensitive' } },
          ],
        });
      }
    });

    it('resolves core_skills_fields into an exact-match filter for system_admin users', async () => {
      const systemAdminUser = {
        id: 'user-3',
        organization_id: null,
        role: 'system_admin',
      } as any;

      await service.findAll(
        systemAdminUser,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined, // scorecard_fields
        undefined, // tools
        undefined, // medical_tools
        'quickbooks:5,claim_generation:8',
      );

      for (const branch of branchesOf()) {
        const filters = andFiltersOf(branch);
        expect(filters).toEqual(
          expect.arrayContaining([
            { quickbooks: { equals: '5' } },
            { claim_generation: { equals: '8' } },
          ]),
        );
      }
    });

    it('ignores core_skills_fields for a non-system role', async () => {
      await service.findAll(
        mockUser,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'quickbooks:5',
      );

      for (const branch of branchesOf()) {
        const filters = andFiltersOf(branch);
        expect(
          filters.some((f: any) => f.quickbooks !== undefined),
        ).toBe(false);
      }
    });

    it('ignores unknown fields in core_skills_fields', async () => {
      const systemAdminUser = {
        id: 'user-4',
        organization_id: null,
        role: 'system_super_admin',
      } as any;

      await service.findAll(
        systemAdminUser,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'not_a_real_field:5',
      );

      for (const branch of branchesOf()) {
        const filters = andFiltersOf(branch);
        expect(
          filters.some((f: any) => f.not_a_real_field !== undefined),
        ).toBe(false);
      }
    });
  });

  describe('findOne', () => {
    it('should return candidate by id and organization_id', async () => {
      const mockCandidate = {
        id: '1',
        organization_id: 'org-1',
        first_name: 'John',
        gender: 'male',
        last_name: 'Doe',
        email: 'a@a.com',
        name: 'John Doe',
        pipeline_status: '1',
        shift_block: '8am-5pm',
        video_link: 'X',
        about_me: 'About me',
        tools: 'JavaScript, TypeScript',
        medical_tools: 'None',
        country: 'USA',
        specialization: 'Software Development',
        years_of_experience: 5,
        hourly_pay_rate: 5,
        employment_type: 'Full Time',
        educations: [{ degree: 'BSc', institution: 'University', year: '2020' }],
        approved_positions_pairing: ['Test'],
        business_unit: 'BerryVirtual',
        experiences: [
          {
            company: 'Company A',
            position: 'Developer',
            start_date: '2021-01-01',
            end_date: '2022-01-01',
            responsabilities: 'Developing software',
          },
        ],
        skills: [{ skill_name: 'JavaScript', skill_type: 'technical' }],
        languages: [{ name: 'English' }],
        // VA Score Card fields
        active_listening_and_comprehension_demonstrated: 'Yes',
        adaptability_to_different_client_personalities_and_workflows: 'Yes',
        can_articulate_experience_clearly_to_clients: 'Yes',
        can_multitask_between_systems_or_windows_efficiently: 'Yes',
        client_readiness___fit_evaluator_notes: 'Ready',
        comfortable_with_basic_tools__google_workspace__zoom__ehr_software_: 'Yes',
        comfortable_with_camera_on_setup: 'Yes',
        communication_skills_evaluator_notes: 'Good communicator',
        confident_on_video_and_phone_calls: 'Yes',
        cultural_alignment_with_us_healthcare_environment: 'Yes',
        demonstrates_problem_solving_and_tech_adaptability: 'Yes',
        demonstrates_stability_and_commitment: 'Yes',
        demonstrates_understanding_of_medical_terminology_and_procedures: 'Yes',
        exhibits_confidence_and_empathy_in_roleplay_scenarios: 'Yes',
        familiarity_with_emr_ehr_systems__kareo__athena__eclinicalworks__etc__: 'Yes',
        for_bilinguals__fluent_and_accurate_in_both_english_and_spanish: null,
        grammar__vocabulary__and_tone_are_appropriate_for_us_clients: 'Yes',
        handles_feedback_constructively: 'Yes',
        has_functioning_headset__webcam__and_backup_device: 'Yes',
        knowledge_of_hipaa_compliance_and_confidentiality: 'Yes',
        medical_knowledge_evaluator_notes: 'Solid background',
        no_medical_industry_experience: null,
        positive_attitude_and_professional_demeanor: 'Yes',
        prior_experience_in_healthcare_or_medical_va_roles: 'Yes',
        professionalism___work_readiness_evaluator_notes: 'Professional',
        punctual_and_responsive_during_recruitment_stages: 'Yes',
        remote_work_discipline_and_time_management: 'Yes',
        speaks_clearly_and_professionally: 'Yes',
        stable_internet_connection__min__20_mbps_: 'Yes',
        technical_competence_evaluator_notes: 'Technically strong',
        tier_level: 'Tier 1',
        total_points: '85',
        understands_workflow_in_medical_offices___telehealth_environments: 'Yes',
        panelCandidates: [
          {
            id: 'pc-1',
            panel: {
              hire_request_id: 'hr-1',
              hireRequest: {
                id: 'hr-1',
                title: 'Hire Request 1',
                status: 'interview_scheduled',
                organization: { id: 'org-1', name: 'Org 1' },
              },
            },
          },
        ],
        existingInOtherClientPanel: true,
      };

      mockPrisma.candidate.findUnique.mockResolvedValue(mockCandidate);

      const result = await service.findOne('1', mockUser);

      expect(prisma.candidate.findUnique).toHaveBeenCalledWith({
        where: {
          id: '1',
          organization_id: 'org-1',
        },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          email: true,
          name: true,
          specialization: true,
          years_of_experience: true,
          hourly_pay_rate: true,
          employment_type: true,
          pipeline_status: true,
          about_me: true,
          tools: true,
          medical_tools: true,
          gender: true,
          country: true,
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
          educations: {
            select: {
              degree: true,
              institution: true,
              year: true,
            },
          },
          approved_positions_pairing: true,
          business_unit: true,
          experiences: {
            orderBy: { start_date: 'desc' },
            select: {
              company: true,
              position: true,
              start_date: true,
              end_date: true,
              responsabilities: true,
            },
          },
          skills: {
            select: {
              skill_name: true,
              skill_type: true,
            },
          },
          languages: {
            select: {
              name: true,
            },
          },
          panelCandidates: {
            // Panels are scoped to the caller's organization so other
            // clients' hire requests never reach the response.
            where: { panel: { hireRequest: { org_id: 'org-1' } } },
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

      const expectedResult = {
        ...mockCandidate,
        pipeline_status: 'Unknown Stage',
        employment_type: 'Full Time',
        panelCandidates: [
          {
            title: 'Hire Request 1',
            organization_name: 'Org 1',
          },
        ],
      };

      expect(result).toEqual(expectedResult);
    });


    it('should return 400 if the candidate Id is empty', async () => {
      await expect(service.findOne('', mockUser)).rejects.toThrow(BadRequestException);
    });

    it('shoud return 401 if the candidate is not found', async () => {

      mockPrisma.candidate.findUnique.mockResolvedValue(null);

      await expect(service.findOne('1', mockUser)).rejects.toThrow(NotFoundException);
    })
  });

  describe('getProperties', () => {
    beforeEach(() => {
      mockPrisma.candidate.findMany.mockReset();
      mockPrisma.candidateLanguage.findMany.mockReset();
      mockPrisma.candidateSkill.findMany.mockReset();
    });

    it('should return distinct languages when field is "languages"', async () => {
      const mockLanguages = [{ name: 'English' }, { name: 'Spanish' }];
      mockPrisma.candidateLanguage = { findMany: jest.fn().mockResolvedValue(mockLanguages) };

      const result = await service.getProperties({ fields: 'languages' });

      expect(mockPrisma.candidateLanguage.findMany).toHaveBeenCalledWith({
        where: {
          candidate: {
            pipeline_status: {
              in: ['1087596819', '261075105'],
            },
          },
        },
        select: { name: true },
        distinct: ['name'],
      });
      expect(result).toEqual({ languages: mockLanguages });
    });

    it('sources "specialization" options from the practice_area_experience property', async () => {
      // Regression guard: `specialization` is written from HubSpot's
      // `practice_area_experience` property, so the filter options must come
      // from the same property. Reading career_highlights_relevant_job_experiences
      // (which feeds CandidateSkill) made real values like "Urgent Care" missing
      // from the dropdown while offering values no candidate has.
      mockedAxios.get.mockResolvedValue({
        data: {
          results: [
            {
              name: 'career_highlights_relevant_job_experiences',
              options: [{ label: 'Bookkeeping', value: 'Bookkeeping' }],
            },
            {
              name: 'practice_area_experience',
              options: [
                { label: 'Urgent Care', value: 'Urgent Care' },
                { label: 'Cardiology', value: 'Cardiology' },
                { label: 'Legacy', value: 'Legacy', hidden: true },
                { label: 'Blank', value: '   ' },
              ],
            },
          ],
        },
      } as any);

      const result = await service.getProperties({ fields: 'specialization' });

      expect(result.specialization).toEqual(['Urgent Care', 'Cardiology']);
      expect(result.specialization).not.toContain('Bookkeeping');
    });

    it('should return distinct skills when field is "skills"', async () => {
      const mockSkills = [{ skill_name: 'JavaScript' }, { skill_name: 'TypeScript' }];
      mockPrisma.candidateSkill = {
        findMany: jest.fn().mockResolvedValue(mockSkills),
        groupBy: jest.fn(),
      };

      const result = await service.getProperties({ fields: 'skills' });

      expect(mockPrisma.candidateSkill.findMany).toHaveBeenCalledWith({
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
        select: { skill_name: true },
        distinct: ['skill_name'],
      });
      expect(result).toEqual({ skills: mockSkills });
    });

    it('should return distinct values for other fields', async () => {
      const mockCountries = [{ country: 'USA' }, { country: 'Brazil' }];
      mockPrisma.candidate.findMany.mockResolvedValue(mockCountries);

      const result = await service.getProperties({ fields: 'country' });

      expect(mockPrisma.candidate.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { pipeline_status: '261075105' },
            { pipeline_status: '1087596819' },
          ],
          AND: [
            {
              country: {
                not: null
              }
            },
            {
              country: {
                not: 'N/A'
              }
            }
          ]
        },
        distinct: ['country'],
        select: { country: true },
      });
      expect(result).toEqual({ country: mockCountries });
    });

    it('should handle multiple fields', async () => {
      const mockLanguages = [{ name: 'English' }];
      const mockSkills = [{ skill_name: 'JavaScript' }];
      const mockCountries = [{ country: 'USA' }];

      mockPrisma.candidateLanguage = { findMany: jest.fn().mockResolvedValue(mockLanguages) };
      mockPrisma.candidateSkill = {
        findMany: jest.fn().mockResolvedValue(mockSkills),
        groupBy: jest.fn(),
      };
      mockPrisma.candidate.findMany.mockResolvedValue(mockCountries);

      const result = await service.getProperties({ fields: 'languages,skills,country' });

      expect(result).toEqual({
        languages: mockLanguages,
        skills: mockSkills,
        country: mockCountries,
      });
    });

    it('should throw BadRequestException on error', async () => {
      mockPrisma.candidate.findMany.mockReset();
      mockPrisma.candidate.findMany.mockImplementation(() => {
        return Promise.reject(new Error('DB error'));
      });

      await expect(service.getProperties({ fields: 'country' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateStatusHubspot', () => {

    beforeEach(() => {
      jest.clearAllMocks();
    });

    const mockCandidate = {
      id: '1',
      hubspot_id: 'hub-123',
    };

    it('should throw BadRequestException if candidate id is missing', async () => {
      await expect(service.updateStatusHubspot('', { status: 'Available Candidates' }))
        .rejects
        .toThrow(BadRequestException);
    });

    it('should throw BadRequestException if status is missing', async () => {
      await expect(service.updateStatusHubspot('1', { status: '' }))
        .rejects
        .toThrow(BadRequestException);
    });

    it('should throw BadRequestException if status is invalid', async () => {
      await expect(service.updateStatusHubspot('1', { status: 'invalid-status' }))
        .rejects
        .toThrow(BadRequestException);
    });

    it('should throw NotFoundException if candidate does not exist', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(null);

      await expect(service.updateStatusHubspot('1', { status: 'Available Candidates' }))
        .rejects
        .toThrow(NotFoundException);
    });

    it('should throw BadGatewayException if HubSpot API fails', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(mockCandidate);
      mockedAxios.patch.mockResolvedValue({ status: 500 } as any);

      await expect(service.updateStatusHubspot('1', { status: 'Available Candidates' }))
        .rejects
        .toThrow(BadGatewayException);
    });

    it('should throw BadGatewayException if prisma update fails', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(mockCandidate);
      mockedAxios.patch.mockResolvedValue({ status: 200 } as any);
      mockPrisma.candidate.update.mockResolvedValue(null);

      await expect(service.updateStatusHubspot('1', { status: 'Available Candidates' }))
        .rejects
        .toThrow(BadGatewayException);
    });

    it('should update candidate status successfully', async () => {
      const updatedCandidate = { id: '1', pipeline_status: '261075105' };
      mockPrisma.candidate.findUnique.mockResolvedValue(mockCandidate);
      mockedAxios.patch.mockResolvedValue({ status: 200 } as any);
      mockPrisma.candidate.update.mockResolvedValue(updatedCandidate);

      const result = await service.updateStatusHubspot('1', { status: 'Available Candidates' });

      expect(mockPrisma.candidate.findUnique).toHaveBeenCalledWith({
        where: { id: '1' },
        select: { hubspot_id: true, pipeline_status: true },
      });
      expect(mockedAxios.patch).toHaveBeenCalled();
      expect(mockPrisma.candidate.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { pipeline_status: '261075105' }, // stageName do dicionário
      });
      expect(result).toEqual(updatedCandidate);
    });
  });

  describe('getRandomTalentPoolCandidates', () => {
    beforeEach(() => {
      mockPrisma.candidate.findMany.mockReset();
      mockPrisma.candidate.findMany.mockResolvedValue([]);
      mockPrisma.candidate.count.mockReset();
      mockPrisma.candidate.count.mockResolvedValue(0);
      mockPrisma.$transaction.mockReset();
    });

    it('should return 25 random candidates from talent pool', async () => {
      const mockCandidates = Array.from({ length: 30 }, (_, i) => ({
        id: `candidate-${i}`,
        first_name: `John${i}`,
        last_name: `Doe${i}`,
        name: `John${i} Doe${i}`,
        country: 'USA',
        employment_type: 'Full-time',
        hourly_pay_rate: { toNumber: () => 25 },
        years_of_experience: 5,
        about_me: 'Test about me',
        specialization: 'Software Development',
        tools: 'JavaScript, TypeScript',
        medical_tools: 'None',
        avatar_url: 'https://example.com/avatar.jpg',
        gender: 'male',
        languages: [{ name: 'English' }],
        skills: [{ skill_name: 'JavaScript', skill_type: 'technical' }],
        educations: [{ institution: 'University', degree: 'BSc', year: '2020' }],
        experiences: [{
          company: 'Company A',
          position: 'Developer',
          start_date: new Date('2021-01-01'),
          end_date: new Date('2022-01-01'),
          responsabilities: 'Development'
        }],
        approved_positions_pairing: ['Developer'],
      }));

      mockPrisma.$transaction.mockResolvedValue([mockCandidates, 20]);

      const result = await service.getRandomTalentPoolCandidates('berryvirtual');

      expect(mockPrisma.$transaction).toHaveBeenCalled();

      expect(result.candidates).toHaveLength(25);
      expect(result.candidates[0]).toHaveProperty('id');
      expect(result.candidates[0]).toHaveProperty('name');
      expect(result.candidates[0]).toHaveProperty('avatar_url');
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('totalTable');
      expect(result.total).toBe(20);
      expect(result.totalTable).toBe(20);
    });

    it('should return fewer than 25 candidates if less available', async () => {
      const mockCandidates = Array.from({ length: 5 }, (_, i) => ({
        id: `candidate-${i}`,
        first_name: `John${i}`,
        last_name: `Doe${i}`,
        name: `John${i} Doe${i}`,
        country: 'USA',
        employment_type: 'Full-time',
        hourly_pay_rate: { toNumber: () => 25 },
        years_of_experience: 5,
        about_me: 'Test about me',
        specialization: 'Software Development',
        tools: 'JavaScript',
        medical_tools: 'None',
        avatar_url: 'https://example.com/avatar.jpg',
        gender: 'male',
        languages: [{ name: 'English' }],
        skills: [{ skill_name: 'JavaScript', skill_type: 'technical' }],
        educations: [],
        experiences: [],
        approved_positions_pairing: [],
      }));

      mockPrisma.$transaction.mockResolvedValue([mockCandidates, 10]);

      const result = await service.getRandomTalentPoolCandidates('berryvirtual');

      expect(result.candidates).toHaveLength(5);
      expect(result.total).toBe(10);
      expect(result.totalTable).toBe(10);
    });

    it('should return empty array if no candidates available', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 25]);

      const result = await service.getRandomTalentPoolCandidates('berryvirtual' );

      expect(result.candidates).toHaveLength(0);
      expect(Array.isArray(result.candidates)).toBe(true);
    });

    it('should handle database errors', async () => {
      mockPrisma.$transaction.mockRejectedValue(new Error('Database error'));

      await expect(service.getRandomTalentPoolCandidates('berryvirtual')).
        rejects.toThrow('Database error');
    });

    it('should exclude candidates with specialization "n/a"', async () => {
      const mockCandidates = [
        {
          id: 'candidate-1',
          first_name: 'John',
          last_name: 'Doe',
          name: 'John Doe',
          country: 'USA',
          employment_type: 'Full-time',
          hourly_pay_rate: { toNumber: () => 25 },
          years_of_experience: 5,
          about_me: 'Test about me',
          specialization: 'Software Development',
          tools: 'JavaScript',
          medical_tools: 'None',
          avatar_url: 'https://example.com/avatar.jpg',
          gender: 'male',
          languages: [{ name: 'English' }],
          skills: [{ skill_name: 'JavaScript', skill_type: 'technical' }],
          educations: [],
          experiences: [],
          approved_positions_pairing: [],
        },
        {
          id: 'candidate-2',
          first_name: 'Jane',
          last_name: 'Smith',
          name: 'Jane Smith',
          country: 'USA',
          employment_type: 'Full-time',
          hourly_pay_rate: { toNumber: () => 25 },
          years_of_experience: 3,
          about_me: 'Test about me',
          specialization: 'n/a',
          tools: 'Python',
          medical_tools: 'None',
          avatar_url: 'https://example.com/avatar2.jpg',
          gender: 'female',
          languages: [{ name: 'Spanish' }],
          skills: [{ skill_name: 'Python', skill_type: 'technical' }],
          educations: [],
          experiences: [],
          approved_positions_pairing: [],
        },
      ];

      mockPrisma.$transaction.mockResolvedValue([[mockCandidates[0]], 25]); // Only the first one should be returned

      const result = await service.getRandomTalentPoolCandidates('berryvirtual');

      expect(mockPrisma.$transaction).toHaveBeenCalled();

      // Should only return candidate without "n/a" specialization
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].specialization).not.toBe('n/a');
      expect(result.candidates[0].specialization).not.toBe('N/A');
    });
  });

  describe('getRandomTalentPoolCandidates — business_unit pool filtering (public talent pool)', () => {
    beforeEach(() => {
      mockPrisma.candidate.findMany.mockReset();
      mockPrisma.candidate.findMany.mockResolvedValue([]);
      mockPrisma.candidate.count.mockReset();
      mockPrisma.candidate.count.mockResolvedValue(0);
      mockPrisma.$transaction.mockReset();
      mockPrisma.$transaction.mockResolvedValue([[], 0]);
    });

    it('applies NO business_unit filter for MedVirtual (sees all candidates)', async () => {
      businessUnitContextMock.poolFor.mockResolvedValue('medical');

      await service.getRandomTalentPoolCandidates('MedVirtual');

      expect(businessUnitContextMock.poolFor).toHaveBeenCalledWith(
        'MedVirtual',
      );
      const findManyArgs = mockPrisma.candidate.findMany.mock.calls[0][0];
      const buCondition = findManyArgs.where.AND.find(
        (c: any) => 'business_unit' in c,
      );
      expect(buCondition.business_unit).toBeUndefined();
    });

    it('applies NO business_unit filter for MMVA (sees all candidates)', async () => {
      businessUnitContextMock.poolFor.mockResolvedValue('medical');

      await service.getRandomTalentPoolCandidates('MMVA');

      expect(businessUnitContextMock.poolFor).toHaveBeenCalledWith('MMVA');
      const findManyArgs = mockPrisma.candidate.findMany.mock.calls[0][0];
      const buCondition = findManyArgs.where.AND.find(
        (c: any) => 'business_unit' in c,
      );
      expect(buCondition.business_unit).toBeUndefined();
    });

    it('restricts to non_medical BU hubspot_values for BerryVirtual', async () => {
      businessUnitContextMock.getVisibleHubspotValues.mockResolvedValue([
        'MedVirtual',
        'Berry Virtual',
        'MMVA',
      ]);
      businessUnitContextMock.poolFor.mockImplementation(async (v: string) => {
        if (v === 'BerryVirtual' || v === 'Berry Virtual') return 'non_medical';
        return 'medical';
      });

      await service.getRandomTalentPoolCandidates('BerryVirtual');

      const findManyArgs = mockPrisma.candidate.findMany.mock.calls[0][0];
      const buCondition = findManyArgs.where.AND.find(
        (c: any) => 'business_unit' in c,
      );
      expect(buCondition.business_unit).toEqual({ in: ['Berry Virtual'] });
    });

    it('applies NO business_unit filter when business_unit param is empty/undefined', async () => {
      businessUnitContextMock.poolFor.mockResolvedValue(null);

      await service.getRandomTalentPoolCandidates(undefined as unknown as string);

      const findManyArgs = mockPrisma.candidate.findMany.mock.calls[0][0];
      const buCondition = findManyArgs.where.AND.find(
        (c: any) => 'business_unit' in c,
      );
      expect(buCondition.business_unit).toBeUndefined();
    });
  });

  describe('processData', () => {
    const candidateId = 'test-candidate-id';
    // Use a file ID > 25 characters to satisfy the regex in extractDriveFileId
    const validFileId = 'test-file-id-with-more-than-25-characters-123';
    const mockCandidate = {
      id: candidateId,
      resume_url: `https://drive.google.com/file/d/${validFileId}/view`,
      first_name: 'John',
      last_name: 'Doe'
    };

    beforeEach(() => {
      mockPrisma.candidate.findUnique.mockResolvedValue(mockCandidate);
      googleMock.downloadFile.mockResolvedValue('Download successful');
      openAIMock.organizeText.mockResolvedValue('{}');

      // Mock fs behaviors for processData
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue(['page1.png']);
    });

    it('should process candidate data successfully and map dates correctly', async () => {
      const mockExtractedData = {
        bio: 'Test Bio',
        experience: [
          {
            company: 'Test Company',
            role: 'Developer',
            start_date: '2020-01-01',
            end_date: null, // "Present" or missing
            description: ['Worked hard']
          }
        ],
        education: [
          {
            institution: 'Test University',
            degree: 'BSc',
            year: '2020-05-01'
          },
          {
            institution: 'Missing Year Uni',
            degree: 'PhD',
            year: null
          }
        ],
        skills: ['Node.js']
      };

      // Mock OpenAI service specific method for this test
      // Note: We need to cast to any because extractDataFromResumeImages is not in the initial mock definition at top of file
      (service['openai'] as any).extractDataFromResumeImages = jest.fn().mockResolvedValue({ data: mockExtractedData, cost: 0 });

      // We need to mock updateFromJson or let it run. Since it uses prisma calls, we can let it run and verify prisma calls.
      // But updateFromJson is private/internal. We are testing processData which calls it.

      const result = await service.processData(candidateId);

      expect(result).toBe(true);
      expect(result).toBe(true);
      expect(googleMock.downloadFile).toHaveBeenCalledWith(validFileId, expect.any(String), expect.any(String));
      expect((service['openai'] as any).extractDataFromResumeImages).toHaveBeenCalled();

      // Verify Experience Mapping
      expect(mockPrisma.candidateExperience.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            candidate_id: candidateId,
            company: 'Test Company',
            start_date: new Date('2020-01-01'),
            end_date: null
          })
        ])
      });

      // Verify Education Mapping (Fix verification)
      expect(mockPrisma.candidateEducation.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            candidate_id: candidateId,
            institution: 'Test University',
            degree: 'BSc',
            year: '2020-05-01' // Should map year from item.year (which is '2020-05-01' here)
          }),
          expect.objectContaining({
            candidate_id: candidateId,
            institution: 'Missing Year Uni',
            degree: 'PhD',
            year: null // Should be null
          })
        ])
      });
    });

    it('should return false if candidate not found', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(null);
      const result = await service.processData('non-existent');
      expect(result).toBe(false);
    });

    it('should invalid Google Drive URL', async () => {
      const invalidCandidate = { ...mockCandidate, resume_url: 'invalid-url' };
      mockPrisma.candidate.findUnique.mockResolvedValue(invalidCandidate);

      const result = await service.processData(candidateId);
      expect(result).toBe(false);
    });
  });

  describe('removeCandidate', () => {
    const mockRemoveData = {
      candidateId: 'candidate-1',
      hireRequestId: 'hire-request-1',
    };

    const mockCandidateRecord = {
      hubspot_id: 'hs-1',
      pipeline_status_origin: '261075105',
    };

    /** Sets up the outer panelCandidate.count mock (pre-removal check) and
     *  the $transaction mock for the actual deletion path. */
    const setupScenario = (
      currentCount: number,
      hireRequestStatus: string,
      otherPanels: { id: string }[] = [],
    ) => {
      mockPrisma.hireRequest.findUnique.mockResolvedValue({ status: hireRequestStatus });
      mockPrisma.panelCandidate.count.mockResolvedValue(currentCount);
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          panelCandidate: {
            deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            findMany: jest.fn().mockResolvedValue(otherPanels),
          },
          candidate: {
            update: jest.fn().mockResolvedValue({}),
          },
        };
        return fn(tx);
      });
    };

    beforeEach(() => {
      hubspotMock.updateOneCandidateFromHireRequest.mockResolvedValue(true);
      HireRequestMock.updateStatus.mockResolvedValue(true);
    });

    it('should throw BadRequestException if candidateId is missing', async () => {
      await expect(
        service.removeCandidate({ candidateId: '', hireRequestId: 'hr-1' } as any, mockUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if hireRequestId is missing', async () => {
      await expect(
        service.removeCandidate({ candidateId: 'c-1', hireRequestId: '' } as any, mockUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if candidate does not exist', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(null);

      await expect(service.removeCandidate(mockRemoveData, mockUser)).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if hire request does not exist', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(mockCandidateRecord);
      mockPrisma.hireRequest.findUnique.mockResolvedValue(null);

      await expect(service.removeCandidate(mockRemoveData, mockUser)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when removing last candidate from panel_ready hire request', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(mockCandidateRecord);
      setupScenario(1, 'panel_ready');

      await expect(service.removeCandidate(mockRemoveData, mockUser)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when removing last candidate from interview_scheduled hire request', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(mockCandidateRecord);
      setupScenario(1, 'interview_scheduled');

      await expect(service.removeCandidate(mockRemoveData, mockUser)).rejects.toThrow(BadRequestException);
    });

    it('should return shouldPromptCancel=true when removing last candidate from sourcing hire request', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(mockCandidateRecord);
      setupScenario(1, 'sourcing');

      const result = await service.removeCandidate(mockRemoveData, mockUser);

      expect(result).toEqual({ success: true, shouldPromptCancel: true });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(hubspotMock.updateOneCandidateFromHireRequest).not.toHaveBeenCalled();
    });

    it('should return shouldPromptCancel=true when removing last candidate from new hire request', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(mockCandidateRecord);
      setupScenario(1, 'new');

      const result = await service.removeCandidate(mockRemoveData, mockUser);

      expect(result).toEqual({ success: true, shouldPromptCancel: true });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('should remove candidate and update HubSpot when panel still has multiple candidates', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(mockCandidateRecord);
      setupScenario(3, 'sourcing', []); // 3 candidates, no critical other panels

      const result = await service.removeCandidate(mockRemoveData, mockUser);

      expect(result).toEqual({ success: true, shouldPromptCancel: false });
      expect(HireRequestMock.updateStatus).not.toHaveBeenCalled();
      expect(hubspotMock.updateOneCandidateFromHireRequest).toHaveBeenCalledWith(
        mockCandidateRecord.hubspot_id,
        mockCandidateRecord.pipeline_status_origin,
        mockUser.id,
        undefined,
        expect.stringContaining(mockRemoveData.hireRequestId),
      );
    });

    it('should use Available Candidates pipeline status when pipeline_status_origin is null', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue({ hubspot_id: 'hs-1', pipeline_status_origin: null });
      setupScenario(2, 'sourcing', []);

      const result = await service.removeCandidate(mockRemoveData, mockUser);

      expect(result).toEqual({ success: true, shouldPromptCancel: false });
      expect(hubspotMock.updateOneCandidateFromHireRequest).toHaveBeenCalledWith(
        'hs-1',
        expect.any(String),
        mockUser.id,
        undefined,
        expect.any(String),
      );
    });

    it('should NOT update HubSpot if candidate is in another panel with selected_by_client or blocked', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(mockCandidateRecord);
      setupScenario(2, 'sourcing', [{ id: 'other-panel-candidate-1' }]);

      const result = await service.removeCandidate(mockRemoveData, mockUser);

      expect(result).toEqual({ success: true, shouldPromptCancel: false });
      expect(hubspotMock.updateOneCandidateFromHireRequest).not.toHaveBeenCalled();
    });

    it('should return { success: false } when an unexpected error occurs during transaction', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(mockCandidateRecord);
      mockPrisma.hireRequest.findUnique.mockResolvedValue({ status: 'sourcing' });
      mockPrisma.panelCandidate.count.mockResolvedValue(2);
      mockPrisma.$transaction.mockRejectedValue(new Error('DB failure'));

      const result = await service.removeCandidate(mockRemoveData, mockUser);

      expect(result).toEqual({ success: false, shouldPromptCancel: false });
    });
  });

  // ---------------------------------------------------------------------------
  // getTalentPoolCandidatesByIds — batch loader used by list endpoints
  // ---------------------------------------------------------------------------

  describe('getTalentPoolCandidatesByIds', () => {
    // Floor prices/margins differ per business unit and language tier, so these
    // configs make a wrong branch visible as a different bill rate.
    const positionConfigs = [
      {
        position: 'Medical Assistant',
        medical_floor_price_english: 10,
        non_medical_floor_price_english: 12,
        medical_floor_price_bilingual: 14,
        non_medical_floor_price_bilingual: 16,
        medical_margin_per_hour: 5,
        non_medical_margin_per_hour: 7,
      },
    ];

    const baseCandidate = {
      id: 'cand-1',
      first_name: 'Jane',
      last_name: 'Doe',
      name: 'Jane Doe',
      country: 'PH',
      employment_type: '1',
      hourly_pay_rate: 8,
      years_of_experience: '5',
      specialization: 'Cardiology',
      tools: 'EHR',
      avatar_url: 'jane.png',
      gender: 'female',
      shift_block: 'AM',
      business_unit: 'MedVirtual',
      // Remapped by the dictionary ('Jr Bookkeeper' -> 'Bookkeeper Jr'), so a
      // missing or double-applied labelling step is visible in assertions.
      approved_positions_pairing: ['Jr Bookkeeper'],
      languages: [{ name: 'English' }],
      skills: [{ skill_name: 'Charting', skill_type: 'hard' }],
    };

    beforeEach(() => {
      positionRateConfigMock.findAllUnpaginated.mockResolvedValue(
        positionConfigs,
      );
      // Resolve the pool from the actual business_unit passed in, so the
      // MedVirtual vs. Berry cases below exercise their real branch instead
      // of both silently falling back to the default 'medical' mock.
      businessUnitContextMock.poolFor.mockImplementation(
        async (bu: string) =>
          bu?.toLowerCase().includes('berry') ? 'non_medical' : 'medical',
      );
    });

    it('returns an empty map without querying when given no ids', async () => {
      const result = await service.getTalentPoolCandidatesByIds([]);

      expect(result.size).toBe(0);
      expect(mockPrisma.candidate.findMany).not.toHaveBeenCalled();
    });

    it('de-duplicates ids and reads the rate config once for the batch', async () => {
      mockPrisma.candidate.findMany.mockResolvedValue([baseCandidate]);

      await service.getTalentPoolCandidatesByIds([
        'cand-1',
        'cand-1',
        'cand-2',
      ]);

      expect(mockPrisma.candidate.findMany).toHaveBeenCalledTimes(1);
      expect(positionRateConfigMock.findAllUnpaginated).toHaveBeenCalledTimes(1);
      expect(
        mockPrisma.candidate.findMany.mock.calls[0][0].where.id.in,
      ).toEqual(['cand-1', 'cand-2']);
    });

    it('omits unknown ids instead of throwing', async () => {
      mockPrisma.candidate.findMany.mockResolvedValue([baseCandidate]);

      const result = await service.getTalentPoolCandidatesByIds([
        'cand-1',
        'missing',
      ]);

      expect(result.has('cand-1')).toBe(true);
      expect(result.has('missing')).toBe(false);
    });

    it('prefixes the avatar URL and labels the approved positions', async () => {
      mockPrisma.candidate.findMany.mockResolvedValue([baseCandidate]);

      const candidate = (
        await service.getTalentPoolCandidatesByIds(['cand-1'])
      ).get('cand-1');

      expect(candidate.avatar_url).toBe(
        'https://medvirtual-avatar.s3.us-east-1.amazonaws.com/jane.png',
      );
      expect(candidate.approved_positions_pairing).toEqual(['Bookkeeper Jr']);
    });

    it('leaves a null avatar_url null', async () => {
      mockPrisma.candidate.findMany.mockResolvedValue([
        { ...baseCandidate, avatar_url: null },
      ]);

      const candidate = (
        await service.getTalentPoolCandidatesByIds(['cand-1'])
      ).get('cand-1');

      expect(candidate.avatar_url).toBeNull();
    });

    // The transform order is load-bearing: computeCandidateRates labels the
    // positions itself and reads the raw employment_type, so it must run before
    // either is normalized. Getting this wrong yields wrong money, silently —
    // these cases pin the output against the single-id path.
    describe.each([
      ['monolingual MedVirtual', { languages: [{ name: 'English' }] }],
      [
        'bilingual MedVirtual',
        { languages: [{ name: 'English' }, { name: 'Spanish' }] },
      ],
      ['monolingual Berry', { business_unit: 'Berry Virtual' }],
      [
        'bilingual Berry',
        {
          business_unit: 'Berry Virtual',
          languages: [{ name: 'English' }, { name: 'Spanish' }],
        },
      ],
      ['no approved positions', { approved_positions_pairing: [] }],
      ['employment_type as ";"-joined string', { employment_type: '1;2' }],
      ['part-time employment_type', { employment_type: '2' }],
      ['null hourly_pay_rate', { hourly_pay_rate: null as any }],
    ])('matches getTalentPoolCandidateById for a %s candidate', (_label, overrides) => {
      it('produces identical rates and display fields', async () => {
        const record = { ...baseCandidate, ...overrides };
        mockPrisma.candidate.findMany.mockResolvedValue([record]);
        mockPrisma.candidate.findUnique.mockResolvedValue(record);

        const single = await service.getTalentPoolCandidateById('cand-1');
        const batched = (
          await service.getTalentPoolCandidatesByIds(['cand-1'])
        ).get('cand-1');

        // The four rate fields are what an inverted transform order breaks.
        expect(batched.bill_rate_hourly).toBe(single.bill_rate_hourly);
        expect(batched.bill_rate_monthly).toBe(single.bill_rate_monthly);
        expect(batched.salary).toBe(single.salary);
        expect(batched.hourlySalary).toBe(single.hourlySalary);

        expect(batched.employment_type).toEqual(single.employment_type);
        expect(batched.approved_positions_pairing).toEqual(
          single.approved_positions_pairing,
        );
        expect(batched.avatar_url).toBe(single.avatar_url);
      });
    });
  });
});