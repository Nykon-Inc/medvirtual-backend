import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { HandlerComissionCreation } from './comissionCreation';
import { PrismaService } from '../../prisma/prisma.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPrisma = {
  hubspotInvoiceSnapshot: { findUnique: jest.fn() },
  affiliateCommission: { upsert: jest.fn() },
  staff: { update: jest.fn() },
};

describe('HandlerComissionCreation', () => {
  let handler: HandlerComissionCreation;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HandlerComissionCreation,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    handler = module.get<HandlerComissionCreation>(HandlerComissionCreation);
  });

  afterEach(() => jest.clearAllMocks());

  const baseEvent = { objectId: 588407860315 };

  const buildInvoice = (
    lineItems: any[],
    dueDate = new Date('2026-09-17'),
  ) => ({
    id: 'inv-1',
    hubspot_id: '588407860315',
    invoice_amount: 3600,
    paid_at: new Date('2026-09-17'),
    due_date: dueDate,
    lineItems,
    organization: {
      id: 'org-1',
      med_alliance_referral_status: 'eligible',
      eligibility_start_at: new Date('2025-01-01'),
      referredByAffiliate: {
        id: 'affiliate-1',
        first_name: 'A',
        last_name: 'B',
        affiliateProfile: {
          id: 'profile-1',
          full_name: 'A B',
          commission_percent_default: 7,
          status: 'active',
        },
      },
    },
  });

  const lineItem = (
    id: string,
    amount: number,
    staffId: string,
    commissionStartDate: Date | null = new Date('2026-01-01'),
  ) => ({
    id,
    amount,
    staff_id: staffId,
    staff: {
      id: staffId,
      hubspot_id: `deal-${staffId}`,
      hubspot_commission_start_date: commissionStartDate,
    },
  });

  it('does not let one line item upsert failure block the other line items on the same invoice', async () => {
    const li1 = lineItem('li-1', 1500, 'staff-1');
    const li2 = lineItem('li-2', 2100, 'staff-2');
    mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
      buildInvoice([li1, li2]),
    );
    mockPrisma.affiliateCommission.upsert
      .mockResolvedValueOnce({ id: 'commission-1' })
      .mockRejectedValueOnce(
        new Error(
          'Unique constraint failed on the fields: (`hubspot_invoice_snapshot_id`)',
        ),
      );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handler.execute(baseEvent)).resolves.toBe(true);

    expect(mockPrisma.affiliateCommission.upsert).toHaveBeenCalledTimes(2);
    expect(mockPrisma.affiliateCommission.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({
          hubspot_line_item_snapshot_id: 'li-1',
          base_amount_snapshot: 1500,
        }),
      }),
    );
    expect(mockPrisma.affiliateCommission.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        create: expect.objectContaining({
          hubspot_line_item_snapshot_id: 'li-2',
          base_amount_snapshot: 2100,
        }),
      }),
    );
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          'Error creating commission for line item li-2',
        ),
      ),
    ).toBe(true);

    errorSpy.mockRestore();
  });

  it('creates a commission for every eligible line item when all upserts succeed', async () => {
    const li1 = lineItem('li-1', 1500, 'staff-1');
    const li2 = lineItem('li-2', 2100, 'staff-2');
    mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
      buildInvoice([li1, li2]),
    );
    mockPrisma.affiliateCommission.upsert.mockResolvedValue({
      id: 'commission-x',
    });

    await expect(handler.execute(baseEvent)).resolves.toBe(true);

    expect(mockPrisma.affiliateCommission.upsert).toHaveBeenCalledTimes(2);
  });

  it('anchors the 365-day window on the invoice due_date, not on processing time', async () => {
    // staff started 2026-01-01; due_date is only ~30 days later — still eligible,
    // even though "now" (system clock at test run) may be much later than that.
    const li = lineItem('li-1', 1500, 'staff-1');
    mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
      buildInvoice([li], new Date('2026-01-31')),
    );
    mockPrisma.affiliateCommission.upsert.mockResolvedValue({
      id: 'commission-1',
    });

    await expect(handler.execute(baseEvent)).resolves.toBe(true);

    expect(mockPrisma.affiliateCommission.upsert).toHaveBeenCalledTimes(1);
  });

  it('skips a line item whose staff window had already expired by the invoice due_date', async () => {
    // staff started 2026-01-01; due_date is 400 days later — expired by due_date,
    // regardless of whether the real system clock is still within 365 days.
    const li = lineItem('li-1', 1500, 'staff-1');
    mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
      buildInvoice([li], new Date('2027-02-05')),
    );

    await expect(handler.execute(baseEvent)).resolves.toBe(true);

    expect(mockPrisma.affiliateCommission.upsert).not.toHaveBeenCalled();
  });

  it('live-fetches hubspot_commission_start_date from HubSpot when not yet synced locally', async () => {
    const li = lineItem('li-1', 1500, 'staff-1', null);
    mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
      buildInvoice([li], new Date('2026-01-31')),
    );
    mockedAxios.get.mockResolvedValueOnce({
      data: { properties: { alliance_commission_start_date: '1764558000000' } }, // 2025-12-01
    });
    mockPrisma.staff.update.mockResolvedValue({});
    mockPrisma.affiliateCommission.upsert.mockResolvedValue({
      id: 'commission-1',
    });

    await expect(handler.execute(baseEvent)).resolves.toBe(true);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.hubapi.com/crm/v3/objects/deals/deal-staff-1?properties=alliance_commission_start_date',
      expect.any(Object),
    );
    expect(mockPrisma.staff.update).toHaveBeenCalledWith({
      where: { id: 'staff-1' },
      data: { hubspot_commission_start_date: new Date(1764558000000) },
    });
    expect(mockPrisma.affiliateCommission.upsert).toHaveBeenCalledTimes(1);
  });

  it('skips a line item as staff_not_deployed when hubspot_commission_start_date is null both locally and in HubSpot', async () => {
    const li = lineItem('li-1', 1500, 'staff-1', null);
    mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(
      buildInvoice([li]),
    );
    mockedAxios.get.mockResolvedValueOnce({ data: { properties: {} } });

    await expect(handler.execute(baseEvent)).resolves.toBe(true);

    expect(mockPrisma.affiliateCommission.upsert).not.toHaveBeenCalled();
  });
});
