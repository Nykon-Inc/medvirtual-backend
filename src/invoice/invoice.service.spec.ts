import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceService } from './invoice.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { StripeService } from '../stripe/stripe.service';
import { MailService } from '../mail/mail.service';
import { getQueueToken } from '@nestjs/bullmq';
import { InvoiceJobStatus } from '@prisma/client';

describe('InvoiceService', () => {
  let service: InvoiceService;
  let prismaMock: any;
  let invoiceQueueMock: any;

  beforeEach(async () => {
    prismaMock = {
      invoiceJob: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({
          id: 'job_123',
          status: InvoiceJobStatus.queued,
        }),
      },
    };

    invoiceQueueMock = {
      add: jest.fn().mockResolvedValue({ id: 'job_id' }),
    };

    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        return defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: StripeService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: getQueueToken('invoice'), useValue: invoiceQueueMock },
        {
          provide: getQueueToken('invoice-prebill-reconciliation'),
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<InvoiceService>(InvoiceService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createInvoice', () => {
    it('should skip creation if a similar job was recently started', async () => {
      const recentJob = {
        id: 'job_existing',
        createdAt: new Date(),
        payload: {
          billing_start_date: '2026-06-01',
          billing_end_date: '2026-06-30',
          organization_id: 'org_123',
        },
      };
      prismaMock.invoiceJob.findMany.mockResolvedValueOnce([recentJob]);

      const res = await service.createInvoice(
        {
          billing_start_date: '2026-06-01',
          billing_end_date: '2026-06-30',
          organization_id: 'org_123',
        },
        'user_1',
      );

      expect(res.status).toBe('skipped');
      expect(res.job_id).toBe('job_existing');
      expect(prismaMock.invoiceJob.create).not.toHaveBeenCalled();
    });

    it('should create a job and enqueue tasks successfully', async () => {
      const res = await service.createInvoice(
        {
          billing_start_date: '2026-06-01',
          billing_end_date: '2026-06-30',
          organization_id: 'org_123',
        },
        'user_1',
      );

      expect(res.status).toBe('queued');
      expect(res.job_id).toBe('job_123');
      expect(prismaMock.invoiceJob.create).toHaveBeenCalled();
      expect(invoiceQueueMock.add).toHaveBeenCalled();
    });
  });
});
