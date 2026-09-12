import { Controller, Post } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Optional } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('Hubstaff')
@Controller('hubstaff')
export class HubstaffController {
  constructor(
    @Optional()
    @InjectQueue('hubstaff-sync')
    private readonly hubstaffSyncQueue: Queue | null,
  ) {}

  @Post('sync')
  @ApiOperation({ summary: 'Trigger Hubstaff members sync' })
  @ApiResponse({
    status: 200,
    description: 'Sync event triggered successfully',
  })
  async triggerSync() {
    if (!this.hubstaffSyncQueue) {
      return { message: 'Queue not available in local mode' };
    }
    await this.hubstaffSyncQueue.add('sync-hubstaff-members', {
      timestamp: new Date().toISOString(),
    });
    return { message: 'Hubstaff members sync event triggered successfully' };
  }
}
