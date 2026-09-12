import { ApiProperty } from '@nestjs/swagger';
import {
  OrganizationRole,
  OrganizationStatus,
  BillingMode,
  BillingFrequency,
} from '@prisma/client';

export class PaginationMetaDto {
  @ApiProperty({ description: 'Current page number' })
  page: number;

  @ApiProperty({ description: 'Number of items per page' })
  limit: number;

  @ApiProperty({ description: 'Total number of items' })
  total: number;

  @ApiProperty({ description: 'Total number of pages' })
  totalPages: number;

  @ApiProperty({ description: 'Whether there is a next page' })
  hasNext: boolean;

  @ApiProperty({ description: 'Whether there is a previous page' })
  hasPrev: boolean;
}

export class InvoiceConfigurationResponseDto {
  @ApiProperty({ description: 'Configuration ID' })
  id: string;

  @ApiProperty({ description: 'Hubstaff ID', required: false, nullable: true })
  hubstaff_id?: string | null;

  @ApiProperty({ description: 'Hubspot ID', required: false, nullable: true })
  hubspot_id?: string | null;

  @ApiProperty({ description: 'Billing mode', enum: BillingMode })
  billing_mode: BillingMode;

  @ApiProperty({ description: 'Billing frequency', enum: BillingFrequency })
  billing_frequency: BillingFrequency;

  @ApiProperty({ description: 'Billing currency' })
  billing_currency: string;

  @ApiProperty({ description: 'Payment terms in days' })
  payment_terms_days: number;

  @ApiProperty({
    description: 'Cycle anchor day',
    required: false,
    nullable: true,
  })
  cycle_anchor_day?: number | null;

  @ApiProperty({ description: 'Auto-submit invoices' })
  auto_submit_invoices: boolean;

  @ApiProperty({ description: 'Auto-publish invoices' })
  auto_publish_invoices: boolean;

  @ApiProperty({ description: 'Auto-sync to Stripe' })
  auto_sync_to_stripe: boolean;

  @ApiProperty({
    description: 'Stripe customer ID',
    required: false,
    nullable: true,
  })
  stripe_customer_id?: string | null;

  @ApiProperty({ description: 'Creation date' })
  createdAt: Date;

  @ApiProperty({ description: 'Last update date' })
  updatedAt: Date;
}

export class OrganizationResponseDto {
  @ApiProperty({ description: 'Organization ID' })
  id: string;

  @ApiProperty({
    description: 'ID from hubspot',
    required: false,
    nullable: true,
  })
  hubspot_id?: string | null;

  @ApiProperty({ description: 'Organization name' })
  name: string;

  @ApiProperty({ description: 'Organization email', required: false })
  email?: string;

  @ApiProperty({ description: 'Organization phone', required: false })
  phone?: string;

  @ApiProperty({ description: 'Organization website URL', required: false })
  website_url?: string;

  @ApiProperty({ description: 'Organization location', required: false })
  location?: string;

  @ApiProperty({ description: 'Organization description', required: false })
  description?: string;

  @ApiProperty({ description: 'Organization industry', required: false })
  industry?: string;

  @ApiProperty({ description: 'Business Unit', required: false })
  business_unit?: string;

  @ApiProperty({ description: 'Organization role', enum: OrganizationRole })
  organization_role: OrganizationRole;

  @ApiProperty({ description: 'Number of employees', required: false })
  number_of_employees?: number;

  @ApiProperty({ description: 'Date founded', required: false })
  date_founded?: Date;

  @ApiProperty({ description: 'Date joined', required: false })
  date_joined?: Date;

  @ApiProperty({ description: 'Date became client', required: false })
  date_became_client?: Date;

  @ApiProperty({ description: 'Organization status', enum: OrganizationStatus })
  status: OrganizationStatus;

  @ApiProperty({ description: 'Signed document URL', required: false })
  signed_document_url?: string;

  @ApiProperty({ description: 'Signed document date', required: false })
  signed_document_date?: Date;

  @ApiProperty({ description: 'Organization specialties', required: false })
  specialties?: string[];

  @ApiProperty({ description: 'Organization services', required: false })
  services?: string[];

  @ApiProperty({ description: 'Owner ID', required: false })
  owner_id?: string;

  @ApiProperty({ description: 'Admin ID', required: false, nullable: true })
  admin_id?: string | null;

  @ApiProperty({
    description: 'Organization address',
    required: false,
    nullable: true,
  })
  address?: string | null;

  @ApiProperty({
    description: 'Organization city',
    required: false,
    nullable: true,
  })
  city?: string | null;

  @ApiProperty({
    description: 'Organization state',
    required: false,
    nullable: true,
  })
  state?: string | null;

  @ApiProperty({
    description: 'Organization postal code',
    required: false,
    nullable: true,
  })
  postal_code?: string | null;

  @ApiProperty({
    description: 'Organization source',
    required: false,
    nullable: true,
  })
  source?: string | null;

  @ApiProperty({
    description: 'Organization type',
    required: false,
    nullable: true,
  })
  type?: string | null;

  @ApiProperty({
    description: 'Contact first name',
    required: false,
    nullable: true,
  })
  contact_first_name?: string | null;

  @ApiProperty({
    description: 'Contact last name',
    required: false,
    nullable: true,
  })
  contact_last_name?: string | null;

  @ApiProperty({
    description: 'Referred by affiliate ID',
    required: false,
    nullable: true,
  })
  referred_by_affiliate_id?: string | null;

  @ApiProperty({
    description: 'Refer to user ID',
    required: false,
    nullable: true,
  })
  refer_to_user_id?: string | null;

  @ApiProperty({
    description: 'Deletion date',
    required: false,
    nullable: true,
  })
  deletedAt?: Date | null;

  @ApiProperty({ description: 'Organization creation date' })
  createdAt: Date;

  @ApiProperty({ description: 'Organization last update date' })
  updatedAt: Date;

  @ApiProperty({ description: 'Owner information', required: false })
  owner?: {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    job_title?: string;
    phone?: string;
  };

  @ApiProperty({ description: 'Admin information', required: false })
  admin?: {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    job_title?: string;
    phone?: string;
  };

  @ApiProperty({ description: 'Number of users in organization' })
  userCount: number;

  @ApiProperty({ description: 'Number of active staff in organization' })
  staffCount: number;

  @ApiProperty({
    description: 'Invoice configuration',
    type: InvoiceConfigurationResponseDto,
    required: false,
  })
  invoiceConfiguration?: InvoiceConfigurationResponseDto;
}

export class PaginatedOrganizationsResponseDto {
  @ApiProperty({
    description: 'Array of organizations',
    type: [OrganizationResponseDto],
  })
  data: OrganizationResponseDto[];

  @ApiProperty({ description: 'Timestamp of the last sync', nullable: true })
  last_synced_at: string;

  @ApiProperty({ description: 'Pagination metadata', type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
