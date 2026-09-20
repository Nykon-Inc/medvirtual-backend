import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HubstaffService } from './hubstaff.service';
import { HubstaffController } from './hubstaff.controller';
import { HubstaffWorker } from './hubstaff.worker';
import { SecretsModule } from '../secrets/secrets.module';
import { PrismaModule } from '../prisma/prisma.module';
import { HubspotModule } from '../hubspot/hubspot.module';
import { queuesEnabledSync } from '../common/app-config';

const QUEUES = queuesEnabledSync();

@Module({
  imports: [
    SecretsModule,
    PrismaModule,
    HubspotModule,
    ...(QUEUES ? [BullModule.registerQueue({ name: 'hubstaff-sync' })] : []),
  ],
  controllers: [HubstaffController],
  providers: [HubstaffService, ...(QUEUES ? [HubstaffWorker] : [])],
  exports: [HubstaffService, ...(QUEUES ? [HubstaffWorker] : [])],
})
export class HubstaffModule {}
