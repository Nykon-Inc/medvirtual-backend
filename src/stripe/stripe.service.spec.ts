import { Test, TestingModule } from '@nestjs/testing';
import { StripeService } from './stripe.service';
import { ConfigService } from '@nestjs/config';
import { SecretsService } from '../secrets/secrets.service';
import { PrismaService } from '../prisma/prisma.service';
import { PusherService } from '../pusher/pusher.service';
import { InvoiceService } from '../invoice/invoice.service';
import { getQueueToken } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';

// Mock Stripe library
const mockWebhookEndpointsList = jest.fn();
const mockWebhookEndpointsDel = jest.fn();
const mockWebhookEndpointsCreate = jest.fn();
const mockConstructEvent = jest.fn();
const mockCouponsCreate = jest.fn();
const mockInvoiceItemsList = jest.fn();
const mockInvoiceItemsCreate = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => {
    return {
      webhookEndpoints: {
        list: mockWebhookEndpointsList,
        del: mockWebhookEndpointsDel,
        create: mockWebhookEndpointsCreate,
      },
      webhooks: {
        constructEvent: mockConstructEvent,
      },
      coupons: {
        create: mockCouponsCreate,
      },
      invoiceItems: {
        list: mockInvoiceItemsList,
        create: mockInvoiceItemsCreate,
      },
    };
  });
});

// Must stay in sync with REQUIRED_EVENTS in initiateWebhookHandler — an endpoint whose
// event list differs is treated as misconfigured and recreated.
const REQUIRED_EVENTS = [
  'customer.created',
  'invoice.paid',
  'invoice.overdue',
  'invoice.voided',
  'invoice.finalized',
  'payment_intent.succeeded',
  'invoice.payment_failed',
  'payment_method.attached',
  'checkout.session.completed',
];

