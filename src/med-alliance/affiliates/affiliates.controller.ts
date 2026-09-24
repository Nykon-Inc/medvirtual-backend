import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AffiliatesService } from './affiliates.service';
import { AuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../auth/current-user.decorator';
import { USER } from '@prisma/client';
import { ADMIN_ROLES, AFFILIATE_ROLES, ORGANIZATION_ROLES } from '../constants';
import { CreateAffiliateProfileDto } from './dto/create-affiliate-profile.dto';
import {
  JoinProgramDto,
  LinkOrganizationDto,
  UpdateAffiliatePayoutPreferencesDto,
  UpdateAffiliateProfileDto,
} from './dto/update-affiliate-profile.dto';
import { ListAffiliatesDto } from './dto/list-affiliates.dto';
import { CreateUserAndAffiliateProfileDto } from './dto/create-user-and-affiliate.dto';
import { InviteUserForAffiliateDto } from './dto/invite-user-for-affiliate.dto';
import { AssociateCompanyDto } from './dto/associate-company.dto';
import { AssociationPreviewQueryDto } from './dto/association-preview-query.dto';

function isBankingComplete(
  billcomVendorId: string | null | undefined,
): boolean {
  return !!billcomVendorId;
}

function mapPayoutHistory(payoutHistory: any[]) {
  return payoutHistory.map((pr: any) => ({
    id: pr.id,
    payout_request_id: pr.id,
    amount: Number(pr.paid_amount ?? pr.requested_amount ?? 0),
    paid_at: pr.paid_at?.toISOString() ?? '',
    payment_method: pr.payment_method ?? '',
    transaction_reference: pr.transaction_reference ?? null,
    status: pr.status,
  }));
}

@ApiTags('med-alliance')
@ApiBearerAuth()
@Controller('med-alliance')
@UseGuards(AuthGuard, RolesGuard)
export class AffiliatesController {
  constructor(private readonly affiliatesService: AffiliatesService) {}

  // ---------------------------------------------------------------------------
  // Admin routes
  // ---------------------------------------------------------------------------

  // POST /med-alliance/admin/affiliates — Create an affiliate profile for a user.
  @Post('admin/affiliates')
  @HttpCode(201)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary: 'Create a new affiliate profile for an existing platform user',
  })
  @ApiBody({ type: CreateAffiliateProfileDto })
  @ApiResponse({
    status: 201,
    description: 'Affiliate profile created successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error or user already has an affiliate profile',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async create(
    @Body() dto: CreateAffiliateProfileDto,
    @CurrentUser() admin: USER,
  ) {
    const data = await this.affiliatesService.create(dto, admin);
    return data;
  }

  // POST /med-alliance/admin/user-and-affiliates — Create both a user and an affiliate profile in one step (for manual enrollments when the user doesn't exist yet).
  @Post('admin/user-and-affiliates')
  @HttpCode(201)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Create a new platform user and their affiliate profile in a single step for manual enrollments',
  })
  @ApiBody({ type: CreateUserAndAffiliateProfileDto })
  @ApiResponse({
    status: 201,
    description: 'User and affiliate profile created successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error or email already in use',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async createUserAndAffiliate(
    @Body() dto: CreateUserAndAffiliateProfileDto,
    @CurrentUser() admin: USER,
  ) {
    const data = await this.affiliatesService.createUserandAffiliate(
      dto,
      admin,
    );
    return data;
  }

  // GET /med-alliance/admin/affiliates — List all affiliate profiles.
  @Get('admin/affiliates')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'List all affiliate profiles with filtering, search, and pagination',
  })
  @ApiQuery({ type: ListAffiliatesDto })
  @ApiResponse({
    status: 200,
    description: 'Affiliate profiles retrieved successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async findAll(@Query() query: ListAffiliatesDto) {
    const result = await this.affiliatesService.findAll(query);
    const data = result.data.map((profile) => {
      const user = profile.user as any;
      const vendorId =
        (profile as any).contact?.hubspot_billcom_vendor_id ??
        user?.contact?.hubspot_billcom_vendor_id ??
        null;
      return {
        id: profile.id,
        user_id: profile.user_id,
        full_name:
          profile.full_name ||
          `${user?.first_name ?? ''} ${user?.last_name ?? ''}`.trim(),
        email: user?.email ?? '',
        status: profile.status,
        commission_percent_default: Number(profile.commission_percent_default),
        payout_preference_method: profile.payout_preference_method,
        payout_preference_reference: profile.payout_preference_reference,
        payout_preference_notes: profile.payout_preference_notes,
        payout_details: {
          billcom_vendor_id: vendorId,
        },
        banking_complete: isBankingComplete(vendorId),
        linked_company: user?.organization?.name ?? null,
        linked_company_id: user?.organization?.id ?? null,
        organization: user?.organization
          ? {
              id: user.organization.id,
              name: user.organization.name,
              business_unit: user.organization.business_unit ?? null,
              organization_role: user.organization.organization_role ?? null,
              status: user.organization.status ?? null,
              admin: user.organization.admin
                ? {
                    id: user.organization.admin.id,
                    first_name: user.organization.admin.first_name,
                    last_name: user.organization.admin.last_name,
                  }
                : null,
            }
          : null,
        referred_companies_count: user?._count?.referredOrganizations ?? 0,
        pending_payout_amount: 0,
        lifetime_commissions: 0,
        hubspot_id: profile.hubspot_id ?? null,
        created_at: profile.createdAt.toISOString(),
        hubspot_pipeline: profile.hubspot_pipeline ?? null,
        hubspot_pipeline_stage: profile.hubspot_pipeline_stage ?? null,
        business_unit: profile.business_unit ?? null,
        user_role: user?.role ?? null,
        associated_contact_id: user?.contact?.id ?? null,
        associated_contact_name:
          [user?.contact?.first_name, user?.contact?.last_name]
            .filter(Boolean)
            .join(' ') || null,
        associated_contact_email: user?.contact?.email ?? null,
        associated_contact_job_title: user?.contact?.job_title ?? null,
      };
    });
    return {
      status: 200,
      message: 'Affiliate profiles retrieved successfully',
      data,
      pagination: result.pagination,
    };
  }

  // GET /med-alliance/admin/stats — Aggregated KPI stats for the admin dashboard.
  // Must be declared before /:id routes.
  @Get('admin/stats')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Get aggregated KPI statistics for the Med Alliance admin dashboard',
  })
  @ApiResponse({
    status: 200,
    description: 'Admin dashboard stats retrieved successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async getAdminStats() {
    const data = await this.affiliatesService.getAdminDashboardStats();
    return {
      status: 200,
      message: 'Admin dashboard stats retrieved successfully',
      data,
    };
  }

  // GET /med-alliance/admin/users/eligible?email=xxx — Search platform users without an affiliate profile.
  // Used by the "Create Affiliate" modal to find existing users.
  @Get('admin/users/eligible')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Search existing platform users who do not yet have an affiliate profile',
  })
  @ApiQuery({
    name: 'email',
    required: false,
    description: 'Search by user email address',
  })
  @ApiResponse({
    status: 200,
    description: 'Eligible users retrieved successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async searchEligibleUsers(@Query('email') email: string) {
    const data = await this.affiliatesService.searchEligibleUsers(email ?? '');
    return {
      status: 200,
      message: 'Eligible users retrieved successfully',
      data,
    };
  }

  // GET /med-alliance/admin/users/eligible-org-users?search=xxx
  // Returns active organization_admin / organization_super_admin users
  // that do not yet have an affiliate profile.
  @Get('admin/users/eligible-org-users')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Search organization admin users who are eligible to join the affiliate program',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by name or email',
  })
  @ApiResponse({
    status: 200,
    description: 'Eligible org users retrieved successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async findEligibleOrgUsers(@Query('search') search?: string) {
    const data = await this.affiliatesService.findEligibleOrgUsers(search);
    return {
      status: 200,
      message: 'Eligible org users retrieved successfully',
      data,
    };
  }

  // GET /med-alliance/admin/affiliates/by-user/:userId — Get affiliate profile by user ID.
  // Must be declared BEFORE the /:id route so NestJS does not treat "by-user" as an id.
  @Get('admin/affiliates/by-user/:userId')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary: 'Get affiliate profile by the associated platform user ID',
  })
  @ApiParam({ name: 'userId', description: 'Platform user UUID' })
  @ApiResponse({
    status: 200,
    description: 'Affiliate profile retrieved successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Affiliate profile not found for this user',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async findByUserId(@Param('userId') userId: string) {
    const data = await this.affiliatesService.findByUserId(userId);
    return { status: 'success', data };
  }

  // GET /med-alliance/admin/affiliates/:id/eligible-commissions
  // Authoritative eligible list for the payout flow — unlike the side panel's
  // `recent_commissions`, this is not capped to a recency window.
  @Get('admin/affiliates/:id/eligible-commissions')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'List every eligible commission for an affiliate, with the total payable amount',
  })
  @ApiParam({ name: 'id', description: 'Affiliate profile UUID' })
  @ApiResponse({
    status: 200,
    description: 'Eligible commissions retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Affiliate profile not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async findEligibleCommissions(@Param('id') id: string) {
    const data = await this.affiliatesService.findEligibleCommissions(id);
    return {
      status: 200,
      message: 'Eligible commissions retrieved successfully',
      data,
    };
  }

  // GET /med-alliance/admin/affiliates/:id — Get one affiliate profile (enriched for side panel).
  @Get('admin/affiliates/:id')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Get a single affiliate profile enriched with commission history and payout data for the side panel',
  })
  @ApiParam({ name: 'id', description: 'Affiliate profile UUID' })
  @ApiResponse({
    status: 200,
    description: 'Affiliate profile retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Affiliate profile not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async findOne(@Param('id') id: string) {
    const enriched = await this.affiliatesService.findOneEnriched(id);
    const profile = enriched.profile;
    const user = (profile as any).user;

    const commsByOrgMap: Record<string, number> = Object.fromEntries(
      enriched.commsByOrg.map((r: any) => [
        r.organization_id,
        Number(r._sum.commission_amount ?? 0),
      ]),
    );

    const vendorId =
      (profile as any).contact?.hubspot_billcom_vendor_id ??
      user?.contact?.hubspot_billcom_vendor_id ??
      null;

    const data = {
      id: profile.id,
      user_id: profile.user_id,
      full_name:
        profile.full_name ||
        `${user?.first_name ?? ''} ${user?.last_name ?? ''}`.trim(),
      email: user?.email ?? '',
      status: profile.status,
      commission_percent_default: Number(profile.commission_percent_default),
      payout_preference_method: profile.payout_preference_method,
      payout_preference_reference: profile.payout_preference_reference,
      payout_preference_notes: profile.payout_preference_notes,
      payout_details: {
        billcom_vendor_id: vendorId,
      },
      banking_complete: isBankingComplete(vendorId),
      linked_company: user?.organization?.name ?? null,
      linked_company_id: user?.organization?.id ?? null,
      organization: user?.organization
        ? {
            id: user.organization.id,
            name: user.organization.name,
            business_unit: user.organization.business_unit ?? null,
            organization_role: user.organization.organization_role ?? null,
            status: user.organization.status ?? null,
            admin: user.organization.admin
              ? {
                  id: user.organization.admin.id,
                  first_name: user.organization.admin.first_name,
                  last_name: user.organization.admin.last_name,
                }
              : null,
          }
        : null,
      referred_companies_count: user?.referredOrganizations?.length ?? 0,
      pending_payout_amount: Number(
        enriched.pendingAgg?._sum?.requested_amount ?? 0,
      ),
      lifetime_commissions: Number(
        enriched.lifetimeAgg?._sum?.commission_amount ?? 0,
      ),
      hubspot_id: profile.hubspot_id ?? null,
      hubspot_pipeline: profile.hubspot_pipeline ?? null,
      hubspot_pipeline_stage: profile.hubspot_pipeline_stage ?? null,
      business_unit: profile.business_unit ?? null,
      user_role: user?.role ?? null,
      created_at: profile.createdAt.toISOString(),
      referred_companies: (user?.referredOrganizations ?? []).map(
        (org: any) => ({
          id: org.id,
          name: org.name,
          referral_status: org.med_alliance_referral_status ?? org.status,
          referral_stage: org.referral_stage ?? null,
          total_commissions: commsByOrgMap[org.id] ?? 0,
        }),
      ),
      // Authoritative totals over ALL eligible commissions. `recent_commissions`
      // below is a capped preview, so counting eligible rows there undercounts
      // whenever pending commissions crowd the window — consumers showing an
      // eligible count, and anything driving a payout, must use these (or
      // GET /admin/affiliates/:id/eligible-commissions for the full list).
      eligible_count: (enriched as any).eligibleAgg?._count ?? 0,
      eligible_amount: Number(
        (enriched as any).eligibleAgg?._sum?.commission_amount ?? 0,
      ),
      recent_commissions: (profile.commissions ?? []).map((c: any) => ({
        id: c.id,
        organization_name: c.organization?.name ?? '',
        amount: Number(c.commission_amount),
        status: c.status,
        date: c.createdAt.toISOString(),
        invoice_id: c.hubspotInvoiceSnapshot?.hubspot_id ?? null,
        name: c.hubspotInvoiceSnapshot?.invoice_number ?? null,
      })),
      payout_history: mapPayoutHistory(enriched.payoutHistory),
      user: {
        id: user?.id ?? null,
        first_name: user?.first_name ?? null,
        last_name: user?.last_name ?? null,
        email: user?.email ?? null,
        role: user?.role ?? null,
        status: user?.status ?? null,
      },
    };

    return {
      status: 200,
      message: 'Affiliate profile retrieved successfully',
      data,
    };
  }

  // PATCH /med-alliance/admin/affiliates/:id/deactivate — Deactivate affiliate profile (and user if role is 'affiliate').
  @Patch('admin/affiliates/:id/deactivate')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Deactivate an affiliate profile and the associated user if their role is affiliate',
  })
  @ApiParam({ name: 'id', description: 'Affiliate profile UUID' })
  @ApiResponse({
    status: 200,
    description: 'Affiliate deactivated successfully',
  })
  @ApiResponse({ status: 404, description: 'Affiliate profile not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async deactivate(@Param('id') id: string, @CurrentUser() admin: USER) {
    await this.affiliatesService.deactivate(id, admin);
    return { status: 200, message: 'Affiliate deactivated successfully' };
  }

  // PATCH /med-alliance/admin/affiliates/:id/reactivate — Reactivate affiliate (and user if role is 'affiliate').
  @Patch('admin/affiliates/:id/reactivate')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Reactivate a previously deactivated affiliate profile and associated user',
  })
  @ApiParam({ name: 'id', description: 'Affiliate profile UUID' })
  @ApiResponse({
    status: 200,
    description: 'Affiliate reactivated successfully',
  })
  @ApiResponse({ status: 404, description: 'Affiliate profile not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async reactivate(@Param('id') id: string, @CurrentUser() admin: USER) {
    await this.affiliatesService.reactivate(id, admin);
    return { status: 200, message: 'Affiliate reactivated successfully' };
  }

  // DELETE /med-alliance/admin/affiliates/:id — Delete an invited affiliate (status must be 'invited').
  @Delete('admin/affiliates/:id')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary: 'Delete an affiliate profile that is still in invited status',
  })
  @ApiParam({ name: 'id', description: 'Affiliate profile UUID' })
  @ApiResponse({ status: 200, description: 'Affiliate deleted successfully' })
  @ApiResponse({ status: 404, description: 'Affiliate profile not found' })
  @ApiResponse({
    status: 400,
    description: 'Affiliate must be in invited status to be deleted',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async deleteInvited(@Param('id') id: string, @CurrentUser() admin: USER) {
    await this.affiliatesService.deleteInvited(id, admin);
    return { status: 200, message: 'Affiliate deleted successfully' };
  }

  // POST /med-alliance/admin/affiliates/:id/invite-user — Invite a user and link them to an affiliate that has no connected user.
  @Post('admin/affiliates/:id/invite-user')
  @HttpCode(201)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Invite a new user and link them to an existing affiliate profile that has no connected user',
  })
  @ApiParam({ name: 'id', description: 'Affiliate profile UUID' })
  @ApiBody({ type: InviteUserForAffiliateDto })
  @ApiResponse({
    status: 201,
    description: 'User invited and linked to affiliate successfully',
  })
  @ApiResponse({ status: 404, description: 'Affiliate profile not found' })
  @ApiResponse({
    status: 400,
    description: 'Affiliate already has a linked user',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async inviteUserForAffiliate(
    @Param('id') id: string,
    @Body() dto: InviteUserForAffiliateDto,
    @CurrentUser() admin: USER,
  ) {
    const enriched = await this.affiliatesService.inviteUserForAffiliate(
      id,
      dto,
      admin.id,
    );
    const profile = enriched.profile;
    const user = profile.user as any;

    const commsByOrgMap: Record<string, number> = Object.fromEntries(
      enriched.commsByOrg.map((r: any) => [
        r.organization_id,
        Number(r._sum.commission_amount ?? 0),
      ]),
    );

    const vendorId =
      (profile as any).contact?.hubspot_billcom_vendor_id ??
      user?.contact?.hubspot_billcom_vendor_id ??
      null;

    const data = {
      id: profile.id,
      user_id: profile.user_id,
      full_name:
        profile.full_name ||
        `${user?.first_name ?? ''} ${user?.last_name ?? ''}`.trim(),
      email: user?.email ?? '',
      status: profile.status,
      commission_percent_default: Number(profile.commission_percent_default),
      payout_preference_method: profile.payout_preference_method,
      payout_preference_reference: profile.payout_preference_reference,
      payout_preference_notes: profile.payout_preference_notes,
      payout_details: {
        billcom_vendor_id: vendorId,
      },
      banking_complete: isBankingComplete(vendorId),
      linked_company: user?.organization?.name ?? null,
      linked_company_id: user?.organization?.id ?? null,
      organization: user?.organization
        ? {
            id: user.organization.id,
            name: user.organization.name,
            business_unit: user.organization.business_unit ?? null,
            organization_role: user.organization.organization_role ?? null,
            status: user.organization.status ?? null,
            admin: user.organization.admin
              ? {
                  id: user.organization.admin.id,
                  first_name: user.organization.admin.first_name,
                  last_name: user.organization.admin.last_name,
                }
              : null,
          }
        : null,
      referred_companies_count: user?.referredOrganizations?.length ?? 0,
      pending_payout_amount: Number(
        enriched.pendingAgg._sum.requested_amount ?? 0,
      ),
      lifetime_commissions: Number(
        enriched.lifetimeAgg._sum.commission_amount ?? 0,
      ),
      hubspot_id: profile.hubspot_id ?? null,
      hubspot_pipeline: profile.hubspot_pipeline ?? null,
      hubspot_pipeline_stage: profile.hubspot_pipeline_stage ?? null,
      business_unit: profile.business_unit ?? null,
      user_role: user?.role ?? null,
      created_at: profile.createdAt.toISOString(),
      referred_companies: (user?.referredOrganizations ?? []).map(
        (org: any) => ({
          id: org.id,
          name: org.name,
          referral_status: org.med_alliance_referral_status ?? org.status,
          referral_stage: org.referral_stage ?? null,
          total_commissions: commsByOrgMap[org.id] ?? 0,
        }),
      ),
      recent_commissions: (profile.commissions ?? []).map((c: any) => ({
        id: c.id,
        organization_name: c.organization?.name ?? '',
        amount: Number(c.commission_amount),
        status: c.status,
        date: c.createdAt.toISOString(),
        invoice_id: c.hubspotInvoiceSnapshot?.hubspot_id ?? null,
        name: c.hubspotInvoiceSnapshot?.invoice_number ?? null,
      })),
      payout_history: mapPayoutHistory(enriched.payoutHistory),
    };

    return {
      status: 201,
      message: 'User invited and linked to affiliate successfully',
      data,
    };
  }

  @Get('admin/affiliates/:id/re-invite-user')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary: 'Re-send the affiliate invite email to an already-invited user',
  })
  @ApiParam({ name: 'id', description: 'Affiliate profile UUID' })
  @ApiResponse({
    status: 200,
    description: 'Re-invitation sent successfully',
  })
  @ApiResponse({ status: 404, description: 'Affiliate profile not found' })
  @ApiResponse({ status: 400, description: 'Affiliate has no connected user' })
  async reInviteAffiliateUser(
    @Param('id') id: string,
    @CurrentUser() admin: USER,
  ) {
    const message = await this.affiliatesService.reInviteAffiliateUser(
      id,
      admin.id,
    );
    return { statusCode: 200, message };
  }

  // PATCH /med-alliance/admin/affiliates/:id — Update profile (admin full access).
  @Patch('admin/affiliates/:id')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Update an affiliate profile (admin full access including commission rate and status)',
  })
  @ApiParam({ name: 'id', description: 'Affiliate profile UUID' })
  @ApiBody({ type: UpdateAffiliateProfileDto })
  @ApiResponse({
    status: 200,
    description: 'Affiliate profile updated successfully',
  })
  @ApiResponse({ status: 404, description: 'Affiliate profile not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAffiliateProfileDto,
  ) {
    const data = await this.affiliatesService.update(id, dto);
    return {
      status: 200,
      message: 'Affiliate profile updated successfully',
      data,
    };
  }

  // PATCH /med-alliance/admin/affiliates/:id/link-organization — Link user to an org.
  @Patch('admin/affiliates/:id/link-organization')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      "Link an affiliate's associated user to a specific platform organization",
  })
  @ApiParam({ name: 'id', description: 'Affiliate profile UUID' })
  @ApiBody({ type: LinkOrganizationDto })
  @ApiResponse({ status: 200, description: 'Organization linked successfully' })
  @ApiResponse({
    status: 404,
    description: 'Affiliate profile or organization not found',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async linkOrganization(
    @Param('id') id: string,
    @Body() dto: LinkOrganizationDto,
    @CurrentUser() admin: USER,
  ) {
    const data = await this.affiliatesService.linkOrganization(id, dto, admin);
    return { status: 200, message: 'Organization linked successfully', data };
  }

  // GET /med-alliance/admin/affiliates/:id/association-preview — Preview what association would produce.
  // Must be declared before /:id/associate-company to avoid routing collision.
  @Get('admin/affiliates/:id/association-preview')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Preview the result of associating an organization: returns org info, invoice snapshots, and projected eligibility',
  })
  @ApiParam({ name: 'id', description: 'Affiliate profile UUID' })
  @ApiQuery({ type: AssociationPreviewQueryDto })
  @ApiResponse({
    status: 200,
    description: 'Preview data retrieved successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Affiliate profile or organization not found',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async associationPreview(
    @Param('id') id: string,
    @Query() query: AssociationPreviewQueryDto,
  ) {
    const data = await this.affiliatesService.previewAssociation(
      id,
      query.organization_id,
    );
    return {
      status: 200,
      message: 'Preview data retrieved successfully',
      data,
    };
  }

  // POST /med-alliance/admin/affiliates/:id/associate-company — Associate existing org as referral.
  @Post('admin/affiliates/:id/associate-company')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Associate an existing platform organization with this affiliate as a referral',
  })
  @ApiParam({ name: 'id', description: 'Affiliate profile UUID' })
  @ApiBody({ type: AssociateCompanyDto })
  @ApiResponse({ status: 200, description: 'Company associated successfully' })
  @ApiResponse({
    status: 404,
    description: 'Affiliate profile or organization not found',
  })
  @ApiResponse({
    status: 400,
    description: 'Company already has a referral or affiliate has no user',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied or affiliate is not active',
  })
  async associateCompany(
    @Param('id') id: string,
    @Body() dto: AssociateCompanyDto,
    @CurrentUser() admin: USER,
  ) {
    const data = await this.affiliatesService.associateCompany(
      id,
      dto.organization_id,
      admin,
    );
    return { status: 200, message: 'Company associated successfully', data };
  }

  // ---------------------------------------------------------------------------
  // Affiliate routes
  // ---------------------------------------------------------------------------

  // POST /med-alliance/affiliates/join — Self-enrollment for organization admins.
  @Post('affiliates/join')
  @HttpCode(201)
  @Roles(...ORGANIZATION_ROLES)
  @ApiOperation({
    summary:
      'Self-enroll as an affiliate in the Med Alliance program (organization admins)',
  })
  @ApiBody({ type: JoinProgramDto })
  @ApiResponse({
    status: 201,
    description: 'Successfully enrolled in the affiliate program',
  })
  @ApiResponse({ status: 400, description: 'Already enrolled or not eligible' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async joinProgram(
    @CurrentUser() currentUser: USER,
    @Body() dto: JoinProgramDto,
  ) {
    const data = await this.affiliatesService.joinProgram(currentUser, dto);
    return data;
  }

  // GET /med-alliance/affiliates/me — Get own profile.
  @Get('affiliates/me')
  @HttpCode(200)
  @Roles(...ORGANIZATION_ROLES, ...AFFILIATE_ROLES)
  @ApiOperation({
    summary: "Get the current affiliate's own profile and enrollment details",
  })
  @ApiResponse({
    status: 200,
    description: 'Affiliate profile retrieved successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Affiliate profile not found for current user',
  })
  async findOwn(@CurrentUser() user: USER) {
    const data = await this.affiliatesService.findOwn(user);
    const vendorId =
      (data.payout_details as Record<string, unknown> | null)
        ?.billcom_vendor_id ?? null;
    return {
      status: 200,
      message: 'Affiliate profile retrieved successfully',
      data: {
        ...data,
        banking_complete: isBankingComplete(vendorId as string | null),
      },
    };
  }

  // GET /med-alliance/affiliates/me/stats — Earnings & recent commissions for affiliate dashboard.
  @Get('affiliates/me/stats')
  @HttpCode(200)
  @Roles(...AFFILIATE_ROLES, ...ORGANIZATION_ROLES)
  @ApiOperation({
    summary:
      'Get earnings summary and recent commission history for the affiliate dashboard',
  })
  @ApiResponse({
    status: 200,
    description: 'Affiliate stats retrieved successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Affiliate profile not found for current user',
  })
  async getMyStats(@CurrentUser() user: USER) {
    const data = await this.affiliatesService.getMyStats(user);
    return {
      status: 200,
      message: 'Affiliate stats retrieved successfully',
      data,
    };
  }

  // PATCH /med-alliance/affiliates/me — Update own payout preferences only.
  @Patch('affiliates/me')
  @HttpCode(200)
  @Roles(...ORGANIZATION_ROLES, ...AFFILIATE_ROLES)
  @ApiOperation({
    summary:
      'Update own payout preferences including payment method and banking details',
  })
  @ApiBody({ type: UpdateAffiliatePayoutPreferencesDto })
  @ApiResponse({
    status: 200,
    description: 'Payout preferences updated successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Affiliate profile not found for current user',
  })
  async updateOwn(
    @CurrentUser() user: USER,
    @Body() dto: UpdateAffiliatePayoutPreferencesDto,
  ) {
    const data = await this.affiliatesService.updateOwn(user, dto);
    return {
      status: 200,
      message: 'Payout preferences updated successfully',
      data,
    };
  }
}
