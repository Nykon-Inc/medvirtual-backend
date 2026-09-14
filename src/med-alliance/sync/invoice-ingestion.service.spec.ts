import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { InvoiceIngestionService } from './invoice-ingestion.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ReviewCasesService } from '../review-cases/review-cases.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockPrisma = {
  hubspotInvoiceSnapshot: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  hubspotLineItemSnapshot: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

const mockReviewCases = { openOrSkip: jest.fn() };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const makeAssociationsResponse = (ids: string[]) => ({
  data: { results: ids.map((id) => ({ id, type: 'company_to_invoice' })) },
});

const makeInvoiceResponse = (overrides: Partial<any> = {}) => ({
  data: {
    id: 'inv-1',
    properties: {
      hs_invoice_status: 'paid',
      hs_payment_status: 'succeeded',
      hs_amount_billed: '1500.00',
      hs_currency_code: 'USD',
      hs_due_date: '2026-02-10T00:00:00.000Z',
      ...overrides,
    },
  },
});

describe('InvoiceIngestionService', () => {
  let service: InvoiceIngestionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceIngestionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ReviewCasesService, useValue: mockReviewCases },
      ],
    }).compile();

    service = module.get<InvoiceIngestionService>(InvoiceIngestionService);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // run — no invoices
  // -------------------------------------------------------------------------
  it('should return zeros when HubSpot returns no associated invoices', async () => {
    mockedAxios.get.mockResolvedValueOnce(makeAssociationsResponse([]));

    const result = await service.run('org-1', 'hs-company-1');

    expect(result).toEqual({
      created: 0,
      updated: 0,
      skipped: 0,
      lineItems: { created: 0, updated: 0, skipped: 0 },
    });
    expect(mockPrisma.hubspotInvoiceSnapshot.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // run — create new snapshot
  // -------------------------------------------------------------------------
  describe('create', () => {
    it('should create a new snapshot when invoice does not exist in DB', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(makeInvoiceResponse());

      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({});

      const result = await service.run('org-1', 'hs-company-1');

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);

      expect(mockPrisma.hubspotInvoiceSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            hubspot_id: 'inv-1',
            organization_id: 'org-1',
            invoice_status: 'paid',
            invoice_amount: '1500.00',
            currency: 'USD',
          }),
        }),
      );
    });

    it('should store a non-null sync_hash on creation', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(makeInvoiceResponse());

      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({});

      await service.run('org-1', 'hs-company-1');

      const createCall =
        mockPrisma.hubspotInvoiceSnapshot.create.mock.calls[0][0];
      expect(createCall.data.sync_hash).toBeTruthy();
      expect(typeof createCall.data.sync_hash).toBe('string');
      expect(createCall.data.sync_hash).toHaveLength(64); // SHA-256 hex
    });

    it.skip('should parse paid_at from hs_due_date', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(
          makeInvoiceResponse({ hs_due_date: '2026-03-15T00:00:00.000Z' }),
        );

      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({});

      await service.run('org-1', 'hs-company-1');

      const createCall =
        mockPrisma.hubspotInvoiceSnapshot.create.mock.calls[0][0];
      expect(createCall.data.paid_at).toEqual(
        new Date('2026-03-15T00:00:00.000Z'),
      );
    });

    it('should set paid_at to null when hs_due_date is absent', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(makeInvoiceResponse({ hs_due_date: null }));

      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({});

      await service.run('org-1', 'hs-company-1');

      const createCall =
        mockPrisma.hubspotInvoiceSnapshot.create.mock.calls[0][0];
      expect(createCall.data.paid_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // run — skip unchanged snapshot
  // -------------------------------------------------------------------------
  describe('skip', () => {
    it('should skip snapshot when sync_hash has not changed', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(makeInvoiceResponse());

      // Pre-compute what the hash will be for this invoice, then mock the DB
      // to return a snapshot with that same hash — triggering skip.
      // We test this by running create first, capturing the hash, then re-running.
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({});

      const firstRun = await service.run('org-1', 'hs-company-1');
      expect(firstRun.created).toBe(1);

      // Capture the hash that was stored
      const storedHash =
        mockPrisma.hubspotInvoiceSnapshot.create.mock.calls[0][0].data
          .sync_hash;

      // Second run: same invoice, same data → DB returns existing snapshot with same hash
      jest.clearAllMocks();
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(makeInvoiceResponse());

      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue({
        id: 'snap-1',
        sync_hash: storedHash,
      });

      const secondRun = await service.run('org-1', 'hs-company-1');

      expect(secondRun.skipped).toBe(1);
      expect(secondRun.created).toBe(0);
      expect(secondRun.updated).toBe(0);
      expect(mockPrisma.hubspotInvoiceSnapshot.create).not.toHaveBeenCalled();
      expect(mockPrisma.hubspotInvoiceSnapshot.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // run — update changed snapshot
  // -------------------------------------------------------------------------
  describe('update', () => {
    it('should update snapshot when sync_hash has changed', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(
          makeInvoiceResponse({ hs_amount_billed: '2000.00' }),
        );

      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue({
        id: 'snap-1',
        sync_hash: 'old-hash-that-does-not-match',
      });
      mockPrisma.hubspotInvoiceSnapshot.update.mockResolvedValue({});

      const result = await service.run('org-1', 'hs-company-1');

      expect(result.updated).toBe(1);
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(0);

      expect(mockPrisma.hubspotInvoiceSnapshot.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'snap-1' },
          data: expect.objectContaining({
            invoice_amount: '2000.00',
          }),
        }),
      );
    });

    it('should update sync_hash on update', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(
          makeInvoiceResponse({ hs_amount_billed: '2000.00' }),
        );

      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue({
        id: 'snap-1',
        sync_hash: 'stale-hash',
      });
      mockPrisma.hubspotInvoiceSnapshot.update.mockResolvedValue({});

      await service.run('org-1', 'hs-company-1');

      const updateCall =
        mockPrisma.hubspotInvoiceSnapshot.update.mock.calls[0][0];
      expect(updateCall.data.sync_hash).toBeTruthy();
      expect(updateCall.data.sync_hash).not.toBe('stale-hash');
    });
  });

  // -------------------------------------------------------------------------
  // sync_hash determinism
  // -------------------------------------------------------------------------
  describe('sync_hash determinism', () => {
    it('should produce the same hash for identical invoice data', async () => {
      const runOnce = async () => {
        mockedAxios.get
          .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
          .mockResolvedValueOnce(makeInvoiceResponse());
        mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
        mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({});
        await service.run('org-1', 'hs-company-1');
        return mockPrisma.hubspotInvoiceSnapshot.create.mock.calls[0][0].data
          .sync_hash;
      };

      const hash1 = await runOnce();
      jest.clearAllMocks();
      const hash2 = await runOnce();

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes when invoice_status changes', async () => {
      // First run: paid
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(
          makeInvoiceResponse({ hs_invoice_status: 'paid' }),
        );
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({});
      await service.run('org-1', 'hs-company-1');
      const hashPaid =
        mockPrisma.hubspotInvoiceSnapshot.create.mock.calls[0][0].data
          .sync_hash;

      jest.clearAllMocks();

      // Second run: outstanding
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(
          makeInvoiceResponse({ hs_invoice_status: 'outstanding' }),
        );
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({});
      await service.run('org-1', 'hs-company-1');
      const hashOutstanding =
        mockPrisma.hubspotInvoiceSnapshot.create.mock.calls[0][0].data
          .sync_hash;

      expect(hashPaid).not.toBe(hashOutstanding);
    });
  });

  // -------------------------------------------------------------------------
  // multiple invoices + partial failure
  // -------------------------------------------------------------------------
  it('should process all invoices and continue on individual fetch failure', async () => {
    mockedAxios.get
      .mockResolvedValueOnce(
        makeAssociationsResponse(['inv-1', 'inv-2', 'inv-3']),
      )
      .mockResolvedValueOnce(makeInvoiceResponse()) // inv-1 OK
      .mockRejectedValueOnce(new Error('HubSpot 404')) // inv-2 fails
      .mockResolvedValueOnce(makeInvoiceResponse()); // inv-3 OK

    mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
    mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({});

    const result = await service.run('org-1', 'hs-company-1');

    // inv-1 and inv-3 created; inv-2 skipped due to error
    expect(result.created).toBe(2);
  });

  it('should use Bearer token from HUBSPOT_ACCESS_TOKEN env var', async () => {
    process.env.HUBSPOT_ACCESS_TOKEN = 'test-token-123';
    mockedAxios.get.mockResolvedValueOnce(makeAssociationsResponse([]));

    await service.run('org-1', 'hs-company-1');

    const [, config] = mockedAxios.get.mock.calls[0];
    expect((config as any).headers.Authorization).toBe('Bearer test-token-123');
  });

  // -------------------------------------------------------------------------
  // Line item ingestion (§2 — previously dead HubspotLineItemSnapshot model)
  // -------------------------------------------------------------------------
  describe('line items', () => {
    const makeInvoiceResponseWithLineItems = (lineItemIds: string[]) => ({
      data: {
        id: 'inv-1',
        properties: {
          hs_invoice_status: 'paid',
          hs_payment_status: 'succeeded',
          hs_amount_billed: '1500.00',
          hs_currency_code: 'USD',
          hs_due_date: '2026-02-10T00:00:00.000Z',
        },
        associations: {
          'line items': {
            results: lineItemIds.map((id) => ({ id })),
          },
        },
      },
    });

    const makeLineItemDetailResponse = (overrides: Partial<any> = {}) => ({
      data: {
        properties: {
          name: 'Rafael Delgado',
          amount: '500.00',
          description: null,
          quantity: '1',
          discount: null,
          ...overrides,
        },
      },
    });

    it('fetches and creates a new HubspotLineItemSnapshot for each line item associated with the invoice', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(makeInvoiceResponseWithLineItems(['li-1']))
        .mockResolvedValueOnce(makeLineItemDetailResponse());

      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({ id: 'snap-1' });
      mockPrisma.hubspotLineItemSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotLineItemSnapshot.create.mockResolvedValue({});

      const result = await service.run('org-1', 'hs-company-1');

      expect(result.lineItems.created).toBe(1);
      expect(mockPrisma.hubspotLineItemSnapshot.create).toHaveBeenCalledWith({
        data: {
          hubspot_id: 'li-1',
          invoice_id: 'snap-1',
          name: 'Rafael Delgado',
          description: null,
          quantity: '1',
          amount: '500.00',
          discount: null,
        },
      });
    });

    it('does not set staff_id/match_status on newly created line items — matching happens in a later step', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(makeInvoiceResponseWithLineItems(['li-1']))
        .mockResolvedValueOnce(makeLineItemDetailResponse());

      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({ id: 'snap-1' });
      mockPrisma.hubspotLineItemSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotLineItemSnapshot.create.mockResolvedValue({});

      await service.run('org-1', 'hs-company-1');

      const createCall = mockPrisma.hubspotLineItemSnapshot.create.mock.calls[0][0];
      expect(createCall.data.staff_id).toBeUndefined();
      expect(createCall.data.match_status).toBeUndefined();
    });

    it('updates an existing line item when its amount changed', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(makeInvoiceResponseWithLineItems(['li-1']))
        .mockResolvedValueOnce(makeLineItemDetailResponse({ amount: '750.00' }));

      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({ id: 'snap-1' });
      mockPrisma.hubspotLineItemSnapshot.findUnique.mockResolvedValue({
        id: 'li-db-1',
        name: 'Rafael Delgado',
        amount: { toString: () => '500.00' },
        description: null,
        quantity: '1',
        discount: null,
      });
      mockPrisma.hubspotLineItemSnapshot.update.mockResolvedValue({});

      const result = await service.run('org-1', 'hs-company-1');

      expect(result.lineItems.updated).toBe(1);
      expect(mockPrisma.hubspotLineItemSnapshot.update).toHaveBeenCalledWith({
        where: { id: 'li-db-1' },
        data: expect.objectContaining({ amount: '750.00' }),
      });
    });

    it('skips an existing line item when nothing changed', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(makeInvoiceResponseWithLineItems(['li-1']))
        .mockResolvedValueOnce(makeLineItemDetailResponse());

      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({ id: 'snap-1' });
      mockPrisma.hubspotLineItemSnapshot.findUnique.mockResolvedValue({
        id: 'li-db-1',
        name: 'Rafael Delgado',
        amount: { toString: () => '500.00' },
        description: null,
        quantity: '1',
        discount: null,
      });

      const result = await service.run('org-1', 'hs-company-1');

      expect(result.lineItems.skipped).toBe(1);
      expect(mockPrisma.hubspotLineItemSnapshot.update).not.toHaveBeenCalled();
    });

    it('still upserts line items even when the parent invoice itself was skipped (unchanged sync_hash)', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(makeInvoiceResponseWithLineItems(['li-1']))
        .mockResolvedValueOnce(makeLineItemDetailResponse());

      // Pre-run to capture the hash, matching the pattern used in the "skip" describe block above.
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValueOnce(null);
      mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValueOnce({ id: 'snap-1' });
      mockPrisma.hubspotLineItemSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotLineItemSnapshot.create.mockResolvedValue({});

      await service.run('org-1', 'hs-company-1');
      const storedHash = mockPrisma.hubspotInvoiceSnapshot.create.mock.calls[0][0].data.sync_hash;

      jest.clearAllMocks();
      mockedAxios.get
        .mockResolvedValueOnce(makeAssociationsResponse(['inv-1']))
        .mockResolvedValueOnce(makeInvoiceResponseWithLineItems(['li-1']))
        .mockResolvedValueOnce(makeLineItemDetailResponse());

      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue({
        id: 'snap-1',
        sync_hash: storedHash,
      });
      mockPrisma.hubspotLineItemSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.hubspotLineItemSnapshot.create.mockResolvedValue({});

      const result = await service.run('org-1', 'hs-company-1');

      expect(result.skipped).toBe(1); // invoice itself skipped
      expect(result.lineItems.created).toBe(1); // but its line item was still upserted
    });
  });
});
