import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ReferredCompaniesService } from './referred-companies.service';
import { EligibilityCheckService } from './eligibility-check.service';
import { ReferralSyncService } from '../sync/referral-sync.service';
import { AuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../auth/current-user.decorator';
import { USER } from '@prisma/client';
import { ADMIN_ROLES, AFFILIATE_ROLES, ORGANIZATION_ROLES } from '../constants';
import { CreateReferredCompanyDto } from './dto/create-referred-company.dto';
import { ListReferredCompaniesDto } from './dto/list-referred-companies.dto';
import { UpdateReferralStageDto } from './dto/update-referral-stage.dto';
import { ApproveEligibilityDto } from './dto/approve-eligibility.dto';
import { BlockEligibilityDto } from './dto/block-eligibility.dto';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('med-alliance')
@ApiBearerAuth()
@Controller('med-alliance')
@UseGuards(AuthGuard, RolesGuard)
export class ReferredCompaniesController {
  constructor(
    private readonly service: ReferredCompaniesService,
    private readonly eligibilityCheck: EligibilityCheckService,
    private readonly referralSync: ReferralSyncService,
  ) {}

  // ---------------------------------------------------------------------------
  // Affiliate routes
  // ---------------------------------------------------------------------------

  // POST /med-alliance/referred-companies — Submit a new company referral.
  @Post('referred-companies')
  @HttpCode(201)
  // Any user can submit a referral, because the button on frontend only appears for the correct ones
  //@Roles(...AFFILIATE_ROLES, ...ADMIN_ROLES)
  @ApiOperation({
    summary: 'Submit a new company referral to the Med Alliance program',
  })
  @ApiBody({ type: CreateReferredCompanyDto })
  @ApiResponse({
    status: 201,
    description: 'Referred company created successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error or duplicate referral',
  })
  async create(
    @Body() dto: CreateReferredCompanyDto,
    @CurrentUser() user: USER,
  ) {
    const data = await this.service.create(dto, user);
    return {
      status: 201,
      message: 'Referred company created successfully',
      data,
    };
  }

  // GET /med-alliance/referred-companies — List own referred companies.
  @Get('referred-companies')
  @HttpCode(200)
  @Roles(...AFFILIATE_ROLES, ...ORGANIZATION_ROLES)
  @ApiOperation({
    summary: 'List all company referrals submitted by the current affiliate',
  })
  @ApiQuery({ type: ListReferredCompaniesDto })
  @ApiResponse({
    status: 200,
    description: 'Referred companies retrieved successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async findAll(
    @Query() query: ListReferredCompaniesDto,
    @CurrentUser() user: USER,
  ) {
    const result = await this.service.findAllForAffiliate(query, user);
    return {
      status: 200,
      message: 'Referred companies retrieved successfully',
      ...result,
    };
  }

  // GET /med-alliance/referred-companies/check-contact-email — Pre-validate contact email against HubSpot.
  @Get('referred-companies/check-contact-email')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Check if a contact email already exists in HubSpot before submitting a referral',
  })
  @ApiQuery({
    name: 'email',
    required: true,
    description: 'Contact email to check',
  })
  @ApiResponse({ status: 200, description: 'Check completed' })
  async checkContactEmail(@Query('email') email: string) {
    const exists = await this.service.checkContactEmailInHubspot(email);
    return { status: 200, message: 'OK', data: { exists } };
  }

  // GET /med-alliance/referred-companies/:id — Get one (scoped to affiliate).
  @Get('referred-companies/:id')
  @HttpCode(200)
  @Roles(...AFFILIATE_ROLES, ...ORGANIZATION_ROLES)
  @ApiOperation({
    summary:
      'Get details for a single referred company scoped to the current affiliate',
  })
  @ApiParam({ name: 'id', description: 'Referred company (organization) UUID' })
  @ApiResponse({
    status: 200,
    description: 'Referred company retrieved successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Referred company not found or access denied',
  })
  async findOne(@Param('id') id: string, @CurrentUser() user: USER) {
    const data = await this.service.findOneForAffiliate(id, user);
    return {
      status: 200,
      message: 'Referred company retrieved successfully',
      data,
    };
  }

  // ---------------------------------------------------------------------------
  // Admin routes
  // ---------------------------------------------------------------------------

  // POST /med-alliance/admin/affiliates/:affiliateId/referred-companies — Create referral on behalf of affiliate.
  @Post('admin/affiliates/:affiliateId/referred-companies')
  @HttpCode(201)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary: 'Create a new company referral on behalf of an affiliate (admin)',
  })
  @ApiParam({ name: 'affiliateId', description: 'Affiliate profile UUID' })
  @ApiBody({ type: CreateReferredCompanyDto })
  @ApiResponse({
    status: 201,
    description: 'Referred company created successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Affiliate profile not found',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied or affiliate is not active',
  })
  async createForAffiliate(
    @Param('affiliateId') affiliateId: string,
    @Body() dto: CreateReferredCompanyDto,
    @CurrentUser() adminUser: USER,
  ) {
    const data = await this.service.createAdminInitiated(
      affiliateId,
      dto,
      adminUser,
    );
    return {
      status: 201,
      message: 'Referred company created successfully',
      data,
    };
  }

  // GET /med-alliance/admin/referred-companies — List all referred companies.
  @Get('admin/referred-companies')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'List all referred companies across all affiliates for admin pipeline management',
  })
  @ApiQuery({ type: ListReferredCompaniesDto })
  @ApiResponse({
    status: 200,
    description: 'Referred companies retrieved successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async findAllAdmin(@Query() query: ListReferredCompaniesDto) {
    const result = await this.service.findAllForAdmin(query);
    return {
      status: 200,
      message: 'Referred companies retrieved successfully',
      ...result,
    };
  }

  // GET /med-alliance/admin/referred-companies/:id — Get one (no scoping).
  @Get('admin/referred-companies/:id')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Get full details for a single referred company without affiliate scoping',
  })
  @ApiParam({ name: 'id', description: 'Referred company (organization) UUID' })
  @ApiResponse({
    status: 200,
    description:
      'Referred company retrieved successfully. Includes referral_submission — an ' +
      'immutable snapshot (ReferralSubmissionSnapshotDto) of the referral form exactly ' +
      'as the affiliate submitted it, or null for referrals created before this field ' +
      'existed. Live organization fields (name, industry, website_url, location, phone) ' +
      'may differ from the snapshot if HubSpot sync has since updated them.',
  })
  @ApiResponse({ status: 404, description: 'Referred company not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async findOneAdmin(@Param('id') id: string) {
    const data = await this.service.findOneForAdmin(id);
    return {
      status: 200,
      message: 'Referred company retrieved successfully',
      data,
    };
  }

  // PATCH /med-alliance/admin/referred-companies/:id/stage — Move company to a new pipeline stage.
  @Patch('admin/referred-companies/:id/stage')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary: 'Move a referred company to a new referral pipeline stage',
  })
  @ApiParam({ name: 'id', description: 'Referred company (organization) UUID' })
  @ApiBody({ type: UpdateReferralStageDto })
  @ApiResponse({
    status: 200,
    description: 'Pipeline stage updated successfully',
  })
  @ApiResponse({ status: 404, description: 'Referred company not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async updateReferralStage(
    @Param('id') id: string,
    @Body() dto: UpdateReferralStageDto,
    @CurrentUser() admin: USER,
  ) {
    const data = await this.service.updateReferralStage(id, dto, admin);
    return {
      status: 200,
      message: 'Pipeline stage updated successfully',
      data,
    };
  }

  // PATCH /med-alliance/admin/referred-companies/:id/approve-eligibility
  // Confirms eligibility for a company that is pending or blocked (not_eligible).
  // Only executable once deployment_date is set and in the past.
  // Accepts backfill flag to control whether past detected commissions are promoted.
  @Patch('admin/referred-companies/:id/approve-eligibility')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Confirm eligibility for a referred company that is pending or blocked (admin)',
  })
  @ApiParam({ name: 'id', description: 'Referred company (organization) UUID' })
  @ApiBody({ type: ApproveEligibilityDto })
  @ApiResponse({ status: 200, description: 'Eligibility confirmed' })
  @ApiResponse({
    status: 400,
    description:
      'Already eligible, already expired, not a referral, not yet deployed, or deployment date is in the future',
  })
  @ApiResponse({ status: 404, description: 'Referred company not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async approveEligibility(
    @Param('id') id: string,
    @Body() dto: ApproveEligibilityDto,
    @CurrentUser() admin: USER,
  ) {
    const data = await this.service.approveEligibility(id, dto, admin);
    return { status: 200, message: 'Eligibility confirmed', data };
  }

  // PATCH /med-alliance/admin/referred-companies/:id/block-eligibility
  // Marks a company as not_eligible with a required reason. Callable from pending or eligible.
  @Patch('admin/referred-companies/:id/block-eligibility')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Block eligibility for a referred company that is pending or eligible (admin)',
  })
  @ApiParam({ name: 'id', description: 'Referred company (organization) UUID' })
  @ApiBody({ type: BlockEligibilityDto })
  @ApiResponse({ status: 200, description: 'Eligibility blocked' })
  @ApiResponse({
    status: 400,
    description: 'Already blocked, already expired, or not a referred company',
  })
  @ApiResponse({ status: 404, description: 'Referred company not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async blockEligibility(
    @Param('id') id: string,
    @Body() dto: BlockEligibilityDto,
    @CurrentUser() admin: USER,
  ) {
    const data = await this.service.blockEligibility(id, dto, admin);
    return { status: 200, message: 'Eligibility blocked', data };
  }

  // POST /med-alliance/admin/referred-companies/:id/eligibility-check
  // Re-runs the MA-004 active-client check for an existing referral.
  @Post('admin/referred-companies/:id/eligibility-check')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Re-run the eligibility check for a referred company to verify active client status',
  })
  @ApiParam({ name: 'id', description: 'Referred company (organization) UUID' })
  @ApiResponse({ status: 200, description: 'Eligibility check completed' })
  @ApiResponse({ status: 404, description: 'Referred company not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async recheck(@Param('id') id: string, @CurrentUser() user: USER) {
    const data = await this.eligibilityCheck.runAndPersist(
      id,
      user.id,
      'admin_action',
    );
    return { status: 200, message: 'Eligibility check completed', data };
  }

  // POST /med-alliance/admin/referred-companies/:id/sync
  // Re-runs the full MA-005 sync pipeline (Phase A + B) for an existing referral.
  // If hubspot_id is already set, Phase A is skipped and only invoices are re-ingested.
  @Post('admin/referred-companies/:id/sync')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Re-run the full sync pipeline for a referred company including HubSpot matching and invoice ingestion',
  })
  @ApiParam({ name: 'id', description: 'Referred company (organization) UUID' })
  @ApiResponse({ status: 200, description: 'Sync completed' })
  @ApiResponse({ status: 404, description: 'Referred company not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async sync(@Param('id') id: string) {
    const data = await this.referralSync.run(id);
    return { status: 200, message: 'Sync completed', data };
  }

  // POST /med-alliance/admin/referred-companies/:id/push-to-hubspot
  // Repairs a referral whose HubSpot company creation failed (hubspot_id is null):
  // creates the company, associates the existing contact and re-runs the sync pipeline.
  @Post('admin/referred-companies/:id/push-to-hubspot')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Create the missing HubSpot company for a referred company and associate its existing contact',
  })
  @ApiParam({ name: 'id', description: 'Referred company (organization) UUID' })
  @ApiResponse({ status: 200, description: 'HubSpot company created' })
  @ApiResponse({
    status: 400,
    description:
      'Not a referred company, already has a HubSpot company, or HubSpot rejected the creation',
  })
  @ApiResponse({ status: 404, description: 'Referred company not found' })
  async pushToHubspot(@Param('id') id: string, @CurrentUser() user: USER) {
    const data = await this.service.pushToHubspot(id, user);
    return { status: 200, message: 'HubSpot company created', data };
  }

  @Get('referred_to/options')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary:
      'Get available options and owners for the referred_to field in company referrals',
  })
  @ApiResponse({
    status: 200,
    description: 'Referred to options retrieved successfully',
  })
  async getReferredToOptionsController() {
    const result = await this.service.getReferredToOptions();
    return {
      status: 200,
      message: 'Referred to options retrieved successfully',
      data: result,
    };
  }
}
