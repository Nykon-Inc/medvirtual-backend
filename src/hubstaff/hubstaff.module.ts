import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HubstaffService } from './hubstaff.service';
import { HubstaffController } from './hubstaff.controller';
import { HubstaffSyncService } from './hubstaff-sync.service';
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
  // HubstaffSyncService is provided regardless of QUEUES: the worker is only
  // one of its callers, and the dry-run script needs it with queues off.
  providers: [
    HubstaffService,
    HubstaffSyncService,
    ...(QUEUES ? [HubstaffWorker] : []),
  ],
  exports: [
    HubstaffService,
    HubstaffSyncService,
    ...(QUEUES ? [HubstaffWorker] : []),
  ],
})
export class HubstaffModule {}
