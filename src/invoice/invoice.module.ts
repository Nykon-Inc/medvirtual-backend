import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { InvoiceService } from './invoice.service';
import { InvoiceController } from './invoice.controller';
import { InvoiceWorker } from './invoice.worker';
import { InvoiceStatsWorker } from './invoice-stats.worker';
import { InvoiceReconciliationWorker } from './invoice-reconciliation.worker';
import { InvoicePrebillReconciliationWorker } from './invoice-prebill-reconciliation.worker';
import { PrismaModule } from '../prisma/prisma.module';
import { PusherModule } from '../pusher/pusher.module';
import { HubstaffModule } from '../hubstaff/hubstaff.module';
import { MailModule } from '../mail/mail.module';
import { PositionRateConfigModule } from '../position-rate-config/position-rate-config.module';
import { BusinessUnitsModule } from '../business-units/business-units.module';
import { queuesEnabledSync } from '../common/app-config';

// With queues disabled, both the queue registrations and the worker providers
// that consume them are skipped entirely rather than registered-but-idle —
// registering a BullMQ queue without Redis available would fail module
// bootstrap, not just leave the queue empty.
const QUEUES = queuesEnabledSync();

const workerProviders = QUEUES
  ? [
      InvoiceWorker,
      InvoiceStatsWorker,
      InvoiceReconciliationWorker,
      InvoicePrebillReconciliationWorker,
    ]
  : [];

@Module({
  imports: [
    PrismaModule,
    PusherModule,
    HubstaffModule,
    MailModule,
    PositionRateConfigModule,
    BusinessUnitsModule,
    ...(QUEUES
      ? [
          BullModule.registerQueue(
            { name: 'invoice' },
            { name: 'invoice-stats' },
            { name: 'invoice-reconciliation' },
            { name: 'invoice-prebill-reconciliation' },
          ),
        ]
      : []),
  ],
  controllers: [InvoiceController],
  providers: [InvoiceService, ...workerProviders],
  exports: [InvoiceService, ...workerProviders],
})
export class InvoiceModule {}
