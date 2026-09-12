import { Controller, Get, Query } from '@nestjs/common';
import { CronService } from './cron.service';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { reRunPipelineDto } from './dto/re-run-pipeline.dto';
import { SyncOrganizationsDto } from './dto/sync-organizations.dto';

@ApiTags('cron')
@Controller('cron')
export class CronController {
  constructor(private readonly cron: CronService) {}

  @Get()
  @ApiOperation({
    summary: 'Re-run pipeline for candidates currently in processing status',
  })
  @ApiQuery({
    name: 'status',
    type: reRunPipelineDto,
    description: 'Status to filter candidates for re-running pipeline',
  })
  @ApiResponse({ status: 200, description: 'Pipeline re-run successfully' })
  async reRunPipeline(@Query() status: reRunPipelineDto) {
    const result = await this.cron.reRunPipeline(status);
    return {
      status: 200,
      message: 'Pipeline re-run successfully',
      data: result,
    };
  }

  @Get('get-candidate-id')
  @ApiOperation({
    summary:
      'Sync candidate IDs for staff records missing them by looking up HubSpot',
  })
  @ApiResponse({ status: 200, description: 'Cron working successfully' })
  async getCandidateId() {
    const result = await this.cron.getCandidateId();
    return {
      status: 200,
      message: 'Cron working successfully',
      data: result,
    };
  }

  @Get('system-report')
  @ApiOperation({
    summary: 'Send a system report email with key platform metrics',
  })
  @ApiResponse({ status: 200, description: 'System report sent successfully' })
  async systemReport() {
    const result = await this.cron.systemReport();
    return {
      status: 200,
      message: 'System report sent successfully',
      data: result,
    };
  }

  @Get('sync-clients-with-active-staffs')
  @ApiOperation({
    summary:
      'Sync client organizations that have active staff members in HubSpot',
  })
  @ApiResponse({ status: 200, description: 'Sync completed successfully' })
  async syncClientsWithActiveStaffs() {
    const result = await this.cron.syncClientsWithActiveStaffs();
    return {
      status: 200,
      message: 'the sync was successful',
      data: result,
    };
  }

  @Get('deactivate-client-users-no-staff')
  @ApiOperation({
    summary:
      'Deactivate client users on organizations with no active staff after 60 days of account creation',
  })
  @ApiResponse({
    status: 200,
    description: 'Client users deactivation completed successfully',
  })
  async deactivateClientUsersWithNoStaff() {
    const result = await this.cron.deactivateClientUsersWithNoStaff();
    return {
      status: 200,
      message: 'Client users deactivation completed successfully',
      data: result,
    };
  }

  @Get('update-hubspot-deal-stages')
  @ApiOperation({
    summary: 'Update HubSpot deal stages for all active staff members',
  })
  @ApiResponse({
    status: 200,
    description: 'HubSpot deal stages updated successfully',
  })
  async syncStaffHubspotDealStages() {
    const result = await this.cron.syncStaffHubspotDealStages();
    return {
      status: 200,
      message: 'HubSpot deal stages updated successfully',
      data: result,
    };
  }

  @Get('sync-positions-from-hubspot')
  @ApiOperation({
    summary:
      'Check for new VA positions in HubSpot and create missing entries in PositionRateConfig',
  })
  @ApiResponse({
    status: 200,
    description: 'Position sync completed successfully',
  })
  async syncPositionsFromHubspot() {
    const result = await this.cron.syncPositionsFromHubspot();
    return {
      status: 200,
      message: 'Position sync completed successfully',
      data: result,
    };
  }

  @Get('create-quarterly-payout-requests')
  @ApiOperation({
    summary:
      'Create quarterly payout requests for affiliates with eligible commissions and send a summary report',
  })
  @ApiResponse({
    status: 200,
    description: 'Quarterly payout requests job completed',
  })
  async createQuarterlyPayoutRequests() {
    const result = await this.cron.createQuarterlyPayoutRequests();
    return {
      status: 200,
      message: 'Quarterly payout requests job completed',
      data: result,
    };
  }

  @Get('sync-growth-partners-from-hubspot')
  @ApiOperation({
    summary:
      'Read Growth Partners from HubSpot and create missing ones in the database as affiliate profiles',
  })
  @ApiResponse({ status: 200, description: 'Growth Partners sync completed' })
  async syncGrowthPartnersFromHubspot() {
    const result = await this.cron.syncGrowthPartnersFromHubspot();
    return {
      status: 200,
      message: 'Growth Partners sync completed',
      data: result,
    };
  }

  @Get('sync-invoice-payment-dates')
  @ApiOperation({
    summary:
      'Fetch hs_payment_date from HubSpot for each invoice snapshot missing paid_at and persist it',
  })
  @ApiResponse({
    status: 200,
    description: 'Invoice payment dates sync completed',
  })
  async syncInvoicePaymentDates() {
    const result = await this.cron.syncInvoicePaymentDates();
    return {
      status: 200,
      message: 'Invoice payment dates sync completed',
      data: result,
    };
  }

