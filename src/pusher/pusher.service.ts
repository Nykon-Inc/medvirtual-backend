import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
const Pusher = require('pusher');

@Injectable()
export class PusherService {
  private pusher: any;
  private readonly logger = new Logger(PusherService.name);

  constructor(private configService: ConfigService) {
    const appId = this.configService.get<string>('PUSHER_APP_ID');
    const key = this.configService.get<string>('PUSHER_KEY');
    const secret = this.configService.get<string>('PUSHER_SECRET');
    const cluster = this.configService.get<string>('PUSHER_CLUSTER');
    const useTLS = this.configService.get<boolean>('PUSHER_USE_TLS', true);

    if (!appId || !key || !secret || !cluster) {
      this.logger.warn(
        'Pusher configuration is incomplete. Real-time notifications may not work.',
      );
      return;
    }

    this.pusher = new Pusher({
      appId,
      key,
      secret,
      cluster,
      useTLS,
    });
  }

  /**
   * Trigger an event on a specific channel
   * @param channel The channel name
   * @param event The event name
   * @param data The data to send
   */
  async trigger(channel: string, event: string, data: any) {
    if (!this.pusher) {
      this.logger.error('Pusher is not initialized. Cannot trigger event.');
      return;
    }

    try {
      await this.pusher.trigger(channel, event, data);
      this.logger.log(`Pusher event triggered: ${event} on channel ${channel}`);
    } catch (error) {
      this.logger.error(`Failed to trigger Pusher event: ${error.message}`);
      throw error;
    }
  }

  /**
   * Authenticate a private/presence channel
   * @param socketId The socket ID from the client
   * @param channel The channel name
   * @param data Optional user data
   */
  authenticate(socketId: string, channel: string, data?: any) {
    if (!this.pusher) {
      throw new Error('Pusher is not initialized');
    }
    return this.pusher.authenticate(socketId, channel, data);
  }
}
