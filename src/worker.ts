import './instrument';
import { NestFactory } from '@nestjs/core';
import * as Sentry from '@sentry/nestjs';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { AppModule } from './app.module';
import { DealsQueueConsumerService } from './sqs/deals-queue-consumer.service';

let shuttingDown = false;

process.on('SIGTERM', () => {
  shuttingDown = true;
});
process.on('SIGINT', () => {
  shuttingDown = true;
});

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const consumer = app.get(DealsQueueConsumerService);
  const client = new SQSClient({
    region: process.env.AWS_REGION || 'us-east-1',
  });
  const queueUrl = process.env.DEALS_QUEUE_URL;

  if (!queueUrl) {
    throw new Error('DEALS_QUEUE_URL is not set');
  }

  console.log(`Worker started, polling ${queueUrl}`);

  while (!shuttingDown) {
    const { Messages } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20, // long polling
        VisibilityTimeout: 60,
      }),
    );

    if (!Messages?.length) {
      continue;
    }

    for (const message of Messages) {
      if (!message.Body) {
        continue;
      }

      const body = message.Body;

      try {
        await Sentry.startSpan(
          { name: 'sqs.deals', op: 'queue.process', forceTransaction: true },
          async () => {
            await consumer.handleMessage(body);
            await client.send(
              new DeleteMessageCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
          },
        );
      } catch (error) {
        // Message is left on the queue: it becomes visible again after the
        // visibility timeout and retries, eventually landing in the DLQ.
        console.error('Failed to process SQS message:', error);
        Sentry.captureException(error, {
          tags: { queue: 'deals', sqs_message_id: message.MessageId },
        });
      }
    }
  }

  console.log('Worker shutting down gracefully');
  await app.close();
  await Sentry.flush(2000);
  process.exit(0);
}

bootstrap().catch(async (error) => {
  console.error('Worker failed to start:', error);
  Sentry.captureException(error);
  await Sentry.flush(2000);
  process.exit(1);
});
