import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { SessionActivityService } from './session-activity.service';
import { PingSessionActivityDto } from './dto/ping-session-activity.dto';

@ApiTags('Session Activity')
@ApiBearerAuth()
@Controller('session-activity')
export class SessionActivityController {
  constructor(
    private readonly sessionActivityService: SessionActivityService,
  ) {}

  @Post('ping')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Record a heartbeat ping for the current session, used to derive time-on-platform / time-on-talent-pool reports',
  })
  @ApiResponse({ status: 200, description: 'Ping recorded successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async ping(
    @Body() body: PingSessionActivityDto,
    @Req() req: Request,
  ): Promise<{ status: number }> {
    const userId = (req['user'] as { id: string }).id;
    const sessionId = req['sessionId'] as string;
    await this.sessionActivityService.recordPing(userId, sessionId, body.scope);
    return { status: 200 };
  }
}
