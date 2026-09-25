import { Controller, Get, HttpCode, Query, UseGuards } from '@nestjs/common';
import { PanelService } from './panel.service';

import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { TalentAvailabilityByRoleDto } from './dto/talent-availability-by-role.dto';
import { ClientSelectedCandidatesQueryDto } from './dto/client-selected-candidates-query.dto';
import { ClientSelectedCandidatesResponseDto } from './dto/client-selected-candidate-row.dto';
import { CandidateEndorsementsQueryDto } from './dto/candidate-endorsements-query.dto';
import { CandidateEndorsementsResponseDto } from './dto/candidate-endorsement-row.dto';
import { ClientLoginsQueryDto } from './dto/client-logins-query.dto';
import { ClientLoginsResponseDto } from './dto/client-login-row.dto';
import { AdminLoginsQueryDto } from './dto/admin-logins-query.dto';
import { AdminLoginsResponseDto } from './dto/admin-login-row.dto';
import { TalentAgingReportDto } from './dto/talent-aging-report.dto';
import { HireRequestsByClientsQueryDto } from './dto/hire-requests-by-clients-query.dto';
import { HireRequestsByClientsResponseDto } from './dto/hire-request-by-client-row.dto';
import { PanelMetricDetailsService } from './panel-metric-details.service';
import { MetricDetailsQueryDto } from './dto/metric-details-query.dto';
import {
  ClientDetailRowDto,
  ClientUserDetailRowDto,
  EndorsedTalentDetailRowDto,
  HiredTalentDetailRowDto,
  HireRequestDetailRowDto,
  MetricDetailsResponse,
  StaffDetailRowDto,
  TalentDetailRowDto,
} from './dto/metric-detail-rows.dto';
import { MetricDetailsRoute } from './metric-details-route.decorator';

@ApiTags('Panel')
@ApiBearerAuth()
@Controller('panel')
export class PanelController {
  constructor(
    private readonly panelService: PanelService,
    private readonly metricDetails: PanelMetricDetailsService,
  ) {}

