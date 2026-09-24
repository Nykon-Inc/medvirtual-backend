import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Request,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { BusinessUnitsService } from './business-units.service';
import { CreateBusinessUnitDto } from './dto/create-business-unit.dto';
import { UpdateBusinessUnitDto } from './dto/update-business-unit.dto';
import { UpdateBrandingDto } from './dto/update-branding.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { USER } from '@prisma/client';

@ApiTags('business-units')
@ApiBearerAuth()
@Controller('business-units')
@UseGuards(AuthGuard, RolesGuard)
@Roles('system_super_admin', 'system_admin')
export class BusinessUnitsController {
  constructor(private readonly service: BusinessUnitsService) {}

  // ── BU CRUD ───────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'List all business units with their branding',
    description:
      'Returns every BusinessUnit row, including dormant ones (is_visible=false) ' +
      'discovered by the daily HubSpot sync cron but not yet activated. ' +
      'This is the single fetch consumed by: the Administration → Business Units ' +
      'page (all rows), the "Customize Design" email-branding tabs, the offer-panel ' +
      'BU dropdown/brand filter, and the frontend brand resolver — each of the ' +
      'latter three filters the result down to is_visible=true before use.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Array of BusinessUnit rows (id, slug, name, is_active, is_visible, ' +
      'hubspot_value, candidate_pool, primary_color, primary_hover, logo_url, ' +
      'favicon_url, branding).',
  })
  findAll() {
    return this.service.findAll();
  }

  @Get('branding')
  // Method-level empty @Roles() OVERRIDES the class-level
  // @Roles('system_super_admin','system_admin') (Reflector.getAllAndOverride
  // takes the handler's metadata first), so RolesGuard admits ANY authenticated
  // user while AuthGuard still enforces a valid token. This is the app-wide
  // brand source consumed by every logged-in user (org users included) so the
  // color/logo/favicon resolver works for them — the admin `GET /` above stays
  // system-admin-only. Returns ONLY visual fields for is_visible=true BUs.
  @Roles()
  @ApiOperation({
    summary: 'Public (any authenticated user) visual branding for visible BUs',
    description:
      'Auth-only (no admin role required). Returns the app-branding fields ' +
      '(slug, name, hubspot_value, primary_color, primary_hover, logo_url, ' +
      'favicon_url) for is_visible=true business units — the data-driven source ' +
      'the frontend brand resolver uses to theme the app for the logged-in ' +
      "user's business unit. Deliberately omits candidate_pool / is_active / " +
      'email branding so no admin/config data leaks to organization users.',
  })
  @ApiResponse({
    status: 200,
    description: 'Array of visible BUs with visual branding fields only.',
  })
  findAllBranding() {
    return this.service.findAllBranding();
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new business unit (auto-creates default branding)',
    description:
      'NOT surfaced in the app UI — Business Unit intake is HubSpot-only ' +
      '(see GET /cron/sync-business-units, which upserts new HubSpot ' +
      '`business_unit` property options as dormant rows automatically). This ' +
      'route is kept for seed scripts and tests / manual recovery only. The ' +
      'created row defaults to is_visible=false unless the request says otherwise.',
  })
  @ApiResponse({ status: 201, description: 'Business unit created' })
  @ApiResponse({ status: 400, description: 'Slug already in use' })
  create(
    @Body() dto: CreateBusinessUnitDto,
    @Request() req: { user: { id: string } },
  ) {
    return this.service.create(dto, req.user.id);
  }

  @Put(':slug')
  @ApiOperation({
    summary:
      'Update a business unit — branding fields, candidate pool, active/visible flags',
    description:
      'Partial update; only fields present in the body are changed. ' +
      'IMPORTANT: flipping `is_visible` from false to true (activating a ' +
      'dormant BU) has side effects beyond the field update itself: ' +
      '(1) synchronously reactivates every Organization/USER/Candidate/' +
      'AffiliateProfile row previously soft-deleted for this slug ' +
      '(matched by `deactivated_by_bu = <slug>`, restoring exactly that set), ' +
      'then (2) fires an async, fire-and-forget multi-object backfill from ' +
      'HubSpot (companies → Organization, contacts → Contact/User, VA custom ' +
      'object 2-5922196 → Candidate, Growth Partner 2-54072002 → Affiliate), ' +
      'upserted by hubspot_id, non-destructive and idempotent, with an audit ' +
      'log entry on completion or failure. The backfill does NOT block this ' +
      'response — it can still be running after you receive 200. Any other ' +
      'transition (true→true, true→false, false→false) only updates the row, ' +
      'no reactivation or backfill is triggered.',
  })
  @ApiParam({
    name: 'slug',
    description: 'Business unit slug',
    example: 'mmva',
  })
  @ApiResponse({
    status: 200,
    description:
      'Updated BusinessUnit row. If this call activated the BU, the backfill ' +
      'is still running in the background at the time this response is sent.',
  })
  @ApiResponse({ status: 404, description: 'Business unit not found' })
  update(
    @Param('slug') slug: string,
    @Body() dto: UpdateBusinessUnitDto,
    @CurrentUser() currentUser: USER,
  ) {
    return this.service.update(slug, dto, currentUser);
  }

  @Delete(':slug')
  @ApiOperation({
    summary: 'Deactivate a business unit (soft delete)',
    description:
      'Legacy soft-delete route, distinct from the is_visible toggle used by ' +
      'the Multi-BU activation flow — sets is_active=false on the BusinessUnit ' +
      'row only. Does not cascade to related Organizations/Users/Candidates/ ' +
      'Affiliates and does not affect is_visible. Use PUT :slug with ' +
      '{ is_visible: false } to take a BU out of operation (dropdowns, brand ' +
      'resolver, email branding).',
  })
  @ApiParam({ name: 'slug', description: 'Business unit slug' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404 })
  deactivate(@Param('slug') slug: string) {
    return this.service.deactivate(slug);
  }

  // ── Backfill ──────────────────────────────────────────────────────────────

  @Post(':slug/backfill-from-hubspot')
  @ApiOperation({
    summary: 'Manually (re)run the multi-object HubSpot backfill for this BU',
    description:
      'Same backfill the PUT :slug activation transition (is_visible false→true) ' +
      'triggers automatically, exposed here for manual re-runs / recovery — e.g. ' +
      'if a first activation partially failed, or to pull in HubSpot records ' +
      'created after activation. Runs synchronously (this call awaits completion, ' +
      'unlike the fire-and-forget path on PUT :slug) across all four object types ' +
      'in parallel: companies → Organization, contacts → Contact/User, VA custom ' +
      'object (2-5922196) → Candidate, Growth Partner (2-54072002) → Affiliate — ' +
      'each upserted by hubspot_id. Fully non-destructive (no deletes) and ' +
      'idempotent (safe to run any number of times, never creates duplicates). ' +
      'Does NOT reactivate deactivated_by_bu rows — that only happens on the ' +
      'PUT :slug activation transition. Rejects with 400 if a backfill for this ' +
      'slug is already running (in-memory concurrency guard, per server instance).',
  })
  @ApiParam({
    name: 'slug',
    description: 'Business unit slug',
    example: 'mmva',
  })
  @ApiResponse({
    status: 200,
    description:
      'Backfill completed. `data` contains the per-object-type counts imported: ' +
      '{ organizations, contacts, candidates, affiliates }.',
  })
  @ApiResponse({ status: 404, description: 'Business unit not found' })
  @ApiResponse({
    status: 400,
    description: 'A backfill is already in progress for this business unit',
  })
  async backfillFromHubspot(@Param('slug') slug: string) {
    const result = await this.service.backfillFromHubspot(slug);
    return {
      status: 200,
      message: 'Backfill completed',
      data: result,
    };
  }

  // ── Branding ──────────────────────────────────────────────────────────────

  @Get(':slug/branding')
  @ApiOperation({
    summary: 'Get email branding for a business unit',
    description:
      'Reads the EmailBranding row associated with this BU — the source used ' +
      "by the DB-first email theme resolver (theme-helper.ts) so a brand's " +
      'transactional emails match its Customize Design settings. Distinct from ' +
      'the app-branding fields (primary_color, logo_url, favicon_url, …) on the ' +
      'BusinessUnit row itself, which drive in-app theming instead.',
  })
  @ApiParam({ name: 'slug', description: 'Business unit slug' })
  @ApiResponse({ status: 200 })
  getBranding(@Param('slug') slug: string) {
    return this.service.getBranding(slug);
  }

  @Put(':slug/branding')
  @ApiOperation({
    summary: 'Update email branding for a business unit (snapshots history)',
    description:
      'Only meaningful for is_visible=true BUs — the "Customize Design" UI ' +
      "filters its BU tabs to visible business units only, so a dormant BU's " +
      'branding is not editable from the app until it is activated (this route ' +
      'itself does not enforce that restriction server-side). Every save is ' +
      'snapshotted; see GET :slug/branding/history.',
  })
  @ApiParam({ name: 'slug', description: 'Business unit slug' })
  @ApiResponse({ status: 200 })
  updateBranding(
    @Param('slug') slug: string,
    @Body() dto: UpdateBrandingDto,
    @Request() req: { user: { id: string } },
  ) {
    return this.service.updateBranding(slug, dto, req.user.id);
  }

  @Get(':slug/branding/history')
  @ApiOperation({ summary: 'Get branding change history for a business unit' })
  @ApiParam({ name: 'slug', description: 'Business unit slug' })
  @ApiResponse({ status: 200 })
  getBrandingHistory(@Param('slug') slug: string) {
    return this.service.getBrandingHistory(slug);
  }

  // ── Sync receiver (internal — peer environment only) ──────────────────────

  @Post(':slug/branding/sync')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive a branding sync from the peer environment (internal)',
  })
  @ApiParam({ name: 'slug', description: 'Business unit slug' })
  @ApiResponse({ status: 200, description: 'Sync applied' })
  @ApiResponse({ status: 401, description: 'Invalid sync secret' })
  async receiveBrandingSync(
    @Param('slug') slug: string,
    @Body()
    body: {
      primary_color?: string;
      secondary_color?: string;
      logo_url?: string;
      company_name?: string;
      layout_preset?: string;
      button_color?: string;
      button_text_color?: string;
    },
    @Headers('x-sync-secret') secret: string,
    @Headers('x-sync-origin') origin: string,
  ) {
    if (!secret || secret !== process.env.INTER_ENV_SYNC_SECRET) {
      throw new UnauthorizedException('Invalid sync secret');
    }
    await this.service.receiveBrandingSyncFromPeer(
      slug,
      body,
      origin ?? 'unknown',
    );
    return { status: 200, message: 'Branding sync applied' };
  }
}
