import * as Sentry from '@sentry/nestjs';
import { SentryLogger } from './sentry-logger';

jest.mock('@sentry/nestjs', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  },
}));

describe('SentryLogger', () => {
  let logger: SentryLogger;
  let stdout: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logger = new SentryLogger();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should still write to stdout', () => {
    logger.log('hello', 'InvoiceWorker');

    expect(stdout).toHaveBeenCalled();
  });

  it('should forward log as info with the context attribute', () => {
    logger.log('Invoice generated', 'InvoiceWorker');

    expect(Sentry.logger.info).toHaveBeenCalledWith('Invoice generated', {
      context: 'InvoiceWorker',
    });
  });

  it('should forward warn', () => {
    logger.warn('Queue slow', 'HubstaffWorker');

    expect(Sentry.logger.warn).toHaveBeenCalledWith('Queue slow', {
      context: 'HubstaffWorker',
    });
  });

  it('should forward error with the stack when one is given', () => {
    logger.error('Sync failed', 'Error: boom\n    at x', 'CronService');

    expect(Sentry.logger.error).toHaveBeenCalledWith('Sync failed', {
      context: 'CronService',
      stack: 'Error: boom\n    at x',
    });
  });

  it('should forward fatal', () => {
    logger.fatal('Out of memory', 'Bootstrap');

    expect(Sentry.logger.fatal).toHaveBeenCalledWith('Out of memory', {
      context: 'Bootstrap',
    });
  });

  it('should skip Nest boot noise', () => {
    logger.log('Mapped {/start, GET} route', 'RouterExplorer');

    expect(Sentry.logger.info).not.toHaveBeenCalled();
  });

  it('should not forward debug or verbose', () => {
    logger.debug('detail', 'CronService');
    logger.verbose('detail', 'CronService');

    expect(Sentry.logger.info).not.toHaveBeenCalled();
  });

  it('should serialise objects and errors', () => {
    logger.log({ invoiceId: 7 });
    logger.error(new Error('boom'));

    expect(Sentry.logger.info).toHaveBeenCalledWith('{"invoiceId":7}', {});
    expect(Sentry.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Error: boom'),
      {},
    );
  });

  it('should fall back to String() for values JSON cannot serialise', () => {
    const circular: any = {};
    circular.self = circular;

    logger.log(circular);

    expect(Sentry.logger.info).toHaveBeenCalledWith('[object Object]', {});
  });
});
