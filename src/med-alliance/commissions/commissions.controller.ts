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
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CommissionsService } from './commissions.service';
import { InvoicesService } from '../invoices/invoices.service';
import { AuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../auth/current-user.decorator';
import { USER } from '@prisma/client';
import { ADMIN_ROLES, AFFILIATE_ROLES, ORGANIZATION_ROLES } from '../constants';
import { ListCommissionsDto } from './dto/list-commissions.dto';
import {
  DecideCommissionDto,
  VoidCommissionDto,
  ReinstateCommissionDto,
  UnvoidCommissionDto,
  UpdateBaseAmountDto,
} from './dto/decide-commission.dto';
import { CreateFromInvoicesDto } from './dto/create-from-invoices.dto';
import { ListMedAllianceAuditLogsDto } from './dto/list-med-alliance-audit-logs.dto';

@ApiTags('med-alliance')
@ApiBearerAuth()
@Controller('med-alliance')
@UseGuards(AuthGuard, RolesGuard)
export class CommissionsController {
  constructor(
    private readonly commissionsService: CommissionsService,
    private readonly invoicesService: InvoicesService,
  ) {}

  // ---------------------------------------------------------------------------
  // Affiliate routes
  // ---------------------------------------------------------------------------

  // GET /med-alliance/commissions — List own commissions.
  @Get('commissions')
  @HttpCode(200)
  @Roles(...AFFILIATE_ROLES, ...ORGANIZATION_ROLES)
  @ApiOperation({
    summary:
      'List commissions for the current affiliate with filtering and pagination',
  })
  @ApiQuery({ type: ListCommissionsDto })
  @ApiResponse({
    status: 200,
    description: 'Commissions retrieved successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async findAll(@Query() query: ListCommissionsDto, @CurrentUser() user: USER) {
    const result = await this.commissionsService.findAllForAffiliate(
      query,
      user,
    );
    return {
      status: 200,
      message: 'Commissions retrieved successfully',
      ...result,
    };
  }

  // GET /med-alliance/commissions/:id — Get one commission (scoped).
  @Get('commissions/:id')
  @HttpCode(200)
  @Roles(...ORGANIZATION_ROLES)
  @ApiOperation({
    summary: 'Get a single commission detail scoped to the current affiliate',
  })
  @ApiParam({ name: 'id', description: 'Commission UUID' })
  @ApiResponse({
    status: 200,
    description: 'Commission retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Commission not found' })
  @ApiResponse({ status: 403, description: 'Access denied to this commission' })
  async findOne(@Param('id') id: string, @CurrentUser() user: USER) {
    const data = await this.commissionsService.findOneForAffiliate(id, user);
    return { status: 200, message: 'Commission retrieved successfully', data };
  }

  // ---------------------------------------------------------------------------
  // Admin routes
  // ---------------------------------------------------------------------------

  // GET /med-alliance/admin/commissions — List all commissions.
  @Get('admin/commissions')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary: 'List all commissions across all affiliates for admin review',
  })
  @ApiQuery({ type: ListCommissionsDto })
  @ApiResponse({
    status: 200,
    description: 'Commissions retrieved successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async findAllAdmin(@Query() query: ListCommissionsDto) {
    const result = await this.commissionsService.findAllForAdmin(query);
    return {
      status: 200,
      message: 'Commissions retrieved successfully',
      ...result,
    };
  }

  // GET /med-alliance/admin/commissions/:id — Get one commission with full details.
  @Get('admin/commissions/:id')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary: 'Get full details for a single commission including audit trail',
  })
  @ApiParam({ name: 'id', description: 'Commission UUID' })
  @ApiResponse({
    status: 200,
    description: 'Commission retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Commission not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async findOneAdmin(@Param('id') id: string) {
    const data = await this.commissionsService.findOneForAdmin(id);
    return { status: 200, message: 'Commission retrieved successfully', data };
  }

  // PATCH /med-alliance/admin/commissions/:id/decide — Approve or reject.
  @Patch('admin/commissions/:id/decide')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary: 'Approve or reject a commission pending admin confirmation',
  })
  @ApiParam({ name: 'id', description: 'Commission UUID' })
  @ApiBody({ type: DecideCommissionDto })
  @ApiResponse({
    status: 200,
    description: 'Commission decision recorded successfully',
  })
  @ApiResponse({ status: 404, description: 'Commission not found' })
  @ApiResponse({
    status: 400,
    description: 'Commission is not in a decidable state',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async decide(
    @Param('id') id: string,
    @Body() dto: DecideCommissionDto,
    @CurrentUser() admin: USER,
  ) {
    const data = await this.commissionsService.decide(id, dto, admin);
    return {
      status: 200,
      message: 'Commission decision recorded successfully',
      data,
    };
  }

  // PATCH /med-alliance/admin/commissions/:id/void — Void a commission.
  @Patch('admin/commissions/:id/void')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Void a commission with a reason, removing it from payout eligibility',
  })
  @ApiParam({ name: 'id', description: 'Commission UUID' })
  @ApiBody({ type: VoidCommissionDto })
  @ApiResponse({ status: 200, description: 'Commission voided successfully' })
  @ApiResponse({ status: 404, description: 'Commission not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async void(
    @Param('id') id: string,
    @Body() dto: VoidCommissionDto,
    @CurrentUser() admin: USER,
  ) {
    const data = await this.commissionsService.void(id, dto, admin);
    return { status: 200, message: 'Commission voided successfully', data };
  }

  // PATCH /med-alliance/admin/commissions/:id/revert-to-pending — Revert eligible → pending_admin_confirmation.
  @Patch('admin/commissions/:id/revert-to-pending')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Revert an eligible commission back to pending admin confirmation status',
  })
  @ApiParam({ name: 'id', description: 'Commission UUID' })
  @ApiResponse({ status: 200, description: 'Commission reverted to pending' })
  @ApiResponse({ status: 404, description: 'Commission not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async revertToPending(@Param('id') id: string, @CurrentUser() admin: USER) {
    const data = await this.commissionsService.revertToPending(id, admin);
    return { status: 200, message: 'Commission reverted to pending', data };
  }

  // PATCH /med-alliance/admin/commissions/:id/unvoid — Unvoid void → detected.
  @Patch('admin/commissions/:id/unvoid')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary: 'Unvoid a voided commission and move it back to detected status',
  })
  @ApiParam({ name: 'id', description: 'Commission UUID' })
  @ApiBody({ type: UnvoidCommissionDto })
  @ApiResponse({ status: 200, description: 'Commission unvoided to detected' })
  @ApiResponse({ status: 404, description: 'Commission not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async unvoid(
    @Param('id') id: string,
    @Body() dto: UnvoidCommissionDto,
    @CurrentUser() admin: USER,
  ) {
    const data = await this.commissionsService.unvoid(id, dto, admin);
    return { status: 200, message: 'Commission unvoided to detected', data };
  }

  // PATCH /med-alliance/admin/commissions/:id/reinstate — Reinstate rejected → eligible.
  @Patch('admin/commissions/:id/reinstate')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary: 'Reinstate a rejected commission back to eligible status',
  })
  @ApiParam({ name: 'id', description: 'Commission UUID' })
  @ApiBody({ type: ReinstateCommissionDto })
  @ApiResponse({
    status: 200,
    description: 'Commission reinstated to eligible',
  })
  @ApiResponse({ status: 404, description: 'Commission not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async reinstate(
    @Param('id') id: string,
    @Body() dto: ReinstateCommissionDto,
    @CurrentUser() admin: USER,
  ) {
    const data = await this.commissionsService.reinstate(id, dto, admin);
    return { status: 200, message: 'Commission reinstated to eligible', data };
  }

  // PATCH /med-alliance/admin/commissions/:id/update-base-amount — Update base amount (detected only).
  @Patch('admin/commissions/:id/update-base-amount')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Update the base invoice amount for a detected commission before it is confirmed',
  })
  @ApiParam({ name: 'id', description: 'Commission UUID' })
  @ApiBody({ type: UpdateBaseAmountDto })
  @ApiResponse({
    status: 200,
    description: 'Commission base amount updated successfully',
  })
  @ApiResponse({ status: 404, description: 'Commission not found' })
  @ApiResponse({
    status: 400,
    description: 'Commission must be in detected status to update base amount',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async updateBaseAmount(
    @Param('id') id: string,
    @Body() dto: UpdateBaseAmountDto,
    @CurrentUser() admin: USER,
  ) {
    const data = await this.commissionsService.updateBaseAmount(id, dto, admin);
    return {
      status: 200,
      message: 'Commission base amount updated successfully',
      data,
    };
  }

  // GET /med-alliance/admin/affiliates/:affiliateId/eligible-invoices
  // Returns paid HubSpot invoices without commissions for this affiliate.
  @Get('admin/affiliates/:affiliateId/eligible-invoices')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'List paid invoices without commissions for an affiliate (manual commission creation)',
  })
  @ApiParam({ name: 'affiliateId', description: 'AffiliateProfile UUID' })
  @ApiResponse({
    status: 200,
    description: 'Eligible invoices retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Affiliate profile not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied or affiliate is not active',
  })
  async getEligibleInvoices(@Param('affiliateId') affiliateId: string) {
    const data =
      await this.invoicesService.getEligibleInvoicesForAffiliate(affiliateId);
    return {
      status: 200,
      message: 'Eligible invoices retrieved successfully',
      data,
    };
  }

  // POST /med-alliance/admin/affiliates/:affiliateId/commissions/from-invoices
  // Creates commissions for the selected line item IDs (per-collaborator, §4.5 #4 —
  // renamed from invoice-level selection; the route path is kept for backward compatibility).
  @Post('admin/affiliates/:affiliateId/commissions/from-invoices')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Manually create commissions for an affiliate from selected matched line items (one commission per collaborator payment)',
  })
  @ApiParam({ name: 'affiliateId', description: 'AffiliateProfile UUID' })
  @ApiBody({ type: CreateFromInvoicesDto })
  @ApiResponse({ status: 200, description: 'Commissions created successfully' })
  @ApiResponse({ status: 404, description: 'Affiliate profile not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied or affiliate is not active',
  })
  async createFromInvoices(
    @Param('affiliateId') affiliateId: string,
    @Body() dto: CreateFromInvoicesDto,
    @CurrentUser() admin: USER,
  ) {
    const result = await this.commissionsService.createFromInvoices(
      affiliateId,
      dto.line_item_ids,
      admin,
    );
    return {
      status: 200,
      message: `${result.created} commission(s) created, ${result.skipped} skipped`,
      data: result,
    };
  }

  // GET /med-alliance/admin/audit-logs — Global audit log viewer.
  @Get('admin/audit-logs')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary: 'List all MedAlliance audit logs (global, admin only)',
  })
  @ApiQuery({ type: ListMedAllianceAuditLogsDto })
  @ApiResponse({
    status: 200,
    description: 'Audit logs retrieved successfully',
  })
  async listAllAuditLogs(@Query() query: ListMedAllianceAuditLogsDto) {
    const result = await this.commissionsService.findAllAuditLogs(query);
    return {
      status: 200,
      message: 'Audit logs retrieved successfully',
      ...result,
    };
  }

  // GET /med-alliance/admin/commissions/:id/audit — Full audit timeline.
  @Get('admin/commissions/:id/audit')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Get the full audit timeline of status changes and admin actions for a commission',
  })
  @ApiParam({ name: 'id', description: 'Commission UUID' })
  @ApiResponse({ status: 200, description: 'Audit log retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Commission not found' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async getAuditLog(@Param('id') id: string) {
    const data = await this.commissionsService.getAuditLog(id);
    return { status: 200, message: 'Audit log retrieved successfully', data };
  }
}