  @Get('sync-invoice-due-dates')
  @ApiOperation({
    summary:
      'Fetch hs_due_date from HubSpot for each invoice snapshot missing due_date and persist it',
  })
  @ApiResponse({
    status: 200,
    description: 'Invoice due dates backfill completed',
  })
  async syncInvoiceDueDates() {
    const result = await this.cron.syncInvoiceDueDates();
    return {
      status: 200,
      message: 'Invoice due dates backfill completed',
      data: result,
    };
  }

  @Get('expire-stale-eligibility')
  @ApiOperation({
    summary:
      'Expire referred companies whose deployment_date passed 365 days, regardless of their current eligibility decision',
  })
  @ApiResponse({
    status: 200,
    description: 'Stale eligibility expiry sweep completed',
  })
  async expireStaleEligibility() {
    const result = await this.cron.expireStaleEligibility();
    return {
      status: 200,
      message: 'Stale eligibility expiry sweep completed',
      data: result,
    };
  }

  @Get('daily-commission-summary')
  @ApiOperation({
    summary:
      'Send a daily summary email to admins listing all commissions pending review',
  })
  @ApiResponse({
    status: 200,
    description: 'Daily commission summary sent successfully',
  })
  async dailyCommissionSummary() {
    const result = await this.cron.dailyCommissionSummary();
    return {
      status: 200,
      message: result.sent
        ? `Daily commission summary sent (${result.count} commissions)`
        : 'No pending commissions — email not sent',
      data: result,
    };
  }

  @Get('weekly-offer-panel-report')
  @ApiOperation({
    summary:
      'Send the weekly Offer Panel Report — panels created over the rolling 8-day window ending at run time (America/Los_Angeles), grouped by creating user',
    description:
      'Triggered every Friday at 10:00 PT by the external scheduler (same mechanism ' +
      'as the other `/cron/*` endpoints — this backend runs on Lambda, so there is ' +
      'no in-process cron). The window opens at 00:00 PT on the day 7 days earlier ' +
      'and closes at the moment of the run, so a Friday run covers last Friday ' +
      'through this Friday morning; the extra day makes consecutive reports overlap ' +
      'rather than drop panels created after the previous run. ' +
      'Filters on `OfferPanel.createdAt` only; the viewed and ' +
      'decided columns show their real timestamps even when those occurred after ' +
      'the window closed. All business units are included in a single email with ' +
      'a business unit column, and sections are ordered by panel count descending. ' +
      'The email is sent even when zero panels were created, so a quiet week stays ' +
      'distinguishable from a broken cron. Note that `OfferPanel` has no ' +
      'soft-delete column, so a panel created and then deleted within the week ' +
      'never appears in the report.',
  })
  @ApiQuery({
    name: 'week_of',
    required: false,
    type: String,
    description:
      'Optional YYYY-MM-DD date used to backfill a prior week. The rolling 8-day ' +
      'window ending at 10:00 on this date (in America/Los_Angeles) is reported. ' +
      'Defaults to now.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Report processed. `data.sent` — whether the email was dispatched. ' +
      '`data.totalPanels` / `data.totalCreators` — report size. ' +
      '`data.weekStart` / `data.weekEnd` — the ISO boundaries of the 8-day window covered. ' +
      '`data.ranOnFridayPt` — false when triggered off-schedule. ' +
      '`data.error` — present only when the email failed to send.',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid week_of value — expected format YYYY-MM-DD',
  })
  async weeklyOfferPanelReport(@Query('week_of') weekOf?: string) {
    const result = await this.cron.weeklyOfferPanelReport(weekOf);
    return {
      status: 200,
      message: result.sent
        ? `Offer panel report sent (${result.totalPanels} panel(s) from ${result.totalCreators} creator(s))`
        : `Offer panel report not sent${result.error ? ` — ${result.error}` : ''}`,
      data: result,
    };
  }

  @Get('detect-commissions-by-affiliate')
  @ApiOperation({
    summary:
      'Detect and create missing commissions for all organizations referred by a specific affiliate. Uses existing eligibility rules — safe to re-run (idempotent).',
  })
  @ApiQuery({
    name: 'affiliate_profile_id',
    required: true,
    type: String,
    description: 'UUID of the affiliate profile to process.',
  })
  @ApiResponse({
    status: 200,
    description: 'Commission detection completed',
  })
  async detectCommissionsByAffiliate(
    @Query('affiliate_profile_id') affiliateProfileId: string,
  ) {
    const result =
      await this.cron.detectCommissionsByAffiliate(affiliateProfileId);
    return {
      status: 200,
      message: 'Commission detection completed',
      data: result,
    };
  }