describe('StripeService', () => {
  let service: StripeService;
  let redisMock: any;
  let prismaMock: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        if (key === 'APP_ENV') return 'local';
        if (key === 'QUEUES_ENABLED') return 'false';
        if (key === 'REDIS_KEY_PREFIX') return 'MEDVIRTUAL:LOCAL:';
        if (key === 'STRIPE_SECRET_KEY') return 'sk_test_mock';
        if (key === 'STRIPE_PUBLIC_KEY') return 'pk_test_mock';
        if (key === 'WEBHOOK_URL') return 'https://webhook.test';
        return defaultValue;
      }),
    };

    const mockSecretsService = {
      getSecret: jest.fn(),
    };

    redisMock = {
      get: jest.fn(),
      set: jest.fn(),
    };

    prismaMock = {
      webhookLog: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: SecretsService, useValue: mockSecretsService },
        { provide: 'REDIS_CLIENT', useValue: redisMock },
        { provide: PrismaService, useValue: prismaMock },
        { provide: PusherService, useValue: {} },
        { provide: getQueueToken('invoice'), useValue: {} },
        {
          provide: getQueueToken('invoice-prebill-reconciliation'),
          useValue: {},
        },
        { provide: InvoiceService, useValue: {} },
      ],
    }).compile();

    service = module.get<StripeService>(StripeService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getPublicKey', () => {
    it('should return public key', async () => {
      await (service as any).initializeStripe();
      expect(service.getPublicKey()).toBe('pk_test_mock');
    });
  });

  describe('Stripe webhook logging', () => {
    const customerCreatedEvent = {
      id: 'evt_customer_created',
      type: 'customer.created',
      api_version: '2026-08-27.basil',
      livemode: false,
      created: 1_788_800_000,
      data: {
        object: {
          id: 'cus_123',
          object: 'customer',
        },
      },
    } as any;

    it('records a verified Stripe event and marks a no-op event ignored', async () => {
      prismaMock.webhookLog.create.mockResolvedValue({
        id: 'log_1',
        status: 'received',
      });
      prismaMock.webhookLog.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.webhookLog.update.mockResolvedValue({});

      await (service as any).processVerifiedWebhook(customerCreatedEvent);

      expect(prismaMock.webhookLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            provider: 'stripe',
            provider_event_id: 'evt_customer_created',
            event_type: 'customer.created',
            provider_object_id: 'cus_123',
            provider_object_type: 'customer',
            payload: customerCreatedEvent,
          }),
        }),
      );
      expect(prismaMock.webhookLog.update).toHaveBeenLastCalledWith({
        where: { id: 'log_1' },
        data: expect.objectContaining({
          status: 'ignored',
          processed_at: expect.any(Date),
        }),
      });
    });

    it('does not dispatch a Stripe event that has already been processed', async () => {
      prismaMock.webhookLog.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      prismaMock.webhookLog.update.mockResolvedValue({
        id: 'log_1',
        status: 'processed',
      });
      prismaMock.webhookLog.updateMany.mockResolvedValue({ count: 0 });
      const dispatch = jest.spyOn(service, 'webhookHandler');

      await (service as any).processVerifiedWebhook(customerCreatedEvent);

      expect(prismaMock.webhookLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            delivery_count: { increment: 1 },
          }),
        }),
      );
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('marks the log failed and rethrows when event processing fails', async () => {
      const event = {
        ...customerCreatedEvent,
        id: 'evt_failed',
        type: 'invoice.paid',
        data: { object: { id: 'in_123', object: 'invoice' } },
      } as any;
      prismaMock.webhookLog.create.mockResolvedValue({
        id: 'log_failed',
        status: 'received',
      });
      prismaMock.webhookLog.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.webhookLog.update.mockResolvedValue({});
      jest
        .spyOn(service, 'webhookHandler')
        .mockRejectedValue(new Error('processing failed'));

      await expect(
        (service as any).processVerifiedWebhook(event),
      ).rejects.toThrow('processing failed');

      expect(prismaMock.webhookLog.update).toHaveBeenLastCalledWith({
        where: { id: 'log_failed' },
        data: {
          status: 'failed',
          error_message: 'processing failed',
          processing_started_at: null,
        },
      });
    });
  });

  describe('initiateWebhookHandler', () => {
    it('should skip setup if stripe not initialized', async () => {
      (service as any).stripe = null;
      const res = await service.initiateWebhookHandler();
      expect(res).toBeUndefined();
    });

    it('should create new webhook if none exists', async () => {
      await (service as any).initializeStripe();
      mockWebhookEndpointsList.mockResolvedValueOnce({ data: [] });
      mockWebhookEndpointsCreate.mockResolvedValueOnce({
        id: 'wh_123',
        secret: 'whsec_123',
      });

      await service.initiateWebhookHandler();

      expect(mockWebhookEndpointsCreate).toHaveBeenCalled();
      // Single colon: the prefix is normalised centrally now. This previously
      // asserted "MEDVIRTUAL:LOCAL::stripe_webhook_secret" — a base key ending
      // in ':' got another ':' appended at the call site.
      expect(redisMock.set).toHaveBeenCalledWith(
        'MEDVIRTUAL:LOCAL:stripe_webhook_secret',
        'whsec_123',
      );
      // The endpoint id must be cached too, otherwise the next boot can't tell
      // whether the cached secret belongs to the endpoint it finds.
      expect(redisMock.set).toHaveBeenCalledWith(
        'MEDVIRTUAL:LOCAL:stripe_webhook_endpoint_id',
        'wh_123',
      );
    });

    it('reuses an existing endpoint when the cached secret belongs to it', async () => {
      await (service as any).initializeStripe();
      mockWebhookEndpointsList.mockResolvedValueOnce({
        data: [
          {
            id: 'wh_existing',
            url: 'https://webhook.test/webhooks/stripe',
            status: 'enabled',
            enabled_events: REQUIRED_EVENTS,
            metadata: { server: 'local:MEDVIRTUAL:LOCAL' },
          },
        ],
      });
      redisMock.get.mockImplementation((key: string) =>
        key.endsWith('stripe_webhook_secret')
          ? Promise.resolve('whsec_existing')
          : Promise.resolve('wh_existing'),
      );

      await service.initiateWebhookHandler();

      expect(mockWebhookEndpointsDel).not.toHaveBeenCalled();
      expect(mockWebhookEndpointsCreate).not.toHaveBeenCalled();
    });

    it('PRIMARY REGRESSION: recreates the endpoint when the cached secret is from a different endpoint', async () => {
      // The staging failure mode: a cached secret was treated as proof of health
      // regardless of which endpoint it came from, so a stale secret made every
      // delivery fail signature verification while boot logged "correctly configured".
      await (service as any).initializeStripe();
      mockWebhookEndpointsList.mockResolvedValueOnce({
        data: [
          {
            id: 'wh_current',
            url: 'https://webhook.test/webhooks/stripe',
            status: 'enabled',
            enabled_events: REQUIRED_EVENTS,
            metadata: { server: 'local:MEDVIRTUAL:LOCAL' },
          },
        ],
      });
      redisMock.get.mockImplementation((key: string) =>
        key.endsWith('stripe_webhook_secret')
          ? Promise.resolve('whsec_stale')
          : Promise.resolve('wh_deleted_long_ago'),
      );
      mockWebhookEndpointsCreate.mockResolvedValueOnce({
        id: 'wh_fresh',
        secret: 'whsec_fresh',
      });

      await service.initiateWebhookHandler();

      expect(mockWebhookEndpointsDel).toHaveBeenCalledWith('wh_current');
      expect(redisMock.set).toHaveBeenCalledWith(
        'MEDVIRTUAL:LOCAL:stripe_webhook_secret',
        'whsec_fresh',
      );
    });

    it('PRIMARY REGRESSION: collapses duplicate endpoints sharing the target URL', async () => {
      // Endpoints created by hand in the dashboard (no metadata) or by an older
      // server label were invisible to the metadata-only cleanup and survived,
      // signing a share of deliveries with a secret we never hold.
      await (service as any).initializeStripe();
      mockWebhookEndpointsList.mockResolvedValueOnce({
        data: [
          {
            id: 'wh_managed',
            url: 'https://webhook.test/webhooks/stripe',
            status: 'enabled',
            enabled_events: REQUIRED_EVENTS,
            metadata: { server: 'local:MEDVIRTUAL:LOCAL' },
          },
          {
            id: 'wh_manual',
            url: 'https://webhook.test/webhooks/stripe',
            status: 'enabled',
            enabled_events: REQUIRED_EVENTS,
            metadata: {},
          },
        ],
      });
      redisMock.get.mockResolvedValue('whsec_cached');
      mockWebhookEndpointsCreate.mockResolvedValueOnce({
        id: 'wh_single',
        secret: 'whsec_single',
      });

      await service.initiateWebhookHandler();

      expect(mockWebhookEndpointsDel).toHaveBeenCalledWith('wh_managed');
      expect(mockWebhookEndpointsDel).toHaveBeenCalledWith('wh_manual');
      expect(mockWebhookEndpointsCreate).toHaveBeenCalledTimes(1);
    });

    it('follows pagination so an endpoint beyond the first page is not duplicated', async () => {
      await (service as any).initializeStripe();
      mockWebhookEndpointsList
        .mockResolvedValueOnce({
          data: [
            {
              id: 'wh_other',
              url: 'https://elsewhere.test/webhooks/stripe',
              metadata: {},
            },
          ],
          has_more: true,
        })
        .mockResolvedValueOnce({
          data: [
            {
              id: 'wh_page2',
              url: 'https://webhook.test/webhooks/stripe',
              status: 'enabled',
              enabled_events: REQUIRED_EVENTS,
              metadata: { server: 'local:MEDVIRTUAL:LOCAL' },
            },
          ],
          has_more: false,
        });
      redisMock.get.mockImplementation((key: string) =>
        key.endsWith('stripe_webhook_secret')
          ? Promise.resolve('whsec_page2')
          : Promise.resolve('wh_page2'),
      );

      await service.initiateWebhookHandler();

      expect(mockWebhookEndpointsList).toHaveBeenCalledTimes(2);
      expect(mockWebhookEndpointsList).toHaveBeenLastCalledWith({
        limit: 100,
        starting_after: 'wh_other',
      });
      expect(mockWebhookEndpointsCreate).not.toHaveBeenCalled();
    });
  });

  describe('buildDeterministicInvoiceItems', () => {
    const buildInvoice = (lineItems: any[]) => ({
      reference: 'INV-1',
      currentVersion: { line_items: lineItems },
    });

    it('sends the gross amount and a discountCents when the line has a discount', async () => {
      const invoice = buildInvoice([
        {
          id: 'line-1',
          final_total: 450,
          adjustment_amount: -50,
          description: 'Staff A',
        },
      ]);

      const result = await (service as any).buildDeterministicInvoiceItems(
        invoice,
      );

      expect(result).toEqual([
        {
          internalItemId: 'INV-1:line-1',
          amountCents: 50000,
          description: 'Staff A',
          type: 'LINE_ITEM',
          discountCents: 5000,
        },
      ]);
    });

    it('keeps the netted amount and omits discountCents for a surcharge', async () => {
      const invoice = buildInvoice([
        {
          id: 'line-1',
          final_total: 550,
          adjustment_amount: 50,
          description: 'Staff A',
        },
      ]);

      const result = await (service as any).buildDeterministicInvoiceItems(
        invoice,
      );

      expect(result).toEqual([
        {
          internalItemId: 'INV-1:line-1',
          amountCents: 55000,
          description: 'Staff A',
          type: 'LINE_ITEM',
        },
      ]);
    });

    it('keeps existing behavior unchanged when there is no adjustment', async () => {
      const invoice = buildInvoice([
        {
          id: 'line-1',
          final_total: 500,
          adjustment_amount: 0,
          description: 'Staff A',
        },
      ]);

      const result = await (service as any).buildDeterministicInvoiceItems(
        invoice,
      );

      expect(result).toEqual([
        {
          internalItemId: 'INV-1:line-1',
          amountCents: 50000,
          description: 'Staff A',
          type: 'LINE_ITEM',
        },
      ]);
    });

    it('skips a line whose gross amount rounds to zero', async () => {
      const invoice = buildInvoice([
        {
          id: 'line-1',
          final_total: 0,
          adjustment_amount: 0,
          description: 'Staff A',
        },
      ]);

      const result = await (service as any).buildDeterministicInvoiceItems(
        invoice,
      );

      expect(result).toEqual([]);
    });
  });

  describe('attachStripeInvoiceItems', () => {
    beforeEach(async () => {
      await (service as any).initializeStripe();
      (service as any).prisma = { invoice: { update: jest.fn() } };
      // safeStripeCall rate-limits through acquireToken(), which increments/expires
      // a per-second Redis bucket — stub it so calls pass straight through.
      redisMock.incr = jest.fn().mockResolvedValue(1);
      redisMock.expire = jest.fn().mockResolvedValue(1);
    });

    it('creates a coupon and attaches it as a discount for a discounted line item', async () => {
      const invoice = {
        id: 'invoice-1',
        reference: 'INV-1',
        stripe_invoice_id: 'in_123',
        currentVersion: {
          line_items: [
            {
              id: 'line-1',
              final_total: 450,
              adjustment_amount: -50,
              description: 'Staff A',
            },
          ],
        },
      };

      mockInvoiceItemsList.mockResolvedValueOnce({ data: [] });
      mockCouponsCreate.mockResolvedValueOnce({ id: 'coupon_abc' });
      mockInvoiceItemsCreate.mockResolvedValueOnce({ id: 'ii_1' });

      await service.attachStripeInvoiceItems(invoice, 'cus_123');

      expect(mockCouponsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          amount_off: 5000,
          currency: 'usd',
          duration: 'once',
        }),
        expect.objectContaining({
          idempotencyKey: 'line-discount-coupon-INV-1-INV-1:line-1',
        }),
      );
      expect(mockInvoiceItemsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 50000,
          discounts: [{ coupon: 'coupon_abc' }],
        }),
        expect.objectContaining({
          idempotencyKey: 'invoice-items-INV-1-INV-1:line-1',
        }),
      );
    });

    it('does not create a coupon for a line item without a discount', async () => {
      const invoice = {
        id: 'invoice-1',
        reference: 'INV-1',
        stripe_invoice_id: 'in_123',
        currentVersion: {
          line_items: [
            {
              id: 'line-1',
              final_total: 500,
              adjustment_amount: 0,
              description: 'Staff A',
            },
          ],
        },
      };

      mockInvoiceItemsList.mockResolvedValueOnce({ data: [] });
      mockInvoiceItemsCreate.mockResolvedValueOnce({ id: 'ii_1' });

      await service.attachStripeInvoiceItems(invoice, 'cus_123');

      expect(mockCouponsCreate).not.toHaveBeenCalled();
      expect(mockInvoiceItemsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 50000 }),
        expect.anything(),
      );
      const [createArgs] = mockInvoiceItemsCreate.mock.calls[0];
      expect(createArgs).not.toHaveProperty('discounts');
    });

    it('skips already-attached items on retry without creating a duplicate coupon', async () => {
      const invoice = {
        id: 'invoice-1',
        reference: 'INV-1',
        stripe_invoice_id: 'in_123',
        currentVersion: {
          line_items: [
            {
              id: 'line-1',
              final_total: 450,
              adjustment_amount: -50,
              description: 'Staff A',
            },
          ],
        },
      };

      // The item is already on the Stripe invoice from a prior attempt.
      mockInvoiceItemsList.mockResolvedValueOnce({
        data: [{ metadata: { internal_item_id: 'INV-1:line-1' } }],
      });

      await service.attachStripeInvoiceItems(invoice, 'cus_123');

      expect(mockCouponsCreate).not.toHaveBeenCalled();
      expect(mockInvoiceItemsCreate).not.toHaveBeenCalled();
    });
  });
});
