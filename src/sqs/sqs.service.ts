import { Injectable } from '@nestjs/common';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

@Injectable()
export class SqsService {
  private client = new SQSClient({
    region: process.env.AWS_REGION || 'us-east-1',
  });

  async sendMessage(payload: any) {
    return this.client.send(
      new SendMessageCommand({
        QueueUrl: payload.QueueUrl,
        MessageBody: JSON.stringify(payload.MessageBody),
      }),
    );
  }
}