  @Get('sync-hire-request-titles')
  @ApiOperation({
    summary:
      'One-time sync: rebuild HireRequest titles that are missing hubspot_role_type, updating both DB and HubSpot',
  })
  @ApiResponse({
    status: 200,
    description: 'Hire request title sync completed',
  })
  async syncHireRequestTitles() {
    const result = await this.cron.syncHireRequestTitles();
    return {
      status: 200,
      message: 'Hire request title sync completed',
      data: result,
    };
  }

  @Get('reconcile-affiliate-contacts')
  @ApiOperation({
    summary:
      'Fetch HubSpot associations for affiliate profiles missing a contact link and backfill contact_id',
  })
  @ApiResponse({
    status: 200,
    description: 'Affiliate contact reconciliation completed',
  })
  async reconcileAffiliateContacts() {
    const result = await this.cron.reconcileAffiliateContacts();
    return {
      status: 200,
      message: 'Affiliate contact reconciliation completed',
      data: result,
    };
  }

  @Get('sweep-stale-contact-ids')
  @ApiOperation({
    summary:
      'Detect HubSpot contacts deleted/merged before webhook coverage existed and clear stale local pointers',
  })
  @ApiResponse({ status: 200, description: 'Stale contact id sweep completed' })
  async sweepStaleContactIds() {
    const result = await this.cron.sweepStaleContactIds();
    return {
      status: 200,
      message: 'Stale contact id sweep completed',
      data: result,
    };
  }

  @Get('sync-organizations-with-hubspot')
  @ApiOperation({
    summary:
      'Full Med Alliance sync for referred organizations: resolves HubSpot company ID, ingests invoices, detects commissions, and promotes eligible companies. Pass organization_id to target a single org; omit to process all referred organizations.',
  })
  @ApiQuery({
    name: 'organization_id',
    required: false,
    type: String,
    description:
      'UUID of a single organization to sync. If omitted, all referred organizations are processed.',
  })
  @ApiResponse({
    status: 200,
    description: 'Organization sync completed',
  })
  async syncOrganizationsWithHubspot(@Query() query: SyncOrganizationsDto) {
    const result = await this.cron.syncOrganizationsWithHubspot(
      query.organization_id,
    );
    return {
      status: 200,
      message: 'Organization sync completed',
      data: result,
    };
  }

  @Get('sync-business-units')
  @ApiOperation({
    summary:
      'Daily HubSpot Business Unit intake (upsert new + reconcile removed)',
    description:
      'Triggered daily by the external scheduler (same mechanism as the other ' +
      '`/cron/*` endpoints — this backend runs on Lambda, so no in-process cron). ' +
      'Reads HubSpot `GET /crm/v3/properties/companies/business_unit` for the ' +
      'current list of option labels, then:\n\n' +
      '1. **Upsert (additions):** every option label is upserted into ' +
      '`BusinessUnit` by derived slug — new labels always land as dormant ' +
      '(`is_visible=false`, `candidate_pool="medical"`); an existing row only ' +
      'has its `hubspot_value` refreshed to the current label spelling, ' +
      '`is_visible` is never touched by the upsert step.\n' +
      '2. **Reconcile (removals) — with safeguard:** any BusinessUnit whose ' +
      '`hubspot_value` is no longer present in the HubSpot options is set ' +
      '`is_visible=false` and every related Organization/USER/Candidate/' +
      'AffiliateProfile is cascade soft-deleted, tagged `deactivated_by_bu=<slug>` ' +
      'so a later re-activation (`PUT /business-units/:slug` with ' +
      '`is_visible:true`) restores exactly that set. This step ONLY runs when ' +
      'the HubSpot read returned HTTP 200 with a non-empty `options` array — ' +
      'any error, timeout, non-200, or empty/malformed response aborts the ' +
      'reconcile (upserts from step 1 still apply) and logs the abort reason, ' +
      'so a transient HubSpot outage can never cascade-delete data.\n\n' +
      'Idempotent — re-running with an unchanged HubSpot options list creates ' +
      'no duplicates and changes nothing. Never hard-deletes a BusinessUnit row.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Sync completed. `data.upserted` — slugs upserted this run (new + refreshed). ' +
      '`data.removed` — slugs decommissioned this run (empty if the reconcile step ' +
      'was aborted). `data.aborted` — true if the reconcile step was skipped due to ' +
      'a bad/empty HubSpot read (upserts still applied in that case). ' +
      '`data.reason` — present only when aborted, explains why.',
  })
  async syncBusinessUnits() {
    const result = await this.cron.syncBusinessUnits();
    return {
      status: 200,
      message: result.aborted
        ? 'Business unit sync completed — reconcile step aborted (bad/empty HubSpot read), upserts only'
        : 'Business unit sync completed',
      data: result,
    };
  }
}