  @Get()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Get aggregated data to populate the internal admin panel dashboard',
  })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    description: 'Start date filter (ISO date string)',
    example: '2024-01-01',
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    description: 'End date filter (ISO date string)',
    example: '2024-12-31',
  })
  @ApiResponse({
    status: 200,
    description: 'Panel data retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async getPanelData(
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ): Promise<any> {
    return await this.panelService.getPanelData(dateFrom, dateTo);
  }

  @Get('talent-availability')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Get the count of currently available candidates grouped by approved position/role',
  })
  @ApiResponse({
    status: 200,
    description: 'Talent availability by role retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async getTalentAvailabilityByRole(): Promise<TalentAvailabilityByRoleDto[]> {
    return this.panelService.getTalentAvailabilityByRole();
  }

  @Get('client-selected-candidates')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'List candidates deployed (selected as winner) by client users, with optional full-result export',
  })
  @ApiResponse({
    status: 200,
    description: 'Client-selected candidates retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async getClientSelectedCandidates(
    @Query() query: ClientSelectedCandidatesQueryDto,
  ): Promise<ClientSelectedCandidatesResponseDto> {
    return this.panelService.getClientSelectedCandidates(query);
  }

  @Get('admin-selected-candidates')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'List candidates hired (selected as winner) by admin users, with optional full-result export',
  })
  @ApiResponse({
    status: 200,
    description: 'Admin-selected candidates retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async getAdminSelectedCandidates(
    @Query() query: ClientSelectedCandidatesQueryDto,
  ): Promise<ClientSelectedCandidatesResponseDto> {
    return this.panelService.getAdminSelectedCandidates(query);
  }

  @Get('candidate-endorsements')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Per-candidate endorsement counts, split by whether the endorsement is attributed to an admin or a client user, with optional full-result export',
  })
  @ApiResponse({
    status: 200,
    description: 'Candidate endorsements retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async getCandidateEndorsements(
    @Query() query: CandidateEndorsementsQueryDto,
  ): Promise<CandidateEndorsementsResponseDto> {
    return this.panelService.getCandidateEndorsements(query);
  }

  @Get('client-logins')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Row-level client (organization) user logins with user name, organization and timestamp, with optional full-result export',
  })
  @ApiResponse({
    status: 200,
    description: 'Client logins retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async getClientLogins(
    @Query() query: ClientLoginsQueryDto,
  ): Promise<ClientLoginsResponseDto> {
    return this.panelService.getClientLogins(query);
  }

  @Get('admin-logins')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Row-level admin user logins with user name, role and timestamp, with optional full-result export',
  })
  @ApiResponse({
    status: 200,
    description: 'Admin logins retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async getAdminLogins(
    @Query() query: AdminLoginsQueryDto,
  ): Promise<AdminLoginsResponseDto> {
    return this.panelService.getAdminLogins(query);
  }

  @Get('hire-requests-by-clients')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Hire requests created by client (organization) users, with creator and organization details, with optional full-result export',
  })
  @ApiResponse({
    status: 200,
    description: 'Hire requests submitted by clients retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async getHireRequestsByClients(
    @Query() query: HireRequestsByClientsQueryDto,
  ): Promise<HireRequestsByClientsResponseDto> {
    return this.panelService.getHireRequestsByClients(query);
  }

  @Get('talent-aging')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Get an aging report (30/60/90 day buckets) for candidates still in the available talent pool',
  })
  @ApiResponse({
    status: 200,
    description: 'Talent aging report retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async getTalentAgingReport(): Promise<TalentAgingReportDto> {
    return this.panelService.getTalentAgingReport();
  }

  // ── Card drill-downs (period-filtered KPI cards) ──────────────────────────

  @MetricDetailsRoute(
    'details/new-hire-requests',
    'Hire requests behind the Overview "New Hire Requests" card',
  )
  getNewHireRequestsDetails(
    @Query() query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<HireRequestDetailRowDto>> {
    return this.metricDetails.getNewHireRequests(query);
  }

  @MetricDetailsRoute(
    'details/new-available-staff',
    'Staff behind the Overview "New Available Virtual Assistant" card',
  )
  getNewAvailableStaffDetails(
    @Query() query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<StaffDetailRowDto>> {
    return this.metricDetails.getNewAvailableStaff(query);
  }

  @MetricDetailsRoute(
    'details/new-clients-with-active-staff',
    'Organizations behind the Overview "New Clients with Active Staff" card',
  )
  getNewClientsWithActiveStaffDetails(
    @Query() query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<ClientDetailRowDto>> {
    return this.metricDetails.getNewClientsWithActiveStaff(query);
  }

  @MetricDetailsRoute(
    'details/users-created',
    'Client users behind the Users "Users Created" card',
  )
  getUsersCreatedDetails(
    @Query() query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<ClientUserDetailRowDto>> {
    return this.metricDetails.getUsersCreated(query);
  }

  @MetricDetailsRoute(
    'details/invites-accepted',
    'Client users behind the Users "Invites Accepted" card',
  )
  getInvitesAcceptedDetails(
    @Query() query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<ClientUserDetailRowDto>> {
    return this.metricDetails.getInvitesAccepted(query);
  }

  @MetricDetailsRoute(
    'details/talents-created',
    'Talents behind the Talents "Created" card',
  )
  getTalentsCreatedDetails(
    @Query() query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<TalentDetailRowDto>> {
    return this.metricDetails.getTalentsCreated(query);
  }

  @MetricDetailsRoute(
    'details/talents-endorsed',
    'Talents behind the Talents "Endorsed" card',
  )
  getTalentsEndorsedDetails(
    @Query() query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<EndorsedTalentDetailRowDto>> {
    return this.metricDetails.getTalentsEndorsed(query);
  }

  @MetricDetailsRoute(
    'details/talents-hired',
    'Talents behind the Talents "Hired" card',
  )
  getTalentsHiredDetails(
    @Query() query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<HiredTalentDetailRowDto>> {
    return this.metricDetails.getTalentsHired(query);
  }

  @MetricDetailsRoute(
    'details/hr-submitted-by-client',
    'Hire requests behind the HR Report "Submitted by Client" card',
  )
  getHrSubmittedByClientDetails(
    @Query() query: MetricDetailsQueryDto,
  ): Promise<MetricDetailsResponse<HireRequestDetailRowDto>> {
    return this.metricDetails.getHrSubmittedByClient(query);
  }
}
