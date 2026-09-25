import { Module, Global, forwardRef } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { StripeController } from './stripe.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncModule } from '../med-alliance/sync/sync.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { BullModule } from '@nestjs/bullmq';
import { queuesEnabledSync } from '../common/app-config';

@Global()
@Module({
  imports: [
    PrismaModule,
    SyncModule,
    forwardRef(() => InvoiceModule),
    ...(queuesEnabledSync()
      ? [
          BullModule.registerQueue(
            { name: 'invoice' },
            { name: 'invoice-prebill-reconciliation' },
          ),
        ]
      : []),
  ],
  providers: [StripeService],
  controllers: [StripeController],
  exports: [StripeService],
})
export class StripeModule {}
