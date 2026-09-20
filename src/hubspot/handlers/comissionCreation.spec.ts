import { Test, TestingModule } from '@nestjs/testing';
import { HandlerComissionCreation } from './comissionCreation';
import { PrismaService } from '../../prisma/prisma.service';

const mockPrisma = {
  hubspotInvoiceSnapshot: { findUnique: jest.fn() },
  affiliateCommission: { upsert: jest.fn() },
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

  const buildInvoice = (lineItems: any[]) => ({
    id: 'inv-1',
    hubspot_id: '588407860315',
    invoice_amount: 3600,
    paid_at: new Date('2026-09-17'),
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

  const lineItem = (id: string, amount: number, staffId: string) => ({
    id,
    amount,
    staff_id: staffId,
    staff: { id: staffId, start_date: new Date('2026-01-01') },
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
});
