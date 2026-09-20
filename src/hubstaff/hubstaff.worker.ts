import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { HubstaffSyncService } from './hubstaff-sync.service';

/**
 * Queue entry point for the Hubstaff → HubSpot → Candidate binding. The
 * matching itself lives in HubstaffSyncService so that a dry run
 * (`scripts/diagnose-hubstaff-sync.ts`) exercises the same code this worker
 * runs, rather than a copy of it that drifts.
 */
@Processor('hubstaff-sync')
export class HubstaffWorker extends WorkerHost {
  private readonly logger = new Logger(HubstaffWorker.name);

  constructor(private readonly hubstaffSyncService: HubstaffSyncService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    switch (job.name) {
      case 'sync-hubstaff-members':
        return await this.hubstaffSyncService.syncMembers();
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }
}
