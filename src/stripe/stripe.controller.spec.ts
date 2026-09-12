import { Test, TestingModule } from '@nestjs/testing';
import { StripeController } from './stripe.controller';
import { StripeService } from './stripe.service';
import { ConfigService } from '@nestjs/config';
import { SecretsService } from '../secrets/secrets.service';
import { PrismaService } from '../prisma/prisma.service';
import { getQueueToken } from '@nestjs/bullmq';
import { PusherService } from '../pusher/pusher.service';
import { InvoiceService } from '../invoice/invoice.service';

describe('StripeController', () => {
  let stripeController: StripeController;
  let stripeService: StripeService;

  beforeEach(async () => {
    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        if (key === 'APP_ENV') return 'local';
        if (key === 'QUEUES_ENABLED') return 'false';
        if (key === 'REDIS_KEY_PREFIX') return 'MEDVIRTUAL:LOCAL:MANNY';
        if (key === 'WEBHOOK_URL') return 'https://test-webhook.ngrok.dev';
        return defaultValue;
      }),
    };

    const mockSecretsService = {
      getSecret: jest.fn().mockResolvedValue({
        stripe_secret_key: 'sk_test_mock',
        stripe_public_key: 'pk_test_mock',
      }),
    };

    const mockRedisClient = {
      get: jest.fn().mockResolvedValue('whsec_mock'),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [StripeController],
      providers: [
        StripeService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: SecretsService, useValue: mockSecretsService },
        { provide: 'REDIS_CLIENT', useValue: mockRedisClient },
        { provide: PrismaService, useValue: {} },
        {
          provide: PusherService,
          useValue: { trigger: jest.fn(), authenticate: jest.fn() },
        },
        {
          provide: getQueueToken('invoice'),
          useValue: { getJob: jest.fn(), add: jest.fn() },
        },
        {
          provide: getQueueToken('invoice-prebill-reconciliation'),
          useValue: { getJob: jest.fn(), add: jest.fn() },
        },
        { provide: InvoiceService, useValue: { getInvoiceDetails: jest.fn() } },
      ],
    }).compile();

    stripeController = module.get<StripeController>(StripeController);
    stripeService = module.get<StripeService>(StripeService);
  });

  it('should be defined', () => {
    expect(stripeController).toBeDefined();
  });

  describe('createCustomer', () => {
    it('should call stripeService.createCustomer with name and email', async () => {
      const mockResult = {
        id: 'cust_123',
        name: 'John Doe',
        email: 'john@example.com',
      };
      const spy = jest
        .spyOn(stripeService, 'createCustomer')
        .mockResolvedValue(mockResult as any);

      const result = await stripeController.createCustomer({
        name: 'John Doe',
        email: 'john@example.com',
      });

      expect(spy).toHaveBeenCalledWith('John Doe', 'john@example.com');
      expect(result).toEqual(mockResult);
    });

    it('should throw BadRequestException if name is missing', async () => {
      await expect(
        stripeController.createCustomer({ name: '' }),
      ).rejects.toThrow('Name is required');
    });
  });

  describe('getInvoiceUrl', () => {
    it('should call stripeService.getInvoiceUrl with id', async () => {
      const mockResult = { url: 'https://stripe.com/invoice/123' };
      const spy = jest
        .spyOn(stripeService, 'getInvoiceUrl')
        .mockResolvedValue(mockResult);

      const result = await stripeController.getInvoiceUrl('in_123');

      expect(spy).toHaveBeenCalledWith('in_123');
      expect(result).toEqual(mockResult);
    });

    it('should throw BadRequestException if id is missing', async () => {
      await expect(stripeController.getInvoiceUrl('')).rejects.toThrow(
        'Stripe invoice ID is required',
      );
    });
  });
});
