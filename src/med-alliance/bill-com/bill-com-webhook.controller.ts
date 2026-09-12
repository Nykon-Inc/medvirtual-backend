import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BillComPayoutService } from './bill-com-payout.service';
import { BillWebhookDto } from './dto/bill-com-webhook.dto';
import { BillWebhookGuard } from './guards/bill-com-webhook.guard';

const TERMINAL_SUCCESS_STATUSES = new Set([
  'PROCESSED',
  'PAID',
  'COMPLETED',
  'SUCCESS',
]);

@ApiTags('webhooks')
@Controller('webhooks')
export class BillComWebhookController {
  private readonly logger = new Logger(BillComWebhookController.name);

  constructor(private readonly billComPayoutService: BillComPayoutService) {}

  @Post('bill-com')
  @HttpCode(200)
  @UseGuards(BillWebhookGuard)
  @ApiOperation({
    summary: 'Receive and process incoming Bill.com webhook events',
  })
  @ApiBody({
    description: 'Payload sent by Bill.com for payment events',
  })
  @ApiResponse({ status: 200, description: 'Webhook received' })
  async handleWebhook(
    @Body() payload: BillWebhookDto,
  ): Promise<{ received: boolean }> {
    console.log('Received Bill.com webhook payload:', JSON.stringify(payload));
    try {
      const eventType: string = payload?.metadata?.eventType ?? '';
      const paymentId: string = payload?.payment?.id ?? '';
      const billIds: string[] = payload?.payment?.billIds ?? [];
      const transaction_reference: string =
        payload?.payment?.transactionNumber ?? '';

      // TODO: validate x-bill-sha-signature header for authenticity
      // TODO: validate payload.metadata.organizationId matches expected org
      if (!paymentId) {
        this.logger.warn(
          'Bill.com webhook received with no payment ID, ignoring',
        );
        return { received: true };
      }

      if (
        eventType === 'payment.updated' &&
        TERMINAL_SUCCESS_STATUSES.has(payload?.payment?.status!)
      ) {
        await this.billComPayoutService.finalizeAsPaid(
          billIds,
          transaction_reference,
        );
        return { received: true };
      }

      if (eventType === 'payment.failed') {
        await this.billComPayoutService.markAsFailed(billIds, 'Payment failed');
        return { received: true };
      }

      this.logger.log(`Bill.com webhook event "${eventType}" ignored`);
    } catch (err) {
      // Never return non-200 to Bill.com — it would trigger retries for a potentially
      // already-processed event.
      this.logger.error('Unhandled error processing Bill.com webhook', err);
    }

    return { received: true };
  }
}
