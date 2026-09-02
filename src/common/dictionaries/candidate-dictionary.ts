export const candidadeToDbDictionary: Record<string, string | string[]> = {
  hs_object_id: 'hubspot_id',
  email: 'email',
  first_name: 'first_name',
  last_name: 'last_name',
  name: 'name',
  hs_pipeline_stage: ['pipeline_status', 'employment_type'],
  agreed_hourly_pay_rate: 'hourly_pay_rate',
  resume_link: 'resume_url',
  headshot_screenshot: 'headshot_url',
  practice_area_experience: 'specialization',
  country__residence_: 'country',
  //changed on 10-03-2025 asked by Pauli
  //employment_type: 'employment_type',
  tools: 'tools',
  medical_tools: 'medical_tools',
  gender: 'gender',
  va_role_s: 'approved_positions_pairing',
  shift_block: 'shift_block',
  video_link: 'video_link',
  business_units: 'business_unit',

  //VA Score Cards fields from Hubspot
  active_listening_and_comprehension_demonstrated:
    'active_listening_and_comprehension_demonstrated',
  adaptability_to_different_client_personalities_and_workflows:
    'adaptability_to_different_client_personalities_and_workflows',
  can_articulate_experience_clearly_to_clients:
    'can_articulate_experience_clearly_to_clients',
  can_multitask_between_systems_or_windows_efficiently:
    'can_multitask_between_systems_or_windows_efficiently',
  client_readiness___fit_evaluator_notes:
    'client_readiness___fit_evaluator_notes',
  comfortable_with_basic_tools__google_workspace__zoom__ehr_software_:
    'comfortable_with_basic_tools__google_workspace__zoom__ehr_software_',
  comfortable_with_camera_on_setup: 'comfortable_with_camera_on_setup',
  communication_skills_evaluator_notes: 'communication_skills_evaluator_notes',
  confident_on_video_and_phone_calls: 'confident_on_video_and_phone_calls',
  cultural_alignment_with_us_healthcare_environment:
    'cultural_alignment_with_us_healthcare_environment',
  demonstrates_problem_solving_and_tech_adaptability:
    'demonstrates_problem_solving_and_tech_adaptability',
  demonstrates_stability_and_commitment:
    'demonstrates_stability_and_commitment',
  demonstrates_understanding_of_medical_terminology_and_procedures:
    'demonstrates_understanding_of_medical_terminology_and_procedures',
  exhibits_confidence_and_empathy_in_roleplay_scenarios:
    'exhibits_confidence_and_empathy_in_roleplay_scenarios',
  familiarity_with_emr_ehr_systems__kareo__athena__eclinicalworks__etc__:
    'familiarity_with_emr_ehr_systems__kareo__athena__eclinicalworks__etc__',
  for_bilinguals__fluent_and_accurate_in_both_english_and_spanish:
    'for_bilinguals__fluent_and_accurate_in_both_english_and_spanish',
  grammar__vocabulary__and_tone_are_appropriate_for_us_clients:
    'grammar__vocabulary__and_tone_are_appropriate_for_us_clients',
  handles_feedback_constructively: 'handles_feedback_constructively',
  has_functioning_headset__webcam__and_backup_device:
    'has_functioning_headset__webcam__and_backup_device',
  knowledge_of_hipaa_compliance_and_confidentiality:
    'knowledge_of_hipaa_compliance_and_confidentiality',
  medical_knowledge_evaluator_notes: 'medical_knowledge_evaluator_notes',
  no_medical_industry_experience: 'no_medical_industry_experience',
  positive_attitude_and_professional_demeanor:
    'positive_attitude_and_professional_demeanor',
  prior_experience_in_healthcare_or_medical_va_roles:
    'prior_experience_in_healthcare_or_medical_va_roles',
  professionalism___work_readiness_evaluator_notes:
    'professionalism___work_readiness_evaluator_notes',
  punctual_and_responsive_during_recruitment_stages:
    'punctual_and_responsive_during_recruitment_stages',
  remote_work_discipline_and_time_management:
    'remote_work_discipline_and_time_management',
  speaks_clearly_and_professionally: 'speaks_clearly_and_professionally',
  stable_internet_connection__min__20_mbps_:
    'stable_internet_connection__min__20_mbps_',
  technical_competence_evaluator_notes: 'technical_competence_evaluator_notes',
  tier_level: 'tier_level',
  total_points: 'total_points',
  understands_workflow_in_medical_offices___telehealth_environments:
    'understands_workflow_in_medical_offices___telehealth_environments',

  //Core Skills fields from Hubspot (VA Score Card extended — p20630393_Virtual_Assistant / med|berry_ta_score_card)
  //Bookkeeping Core Skills (gate: bookkeeping)
  quickbooks: 'quickbooks',
  other_accounting_software: 'other_accounting_software',
  chart_of_accounts_setup___maintenance:
    'chart_of_accounts_setup___maintenance',
  transaction_categorization: 'transaction_categorization',
  bank__credit_card_reconciliations: 'bank__credit_card_reconciliations',
  accounts_payable_ap: 'accounts_payable_ap',
  accounts_receivable_ar: 'accounts_receivable_ar',
  payroll_posting__reconciliation_not_processing_unless_required:
    'payroll_posting__reconciliation_not_processing_unless_required',
  payroll_posting: 'payroll_posting',
  monthend_close: 'monthend_close',
  journal_entries__adjustments: 'journal_entries__adjustments',
  balance_sheet: 'balance_sheet',
  pl: 'pl',
  accrual_vs_cash_understanding: 'accrual_vs_cash_understanding',
  prepare_books_for_cpatax_handoff: 'prepare_books_for_cpatax_handoff',
  client_communication: 'client_communication',
  account_reconciliation: 'account_reconciliation',
  financial_analysis: 'financial_analysis',
  financial_reporting: 'financial_reporting',
  total_score_bookkeeping: 'total_score_bookkeeping',
  notes_bookkeeping: 'notes_bookkeeping',

  //Medical/Dental Core Skills (Admin) (gate: medical__dental_admin)
  patient_scheduling__calendar_management:
    'patient_scheduling__calendar_management',
  insurance_verification_eligibility__benefits:
    'insurance_verification_eligibility__benefits',
  prior_authorizations__referrals: 'prior_authorizations__referrals',
  inbound_call_handling__patient_support:
    'inbound_call_handling__patient_support',
  outbound_calls_recalls_noshows_followups:
    'outbound_calls_recalls_noshows_followups',
  emrehr_data_entry__chart_updating: 'emrehr_data_entry__chart_updating',
  patient_intake__demographics_documentation_accuracy:
    'patient_intake__demographics_documentation_accuracy',
  referrals_sending_receiving_tracking:
    'referrals_sending_receiving_tracking',
  total_score_medical__dental_admin: 'total_score_medical__dental_admin',
  notes_medical__dental_admin: 'notes_medical__dental_admin',

  //Medical/Dental Core Skills (Biller) (gate: medical__dental_biller)
  n2_years_healthcare_billing_experience:
    'n2_years_healthcare_billing_experience',
  total_years_on_healthcare_billing_experience:
    'total_years_on_healthcare_billing_experience',
  patient_phone_communication: 'patient_phone_communication',
  role_type: 'role_type',
  insurance_verification_knowledge: 'insurance_verification_knowledge',
  prior_authorizations_experience: 'prior_authorizations_experience',
  cpt__icd10_coding: 'cpt__icd10_coding',
  charge_entry: 'charge_entry',
  claim_generation: 'claim_generation',
  claim_submission: 'claim_submission',
  denial_management: 'denial_management',
  insurance_followup: 'insurance_followup',
  ar_management: 'ar_management',
  payment_posting: 'payment_posting',
  identifying_underpayments: 'identifying_underpayments',
  medicaldental_biller_total_percentage_score:
    'medicaldental_biller_total_percentage_score',
  notes_medical__dental_biller: 'notes_medical__dental_biller',

  //Sales Core Skills (Sales Executive) (gate: sales_executive)
  consultative_selling: 'consultative_selling',
  fullcycle_sales: 'fullcycle_sales',
  objection_handling__negotiation: 'objection_handling__negotiation',
  virtual_demos__presentations: 'virtual_demos__presentations',
  pipeline_management: 'pipeline_management',
  closing_sales: 'closing_sales',
  total_score_sales_executive: 'total_score_sales_executive',
  notes_sales_executive: 'notes_sales_executive',

  //Sales Core Skills (SDR) (gate: sales_development_representative_sdr)
  lead_research__qualification: 'lead_research__qualification',
  crm_proficiency: 'crm_proficiency',
  outbound_prospecting_emaillvcalls: 'outbound_prospecting_emaillvcalls',
  cold_calling: 'cold_calling',
  appointment_setting: 'appointment_setting',
  kpi_awareness__tracking: 'kpi_awareness__tracking',
  total_score_sales_development_representative_sdr:
    'total_score_sales_development_representative_sdr',
  notes_sales_development_representative_sdr:
    'notes_sales_development_representative_sdr',

  //Sales Core Skills (Sales & Account Manager) (gate: sales__account_manager)
  client_relationship_management: 'client_relationship_management',
  retention_strategy: 'retention_strategy',
  upsell__crosssell: 'upsell__crosssell',
  account_onboarding: 'account_onboarding',
  issue_resolution: 'issue_resolution',
  total_score_sales__account_manager: 'total_score_sales__account_manager',
  notes_sales__account_manager: 'notes_sales__account_manager',
  vaid: 'vaid'
};

export const dbToCandidateDictionary: Record<string, string> =
  Object.fromEntries(
    Object.entries(candidadeToDbDictionary).map(([key, value]) => [value, key]),
  );
