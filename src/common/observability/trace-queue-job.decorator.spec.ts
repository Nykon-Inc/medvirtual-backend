import * as Sentry from '@sentry/nestjs';
import { TraceQueueJob } from './trace-queue-job.decorator';

jest.mock('@sentry/nestjs', () => ({
  startSpan: jest.fn((_options, callback) => callback()),
  captureException: jest.fn(),
}));

class FakeWorker {
  prefix = 'done';

  @TraceQueueJob('invoice')
  process(job: any): Promise<string> {
    if (job.data?.fail) {
      return Promise.reject(new Error('boom'));
    }
    return Promise.resolve(`${this.prefix}:${job.id}`);
  }
}

describe('TraceQueueJob', () => {
  let worker: FakeWorker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new FakeWorker();
  });

  it('should run the job inside a transaction named after the queue and job', async () => {
    const result = await worker.process({ id: '7', name: 'generate-invoice' });

    expect(result).toBe('done:7');
    expect(Sentry.startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'queue.invoice/generate-invoice',
        op: 'queue.process',
        forceTransaction: true,
      }),
      expect.any(Function),
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('should fall back to "unknown" when the job has no name', async () => {
    await worker.process({ id: '8' });

    expect(Sentry.startSpan).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'queue.invoice/unknown' }),
      expect.any(Function),
    );
  });

  it('should report the error and rethrow so BullMQ can retry', async () => {
    const job = {
      id: '9',
      name: 'generate-invoice',
      attemptsMade: 2,
      data: { fail: true },
    };

    await expect(worker.process(job)).rejects.toThrow('boom');
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { queue: 'invoice', job_name: 'generate-invoice' },
        extra: { job_id: '9', attempts_made: 2 },
      }),
    );
  });
});
