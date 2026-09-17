import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Server } from 'http';
import { describeAppConfig, isProduction } from './common/app-config';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Lets providers (e.g. RedisModule) release connections on SIGTERM/SIGINT
  // instead of orphaning them on every restart.
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') || 3000;

  // Surface the resolved environment config up front: whether queues are live
  // and whether Stripe is on live keys used to be inferred from a substring of
  // REDIS_BASE_KEY and was invisible until something went wrong.
  logger.log(`Config: ${describeAppConfig(configService)}`);
  if (isProduction(configService)) {
    logger.warn('APP_ENV=production — using LIVE Stripe credentials.');
  }

  app.enableCors({
    origin: [
      'https://app.medvirtual.ai',
      'https://staging.medvirtual.ai',
      'http://localhost:3001',
      'http://localhost:3000',
      'http://localhost:9000',
      'https://mv.staging.nykon.cloud',
      'https://mv-api.staging.nykon.cloud',
      'https://deploy-invoicing.d2odvfjc5yqdaj.amplifyapp.com',
      'https://test-prod.d2odvfjc5yqdaj.amplifyapp.com',
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const server = app.getHttpServer() as Server;
  server.setTimeout(20 * 60 * 1000); // 20 min

  await app.listen(port);
  logger.log(`Application is running on: http://localhost:${port}`);
}

bootstrap().catch((err) => {
  // Without this the process exits 0 on a failed bootstrap, so a crash-looping
  // container looks like a clean shutdown to the orchestrator.
  new Logger('Bootstrap').error('Application failed to start', err);
  process.exit(1);
});
