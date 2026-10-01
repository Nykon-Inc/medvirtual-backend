import {
  Body,
  Controller,
  Post,
  Put,
  Param,
  HttpCode,
  Get,
  UseGuards,
  Query,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { OrganizationService } from './organization.service';
import { CreateOrganizationDto } from './dto/createOrganization.dto';
import { UpdateOrganizationDto } from './dto/updateOrganization.dto';
import { ConvertToClientDto } from './dto/convertToClient.dto';
import { UpdateInvoiceConfigurationDto } from './dto/updateInvoiceConfiguration.dto';
import { GetOrganizationsDto } from './dto/getOrganizations.dto';
import {
  OrganizationContactDto,
  PaginatedOrganizationsResponseDto,
} from './dto/organizationResponse.dto';
import {
  GetOrganizationStaffDto,
  AdminCreateStaffDto,
} from './dto/admin-staff-management.dto';
import {
  GetCandidatesForAdminDto,
  GetHireRequestsForAdminDto,
  AdminCreateStaffWithHireRequestDto,
} from './dto/admin-staff-selection.dto';

import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { USER } from '@prisma/client';

@ApiTags('Organization')
@ApiBearerAuth()
@Controller('organization')
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get('hubspot')
  @ApiOperation({ summary: 'Fetch all organizations from HubSpot CRM' })
  @ApiResponse({
    status: 200,
    description: 'Organizations retrieved from HubSpot successfully',
  })
  async getfromHubspot() {
    return await this.organizationService.getAllFromHubspot();
  }
  //========== // =========

  @Get('')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get all organizations' })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiResponse({
    status: 200,
    description: 'List of organizations retrieved successfully',
  })
  async getAll(@CurrentUser() user: USER, @Query('status') status?: string) {
    return await this.organizationService.getAll(user, status);
  }

  @Get('paginated')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(
    'system_super_admin',
    'system_admin',
    'organization_admin',
    'organization_super_admin',
  )
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get organizations with pagination, filtering, and search',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of organizations retrieved successfully',
    type: PaginatedOrganizationsResponseDto,
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 10, max: 100)',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search term for name, email, description, or member user name',
  })
  @ApiQuery({
    name: 'role',
    required: false,
    enum: ['prospect', 'client'],
    description: 'Filter by organization role',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    type: String,
    description: 'Filter by organization type',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['active', 'inactive'],
    description: 'Filter by organization status',
  })
  @ApiQuery({
    name: 'industry',
    required: false,
    type: String,
    description: 'Filter by industry',
  })
  @ApiQuery({
    name: 'location',
    required: false,
    type: String,
    description: 'Filter by location',
  })
  @ApiQuery({
    name: 'admin',
    required: false,
    type: String,
    description:
      'Filter by admin ID (available for system_super_admin and system_admin)',
  })
  @ApiQuery({
    name: 'hubstaffConnected',
    required: false,
    enum: ['true', 'false'],
    description: 'Filter by Hubstaff connection status',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: [
      'name',
      'email',
      'createdAt',
      'updatedAt',
      'number_of_employees',
      'userCount',
      'activeStaffCount',
    ],
    description: 'Sort field (default: createdAt)',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Sort order (default: desc)',
  })
  @ApiQuery({
    name: 'hasUser',
    required: false,
    type: Boolean,
    description:
      'Filter to show only organizations with at least one active user (userCount > 0)',
  })
  @ApiQuery({
    name: 'hasStaff',
    required: false,
    type: Boolean,
    description:
      'Filter to show only organizations with at least one active staff (staffCount > 0)',
  })
  @ApiQuery({
    name: 'without_referral',
    required: false,
    type: Boolean,
    description:
      'When true, only return organizations with no affiliate referral (referred_by_affiliate_id is null)',
  })
  @ApiQuery({
    name: 'billing_mode',
    required: false,
    enum: ['arrears', 'prebill'],
    description: 'Filter by billing mode',
  })
  async getAllPaginated(
    @CurrentUser() user: USER,
    @Query() query: GetOrganizationsDto,
  ): Promise<PaginatedOrganizationsResponseDto> {
    return await this.organizationService.getAllPaginated(user, query);
  }

  @Get(':id/contact')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(
    'system_admin',
    'system_super_admin',
    'organization_admin',
    'organization_super_admin',
  )
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get the main contact associated with an organization',
  })
  @ApiResponse({
    status: 200,
    description: 'Contact retrieved successfully',
    type: [OrganizationContactDto],
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getContactByOrgId(
    @Param('id') id: string,
  ): Promise<OrganizationContactDto[]> {
    return await this.organizationService.getContactByOrgId(id);
  }

  // GET /organization/check-name — Check if an organization name already exists in the DB.
  @Get('check-name')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Check if an organization name already exists before creating',
  })
  @ApiQuery({
    name: 'name',
    required: true,
    description: 'Organization name to check',
  })
  @ApiResponse({ status: 200, description: 'Check completed' })
  async checkName(@Query('name') name: string) {
    const exists =
      await this.organizationService.checkOrganizationNameExists(name);
    return { status: 200, message: 'OK', data: { exists } };
  }

  @Get('/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(
    'system_admin',
    'system_super_admin',
    'organization_admin',
    'organization_super_admin',
  )
  @HttpCode(200)
  @ApiOperation({ summary: 'Get organization by Id' })
  @ApiResponse({
    status: 200,
    description: 'Organization retrieved successfully',
  })
  async getById(@Param('id') id: string) {
    return await this.organizationService.getById(id);
  }

  @Post('create')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(201)
  @ApiBody({ type: CreateOrganizationDto })
  @ApiOperation({ summary: 'Create a new organization' })
  @ApiResponse({
    status: 201,
    description: 'Organization created successfully',
  })
  async create(@Body() data: CreateOrganizationDto, @CurrentUser() user: USER) {
    const org = await this.organizationService.create(data, user);
    return {
      status: 201,
      message: 'Organization created successfully',
      organization: org,
    };
  }

  @Put('edit/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(
    'system_admin',
    'system_super_admin',
    'organization_admin',
    'organization_super_admin',
  )
  @HttpCode(200)
  @ApiBody({ type: UpdateOrganizationDto })
  @ApiOperation({ summary: 'Edit organization info' })
  @ApiResponse({
    status: 200,
    description: 'Organization updated successfully',
  })
  async update(
    @Param('id') id: string,
    @Body() data: UpdateOrganizationDto,
    @CurrentUser() user: USER,
  ) {
    const org = await this.organizationService.update(id, data, user?.id);
    return {
      status: 200,
      message: 'Organization updated successfully',
      organization: org,
    };
  }

  @Put('/:id/invoice-configuration')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(
    'system_admin',
    'system_super_admin',
    'organization_admin',
    'organization_super_admin',
  )
  @HttpCode(200)
  @ApiBody({ type: UpdateInvoiceConfigurationDto })
  @ApiOperation({ summary: 'Update organization invoice configuration' })
  @ApiResponse({
    status: 200,
    description: 'Invoice configuration updated successfully',
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  async updateInvoiceConfiguration(
    @Param('id') id: string,
    @Body() data: UpdateInvoiceConfigurationDto,
    @CurrentUser() user: USER,
  ) {
    return await this.organizationService.updateInvoiceConfiguration(
      id,
      data,
      user?.id,
    );
  }

  @Post('convert-to-client/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(
    'system_admin',
    'system_super_admin',
    'organization_admin',
    'organization_super_admin',
  )
  @HttpCode(200)
  @ApiBody({ type: ConvertToClientDto })
  @ApiOperation({ summary: 'Convert organization from prospect to client' })
  @ApiResponse({
    status: 200,
    description: 'Organization converted to client successfully',
  })
  async convertToClient(
    @Param('id') id: string,
    @Body() data: ConvertToClientDto,
  ) {
    const org = await this.organizationService.convertToClient(id, data);
    return {
      status: 200,
      message: 'Organization converted to client successfully',
      organization: org,
    };
  }

  // Repairs an app-created organization whose HubSpot company creation failed.
  // Referred companies should use POST med-alliance/admin/referred-companies/:id/push-to-hubspot,
  // which also re-runs the referral sync pipeline.
  @Post('push-to-hubspot/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Create the missing HubSpot company for an organization and associate its existing contacts',
  })
  @ApiResponse({
    status: 200,
    description: 'HubSpot company created successfully',
  })
  async pushToHubspot(@Param('id') id: string, @CurrentUser() user: USER) {
    const data = await this.organizationService.pushToHubspot(id, user);
    return {
      status: 200,
      message: 'HubSpot company created successfully',
      data,
    };
  }

  @Put('assign-admin/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Assign an admin to an organization' })
  @ApiResponse({
    status: 200,
    description: 'Admin assigned successfully',
  })
  async assignAdmin(
    @Param('id') id: string,
    @Body('admin_id') adminId: string,
  ) {
    const org = await this.organizationService.assignAdmin(id, adminId);
    return {
      status: 200,
      message: 'Admin assigned successfully',
      organization: org,
    };
  }

  // @Post('delete/:id')
  // @UseGuards(AuthGuard, RolesGuard)
  // @Roles('system_super_admin')
  // @HttpCode(200)
  // @ApiOperation({ summary: 'Delete organization' })
  // @ApiResponse({
  //   status: 200,
  //   description: 'Organization deleted successfully',
  // })
  // async delete(@Param('id') id: string) {
  //   await this.organizationService.delete(id);
  //   return {
  //     status: 200,
  //     message: 'Organization deleted successfully',
  //   };
  // }

  // Admin Staff Management Endpoints
  @Get(':id/staff')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get staff for a specific organization',
    description:
      'Allows system admins to view all staff members for any organization',
  })
  @ApiResponse({
    status: 200,
    description: 'Organization staff retrieved successfully',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'perPage',
    required: false,
    type: Number,
    description: 'Items per page (default: 10)',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search term for staff name or hire request title',
  })
  @ApiQuery({
    name: 'start_date_from',
    required: false,
    type: Date,
    description: 'Filter staff by start date from',
  })
  @ApiQuery({
    name: 'start_date_to',
    required: false,
    type: Date,
    description: 'Filter staff by start date to',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description: 'Filter staff by status (e.g., Active, Inactive, etc.)',
  })
  async getOrganizationStaff(
    @Param('id') organizationId: string,
    @Query() query: GetOrganizationStaffDto,
    @CurrentUser() user: USER,
  ) {
    return await this.organizationService.getOrganizationStaff(
      organizationId,
      query,
      user,
    );
  }

  @Post('staff/create')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create staff for any organization',
    description:
      'Allows system admins to create staff members for any organization',
  })
  @ApiBody({ type: AdminCreateStaffDto })
  @ApiResponse({
    status: 201,
    description: 'Staff created successfully for organization',
  })
  async createStaffForOrganization(
    @Body() data: AdminCreateStaffDto,
    @CurrentUser() user: USER,
  ) {
    return await this.organizationService.createStaffForOrganization(
      data,
      user,
    );
  }

  // Admin Selection Endpoints
  @Get('candidates')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get all candidates for admin selection',
    description:
      'Allows system admins to view and select candidates for staff creation',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'perPage',
    required: false,
    type: Number,
    description: 'Items per page (default: 20)',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search term for candidate name or email',
  })
  @ApiQuery({
    name: 'specialization',
    required: false,
    type: String,
    description: 'Filter by specialization',
  })
  @ApiQuery({
    name: 'employment_type',
    required: false,
    type: String,
    description: 'Filter by employment type',
  })
  @ApiQuery({
    name: 'country',
    required: false,
    type: String,
    description: 'Filter by country',
  })
  @ApiResponse({
    status: 200,
    description: 'Candidates retrieved successfully',
  })
  async getCandidatesForAdmin(@Query() query: GetCandidatesForAdminDto) {
    return await this.organizationService.getCandidatesForAdmin(query);
  }

  @Get(':id/hire-requests')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get hire requests for organization',
    description:
      'Allows system admins to view existing hire requests for an organization',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'perPage',
    required: false,
    type: Number,
    description: 'Items per page (default: 20)',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search term for hire request title',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description: 'Filter by status',
  })
  @ApiQuery({
    name: 'specialization',
    required: false,
    type: String,
    description: 'Filter by specialization',
  })
  @ApiResponse({
    status: 200,
    description: 'Hire requests retrieved successfully',
  })
  async getHireRequestsForAdmin(
    @Param('id') organizationId: string,
    @Query() query: GetHireRequestsForAdminDto,
  ) {
    return await this.organizationService.getHireRequestsForAdmin(
      organizationId,
      query,
    );
  }

  @Post('staff/create-with-hire-request')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create staff with optional hire request',
    description:
      'Allows system admins to create staff with or without existing hire request',
  })
  @ApiBody({ type: AdminCreateStaffWithHireRequestDto })
  @ApiResponse({
    status: 201,
    description: 'Staff created successfully for organization',
  })
  async createStaffWithOptionalHireRequest(
    @Body() data: AdminCreateStaffWithHireRequestDto,
    @CurrentUser() user: USER,
  ) {
    return await this.organizationService.createStaffWithOptionalHireRequest(
      data,
      user,
    );
  }

  @Get('hire-requests/:id/details')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get hire request details with attached candidates',
    description:
      'Allows system admins to view hire request details and attached candidates',
  })
  @ApiParam({
    name: 'id',
    required: true,
    type: String,
    description: 'Hire request ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Hire request details retrieved successfully',
  })
  async getHireRequestDetails(@Param('id') id: string) {
    return await this.organizationService.getHireRequestDetails(id);
  }

  @Get('hire-requests/:id/candidates')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get candidates attached to a specific hire request',
    description:
      'Allows system admins to view candidates that are attached to a specific hire request',
  })
  @ApiParam({
    name: 'id',
    required: true,
    type: String,
    description: 'Hire request ID',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'perPage',
    required: false,
    type: Number,
    description: 'Items per page (default: 20)',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search term for candidate name or email',
  })
  @ApiQuery({
    name: 'specialization',
    required: false,
    type: String,
    description: 'Filter by specialization',
  })
  @ApiQuery({
    name: 'employment_type',
    required: false,
    type: String,
    description: 'Filter by employment type',
  })
  @ApiQuery({
    name: 'country',
    required: false,
    type: String,
    description: 'Filter by country',
  })
  @ApiResponse({
    status: 200,
    description: 'Candidates for hire request retrieved successfully',
  })
  async getCandidatesForHireRequest(
    @Param('id') id: string,
    @Query() query: GetCandidatesForAdminDto,
  ) {
    return await this.organizationService.getCandidatesForHireRequest(
      id,
      query,
    );
  }

  @Get('populate-db/from-hubspot')
  @ApiOperation({
    summary: 'Populate the database with organizations imported from HubSpot',
  })
  @ApiResponse({
    status: 200,
    description: 'Organizations populated successfully',
  })
  async populateDbFromHubspot() {
    return await this.organizationService.populateDbFromHubspot();
  }

  @Get('desactive-all/without-staff')
  @ApiOperation({
    summary:
      'Deactivate all organization records that have no associated staff members',
  })
  @ApiResponse({
    status: 200,
    description: 'Organizations deactivated successfully',
  })
  async desactiveWithoutStaff() {
    return await this.organizationService.desactiveWithoutStaff();
  }

  @Get('sync-all/organizations-with-deals')
  @UseGuards(AuthGuard)
  @Roles('system_super_admin', 'system_admin')
  @ApiOperation({
    summary: 'Sync all organizations with their associated deals in HubSpot',
  })
  @ApiResponse({
    status: 200,
    description: 'Organizations synced with deals successfully',
  })
  async syncAllOrganizationsWithDeals() {
    return await this.organizationService.syncOrganizationsWithDeals();
  }

  @Get('get-organization/industry-types')
  @UseGuards(AuthGuard)
  @Roles('system_super_admin', 'system_admin')
  @ApiOperation({
    summary:
      'Get available industry type options from HubSpot for organization forms',
  })
  @ApiResponse({
    status: 200,
    description: 'Industry types retrieved successfully',
  })
  async getOrganizationIndustryTypes() {
    return await this.organizationService.getOrganizationIndustryTypes();
  }

  @Get('get-organization-types/all')
  @UseGuards(AuthGuard)
  @Roles('system_super_admin', 'system_admin')
  @ApiOperation({
    summary:
      'Get available organization type options from HubSpot for organization forms',
  })
  @ApiResponse({
    status: 200,
    description: 'Organization types retrieved successfully',
  })
  async getOrganizationTypes() {
    return await this.organizationService.getOrganizationTypes();
  }
}
