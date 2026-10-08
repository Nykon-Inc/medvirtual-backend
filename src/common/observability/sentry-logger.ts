import { ConsoleLogger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

type ForwardedLevel = 'info' | 'warn' | 'error' | 'fatal';

// Nest prints one line per provider and per route at boot; on every pm2 reload
// that is several hundred lines of no diagnostic value.
const BOOT_CONTEXTS = new Set([
  'InstanceLoader',
  'RouterExplorer',
  'RoutesResolver',
  'NestFactory',
  'NestApplication',
]);

/**
 * Keeps Nest's normal stdout output (so `pm2 logs` is unchanged) and mirrors
 * log/warn/error/fatal to Sentry. Needed because Nest's logger writes straight
 * to process.stdout, which the SDK's console integration never sees.
 */
export class SentryLogger extends ConsoleLogger {
  log(message: any, ...optionalParams: any[]): void {
    super.log(message, ...optionalParams);
    this.forward('info', message, optionalParams);
  }

  warn(message: any, ...optionalParams: any[]): void {
    super.warn(message, ...optionalParams);
    this.forward('warn', message, optionalParams);
  }

  error(message: any, ...optionalParams: any[]): void {
    super.error(message, ...optionalParams);
    this.forward('error', message, optionalParams);
  }

  fatal(message: any, ...optionalParams: any[]): void {
    super.fatal(message, ...optionalParams);
    this.forward('fatal', message, optionalParams);
  }

  private forward(level: ForwardedLevel, message: any, params: any[]): void {
    // Nest appends the logger's context as the last string argument; on
    // error/fatal a stack string may precede it.
    const strings = params.filter((param) => typeof param === 'string');
    const context = strings.length ? strings[strings.length - 1] : this.context;
    if (context && BOOT_CONTEXTS.has(context)) return;

    const attributes: Record<string, unknown> = {};
    if (context) attributes.context = context;
    if ((level === 'error' || level === 'fatal') && strings.length > 1) {
      attributes.stack = strings[0];
    }

    Sentry.logger[level](this.stringify(message), attributes);
  }

  private stringify(message: any): string {
    if (typeof message === 'string') return message;
    if (message instanceof Error) return message.stack ?? message.message;
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }
}
