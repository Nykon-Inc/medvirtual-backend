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
        { provide: PositionRateConfigService, useValue: positionRateConfigMock },
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
        },
      ]);

      await (worker as any).generateInvoiceRecord(org, payload);

      // Verify what was passed to invoiceLineItem.create
      expect(prismaMock.invoiceLineItem.create).toHaveBeenCalled();
      const calls = prismaMock.invoiceLineItem.create.mock.calls;
      const primaryLineCall = calls.find((c: any) => c[0].data.type === 'primary');
      expect(primaryLineCall).toBeDefined();

      const serviceAmount = primaryLineCall[0].data.service_amount;
      // 4 days (June 16 to 19) are weekdays: 16 (Tue), 17 (Wed), 18 (Thu), 19 (Fri). All 4 are workdays.
      // With prebill = true, hours = 4 * 8 = 32 hours.
      // prorationRate = (4000 * 12) / 52 / 40 = 23.076923076923077
      // expected total = 32 * 23.076923076923077 = 738.4615384615385
      const expected = new Decimal(32).mul(new Decimal((4000 * 12) / 52 / 40));
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
        },
      ]);

      await (worker as any).generateInvoiceRecord(org, payload);

      const calls = prismaMock.invoiceLineItem.create.mock.calls;
      const primaryLineCall = calls.find((c: any) => c[0].data.type === 'primary');
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
        },
      ]);

      await (worker as any).generateInvoiceRecord(org, payload);

      const calls = prismaMock.invoiceLineItem.create.mock.calls;
      const primaryLineCall = calls.find((c: any) => c[0].data.type === 'primary');
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
        },
      ]);

      await (worker as any).generateInvoiceRecord(org, payload);

      const calls = prismaMock.invoiceLineItem.create.mock.calls;
      const primaryLineCall = calls.find((c: any) => c[0].data.type === 'primary');
      expect(primaryLineCall).toBeDefined();

      const serviceAmount = primaryLineCall[0].data.service_amount;
      // June 1 to June 20 contains 15 workdays.
      // hours = 15 * 8 = 120.
      // expected total = 120 * 23.076923076923077 = 2769.230769230769
      const expected = new Decimal(120).mul(new Decimal((4000 * 12) / 52 / 40));
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
      const primaryLineCall = calls.find((c: any) => c[0].data.type === 'primary');
      expect(primaryLineCall).toBeDefined();

      // floor (18) + margin (2) = $20/hr — not the old hardcoded $12/hr fallback.
      expect(primaryLineCall[0].data.hourly_rate.toNumber()).toBe(20);
      expect(primaryLineCall[0].data.hourly_rate.toNumber()).not.toBe(12);
    });
  });
});
