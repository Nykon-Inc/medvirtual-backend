import * as Sentry from '@sentry/nestjs';
import type { Job } from 'bullmq';

/**
 * Wraps a BullMQ `process()` method so every job shows up in Sentry as its own
 * transaction and a thrown error is reported before BullMQ retries it. The SDK
 * has no BullMQ auto-instrumentation, so without this jobs are invisible.
 */
export function TraceQueueJob(queue: string): MethodDecorator {
  return (_target, _propertyKey, descriptor: PropertyDescriptor) => {
    const original = descriptor.value;

    descriptor.value = function (job: Job, ...rest: unknown[]) {
      const jobName = job?.name ?? 'unknown';

      return Sentry.startSpan(
        {
          name: `queue.${queue}/${jobName}`,
          op: 'queue.process',
          forceTransaction: true,
          attributes: {
            'messaging.destination.name': queue,
            'messaging.message.id': job?.id,
          },
        },
        async () => {
          try {
            return await original.apply(this, [job, ...rest]);
          } catch (error) {
            Sentry.captureException(error, {
              tags: { queue, job_name: jobName },
              extra: { job_id: job?.id, attempts_made: job?.attemptsMade },
            });
            throw error;
          }
        },
      );
    };

    return descriptor;
  };
}
