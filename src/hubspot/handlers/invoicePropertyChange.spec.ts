import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { HandlerInvoicePropertyChange } from './invoicePropertyChange';
import { PrismaService } from '../../prisma/prisma.service';
import { HandlerInvoiceCreation } from './invoiceCreation';
import { HandlerComissionCreation } from './comissionCreation';
import { StaffMatchingService } from '../../med-alliance/sync/staff-matching.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPrisma = {
  hubspotInvoiceSnapshot: { findUnique: jest.fn(), update: jest.fn() },
  organization: { findUnique: jest.fn(), updateMany: jest.fn() },
  medAllianceAuditLog: { create: jest.fn() },
  $transaction: jest.fn(),
};

const mockInvoiceCreation = { execute: jest.fn() };
const mockComissionCreation = { execute: jest.fn() };
const mockStaffMatching = { run: jest.fn() };

describe('HandlerInvoicePropertyChange', () => {
  let handler: HandlerInvoicePropertyChange;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HandlerInvoicePropertyChange,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: HandlerInvoiceCreation, useValue: mockInvoiceCreation },
        { provide: HandlerComissionCreation, useValue: mockComissionCreation },
        { provide: StaffMatchingService, useValue: mockStaffMatching },
      ],
    }).compile();

    handler = module.get<HandlerInvoicePropertyChange>(
      HandlerInvoicePropertyChange,
    );
  });

  afterEach(() => jest.clearAllMocks());

  const baseEvent = {
    objectId: 588408164423,
    propertyName: 'hs_invoice_status',
    propertyValue: 'paid',
  };

  const mockPdfFetch = () => {
    mockedAxios.get.mockResolvedValue({ data: { properties: {} } });
  };

  it('runs StaffMatchingService before comissionCreation when the organization is resolved', async () => {
    const callOrder: string[] = [];
    mockStaffMatching.run.mockImplementation(() => {
      callOrder.push('staffMatching');
      return Promise.resolve();
    });
    mockComissionCreation.execute.mockImplementation(() => {
      callOrder.push('comissionCreation');
      return Promise.resolve();
    });

    mockPrisma.hubspotInvoiceSnapshot.findUnique
      .mockResolvedValueOnce({ id: 'inv-1' }) // initial existence check
      .mockResolvedValueOnce({
        paid_at: new Date('2026-01-01'),
        organization: { id: 'org-1' },
      }); // invoiceWithOrg lookup
    mockPrisma.hubspotInvoiceSnapshot.update.mockResolvedValue({});
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      referred_by_affiliate_id: null, // no referred affiliate -> deployed transition skipped, unrelated to staff matching
      med_alliance_referral_status: null,
      med_alliance_block_reason: null,
      first_paid_invoice_at: new Date('2025-01-01'),
      referral_stage: 'deployed',
    });
    mockPdfFetch();

    await handler.execute(baseEvent);

    expect(mockStaffMatching.run).toHaveBeenCalledWith('org-1');
    expect(mockComissionCreation.execute).toHaveBeenCalledWith(baseEvent);
    expect(callOrder).toEqual(['staffMatching', 'comissionCreation']);
  });

  it('does not call StaffMatchingService when the invoice has no linked organization', async () => {
    mockPrisma.hubspotInvoiceSnapshot.findUnique
      .mockResolvedValueOnce({ id: 'inv-1' })
      .mockResolvedValueOnce({
        paid_at: new Date('2026-01-01'),
        organization: null,
      });
    mockPrisma.hubspotInvoiceSnapshot.update.mockResolvedValue({});
    mockPdfFetch();

    await handler.execute(baseEvent);

    expect(mockStaffMatching.run).not.toHaveBeenCalled();
    expect(mockComissionCreation.execute).toHaveBeenCalledWith(baseEvent);
  });

  it('does not emit the old unconditional "is the first paid invoice" log', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    mockPrisma.hubspotInvoiceSnapshot.findUnique
      .mockResolvedValueOnce({ id: 'inv-1' })
      .mockResolvedValueOnce({
        paid_at: new Date('2026-01-01'),
        organization: { id: 'org-1' },
      });
    mockPrisma.hubspotInvoiceSnapshot.update.mockResolvedValue({});
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      referred_by_affiliate_id: null,
      med_alliance_referral_status: null,
      med_alliance_block_reason: null,
      first_paid_invoice_at: new Date('2025-01-01'),
      referral_stage: 'deployed',
    });
    mockPdfFetch();

    await handler.execute(baseEvent);

    const loggedMessages = logSpy.mock.calls.map((call) => String(call[0]));
    expect(
      loggedMessages.some((msg) => msg.includes('is the first paid invoice')),
    ).toBe(false);
    expect(
      loggedMessages.some((msg) =>
        msg.includes('Checking deployed transition for organization org-1'),
      ),
    ).toBe(true);

    logSpy.mockRestore();
  });
});
