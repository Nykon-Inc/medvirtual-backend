import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import {
  OfferPanelRecipientType,
  OfferPanelStatus,
  USER,
} from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { OfferPanelsService } from './offer-panels.service';
import { QueryOfferPanelsDto } from './dto/query-offer-panels.dto';
import { OfferPanelStatsQueryDto } from './dto/offer-panel-stats.dto';
import { MetricDetailsQueryDto } from '../panel/dto/metric-details-query.dto';
import { MetricDetailsRoute } from '../panel/metric-details-route.decorator';
import { CreateOfferPanelDto } from './dto/create-offer-panel.dto';
import { UpdateOfferPanelDto } from './dto/update-offer-panel.dto';
import { OfferPanelsAuditService } from './offer-panels-audit.service';

@ApiTags('Offer Panels')
@ApiBearerAuth()
@Controller()
export class OfferPanelsController {
  constructor(
    private readonly offerPanelsService: OfferPanelsService,
    private readonly panelAudit: OfferPanelsAuditService,
  ) {}

  @Post('offer-panels')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_admin', 'system_super_admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create offer panels with fan-out (admin)' })
  @ApiResponse({
    status: 201,
    description:
      'One OfferPanel per recipient created. Returns array of created panels.',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error — details in response body',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async create(@Body() dto: CreateOfferPanelDto, @CurrentUser() user: USER) {
    const data = await this.offerPanelsService.create(dto, user);
    return { status: 201, data };
  }

  // Static segment — must be declared BEFORE :id
  @Get('offer-panels/contacts/search')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_admin', 'system_super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Search users and contacts for recipient picker (admin)',
  })
  @ApiQuery({
    name: 'q',
    required: true,
    type: String,
    description: 'Search term (name or email)',
  })
  @ApiQuery({
    name: 'business_unit',
    required: true,
    type: String,
    description:
      'Business unit hubspot_value to filter results (data-driven — any ' +
      'currently visible business unit, e.g. "MedVirtual", "Berry Virtual", "MMVA")',
  })
  @ApiResponse({
    status: 200,
    description:
      'Returns up to 20 results with recipient_type pre-set (client_user or company_contact)',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async searchContacts(
    @Query('q') q: string,
    @Query('business_unit') businessUnit: string,
  ) {
    const data = await this.offerPanelsService.searchContacts(
      q ?? '',
      businessUnit,
    );
    return { status: 200, data };
  }

  @Get('offer-panels')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_admin', 'system_super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List all offer panels (admin)' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'created_by', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: OfferPanelStatus })
  @ApiQuery({
    name: 'recipient_type',
    required: false,
    enum: OfferPanelRecipientType,
  })
  @ApiQuery({ name: 'client', required: false, type: String })
  @ApiQuery({ name: 'business_unit', required: false, type: String })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    type: String,
    description: 'Inclusive start of the window (YYYY-MM-DD), on creation date',
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    type: String,
    description: 'Inclusive end of the window (YYYY-MM-DD), on creation date',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Panels retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async findAll(
    @Query() query: QueryOfferPanelsDto,
    @CurrentUser() user: USER,
  ) {
    const result = await this.offerPanelsService.findAll(query, user);
    return {
      status: 200,
      data: result.data,
      // Per-status tallies for the UI's status tabs. They honour every filter
      // except status, so each tab shows its own size.
      counts: result.counts,
      pagination: result.pagination,
    };
  }

  // Static segments declared BEFORE :id to avoid route conflicts
  @Get('offer-panels/stats')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_admin', 'system_super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Offer panel analytics aggregated by sender, for the Operational Dashboard',
  })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    type: String,
    description: 'Inclusive start of the window (YYYY-MM-DD), on creation date',
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    type: String,
    description: 'Inclusive end of the window (YYYY-MM-DD), on creation date',
  })
  @ApiQuery({ name: 'business_unit', required: false, type: String })
  @ApiResponse({
    status: 200,
    description: 'Statistics retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async getStats(@Query() query: OfferPanelStatsQueryDto) {
    const data = await this.offerPanelsService.getStats(query);
    return { status: 200, data };
  }

  // Operational Dashboard card drill-downs — also static, so before :id.

  @MetricDetailsRoute(
    'offer-panels/stats/details/total',
    'Offer panels behind the "Total Panels" card',
  )
  getTotalPanelsDetails(@Query() query: MetricDetailsQueryDto) {
    return this.offerPanelsService.getStatsDetails('total', query);
  }

  @MetricDetailsRoute(
    'offer-panels/stats/details/accepted',
    'Offer panels behind the "Panels Accepted" card',
  )
  getAcceptedPanelsDetails(@Query() query: MetricDetailsQueryDto) {
    return this.offerPanelsService.getStatsDetails('accepted', query);
  }

  @MetricDetailsRoute(
    'offer-panels/stats/details/declined',
    'Offer panels behind the "Panels Declined" card',
  )
  getDeclinedPanelsDetails(@Query() query: MetricDetailsQueryDto) {
    return this.offerPanelsService.getStatsDetails('declined', query);
  }

  @MetricDetailsRoute(
    'offer-panels/stats/details/awaiting-response',
    'Offer panels behind the "Awaiting Response" card',
  )
  getAwaitingResponsePanelsDetails(@Query() query: MetricDetailsQueryDto) {
    return this.offerPanelsService.getStatsDetails('awaiting-response', query);
  }

  @MetricDetailsRoute(
    'offer-panels/stats/details/awaiting-view',
    'Offer panels behind the "Awaiting View" card',
  )
  getAwaitingViewPanelsDetails(@Query() query: MetricDetailsQueryDto) {
    return this.offerPanelsService.getStatsDetails('awaiting-view', query);
  }

  @Get('offer-panels/mine')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('organization_admin', 'organization_super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "List the authenticated client's offer panels" })
  @ApiResponse({ status: 200, description: 'Panels retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async findMine(@CurrentUser() user: USER) {
    const data = await this.offerPanelsService.findForClientUser(user);
    return {
      status: 200,
      data,
    };
  }

  @Get('offer-panels/by-candidate/:candidateId')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_admin', 'system_super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List offer panels that include a given candidate (admin)',
  })
  @ApiParam({ name: 'candidateId', type: String, description: 'Candidate ID' })
  @ApiResponse({
    status: 200,
    description: 'Offer panels retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async findByCandidateId(@Param('candidateId') candidateId: string) {
    const data = await this.offerPanelsService.findByCandidateId(candidateId);
    return data;
  }

  @Get('offer-panels/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(
    'system_admin',
    'system_super_admin',
    'organization_admin',
    'organization_super_admin',
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Get offer panel by ID with full candidate card data (admin/client)',
  })
  @ApiParam({ name: 'id', type: String, description: 'Offer panel ID' })
  @ApiResponse({
    status: 200,
    description:
      'Returns the offer panel with title, description, status, recipient info, business_unit, and candidates in card shape (same fields as /candidates/talent-pool/:id)',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Offer panel not found' })
  async findOne(@Param('id') id: string, @CurrentUser() user: USER) {
    const panel = await this.offerPanelsService.findOne(id, user);
    return {
      status: 200,
      data: panel,
    };
  }

  // ':id/audit' is more specific than ':id' and cannot be shadowed by it, but is
  // kept adjacent to findOne so the file's route-ordering invariant stays obvious.
  @Get('offer-panels/:id/audit')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_admin', 'system_super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get the audit timeline for an offer panel (admin)',
    description:
      'Every audit entry for the panel, oldest first. Covers created, viewed, ' +
      'updated, candidate_removed, accepted, declined, deleted and resent, across ' +
      'both the authenticated and public-token paths.',
  })
  @ApiParam({ name: 'id', type: String, description: 'Offer panel ID' })
  @ApiResponse({ status: 200, description: 'Audit entries retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async findAudit(@Param('id') id: string) {
    const data = await this.panelAudit.findByOfferPanel(id);
    return { status: 200, data };
  }

  // POST, not GET: this mutates state (sends an email, writes an audit row) and must
  // not be triggerable by a link prefetch or an address-bar visit.
  @Post('offer-panels/:id/resend')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_admin', 'system_super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resend the public panel link to its recipient (admin)',
    description:
      'Re-sends the existing tokenized link. The token is reused, not rotated, so ' +
      'any link already shared keeps working. Allowed on decided panels — the ' +
      'public page renders read-only once accepted or declined.',
  })
  @ApiParam({ name: 'id', type: String, description: 'Offer panel ID' })
  @ApiResponse({ status: 200, description: 'Email resent' })
  @ApiResponse({
    status: 400,
    description: 'Panel is not public, or the send failed',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Offer panel not found' })
  async resend(@Param('id') id: string, @CurrentUser() user: USER) {
    const data = await this.offerPanelsService.resendPublicLink(id, user);
    return { status: 200, data };
  }

  // Task 4.1 — track view (client auth, R17)
  @Post('offer-panels/:id/viewed')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('organization_admin', 'organization_super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Track that the client viewed an offer panel (R17)',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'View tracked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Offer panel not found' })
  async trackView(@Param('id') id: string, @CurrentUser() user: USER) {
    await this.offerPanelsService.trackView(id, user);
    return { status: 200 };
  }

  // Task 4.2 — remove candidate from offer (client, R7/R8)
  @Delete('offer-panels/:id/candidates/:candidateId')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('organization_admin', 'organization_super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Remove a candidate from the offer panel (R7). Deletes panel if last candidate removed (R8).',
  })
  @ApiParam({ name: 'id', type: String, description: 'Offer panel ID' })
  @ApiParam({
    name: 'candidateId',
    type: String,
    description: 'Candidate ID to remove',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ deleted: true } when panel deleted (R8); { deleted: false, panel } otherwise',
  })
  @ApiResponse({
    status: 400,
    description: 'Cannot modify a decided offer panel',
  })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 404,
    description: 'Offer panel or candidate not found',
  })
  async removeCandidate(
    @Param('id') id: string,
    @Param('candidateId') candidateId: string,
    @CurrentUser() user: USER,
  ) {
    const result = await this.offerPanelsService.removeCandidate(
      id,
      candidateId,
      user,
    );
    return { status: 200, data: result };
  }

  // Task 4.3 — decline (client, R6/R12)
  @Post('offer-panels/:id/decline')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('organization_admin', 'organization_super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Decline an offer panel (R6). Notifies the admin (R12). Idempotent.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'Declined successfully' })
  @ApiResponse({ status: 400, description: 'Cannot decline an accepted panel' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Offer panel not found' })
  async decline(@Param('id') id: string, @CurrentUser() user: USER) {
    await this.offerPanelsService.decline(id, user);
    return { status: 200 };
  }

  // Task 4.4 — accept (client, R4/R11/R12)
  @Post('offer-panels/:id/accept')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('organization_admin', 'organization_super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Accept offer panel → creates HireRequest in panel_ready (R4/R11). Notifies admin (R12). Idempotent.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({
    status: 200,
    description: 'Accepted. Returns the created HireRequest.',
  })
  @ApiResponse({ status: 400, description: 'Cannot accept a declined panel' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Offer panel not found' })
  async accept(@Param('id') id: string, @CurrentUser() user: USER) {
    const data = await this.offerPanelsService.acceptByClientUser(id, user);
    return { status: 200, data };
  }

  // Task 4.6 — admin edit
  @Patch('offer-panels/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_admin', 'system_super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update offer panel title/description (admin)' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'Updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Offer panel not found' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateOfferPanelDto,
    @CurrentUser() user: USER,
  ) {
    const data = await this.offerPanelsService.update(id, dto, user);
    return { status: 200, data };
  }

  // Task 4.7 — admin delete
  @Delete('offer-panels/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_admin', 'system_super_admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Hard delete an offer panel (admin). No recipient notification.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 204, description: 'Deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Offer panel not found' })
  async remove(@Param('id') id: string, @CurrentUser() user: USER) {
    await this.offerPanelsService.remove(id, user);
  }
}
