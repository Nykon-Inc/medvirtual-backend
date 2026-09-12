export interface HubstaffMember {
  id?: number;
  user_id: number;
  membership_role: string;
  membership_status: string;
  created_at: string;
  updated_at: string;
  last_client_activity: string;
  trackable: boolean;
  effective_role: string;
  view_only: boolean;
  profile?: HubstaffProfile;
  metadata?: Record<string, any>;
  user?: HubstaffUser;
}

export interface HubstaffUser {
  id: number;
  name: string;
  first_name: string;
  last_name: string;
  email: string;
  time_zone: string;
  ip_address: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface HubstaffProfile {
  employee_id?: string;
  birthday?: string;
  started_on?: string;
  custom_fields?: Record<string, string>;
}

export interface HubstaffTimeOffRequestDay {
  date: string;
  amount_used: number;
  starts_at: string;
  stops_at: string;
  holiday: boolean;
  paid: boolean;
}

export interface HubstaffTimeOffRequest {
  id: number;
  user_id: number;
  time_off_policy_id: number;
  status: string;
  all_day: boolean;
  starts_at: string;
  stops_at: string;
  submitted_at: string;
  approved_at?: string;
  denied_at?: string;
  paid: boolean;
  amount_used: number;
  message?: string;
  response?: string;
  created_by_id: number;
  approved_by_id?: number;
  denied_by_id?: number;
  team_payment_detail_id?: number;
  team_payment_id?: number;
  time_off_request_days?:
    | HubstaffTimeOffRequestDay
    | HubstaffTimeOffRequestDay[];
  created_at: string;
  updated_at: string;
}
