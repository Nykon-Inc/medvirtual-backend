import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InvoicePrebillReconciliationWorker } from './invoice-prebill-reconciliation.worker';
import { InvoiceWorker } from './invoice.worker';
import { PrismaService } from '../prisma/prisma.service';
import { HubstaffService } from '../hubstaff/hubstaff.service';
import { PusherService } from '../pusher/pusher.service';
import { StripeService } from '../stripe/stripe.service';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { InternalInvoiceSnapshotService } from '../med-alliance/sync/internal-invoice-snapshot.service';

describe('InvoicePrebillReconciliationWorker', () => {
  let reconciler: InvoicePrebillReconciliationWorker;
  let prismaMock: any;
  let hubstaffMock: any;

  const USER_ID = 123;
  // 3520 / 176 = $20/hr proration rate, so a half-month flat salary is $1760.
  const MONTHLY_SALARY = 3520;
  const PRORATION_RATE = MONTHLY_SALARY / 176;
  const HALF_MONTH_SALARY = MONTHLY_SALARY / 2;
  // Sep 16-30 2026 is 11 weekdays with no observed holiday: 11 * 8 = 88hrs expected.
  const WORKDAYS = [
    '2026-09-16',
    '2026-09-17',
    '2026-09-18',
    '2026-09-21',
    '2026-09-22',
    '2026-09-23',
    '2026-09-24',
    '2026-09-25',
    '2026-09-28',
    '2026-09-29',
    '2026-09-30',
  ];
  const REQUIRED_HOURS = WORKDAYS.length * 8;

  /** `total` hours spread 8hrs/day across as many workdays as it takes. */
  const activitiesTotalling = (total: number) => {
    const acts: any[] = [];
    let left = total;
    for (const day of WORKDAYS) {
      const hours = Math.min(8, left);
      left -= hours;
      if (hours > 0) {
        acts.push({
          user_id: USER_ID,
          user_name: 'John Doe',
          day,
          total_time_logged: hours * 3600,
          overall: hours * 3600,
        });
      }
    }
    return acts;
  };

  const computeHalfMonth = () =>
    (reconciler as any).computeActualLineItems({
      org: { id: 'org_id', hubspot_id: null },
      hubstaffId: '999',
      organizationId: 'org_id',
      billingStartDate: '2026-09-16',
      billingEndDate: '2026-09-30',
      prebilledWorkerIds: [String(USER_ID)],
    });

  beforeEach(async () => {
    prismaMock = {
      candidate: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { hubstaff_id: String(USER_ID), hubspot_vaid: null },
          ]),
      },
      staff: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'staff_1',
            candidate: {
              hubstaff_id: String(USER_ID),
              business_unit: null,
              languages: [],
            },
            salary: String(MONTHLY_SALARY),
            hubspot_deployment_type: 'Full-Time',
            status: 'active',
            organization_id: 'org_id',
            hubspot_organization_id: null,
          },
        ]),
      },
    };

    hubstaffMock = {
      getProjectMembers: jest
        .fn()
        .mockResolvedValue([{ user_id: USER_ID, name: 'John Doe' }]),
      getTimeOffRequests: jest.fn().mockResolvedValue([]),
      getHubstaffDailyActivityForInvoice: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicePrebillReconciliationWorker,
        InvoiceWorker,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HubstaffService, useValue: hubstaffMock },
        { provide: PusherService, useValue: {} },
        { provide: StripeService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: InternalInvoiceSnapshotService,
          useValue: { safeSync: jest.fn(), safeOnPaid: jest.fn() },
        },
        {
          provide: PositionRateConfigService,
          useValue: { findAllUnpaginated: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: BusinessUnitContext,
          useValue: { poolFor: jest.fn().mockResolvedValue('medical') },
        },
      ],
    }).compile();

    reconciler = module.get(InvoicePrebillReconciliationWorker);
  });

  describe('salaried flat-pay hour reporting', () => {
    it('reports the full expected hours when a small deficit still bills the flat salary', async () => {
      // 80 of 88hrs is inside the 10hr tolerance, so the actual cost is still the
      // whole half-month salary. primary_hours must match what the generator put on
      // the invoice (88), or process() posts a reconciliation delta for hours the
      // invoice was never short.
      hubstaffMock.getHubstaffDailyActivityForInvoice.mockResolvedValue(
        activitiesTotalling(80),
      );

      const [line] = await computeHalfMonth();

      expect(line.primary_total.toNumber()).toBeCloseTo(HALF_MONTH_SALARY, 2);
      expect(line.primary_hours).toBe(REQUIRED_HOURS);
      expect(line.hourly_rate.toNumber()).toBeCloseTo(PRORATION_RATE, 2);
    });

    it('prorates against hours actually worked once the deficit passes 10 hours', async () => {
      // 70 of 88 — a deficit of 18 — drops out of flat-salary billing, so the line
      // reports the 70hrs worked at the prorated rate.
      hubstaffMock.getHubstaffDailyActivityForInvoice.mockResolvedValue(
        activitiesTotalling(70),
      );

      const [line] = await computeHalfMonth();

      expect(line.primary_total.toNumber()).toBeCloseTo(70 * PRORATION_RATE, 2);
      expect(line.primary_hours).toBeCloseTo(70, 2);
      expect(line.hourly_rate.toNumber()).toBeCloseTo(PRORATION_RATE, 2);
    });
  });
});
