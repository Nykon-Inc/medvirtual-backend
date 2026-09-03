import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { HubstaffService } from '../hubstaff/hubstaff.service';
import { PusherService } from '../pusher/pusher.service';
import { InvoiceJobStatus, InvoiceStatus, InvoiceVersionStatus, InvoiceLineType, InvoiceLineCategory, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { DateTime } from 'luxon';
import { StripeService } from '../stripe/stripe.service';
import { ConfigService } from '@nestjs/config';
import { queuesEnabled } from '../common/app-config';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import {
  buildConfigMap,
  buildCandidatePoolMap,
  computeCandidateRates,
  CandidateLike,
  CandidatePool,
} from '../common/utils/salary.util';

/**
 * BullMQ worker that does the actual heavy lifting of invoice generation — everything
 * InvoiceService.createInvoice/createBulkInvoices does is just enqueuing a job for this
 * class to process. This is where Hubstaff time-tracking data, staff pay
 * rates/salaries, PTO requests, and a hardcoded US holiday calendar all get combined
 * into the worked/PTO/holiday hour breakdown and dollar amounts on each
 * InvoiceLineItem — the single most business-logic-dense file in the invoicing feature.
 *
 * Also handles the 'attempt-collection' job type (queued by StripeService when an
 * invoice's due date arrives) since it shares the same BullMQ 'invoice' queue.
 */
@Processor('invoice')
@Injectable()
export class InvoiceWorker extends WorkerHost {
  private readonly logger = new Logger(InvoiceWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubstaff: HubstaffService,
    private readonly pusher: PusherService,
    private readonly stripeService: StripeService,
    private readonly configService: ConfigService,
    private readonly positionRateConfigService: PositionRateConfigService,
    private readonly businessUnitContext: BusinessUnitContext,
  ) {
    super();
  }

  /** Builds a human-scannable invoice reference like "20260305-02-30-XKQPZ" — date/time
   * of generation plus a random 5-char suffix. See InvoiceService.updateStatus for how
   * that suffix later gets swapped for the real invoice_number once one is assigned. */
  private generateReference(date: Date = new Date(), customSuffix?: string): string {
    const suffix = customSuffix || this.generateRandomString(5);
    const dateVal = DateTime.fromJSDate(date).toFormat("yyyyLLdd-hh-mm");
    return `${dateVal}-${suffix.toUpperCase()}`;
  }

  private generateRandomString(length: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Last-resort hourly rate for a worker with neither a salary nor a candidate
   * hourly_pay_rate on file — the position+business-unit floor price (same calculation
   * used across candidates/hire-requests), rather than a hardcoded number. Falls back to
   * 0 only if the candidate has no resolvable business unit/position at all.
   */
  public fallbackHourlyRate(
    candidate: CandidateLike | null,
    positionConfigMap: ReturnType<typeof buildConfigMap>,
    candidatePoolMap: Map<string, CandidatePool>,
  ): number {
    if (!candidate) return 0;
    const pool = candidatePoolMap.get(candidate.business_unit ?? '') ?? 'medical';
    return computeCandidateRates(candidate, positionConfigMap, pool).bill_rate_hourly;
  }

  /** Builds the position-rate config lookup used by fallbackHourlyRate — fetched once
   * per batch by callers (this worker's own generateInvoiceRecord, and
   * InvoicePrebillReconciliationWorker) rather than per-worker inside a loop. */
  public async buildPositionConfigMap() {
    const configs = await this.positionRateConfigService.findAllUnpaginated();
    return buildConfigMap(configs);
  }

  /** Builds the business_unit → candidate_pool lookup used by fallbackHourlyRate. */
  public async buildCandidatePoolMap(candidates: { business_unit: string | null }[]) {
    return buildCandidatePoolMap(candidates, this.businessUnitContext);
  }

  /** Counts Mon-Fri days (inclusive) in a date range — the baseline "how many days
   * should this worker have been billed for" denominator used in overtime detection. */
  public getWorkdaysCount(startDate: Date, endDate: Date): number {
    let count = 0;
    let curDate = DateTime.fromJSDate(startDate, { zone: 'utc' }).startOf('day');
    const lastDate = DateTime.fromJSDate(endDate, { zone: 'utc' }).startOf('day');
    while (curDate.toMillis() <= lastDate.toMillis()) {
      const dayOfWeek = curDate.weekday; // 1 = Monday, 7 = Sunday in Luxon
      if (dayOfWeek >= 1 && dayOfWeek <= 5) {
        count++;
      }
      curDate = curDate.plus({ days: 1 });
    }
    return count;
  }

  /**
   * Computes the 6 US federal holidays this billing system pays out on, for a given
   * year. Deliberately hardcoded/computed rather than stored in the DB or fetched from
   * an external calendar — these dates are simple enough to derive algorithmically
   * (nth weekday of a month) and this avoids needing yearly manual data entry. Only the
   * fixed-date and floating-Monday/Thursday holidays MedVirtual observes are included
   * here — this is NOT a general-purpose US holiday calendar (e.g. no MLK Day, no
   * Veterans Day).
   */
  public getHolidaysForYear(year: number): string[] {
    const holidays: string[] = [];

    // 1. New Year's Day (Jan 1)
    holidays.push(DateTime.fromObject({ year, month: 1, day: 1 }).toFormat('yyyy-MM-dd'));

    // 2. Memorial Day (last Monday of May)
    let memorialDay = DateTime.fromObject({ year, month: 5, day: 31 });
    while (memorialDay.weekday !== 1) { // 1 = Monday in Luxon
      memorialDay = memorialDay.minus({ days: 1 });
    }
    holidays.push(memorialDay.toFormat('yyyy-MM-dd'));

    // 3. Independence Day (July 4)
    holidays.push(DateTime.fromObject({ year, month: 7, day: 4 }).toFormat('yyyy-MM-dd'));

    // 4. Labor Day (first Monday of September)
    let laborDay = DateTime.fromObject({ year, month: 9, day: 1 });
    while (laborDay.weekday !== 1) {
      laborDay = laborDay.plus({ days: 1 });
    }
    holidays.push(laborDay.toFormat('yyyy-MM-dd'));

    // 5. Thanksgiving (fourth Thursday of November)
    let thanksgiving = DateTime.fromObject({ year, month: 11, day: 1 });
    while (thanksgiving.weekday !== 4) { // 4 = Thursday in Luxon
      thanksgiving = thanksgiving.plus({ days: 1 });
    }
    thanksgiving = thanksgiving.plus({ weeks: 3 });
    holidays.push(thanksgiving.toFormat('yyyy-MM-dd'));

    // 6. Christmas (Dec 25)
    holidays.push(DateTime.fromObject({ year, month: 12, day: 25 }).toFormat('yyyy-MM-dd'));

    return holidays;
  }


  /**
   * BullMQ's single entry point — dispatches by job.name since this worker handles two
   * unrelated job types sharing the 'invoice' queue: 'generate-invoice' (the main
   * event) and 'attempt-collection' (scheduled by StripeService.webhookHandler when an
   * invoice's due date arrives, to trigger an automatic charge attempt).
   */
  async process(job: Job<any, any, string>): Promise<any> {
    if (!queuesEnabled(this.configService)) {
      this.logger.warn(`LOCAL mode — invoice job '${job.name}' skipped.`);
      return;
    }
    if (job.name === 'attempt-collection') {
      const { invoiceId, stripeInvoiceId } = job.data;
      this.logger.log(`Attempting collection for invoice ${invoiceId} / Stripe ${stripeInvoiceId}`);
      const invoice = await this.prisma.invoice.findUnique({
        where: { id: invoiceId },
      });
      if (invoice && invoice.status !== 'paid') {
        try {
          await this.stripeService.payInvoice(stripeInvoiceId);
          this.logger.log(`Successfully collected payment for invoice ${invoiceId}`);
        } catch (err) {
          this.logger.error(`Failed to collect payment for invoice ${invoiceId}: ${err.message}`);
          throw err; // retry job — BullMQ will retry a thrown error per the job's retry config
        }
      }
      return;
    }

    if (job.name !== 'generate-invoice') {
      this.logger.warn(`Unknown job name: ${job.name}`);
      return;
    }

    const payload = job.data;
    const { job_id, organization_id, billing_start_date, billing_end_date, created_by, is_prebill, isCustom } = payload;

    try {
      // 1. Mark job as "processing"
      await this.prisma.invoiceJob.update({
        where: { id: job_id },
        data: { status: InvoiceJobStatus.processing },
      });

      await this.pusher.trigger(`user-${created_by}`, 'invoice.job.creation', {
        job_id,
        status: 'processing',
        timestamp: new Date().toISOString(),
      });

      // 2. Fetch Organization & Configuration
      const org = await this.prisma.organization.findUnique({
        where: { id: organization_id },
        include: { invoiceConfiguration: true },
      });

      if (!org) {
        throw new Error('Organization not found');
      }

      if (!isCustom && (!org.invoiceConfiguration || !org.invoiceConfiguration.hubstaff_id)) {
        throw new Error('Organization Hubstaff connection missing');
      }

      // 4. Generate Invoice (Core Logic)
      const invoice = await this.generateInvoiceRecord(org, payload);

      // 5. Emit Completion
      await this.completeJob(job_id, created_by, [invoice.id]);

    } catch (error) {
      this.logger.error(`Job ${job_id} failed: ${error.message}`);
      await this.prisma.invoiceJob.update({
        where: { id: job_id },
        data: {
          status: InvoiceJobStatus.failed,
          error_message: error.message,
          failed_tasks: { increment: 1 },
        },
      });

      await this.pusher.trigger(`user-${created_by}`, 'invoice.job.creation', {
        job_id,
        status: 'failed',
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * The core generation algorithm. Two very different paths depending on `isCustom`:
   *
   * - isCustom=true: creates a bare draft Invoice + InvoiceVersion with zero line
   *   items — used when an admin wants to hand-build a one-off invoice from scratch
   *   rather than auto-generating from tracked hours.
   * - isCustom=false (the normal path): pulls Hubstaff time-tracking data (or, for
   *   prebill invoices, assumes a standard 8hr/day baseline since actual hours aren't
   *   known yet), combines it with approved PTO and the US holiday calendar, and
   *   builds one primary InvoiceLineItem per worker plus nested overtime/bonus/
   *   reconciliation lines — see the inline comments through the day-by-day loop below
   *   for the actual billing rules.
   *
   * Everything is written inside a single Prisma transaction so a partially-generated
   * invoice (e.g. failure halfway through creating line items) never gets persisted.
   */
  private async generateInvoiceRecord(org: any, payload: any) {
    const {
      organization_id,
      billing_start_date,
      billing_end_date,
      issue_date,
      due_date,
      public_due_date,
      is_prebill,
      isCustom,
      allowFees,
      ops,
      fee,
      created_by
    } = payload;

    if (isCustom) {
      return await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // 1. Create Invoice Header
        const invoice = await tx.invoice.create({
          data: {
            organization_id,
            status: InvoiceStatus.draft,
            created_by,
            billing_start_date: DateTime.fromISO(billing_start_date, { zone: 'utc' }).toJSDate(),
            billing_end_date: DateTime.fromISO(billing_end_date, { zone: 'utc' }).toJSDate(),
            reference: this.generateReference(),
            is_custom: true,
          },
        });

        // 2. Create Invoice Version (Draft)
        const version = await tx.invoiceVersion.create({
          data: {
            invoice_id: invoice.id,
            version_number: 1,
            status: InvoiceVersionStatus.draft,
            currency: org?.invoiceConfiguration?.billing_currency || 'USD',
            billing_start_date: DateTime.fromISO(billing_start_date, { zone: 'utc' }).toJSDate(),
            billing_end_date: DateTime.fromISO(billing_end_date, { zone: 'utc' }).toJSDate(),
            issue_date: issue_date ? DateTime.fromISO(issue_date, { zone: 'utc' }).toJSDate() : null,
            due_date: due_date ? DateTime.fromISO(due_date, { zone: 'utc' }).toJSDate() : null,
            public_due_date: public_due_date ? DateTime.fromISO(public_due_date, { zone: 'utc' }).toJSDate() : null,
            is_prebill: is_prebill || false,
            allow_fees: allowFees || false,
            created_by,
            subtotal: 0,
            total: 0,
            discountType: 'dollar',
            discountValue: 0,
          },
        });

        // 3. Link Version to Invoice Header
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { current_version_id: version.id },
        });

        return invoice;
      });
    }

    const hubstaffId = org.invoiceConfiguration.hubstaff_id;

    // Fetch project members to get names for snapshots — worker_name_snapshot on each
    // line item is populated from this map so historical invoices keep showing the
    // worker's name as of generation time even if they're later renamed in Hubstaff.
    const members = await this.hubstaff.getProjectMembers(hubstaffId);

    const memberMap = new Map<number, string>();
    members.forEach((m: any) => {
      if (m.user_id) {
        memberMap.set(m.user_id, m.name || m.user?.name || `Hubstaff User ${m.user_id}`);
      }
    });

    const hubstaffUserIds = members
      .map((m: any) => m.user_id ? String(m.user_id) : null)
      .filter((id): id is string => !!id);

    const startOfPeriod = DateTime.fromISO(billing_start_date, { zone: 'utc' }).startOf('day').toJSDate();
    const endOfPeriod = DateTime.fromISO(billing_end_date, { zone: 'utc' }).endOf('day').toJSDate();

    // Fetch all staff by candidate's hubstaff_id, matching this organization. The OR
    // matches by either our own organization_id or the org's HubSpot company id, since
    // staff assignment records may be linked via either identifier depending on how
    // they were created. Also sideloads resolved 'bonus'-type tickets from this exact
    // billing period, which get turned into bonus line items further down.
    const staffRecords = (hubstaffUserIds.length > 0) ? await this.prisma.staff.findMany({
      where: {
        candidate: {
          hubstaff_id: {
            in: hubstaffUserIds,
          },
        },
        OR: [
          { organization_id: organization_id },
          ...(org.hubspot_id ? [{ hubspot_organization_id: org.hubspot_id }] : []),
        ],
      },
      include: {
        candidate: {
          include: {
            // Needed by computeCandidateRates (via fallbackHourlyRate) to pick the
            // bilingual vs. english floor price when a worker has no salary/hourly_pay_rate.
            languages: true,
          },
        },
        tickets: {
          where: {
            type: {
              equals: 'bonus',
              mode: 'insensitive',
            },
            org_id: organization_id,
            status: 'resolved',
            createdAt: {
              gte: startOfPeriod,
              lte: endOfPeriod,
            },
          },
        },
      },
    }) : [];

    // Fallback bill rate source for workers with neither a salary nor a candidate
    // hourly_pay_rate on file — reuses the same position+business-unit floor price
    // calculation as the rest of the app (candidates/hire-requests) instead of a
    // hardcoded number, computed once per batch to avoid N+1 lookups in the loop below.
    const positionConfigMap = await this.buildPositionConfigMap();
    const candidatePoolMap = await this.buildCandidatePoolMap(
      staffRecords.map((s) => ({ business_unit: s.candidate?.business_unit ?? null })),
    );

    // Aggregate per-worker total tracked seconds for the period — tracked/overall are
    // fed into userSummary either from a flat prebill assumption or real Hubstaff
    // activity records, depending on billing mode (see branches below). The day-by-day
    // breakdown into worked/pto/holiday buckets happens later in the main loop; this is
    // just the first pass to know which workers to build line items for at all.
    const userSummary = new Map<number, { tracked: number; overall: number }>();
    let activities: any[] = [];

    if (is_prebill) {
      // Pre-bill logic: actual hours aren't known yet (billing happens BEFORE the cycle
      // starts — see BillingMode.prebill), so assume every project member works a
      // standard 8hrs/day baseline for the full period. The real numbers get
      // reconciled afterward via InvoicePrebillReconciliationWorker, which compares
      // this assumption against what Hubstaff actually recorded once the cycle closes.
      const startDate = DateTime.fromISO(billing_start_date, { zone: 'utc' }).toJSDate();
      const endDate = DateTime.fromISO(billing_end_date, { zone: 'utc' }).toJSDate();
      const days = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 3600 * 24)) + 1;
      const secondsPerMember = days * 8 * 3600;

      members.forEach((member: any) => {
        userSummary.set(member.user_id, {
          tracked: secondsPerMember,
          overall: secondsPerMember,
        });
      });

      if (members.length === 0) {
        this.logger.warn(`No members found for Hubstaff project ${hubstaffId} during pre-bill for org ${organization_id}`);
      }
    } else {
      // Regular logic: Fetch Hubstaff activities
      activities = await this.hubstaff.getHubstaffDailyActivityForInvoice({
        hubstaffId: Number(hubstaffId),
        start_date: billing_start_date,
        end_date: billing_end_date,
      });

      if (activities.length === 0) {
        this.logger.warn(`No activities found for org ${organization_id} in period ${billing_start_date} - ${billing_end_date}`);
      }

      activities.forEach((act: any) => {
        const current = userSummary.get(act.user_id) || { tracked: 0, overall: 0 };
        userSummary.set(act.user_id, {
          tracked: current.tracked + act.total_time_logged,
          overall: current.overall + act.overall,
        });

        // Use sideloaded user name if available to populate/update memberMap
        if (act.user_name) {
          memberMap.set(act.user_id, act.user_name);
        }
      });
    }

    // Now collect all unique user IDs for fetching PTOs — union of project members and
    // anyone who logged activity, in case someone tracked time without being a
    // "current" project member (e.g. removed from the project mid-cycle).
    const uniqueUserIdsForPto = Array.from(new Set([
      ...hubstaffUserIds,
      ...activities.map((act: any) => String(act.user_id))
    ]));

    // Fetch and filter approved PTOs. Only `approved` requests count toward billing —
    // pending/denied PTO requests are ignored entirely (the worker is just treated as
    // not having worked those hours, same as any other untracked time).
    const startDateISO = DateTime.fromISO(billing_start_date, { zone: 'utc' }).startOf('day').toISO() || undefined;
    const endDateISO = DateTime.fromISO(billing_end_date, { zone: 'utc' }).plus({ days: 1 }).startOf('day').toISO() || undefined;

    const ptoRequests = (uniqueUserIdsForPto.length > 0)
      ? await this.hubstaff.getTimeOffRequests(uniqueUserIdsForPto, startDateISO, endDateISO)
      : [];

    const approvedPtos = ptoRequests.filter(pto => pto.status === 'approved');

    // Precompute the list of every calendar day in the billing period, and the set of
    // US holiday dates falling within it — both are walked once per worker in the main
    // loop below rather than recomputed per-worker.
    const startJSDate = DateTime.fromISO(billing_start_date, { zone: 'utc' }).toJSDate();
    const endJSDate = DateTime.fromISO(billing_end_date, { zone: 'utc' }).toJSDate();
    let curDate = DateTime.fromJSDate(startJSDate, { zone: 'utc' }).startOf('day');
    const lastDate = DateTime.fromJSDate(endJSDate, { zone: 'utc' }).startOf('day');
    const allDaysList: DateTime[] = [];
    while (curDate.toMillis() <= lastDate.toMillis()) {
      allDaysList.push(curDate);
      curDate = curDate.plus({ days: 1 });
    }

    const startYear = DateTime.fromISO(billing_start_date, { zone: 'utc' }).year;
    const endYear = DateTime.fromISO(billing_end_date, { zone: 'utc' }).year;
    const holidayDates = new Set<string>();
    for (let y = startYear; y <= endYear; y++) {
      this.getHolidaysForYear(y).forEach(h => holidayDates.add(h));
    }

    return await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 1. Create Invoice Header
      const invoice = await tx.invoice.create({
        data: {
          organization_id,
          status: InvoiceStatus.draft,
          created_by,
          billing_start_date: DateTime.fromISO(billing_start_date, { zone: 'utc' }).toJSDate(),
          billing_end_date: DateTime.fromISO(billing_end_date, { zone: 'utc' }).toJSDate(),
          reference: this.generateReference(),
          is_custom: false,
        },
      });

      // 2. Create Invoice Version (Draft)
      const version = await tx.invoiceVersion.create({
        data: {
          invoice_id: invoice.id,
          version_number: 1,
          status: InvoiceVersionStatus.draft,
          currency: org.invoiceConfiguration.billing_currency || 'USD',
          billing_start_date: DateTime.fromISO(billing_start_date, { zone: 'utc' }).toJSDate(),
          billing_end_date: DateTime.fromISO(billing_end_date, { zone: 'utc' }).toJSDate(),
          issue_date: issue_date ? DateTime.fromISO(issue_date, { zone: 'utc' }).toJSDate() : null,
          due_date: due_date ? DateTime.fromISO(due_date, { zone: 'utc' }).toJSDate() : null,
          public_due_date: public_due_date ? DateTime.fromISO(public_due_date, { zone: 'utc' }).toJSDate() : null,
          is_prebill: is_prebill || false, // Pre-bill flag from DTO
          allow_fees: allowFees || false,
          created_by,
          subtotal: 0,
          total: 0,
          discountType: 'dollar',
          discountValue: 0,
        },
      });

      let subtotal = new Decimal(0);

      // 3. Create Line Items — one primary InvoiceLineItem per worker who tracked time
      // or was assumed to (prebill), plus nested overtime/bonus/reconciliation lines.
      for (const [userId, stats] of userSummary.entries()) {
        // Find Staff & Candidate
        const staff = staffRecords.find(s => s.candidate?.hubstaff_id === String(userId)) || null;
        const candidate = staff?.candidate || null;

        // Full-time workers have an 8hr/day baseline (salaried expectation); part-time
        // workers have a 4hr/day baseline. This baseline drives both holiday pay
        // (below) and overtime detection (requiredHours further down).
        let isFullTime = true;
        if (staff) {
          const deploymentType = (staff.hubspot_deployment_type || '').trim().toLowerCase().replace('-', ' ');
          isFullTime = deploymentType === 'full time' || deploymentType === 'fulltime';
        }
        const dailyBaseline = isFullTime ? 8 : 4;

        // Walk every day in the billing period once per worker, classifying each day as
        // worked/PTO/holiday and accumulating payable hours into the three buckets
        // below. This is the actual implementation of the org's holiday/PTO pay policy.
        let totalWorkedHours = 0;
        let totalPtoHours = 0;
        let totalHolidayHours = 0;
        let actualWorkedHoursOnHolidays = 0;

        for (const dayOfPeriod of allDaysList) {
          const dateStr = dayOfPeriod.toFormat('yyyy-MM-dd');
          const isWeekday = dayOfPeriod.weekday >= 1 && dayOfPeriod.weekday <= 5;
          const isHoliday = isWeekday && holidayDates.has(dateStr);

          // 1. Calculate worked hours for this day
          let dailyWorked = 0;
          if (is_prebill) {
            // Pre-bill assumes baseline hours on weekday non-holidays,
            // and 0 worked hours on holidays (they just get standard holiday pay at 100%).
            dailyWorked = (isWeekday && !isHoliday) ? dailyBaseline : 0;
          } else {
            const dayActs = activities.filter(act => act.user_id === userId && act.day === dateStr);
            const totalSeconds = dayActs.reduce((sum, act) => sum + act.total_time_logged, 0);
            dailyWorked = totalSeconds / 3600;
          }
          totalWorkedHours += dailyWorked;

          if (isHoliday) {
            // Holiday billing logic:
            // If VA does NOT work (dailyWorked is zero): You bill required hours (dailyBaseline)
            // If VA DOES work (dailyWorked > zero): You bill required hours (dailyBaseline) + dailyWorked * 50%
            let dailyHolidayPayable = dailyBaseline;
            if (dailyWorked > 0) {
              dailyHolidayPayable += dailyWorked * 0.5;
              actualWorkedHoursOnHolidays += dailyWorked;
            }
            totalHolidayHours += dailyHolidayPayable;
          } else {
            // 2. Calculate approved PTO hours for this day (only on non-holiday weekdays)
            // Note: If a day is a holiday, we ignore any approved PTO requests for it
            // since the holiday block above already pipes in the holiday pay.
            let dailyPto = 0;
            if (isWeekday) {
              const userPtos = approvedPtos.filter(pto => pto.user_id === userId);
              for (const pto of userPtos) {
                const days = pto.time_off_request_days
                  ? (Array.isArray(pto.time_off_request_days) ? pto.time_off_request_days : [pto.time_off_request_days])
                  : [];
                for (const day of days) {
                  if (day.date === dateStr) {
                    dailyPto += (day.amount_used || 0) / 3600;
                  }
                }
              }
            }
            totalPtoHours += dailyPto;
          }
        }

        // totalPayableHours subtracts actualWorkedHoursOnHolidays from totalWorkedHours
        // because those hours were already folded into totalHolidayHours above (at the
        // 150% holiday rate) — without the subtraction they'd be double-counted.
        const totalPayableHours = (totalWorkedHours - actualWorkedHoursOnHolidays) + totalPtoHours + totalHolidayHours;
        const hours = new Decimal(totalPayableHours);

        // Overtime is only recognized once payable hours exceed the expected baseline
        // by more than 4 hours — a small buffer so minor day-to-day variance doesn't
        // trigger overtime billing.
        const workdaysInPeriod = this.getWorkdaysCount(startJSDate, endJSDate);
        const requiredHours = workdaysInPeriod * dailyBaseline;
        const actualHours = totalPayableHours;
        const hasOvertime = actualHours > requiredHours + 4;

        let hourlyRate = new Decimal(
          this.fallbackHourlyRate(candidate, positionConfigMap, candidatePoolMap),
        ); // Default fallback — position+BU floor price, used when no salary/hourly_pay_rate applies below
        let lineTotal = hours.mul(hourlyRate);
        let primaryHours = actualHours;

        let overtimeHours = 0;
        let overtimeHourlyRate = new Decimal(0);
        let overtimeTotal = new Decimal(0);

        if (hasOvertime) {
          // Split into a primary line capped at requiredHours (billed at the normal/
          // salaried rate) plus a separate overtime line for the excess — this is why
          // primaryHours is reset to requiredHours rather than staying at actualHours.
          overtimeHours = actualHours - requiredHours;
          primaryHours = requiredHours;

          if (staff && staff.salary) {
            // Salaried worker: derive an hourly-equivalent rate from their monthly
            // salary (annualized, then divided across a standard 52-week/40hr year)
            // purely to price the overtime hours — their primary/base pay is still the
            // flat salary amount computed in the full/half-month branches below.
            const monthlySalary = Number(staff.salary);
            const prorationRate = (monthlySalary * 12) / 52 / 40;
            overtimeHourlyRate = new Decimal(prorationRate);
            overtimeTotal = new Decimal(overtimeHours).mul(overtimeHourlyRate);

            // Detect whether this billing cycle is a calendar full-month, a half-month
            // (1st-15th or 16th-end), or an irregular custom range — full-time salaried
            // workers are billed a flat monthly/half-monthly salary for the standard
            // cycle shapes, and only fall back to hourly proration for anything else
            // (e.g. a short custom-range invoice).
            if (isFullTime) {
              const startDT = DateTime.fromJSDate(startJSDate, { zone: 'utc' });
              const endDT = DateTime.fromJSDate(endJSDate, { zone: 'utc' });
              const diffInDays = endDT.diff(startDT, 'days').days + 1;

              const startDay = startDT.day;
              const endDay = endDT.day;
              const daysInMonth = startDT.daysInMonth;

              // >=27 days is treated as "close enough" to a full month even if the
              // range doesn't land exactly on the 1st/last day (e.g. a 28-day February
              // cycle, or a cycle shifted by a day or two).
              const isFullMonth = (startDay === 1 && endDay === daysInMonth) || (diffInDays >= 27);
              const isHalfMonth = !isFullMonth && (
                (startDay === 1 && endDay === 15) ||
                (startDay === 16 && endDay === daysInMonth)
              );

              if (isFullMonth) {
                const baseSalary = monthlySalary;
                lineTotal = new Decimal(baseSalary);
                hourlyRate = primaryHours > 0 ? lineTotal.div(new Decimal(primaryHours)) : new Decimal(0);
              } else if (isHalfMonth) {
                const baseSalary = monthlySalary / 2;
                lineTotal = new Decimal(baseSalary);
                hourlyRate = primaryHours > 0 ? lineTotal.div(new Decimal(primaryHours)) : new Decimal(0);
              } else {
                hourlyRate = new Decimal(prorationRate);
                lineTotal = new Decimal(primaryHours).mul(hourlyRate);
              }
            } else {
              hourlyRate = new Decimal(prorationRate);
              lineTotal = new Decimal(primaryHours).mul(hourlyRate);
            }
          } else if (candidate && candidate.hourly_pay_rate) {
            // No salary on file — fall back to the candidate's own hourly rate.
            const rate = Number(candidate.hourly_pay_rate);
            hourlyRate = new Decimal(rate);
            lineTotal = new Decimal(primaryHours).mul(hourlyRate);
            overtimeHourlyRate = new Decimal(rate);
            overtimeTotal = new Decimal(overtimeHours).mul(overtimeHourlyRate);
          } else {
            // No salary AND no candidate hourly rate on file — last-resort fallback using
            // the position+business-unit floor price (same rate for base and overtime)
            // rather than failing invoice generation entirely for a worker with
            // incomplete pay-rate data.
            const fallbackRate = this.fallbackHourlyRate(candidate, positionConfigMap, candidatePoolMap);
            hourlyRate = new Decimal(fallbackRate);
            lineTotal = new Decimal(primaryHours).mul(hourlyRate);
            overtimeHourlyRate = new Decimal(fallbackRate);
            overtimeTotal = new Decimal(overtimeHours).mul(overtimeHourlyRate);
          }
        } else {
          // No-overtime path: same salaried full/half-month billing shape as above, but
          // with one extra rule — a salaried worker who fell noticeably short of their
          // expected hours (deficit > 10) gets billed hourly for what they actually
          // worked instead of the flat salary, rather than being paid in full for time
          // not worked.
          if (staff && staff.salary) {
            const monthlySalary = Number(staff.salary);
            const prorationRate = (monthlySalary * 12) / 52 / 40;
            const prorationHourlyDecimal = new Decimal(prorationRate);

            if (isFullTime) {
              // Full-Time staff logic
              const startDT = DateTime.fromJSDate(startJSDate, { zone: 'utc' });
              const endDT = DateTime.fromJSDate(endJSDate, { zone: 'utc' });
              const diffInDays = endDT.diff(startDT, 'days').days + 1;

              const startDay = startDT.day;
              const endDay = endDT.day;
              const daysInMonth = startDT.daysInMonth;

              const isFullMonth = (startDay === 1 && endDay === daysInMonth) || (diffInDays >= 27);
              const isHalfMonth = !isFullMonth && (
                (startDay === 1 && endDay === 15) ||
                (startDay === 16 && endDay === daysInMonth)
              );

              if (isFullMonth) {
                const baseSalary = monthlySalary;
                const deficit = requiredHours - actualHours;
                if (deficit > 10) {
                  lineTotal = hours.mul(prorationHourlyDecimal);
                } else {
                  lineTotal = new Decimal(baseSalary);
                }
                hourlyRate = hours.gt(0) ? lineTotal.div(hours) : new Decimal(0);
              } else if (isHalfMonth) {
                const baseSalary = monthlySalary / 2;
                const deficit = requiredHours - actualHours;
                if (deficit > 10) {
                  lineTotal = hours.mul(prorationHourlyDecimal);
                } else {
                  lineTotal = new Decimal(baseSalary);
                }
                hourlyRate = hours.gt(0) ? lineTotal.div(hours) : new Decimal(0);
              } else {
                // Not a full month and not a half month -> Prorate based on hours
                lineTotal = hours.mul(prorationHourlyDecimal);
                hourlyRate = prorationHourlyDecimal;
              }
            } else {
              // Non-Full-Time staff logic
              hourlyRate = prorationHourlyDecimal;
              lineTotal = hours.mul(hourlyRate);
            }
          } else if (candidate && candidate.hourly_pay_rate) {
            hourlyRate = new Decimal(Number(candidate.hourly_pay_rate));
            lineTotal = hours.mul(hourlyRate);
          } else {
            // No salary AND no candidate hourly rate on file — same position+BU floor
            // price fallback as the overtime branch above (hourlyRate already holds it
            // from initialization, but set explicitly here for clarity).
            hourlyRate = new Decimal(
              this.fallbackHourlyRate(candidate, positionConfigMap, candidatePoolMap),
            );
            lineTotal = hours.mul(hourlyRate);
          }
        }

        const memberName = memberMap.get(userId) || `Hubstaff User ${userId}`;

        // The primary line item for this worker — hours breakdown, computed rate, and
        // service_amount from all the branching logic above. operations_cost/
        // medvirtual_fees are only populated when allowFees is set (see
        // InvoiceVersion.allow_fees) — some orgs never see the internal cost breakdown.
        const primaryLineItem = await tx.invoiceLineItem.create({
          data: {
            invoice_version_id: version.id,
            worker_id: userId.toString(),
            worker_name_snapshot: memberName,
            type: InvoiceLineType.primary,
            category: InvoiceLineCategory.hourly_service,
            description: `Hourly services for ${memberName}`,
            effective_worked_hours: new Decimal(primaryHours),
            total_hours_worked: new Decimal(totalWorkedHours),
            total_pto_hours: new Decimal(totalPtoHours),
            total_holiday_hours: new Decimal(totalHolidayHours),
            total_hours_payable: new Decimal(primaryHours),
            hourly_rate: hourlyRate,
            service_amount: lineTotal,
            operations_cost: allowFees ? new Decimal(ops || 0) : new Decimal(0),
            medvirtual_fees: allowFees ? new Decimal(fee || 0) : new Decimal(0),
            final_total: allowFees
              ? lineTotal.add(new Decimal(ops || 0)).add(new Decimal(fee || 0))
              : lineTotal,
            is_full_time: isFullTime,
            created_by,
          },
        });

        const lineItemTotal = allowFees
          ? lineTotal.add(new Decimal(ops || 0)).add(new Decimal(fee || 0))
          : lineTotal;
        subtotal = subtotal.add(lineItemTotal);

        if (hasOvertime) {
          await tx.invoiceLineItem.create({
            data: {
              invoice_version_id: version.id,
              parent_line_item_id: primaryLineItem.id,
              worker_id: userId.toString(),
              worker_name_snapshot: memberName,
              type: InvoiceLineType.additional,
              category: InvoiceLineCategory.overtime,
              description: `Overtime: ${overtimeHours.toFixed(2)} hours`,
              effective_worked_hours: new Decimal(overtimeHours),
              total_hours_payable: new Decimal(overtimeHours),
              hourly_rate: overtimeHourlyRate,
              final_total: overtimeTotal,
              is_full_time: isFullTime,
              created_by,
            },
          });
          subtotal = subtotal.add(overtimeTotal);
        }

        // Bonus tickets: resolved support tickets of type 'bonus' created during this
        // billing period (fetched in staffRecords above) get turned into their own
        // bonus line items. The dollar amount isn't a structured field on the ticket —
        // it's parsed out of the ticket title via regex (e.g. a title like "Approved:
        // $150 retention bonus" yields $150), since bonus tickets are created through
        // the general support-ticket flow rather than a dedicated bonus-entry form.
        if (staff) {
          this.logger.log('Staff found for user_id:', userId);
          const bonusTickets = staff.tickets || [];

          for (const ticket of bonusTickets) {
            const dollarMatch = ticket.title.match(/\$\s*([\d,]+(?:\.\d+)?)/);
            if (dollarMatch) {
              const amountStr = dollarMatch[1].replace(/,/g, '');
              const amount = parseFloat(amountStr);
              if (!isNaN(amount) && amount > 0) {
                const bonusAmount = new Decimal(amount);

                await tx.invoiceLineItem.create({
                  data: {
                    invoice_version_id: version.id,
                    parent_line_item_id: primaryLineItem.id,
                    ticket_id: ticket.id,
                    worker_id: userId.toString(),
                    worker_name_snapshot: memberName,
                    type: InvoiceLineType.additional,
                    category: InvoiceLineCategory.bonus,
                    description: `${ticket.description}`,
                    effective_worked_hours: new Decimal(1),
                    total_hours_worked: new Decimal(1),
                    total_hours_payable: new Decimal(1),
                    hourly_rate: bonusAmount,
                    final_total: bonusAmount,
                    is_full_time: isFullTime,
                    created_by,
                  },
                });

                subtotal = subtotal.add(bonusAmount);
              }
            }
          }
        }
      }

      // 4. Apply any pending BillingLedgerEntry adjustments for this org/period
      //    These are reconciliation deltas from previous pre-billed invoices that
      //    have not yet been applied to a subsequent invoice line item.
      //    Scoped to workers who already have a primary line item on THIS invoice
      //    (workerIds, from userSummary) — a pending credit/debit for a worker who
      //    isn't being billed this cycle simply stays pending until they are again.
      const workerIds = Array.from(userSummary.keys()).map(String);

      if (workerIds.length > 0) {
        const pendingLedgerEntries = await tx.billingLedgerEntry.findMany({
          where: {
            organization_id,
            worker_id: { in: workerIds },
            applied_to_line_item_id: null,
          },
        });

        for (const ledgerEntry of pendingLedgerEntries) {
          // Find the primary line item on this version for the same worker
          const matchingLineItem = await tx.invoiceLineItem.findFirst({
            where: {
              invoice_version_id: version.id,
              worker_id: ledgerEntry.worker_id,
              type: InvoiceLineType.primary,
            },
          });

          if (!matchingLineItem) continue;

          // debit  = client owes more (actual > prebill) → add to invoice
          // credit = client was overbilled               → deduct from invoice
          const isDebit = ledgerEntry.direction === 'debit';
          const adjustmentAmount = new Decimal(ledgerEntry.remaining_amount);
          const signedAmount = isDebit ? adjustmentAmount : adjustmentAmount.negated();

          const adjustmentLine = await tx.invoiceLineItem.create({
            data: {
              invoice_version_id: version.id,
              parent_line_item_id: matchingLineItem.id,
              worker_id: ledgerEntry.worker_id ?? undefined,
              worker_name_snapshot: matchingLineItem.worker_name_snapshot,
              type: InvoiceLineType.additional,
              category: isDebit
                ? InvoiceLineCategory.reconciliation_debit
                : InvoiceLineCategory.reconciliation_credit,
              description: isDebit
                ? `Invoice Adjustment - Overtime`
                : `Invoice Adjustment - Unworked Hours`,
              effective_worked_hours: new Decimal(0),
              total_hours_payable: new Decimal(0),
              hourly_rate: new Decimal(0),
              final_total: signedAmount,
              is_full_time: matchingLineItem.is_full_time,
              created_by,
            },
          });

          subtotal = subtotal.add(signedAmount);

          // Link the ledger entry to this new line item
          await tx.billingLedgerEntry.update({
            where: { id: ledgerEntry.id },
            data: { applied_to_line_item_id: adjustmentLine.id },
          });
        }
      }

      // 5. Update Version Totals
      const finalVersion = await tx.invoiceVersion.update({
        where: { id: version.id },
        data: {
          subtotal,
          total: subtotal, // Tax handling can be added later
        },
      });

      // 6. Link Version to Invoice Header
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { current_version_id: version.id },
      });

      return invoice;
    });
  }

  /** Marks the InvoiceJob completed and notifies the requesting user over Pusher — the
   * "your invoice is ready" real-time signal the frontend listens for after generation. */
  private async completeJob(job_id: string, userId: string, invoiceIds: string[]) {
    await this.prisma.invoiceJob.update({
      where: { id: job_id },
      data: {
        status: InvoiceJobStatus.completed,
        completed_tasks: { increment: 1 },
        result: { invoice_ids: invoiceIds },
      },
    });

    await this.pusher.trigger(`user-${userId}`, 'invoice.job.creation', {
      job_id,
      status: 'completed',
      invoice_ids: invoiceIds,
      timestamp: new Date().toISOString(),
    });
  }
}
