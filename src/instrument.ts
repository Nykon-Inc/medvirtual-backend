/* istanbul ignore file */
// Must be the first import of every entry point: the SDK patches http, Prisma
// and Redis as they are loaded, so anything required before this runs untraced.
// ConfigModule only reads .env once Nest boots, which is too late for the SDK.
import 'dotenv/config';
import * as Sentry from '@sentry/nestjs';
import { appEnvSync } from './common/app-config';
import {
  redactAttributes,
  redactSensitive,
} from './common/observability/redact-sensitive';

const DEFAULT_TRACES_SAMPLE_RATE = 0.2;

function tracesSampleRate(): number {
  const parsed = Number(process.env.SENTRY_TRACES_SAMPLE_RATE);
  return process.env.SENTRY_TRACES_SAMPLE_RATE && !Number.isNaN(parsed)
    ? parsed
    : DEFAULT_TRACES_SAMPLE_RATE;
}

// Without SENTRY_DSN the SDK is a no-op, which is how local dev stays silent.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: appEnvSync(),
  release: process.env.SENTRY_RELEASE,
  sendDefaultPii: false,
  enableLogs: true,
  integrations: [
    Sentry.prismaIntegration(),
    // console.log is deliberately left out: those calls dump whole records
    // (contacts, organizations, webhook payloads). Only warn/error leave the host.
    Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
  ],
  beforeSendLog(log) {
    return {
      ...log,
      message: redactSensitive(String(log.message)),
      attributes: redactAttributes(log.attributes),
    };
  },
  tracesSampler: ({ name }) => {
    // GET /start is polled by the deploy script and the uptime monitor.
    if (name?.endsWith('/start')) return 0;
    return tracesSampleRate();
  },
  beforeSend(event) {
    // Request bodies and cookies carry candidate/contact PII and session tokens.
    if (event.request) {
      delete event.request.cookies;
      delete event.request.data;
    }
    return event;
  },
});
