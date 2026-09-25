import { Test, TestingModule } from '@nestjs/testing';
import { InternalInvoiceSnapshotService } from '../med-alliance/sync/internal-invoice-snapshot.service';
import { InvoiceService } from './invoice.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { StripeService } from '../stripe/stripe.service';
import { MailService } from '../mail/mail.service';
import { getQueueToken } from '@nestjs/bullmq';
import { InvoiceJobStatus } from '@prisma/client';
import { UserAuditService } from '../user-audit/user-audit.service';

const allianceSnapshotMock = {
  safeSync: jest.fn(),
  safeOnPaid: jest.fn(),
};

const userAuditServiceMock = {
  log: jest.fn().mockResolvedValue(undefined),
  logOrThrow: jest.fn().mockResolvedValue(undefined),
  logMany: jest.fn().mockResolvedValue(undefined),
  logUpdate: jest.fn().mockResolvedValue(undefined),
  logBulkUpdate: jest.fn().mockResolvedValue(undefined),
  buildUpdateEntries: jest.fn().mockReturnValue([]),
};

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
        { provide: UserAuditService, useValue: userAuditServiceMock },
        InvoiceService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: StripeService, useValue: {} },
        { provide: MailService, useValue: {} },
        {
          provide: InternalInvoiceSnapshotService,
          useValue: allianceSnapshotMock,
        },
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

  describe('Med Alliance snapshot hooks', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      Object.assign(prismaMock, {
        invoice: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'inv-1',
            status: 'published',
            invoice_number: '00001',
            current_version_id: 'ver-1',
          }),
          update: jest.fn().mockResolvedValue({
            id: 'inv-1',
            current_version_id: 'ver-1',
          }),
        },
        invoiceAuditLog: { create: jest.fn().mockResolvedValue({}) },
      });
    });

    it('runs the paid commission flow when an invoice is manually marked as paid', async () => {
      await service.updateStatus('inv-1', 'paid' as any, 'user-1');

      expect(allianceSnapshotMock.safeOnPaid).toHaveBeenCalledWith('inv-1');
      expect(allianceSnapshotMock.safeSync).not.toHaveBeenCalled();
    });

    it('refreshes the snapshot on any other status change', async () => {
      await service.updateStatus('inv-1', 'under_review' as any, 'user-1');

      expect(allianceSnapshotMock.safeSync).toHaveBeenCalledWith('inv-1');
      expect(allianceSnapshotMock.safeOnPaid).not.toHaveBeenCalled();
    });

    it('refreshes the snapshot after a new version is saved', async () => {
      Object.assign(prismaMock, {
        invoiceVersion: {
          findFirst: jest.fn().mockResolvedValue({ version_number: 1 }),
          create: jest.fn().mockResolvedValue({ id: 'ver-2' }),
        },
        invoiceLineItem: { create: jest.fn() },
      });
      prismaMock.invoice.findUnique.mockResolvedValue({
        id: 'inv-1',
        currentVersion: { status: 'draft' },
      });

      await service.createVersion(
        'inv-1',
        { line_items: [], subtotal: 0, tax_total: 0, total: 0 } as any,
        'user-1',
      );

      expect(allianceSnapshotMock.safeSync).toHaveBeenCalledWith('inv-1');
    });
  });
});
