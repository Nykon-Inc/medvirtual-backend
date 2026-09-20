import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceWorker } from './invoice.worker';
import { PrismaService } from '../prisma/prisma.service';
import { HubstaffService } from '../hubstaff/hubstaff.service';
import { PusherService } from '../pusher/pusher.service';
import { StripeService } from '../stripe/stripe.service';
import { ConfigService } from '@nestjs/config';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { Decimal } from '@prisma/client/runtime/library';
import { DateTime } from 'luxon';

describe('InvoiceWorker', () => {
  let worker: InvoiceWorker;
  let prismaMock: any;
  let hubstaffMock: any;
  let positionRateConfigMock: any;
  let businessUnitContextMock: any;

  beforeEach(async () => {
    prismaMock = {
      $transaction: jest.fn((cb) => cb(prismaMock)),
      invoice: {
        create: jest.fn().mockResolvedValue({ id: 'invoice_id' }),
        update: jest.fn().mockResolvedValue({ id: 'invoice_id' }),
      },
      invoiceVersion: {
        create: jest.fn().mockResolvedValue({ id: 'version_id' }),
        update: jest.fn().mockResolvedValue({ id: 'version_id' }),
      },
      invoiceLineItem: {
        create: jest.fn().mockResolvedValue({ id: 'line_item_id' }),
      },
      invoiceAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit_log_id' }),
      },
      billingLedgerEntry: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      staff: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    hubstaffMock = {
      getProjectMembers: jest.fn().mockResolvedValue([]),
      getTimeOffRequests: jest.fn().mockResolvedValue([]),
      getHubstaffDailyActivityForInvoice: jest.fn().mockResolvedValue([]),
    };

    positionRateConfigMock = {
      findAllUnpaginated: jest.fn().mockResolvedValue([]),
    };

    businessUnitContextMock = {
      poolFor: jest.fn().mockResolvedValue('medical'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceWorker,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HubstaffService, useValue: hubstaffMock },
        { provide: PusherService, useValue: {} },
        { provide: StripeService, useValue: {} },
        { provide: ConfigService, useValue: {} },
        {
          provide: PositionRateConfigService,
          useValue: positionRateConfigMock,
        },
        { provide: BusinessUnitContext, useValue: businessUnitContextMock },
      ],
    }).compile();

    worker = module.get<InvoiceWorker>(InvoiceWorker);
  });

  describe('generateInvoiceRecord proration logic', () => {
    const org = {
      id: 'org_id',
      invoiceConfiguration: {
        hubstaff_id: 'hubstaff_project_id',
        billing_currency: 'USD',
      },
    };

    it('excludes hardcoded Hubstaff users from invoice generation', async () => {
      const payload = {
        organization_id: 'org_id',
        billing_start_date: '2026-06-01',
        billing_end_date: '2026-06-30',
        is_prebill: true,
        created_by: 'user_1',
      };

      hubstaffMock.getProjectMembers.mockResolvedValue([
        { user_id: 3020409, name: 'Nancy' },
        { user_id: '1954999', name: 'Kier' },
        { user_id: 2548488, name: 'Patricia' },
        { user_id: 123, name: 'John Doe' },
      ]);

      await (worker as any).generateInvoiceRecord(org, payload);

      expect(prismaMock.staff.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            candidate: { hubstaff_id: { in: ['123'] } },
          }),
        }),
      );
    });

    it('calculates with proration rate for a short custom period (June 16 to 19 - below half month)', async () => {
      const payload = {
        organization_id: 'org_id',
        billing_start_date: '2026-06-16',
        billing_end_date: '2026-06-19',
        is_prebill: true,
        created_by: 'user_1',
      };

      hubstaffMock.getProjectMembers.mockResolvedValue([
        { user_id: 123, name: 'John Doe' },
      ]);

      prismaMock.staff.findMany.mockResolvedValue([
        {
          id: 'staff_1',
          candidate: {
            hubstaff_id: '123',
          },
          salary: '4000',
          hubspot_deployment_type: 'Full-Time',
          status: 'active',
        },
      ]);

      await (worker as any).generateInvoiceRecord(org, payload);

      // Verify what was passed to invoiceLineItem.create
      expect(prismaMock.invoiceLineItem.create).toHaveBeenCalled();
      const calls = prismaMock.invoiceLineItem.create.mock.calls;
      const primaryLineCall = calls.find(
        (c: any) => c[0].data.type === 'primary',
      );
      expect(primaryLineCall).toBeDefined();

      const serviceAmount = primaryLineCall[0].data.service_amount;
      // 4 days (June 16 to 19) are weekdays: 16 (Tue), 17 (Wed), 18 (Thu), 19 (Fri). All 4 are workdays.
      // With prebill = true, hours = 4 * 8 = 32 hours.
      // prorationRate = 4000 / 176 = 22.727272727272727
      // expected total = 32 * 22.727272727272727 = 727.2727272727273
      const expected = new Decimal(32).mul(new Decimal(4000 / 176));
      expect(serviceAmount.toNumber()).toBeCloseTo(expected.toNumber(), 2);
    });

    it('uses half month salary for standard half month (June 16 to 30)', async () => {
      const payload = {
        organization_id: 'org_id',
        billing_start_date: '2026-06-16',
        billing_end_date: '2026-06-30',
        is_prebill: true,
        created_by: 'user_1',
      };

      hubstaffMock.getProjectMembers.mockResolvedValue([
        { user_id: 123, name: 'John Doe' },
      ]);

      prismaMock.staff.findMany.mockResolvedValue([
        {
          id: 'staff_1',
          candidate: {
            hubstaff_id: '123',
          },
          salary: '4000',
          hubspot_deployment_type: 'Full-Time',
          status: 'active',
        },
      ]);

      await (worker as any).generateInvoiceRecord(org, payload);

      const calls = prismaMock.invoiceLineItem.create.mock.calls;
      const primaryLineCall = calls.find(
        (c: any) => c[0].data.type === 'primary',
      );
      expect(primaryLineCall).toBeDefined();

      const serviceAmount = primaryLineCall[0].data.service_amount;
      // Should be flat half month salary = 4000 / 2 = 2000
      expect(serviceAmount.toNumber()).toBe(2000);
    });

    it('uses full month salary for standard full month (June 1 to 30)', async () => {
      const payload = {
        organization_id: 'org_id',
        billing_start_date: '2026-06-01',
        billing_end_date: '2026-06-30',
        is_prebill: true,
        created_by: 'user_1',
      };

      hubstaffMock.getProjectMembers.mockResolvedValue([
        { user_id: 123, name: 'John Doe' },
      ]);

      prismaMock.staff.findMany.mockResolvedValue([
        {
          id: 'staff_1',
          candidate: {
            hubstaff_id: '123',
          },
          salary: '4000',
          hubspot_deployment_type: 'Full-Time',
          status: 'active',
        },
      ]);

      await (worker as any).generateInvoiceRecord(org, payload);

      const calls = prismaMock.invoiceLineItem.create.mock.calls;
      const primaryLineCall = calls.find(
        (c: any) => c[0].data.type === 'primary',
      );
      expect(primaryLineCall).toBeDefined();

      const serviceAmount = primaryLineCall[0].data.service_amount;
      // Should be flat full month salary = 4000
      expect(serviceAmount.toNumber()).toBe(4000);
    });

    it('calculates with proration rate for a period above half month but below full month (June 1 to 20)', async () => {
      const payload = {
        organization_id: 'org_id',
        billing_start_date: '2026-06-01',
        billing_end_date: '2026-06-20',
        is_prebill: true,
        created_by: 'user_1',
      };

      hubstaffMock.getProjectMembers.mockResolvedValue([
        { user_id: 123, name: 'John Doe' },
      ]);

      prismaMock.staff.findMany.mockResolvedValue([
        {
          id: 'staff_1',
          candidate: {
            hubstaff_id: '123',
          },
          salary: '4000',
          hubspot_deployment_type: 'Full-Time',
          status: 'active',
        },
      ]);

      await (worker as any).generateInvoiceRecord(org, payload);

      const calls = prismaMock.invoiceLineItem.create.mock.calls;
      const primaryLineCall = calls.find(
        (c: any) => c[0].data.type === 'primary',
      );
      expect(primaryLineCall).toBeDefined();

      const serviceAmount = primaryLineCall[0].data.service_amount;
      // June 1 to June 20 contains 15 workdays.
      // hours = 15 * 8 = 120.
      // expected total = 120 * 23.076923076923077 = 2769.230769230769
      const expected = new Decimal(120).mul(new Decimal(4000 / 176));
      expect(serviceAmount.toNumber()).toBeCloseTo(expected.toNumber(), 2);
    });

    it('falls back to the position/business-unit floor price — not a hardcoded $12 — when staff has no salary and candidate has no hourly_pay_rate', async () => {
      const payload = {
        organization_id: 'org_id',
        billing_start_date: '2026-06-01',
        billing_end_date: '2026-06-30',
        is_prebill: true,
        created_by: 'user_1',
      };

      hubstaffMock.getProjectMembers.mockResolvedValue([
        { user_id: 123, name: 'Jane Doe' },
      ]);

      prismaMock.staff.findMany.mockResolvedValue([
        {
          id: 'staff_1',
          candidate: {
            hubstaff_id: '123',
            hourly_pay_rate: null,
            approved_positions_pairing: ['Medical VA'],
            languages: [],
            employment_type: null,
            business_unit: 'medvirtual',
          },
          salary: null,
          hubspot_deployment_type: 'Full-Time',
          status: 'active',
        },
      ]);

      positionRateConfigMock.findAllUnpaginated.mockResolvedValue([
        {
          position: 'Medical VA',
          medical_floor_price_english: 18,
          non_medical_floor_price_english: 18,
          medical_floor_price_bilingual: 20,
          non_medical_floor_price_bilingual: 20,
          medical_margin_per_hour: 2,
          non_medical_margin_per_hour: 2,
        },
      ]);

      await (worker as any).generateInvoiceRecord(org, payload);

      const calls = prismaMock.invoiceLineItem.create.mock.calls;
      const primaryLineCall = calls.find(
        (c: any) => c[0].data.type === 'primary',
      );
      expect(primaryLineCall).toBeDefined();

      // floor (18) + margin (2) = $20/hr — not the old hardcoded $12/hr fallback.
      expect(primaryLineCall[0].data.hourly_rate.toNumber()).toBe(20);
      expect(primaryLineCall[0].data.hourly_rate.toNumber()).not.toBe(12);
    });

    it('creates an invoice_created audit log entry when generating an invoice', async () => {
      const payload = {
        organization_id: 'org_id',
        billing_start_date: '2026-06-16',
        billing_end_date: '2026-06-30',
        is_prebill: true,
        created_by: 'user_123',
      };

      await (worker as any).generateInvoiceRecord(org, payload);

      expect(prismaMock.invoiceAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          invoice_id: 'invoice_id',
          invoice_version_id: 'version_id',
          actor_id: 'user_123',
          event: 'invoice_created',
          new_value: expect.objectContaining({
            status: 'draft',
            is_custom: false,
          }),
        }),
      });
    });

    it('creates an invoice_created audit log entry for custom invoices', async () => {
      const payload = {
        organization_id: 'org_id',
        billing_start_date: '2026-06-16',
        billing_end_date: '2026-06-30',
        isCustom: true,
        created_by: 'user_456',
      };

      await (worker as any).generateInvoiceRecord(org, payload);

      expect(prismaMock.invoiceAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          invoice_id: 'invoice_id',
          invoice_version_id: 'version_id',
          actor_id: 'user_456',
          event: 'invoice_created',
          new_value: expect.objectContaining({
            status: 'draft',
            is_custom: true,
          }),
        }),
      });
    });
  });

  describe('pre-bill: flat baseline only', () => {
    const org = {
      id: 'org_id',
      invoiceConfiguration: {
        hubstaff_id: 'hubstaff_project_id',
        billing_currency: 'USD',
      },
    };

    const activeStaff = (hubstaffId: string) => ({
      id: `staff_${hubstaffId}`,
      candidate: { hubstaff_id: hubstaffId, hourly_pay_rate: '20' },
      salary: null,
      hubspot_deployment_type: 'Full-Time',
      status: 'active',
      tickets: [],
    });

    const primaryLines = () =>
      prismaMock.invoiceLineItem.create.mock.calls
        .map((c: any) => c[0].data)
        .filter((d: any) => d.type === 'primary');

    const categories = () =>
      prismaMock.invoiceLineItem.create.mock.calls.map(
        (c: any) => c[0].data.category,
      );

    it('ignores approved PTO — no PTO hours and no phantom overtime', async () => {
      // The regression behind Irene Mae Sombilon's invoice: pre-bill already assumes
      // the VA worked every weekday, so adding approved PTO on top counted Sep 17
      // twice (8h assumed + 8h PTO) and pushed payable hours past the overtime
      // threshold, inventing 8hrs of overtime nobody worked.
      hubstaffMock.getProjectMembers.mockResolvedValue([
        { user_id: 123, name: 'Irene' },
      ]);
      prismaMock.staff.findMany.mockResolvedValue([activeStaff('123')]);
      hubstaffMock.getTimeOffRequests.mockResolvedValue([
        {
          user_id: 123,
          status: 'approved',
          time_off_request_days: [
            { date: '2026-09-17', amount_used: 8 * 3600 },
          ],
        },
      ]);

      await (worker as any).generateInvoiceRecord(org, {
        organization_id: 'org_id',
        billing_start_date: '2026-09-16',
        billing_end_date: '2026-09-30',
        is_prebill: true,
        created_by: 'user_1',
      });

      // Sep 16–30 2026 = 11 workdays × 8h = 88h flat, PTO disregarded.
      const [primary] = primaryLines();
      expect(primary.effective_worked_hours.toNumber()).toBe(88);
      expect(primary.total_pto_hours.toNumber()).toBe(0);
      expect(categories()).not.toContain('overtime');
    });

    it('ignores holidays — no holiday hours and no holiday-overtime line', async () => {
      // September 2026 contains Labor Day (Sep 7); pre-bill must still bill a flat
      // 22 workdays × 8h and leave holiday treatment to the reconciliation.
      hubstaffMock.getProjectMembers.mockResolvedValue([
        { user_id: 123, name: 'Irene' },
      ]);
      prismaMock.staff.findMany.mockResolvedValue([activeStaff('123')]);

      await (worker as any).generateInvoiceRecord(org, {
        organization_id: 'org_id',
        billing_start_date: '2026-09-01',
        billing_end_date: '2026-09-30',
        is_prebill: true,
        created_by: 'user_1',
      });

      const [primary] = primaryLines();
      expect(primary.effective_worked_hours.toNumber()).toBe(176);
      expect(primary.total_holiday_hours.toNumber()).toBe(0);
      expect(categories()).not.toContain('holiday');
      expect(categories()).not.toContain('overtime');
    });

    it('excludes a project member with no staff record for this org', async () => {
      // Precious Honelette Magnaye's case: still on the client's Hubstaff project but
      // assigned to a different organization in our database, so she was billed 88
      // baseline hours at a $0 rate. She should not appear at all.
      hubstaffMock.getProjectMembers.mockResolvedValue([
        { user_id: 123, name: 'Irene' },
        { user_id: 999, name: 'Precious' },
      ]);
      prismaMock.staff.findMany.mockResolvedValue([activeStaff('123')]);

      await (worker as any).generateInvoiceRecord(org, {
        organization_id: 'org_id',
        billing_start_date: '2026-09-16',
        billing_end_date: '2026-09-30',
        is_prebill: true,
        created_by: 'user_1',
      });

      const lines = primaryLines();
      expect(lines).toHaveLength(1);
      expect(lines[0].worker_id).toBe('123');
    });

    it('excludes a project member whose staff record is not active', async () => {
      hubstaffMock.getProjectMembers.mockResolvedValue([
        { user_id: 123, name: 'Irene' },
        { user_id: 456, name: 'Terminated VA' },
      ]);
      prismaMock.staff.findMany.mockResolvedValue([
        activeStaff('123'),
        { ...activeStaff('456'), status: 'terminated' },
      ]);

      await (worker as any).generateInvoiceRecord(org, {
        organization_id: 'org_id',
        billing_start_date: '2026-09-16',
        billing_end_date: '2026-09-30',
        is_prebill: true,
        created_by: 'user_1',
      });

      const lines = primaryLines();
      expect(lines).toHaveLength(1);
      expect(lines[0].worker_id).toBe('123');
    });
  });

  describe('post-bill: billed from who logged time', () => {
    const org = {
      id: 'org_id',
      invoiceConfiguration: {
        hubstaff_id: 'hubstaff_project_id',
        billing_currency: 'USD',
      },
    };

    it('bills someone who logged time but is no longer a project member, at their real rate', async () => {
      // Project membership is empty — the worker left the project mid-cycle — but they
      // tracked time in the window, so they must still be billed AND priced (their
      // staff record has to be looked up by activity, not by membership).
      hubstaffMock.getProjectMembers.mockResolvedValue([]);
      hubstaffMock.getHubstaffDailyActivityForInvoice.mockResolvedValue([
        {
          user_id: 777,
          user_name: 'Departed VA',
          day: '2026-09-16',
          total_time_logged: 8 * 3600,
          overall: 8 * 3600,
        },
      ]);
      prismaMock.staff.findMany.mockResolvedValue([
        {
          id: 'staff_777',
          candidate: { hubstaff_id: '777', hourly_pay_rate: '20' },
          salary: null,
          hubspot_deployment_type: 'Full-Time',
          status: 'active',
          tickets: [],
        },
      ]);

      await (worker as any).generateInvoiceRecord(org, {
        organization_id: 'org_id',
        billing_start_date: '2026-09-16',
        billing_end_date: '2026-09-30',
        created_by: 'user_1',
      });

      const primary = prismaMock.invoiceLineItem.create.mock.calls
        .map((c: any) => c[0].data)
        .find((d: any) => d.type === 'primary');

      expect(primary).toBeDefined();
      expect(primary.worker_id).toBe('777');
      expect(primary.worker_name_snapshot).toBe('Departed VA');
      // Priced at their real $20/hr rather than the $0 fallback.
      expect(primary.hourly_rate.toNumber()).toBe(20);
      expect(primary.service_amount.toNumber()).toBe(8 * 20);
    });

    it('does not bill a project member who logged no time', async () => {
      hubstaffMock.getProjectMembers.mockResolvedValue([
        { user_id: 123, name: 'Idle VA' },
      ]);
      hubstaffMock.getHubstaffDailyActivityForInvoice.mockResolvedValue([]);
      prismaMock.staff.findMany.mockResolvedValue([
        {
          id: 'staff_123',
          candidate: { hubstaff_id: '123', hourly_pay_rate: '20' },
          salary: null,
          hubspot_deployment_type: 'Full-Time',
          status: 'active',
          tickets: [],
        },
      ]);

      await (worker as any).generateInvoiceRecord(org, {
        organization_id: 'org_id',
        billing_start_date: '2026-09-16',
        billing_end_date: '2026-09-30',
        created_by: 'user_1',
      });

      const primaries = prismaMock.invoiceLineItem.create.mock.calls
        .map((c: any) => c[0].data)
        .filter((d: any) => d.type === 'primary');
      expect(primaries).toHaveLength(0);
    });
  });

  describe('overtime pricing', () => {
    const org = {
      id: 'org_id',
      invoiceConfiguration: {
        hubstaff_id: 'hubstaff_project_id',
        billing_currency: 'USD',
      },
    };

    const USER_ID = 123;
    // Hourly worker (no salary on file) so the bill rate both overtime formulas
    // multiply is unambiguously $20/hr, independent of salary proration.
    const BILL_RATE = 20;

    /** One Hubstaff daily-activity row per weekday in the period, all the same length. */
    const weekdayActivities = (
      start: string,
      end: string,
      hoursPerDay: number,
    ) => {
      const acts: any[] = [];
      let day = DateTime.fromISO(start, { zone: 'utc' });
      const last = DateTime.fromISO(end, { zone: 'utc' });
      while (day <= last) {
        if (day.weekday <= 5) {
          acts.push({
            user_id: USER_ID,
            user_name: 'John Doe',
            day: day.toFormat('yyyy-MM-dd'),
            total_time_logged: hoursPerDay * 3600,
            overall: hoursPerDay * 3600,
          });
        }
        day = day.plus({ days: 1 });
      }
      return acts;
    };

    const lineOfCategory = (category: string) =>
      prismaMock.invoiceLineItem.create.mock.calls.find(
        (c: any) => c[0].data.category === category,
      )?.[0].data;

    beforeEach(() => {
      hubstaffMock.getProjectMembers.mockResolvedValue([
        { user_id: USER_ID, name: 'John Doe' },
      ]);
      prismaMock.staff.findMany.mockResolvedValue([
        {
          id: 'staff_1',
          candidate: {
            hubstaff_id: String(USER_ID),
            hourly_pay_rate: String(BILL_RATE),
          },
          salary: null,
          hubspot_deployment_type: 'Full-Time',
          status: 'active',
          tickets: [],
        },
      ]);
    });

    it('bills regular overtime at 1.5x the bill rate', async () => {
      // June 2026 has 22 workdays and no observed holiday, so a full-time VA's
      // baseline is 22 * 8 = 176hrs. Working 9hrs every weekday gives 198 payable
      // hours — 22 of them overtime.
      hubstaffMock.getHubstaffDailyActivityForInvoice.mockResolvedValue(
        weekdayActivities('2026-06-01', '2026-06-30', 9),
      );

      await (worker as any).generateInvoiceRecord(org, {
        organization_id: 'org_id',
        billing_start_date: '2026-06-01',
        billing_end_date: '2026-06-30',
        created_by: 'user_1',
      });

      const primary = lineOfCategory('hourly_service');
      expect(primary.effective_worked_hours.toNumber()).toBe(176);
      expect(primary.service_amount.toNumber()).toBeCloseTo(176 * BILL_RATE, 2);

      const overtime = lineOfCategory('overtime');
      expect(overtime).toBeDefined();
      expect(overtime.effective_worked_hours.toNumber()).toBeCloseTo(22, 2);
      expect(overtime.hourly_rate.toNumber()).toBeCloseTo(BILL_RATE * 1.5, 2);
      expect(overtime.final_total.toNumber()).toBeCloseTo(
        22 * BILL_RATE * 1.5,
        2,
      );
    });

    it('bills holiday work at an additional 0.5x on its own line, without triggering regular overtime', async () => {
      // September 2026 also has 22 workdays, one of which (Sep 7) is Labor Day.
      // Working the standard 8hrs every weekday means no regular overtime at all —
      // the holiday premium must not inflate payable hours past the baseline.
      hubstaffMock.getHubstaffDailyActivityForInvoice.mockResolvedValue(
        weekdayActivities('2026-09-01', '2026-09-30', 8),
      );

      await (worker as any).generateInvoiceRecord(org, {
        organization_id: 'org_id',
        billing_start_date: '2026-09-01',
        billing_end_date: '2026-09-30',
        created_by: 'user_1',
      });

      const primary = lineOfCategory('hourly_service');
      expect(primary.effective_worked_hours.toNumber()).toBe(176);
      // The holiday itself is still billed at the standard 8hr baseline on the primary.
      expect(primary.total_holiday_hours.toNumber()).toBe(8);

      expect(lineOfCategory('overtime')).toBeUndefined();

      const holiday = lineOfCategory('holiday');
      expect(holiday).toBeDefined();
      expect(holiday.effective_worked_hours.toNumber()).toBe(8);
      expect(holiday.hourly_rate.toNumber()).toBeCloseTo(BILL_RATE * 0.5, 2);
      expect(holiday.final_total.toNumber()).toBeCloseTo(
        8 * BILL_RATE * 0.5,
        2,
      );
    });

    it('applies the holiday and regular overtime multipliers independently in the same period', async () => {
      // 10hrs every weekday in September 2026, including 10hrs on Labor Day:
      //   payable = 220 worked - 10 holiday-worked + 8 holiday baseline = 218
      //   regular overtime = 218 - 176 = 42hrs at 1.5x
      //   holiday overtime = the 10hrs worked on Sep 7, at an additional 0.5x
      hubstaffMock.getHubstaffDailyActivityForInvoice.mockResolvedValue(
        weekdayActivities('2026-09-01', '2026-09-30', 10),
      );

      await (worker as any).generateInvoiceRecord(org, {
        organization_id: 'org_id',
        billing_start_date: '2026-09-01',
        billing_end_date: '2026-09-30',
        created_by: 'user_1',
      });

      const overtime = lineOfCategory('overtime');
      expect(overtime.effective_worked_hours.toNumber()).toBeCloseTo(42, 2);
      expect(overtime.final_total.toNumber()).toBeCloseTo(
        42 * BILL_RATE * 1.5,
        2,
      );

      const holiday = lineOfCategory('holiday');
      expect(holiday.effective_worked_hours.toNumber()).toBe(10);
      expect(holiday.final_total.toNumber()).toBeCloseTo(
        10 * BILL_RATE * 0.5,
        2,
      );
    });

    it('charges the holiday premium even for a salaried worker billed a flat monthly amount', async () => {
      // A full-month salaried VA's primary line is the flat salary regardless of
      // hours, so the 50% holiday premium is only actually charged because it lives
      // on its own line priced off the hourly-equivalent bill rate.
      prismaMock.staff.findMany.mockResolvedValue([
        {
          id: 'staff_1',
          candidate: { hubstaff_id: String(USER_ID) },
          salary: '4000',
          hubspot_deployment_type: 'Full-Time',
          status: 'active',
          tickets: [],
        },
      ]);
      hubstaffMock.getHubstaffDailyActivityForInvoice.mockResolvedValue(
        weekdayActivities('2026-09-01', '2026-09-30', 8),
      );

      await (worker as any).generateInvoiceRecord(org, {
        organization_id: 'org_id',
        billing_start_date: '2026-09-01',
        billing_end_date: '2026-09-30',
        created_by: 'user_1',
      });

      const salariedBillRate = 4000 / 176;

      expect(lineOfCategory('hourly_service').service_amount.toNumber()).toBe(
        4000,
      );

      const holiday = lineOfCategory('holiday');
      expect(holiday).toBeDefined();
      expect(holiday.hourly_rate.toNumber()).toBeCloseTo(
        salariedBillRate * 0.5,
        2,
      );
      expect(holiday.final_total.toNumber()).toBeCloseTo(
        8 * salariedBillRate * 0.5,
        2,
      );
    });
  });
});
