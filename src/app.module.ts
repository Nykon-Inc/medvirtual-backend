import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UserModule } from './user/user.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { RecoverypassModule } from './recoverypass/recoverypass.module';
import { HubspotModule } from './hubspot/hubspot.module';
import { GoogledriveModule } from './googledrive/googledrive.module';
import { OrganizationModule } from './organization/organization.module';
import { CandidatesModule } from './candidate/candidates.module';
import { S3Module } from './s3/s3.module';
import { OpenaiModule } from './openai/openai.module';
import { OpenrouterModule } from './openrouter/openrouter.module';
import { AiComparisonModule } from './ai-comparison/ai-comparison.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { CronModule } from './cron/cron.module';
import { HireRequestModule } from './hire-request/hire-request.module';
import { TicketModule } from './ticket/ticket.module';
import { UserAuditModule } from './user-audit/user-audit.module';
import { StaffModule } from './staff/staff.module';
import { NotificationsModule } from './notifications/notifications.module';
import { EmailTestModule } from './email-test/email-test.module';
import { PanelModule } from './panel/panel.module';
import { TalentPoolLeadsModule } from './talent-pool-leads/talent-pool-leads.module';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { SqsModule } from './sqs/sqs.module';
import { PositionRateConfigModule } from './position-rate-config/position-rate-config.module';
import { MedAllianceModule } from './med-alliance/med-alliance.module';
import { OfferPanelsModule } from './offer-panels/offer-panels.module';
import { EmailTemplatesModule } from './email-templates/email-templates.module';
import { BusinessUnitsModule } from './business-units/business-units.module';
import { SecretsModule } from './secrets/secrets.module';
import { HubstaffModule } from './hubstaff/hubstaff.module';
import { BullModule } from '@nestjs/bullmq';
import { RedisModule } from './redis/redis.module';
import { PusherModule } from './pusher/pusher.module';
import { InvoiceModule } from './invoice/invoice.module';
import { StripeModule } from './stripe/stripe.module';
import { bullPrefix, queuesEnabledSync } from './common/app-config';
import { SessionActivityModule } from './session-activity/session-activity.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ...(!queuesEnabledSync()
      ? []
      : [
          BullModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => {
              const prefix = bullPrefix(configService);
              return {
                connection: {
                  host: configService.get<string>('REDIS_HOST', 'localhost'),
                  port: configService.get<number>('REDIS_PORT', 6379),
                  password: configService.get<string>('REDIS_PASSWORD'),
                  username: configService.get<string>(
                    'REDIS_USERNAME',
                    'basic',
                  ),
                  maxRetriesPerRequest: null, // required by BullMQ
                  enableReadyCheck: false, // recommended by BullMQ
                },
                prefix,
              };
            },
          }),
        ]),
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 1 minute
        limit: 100, // 100 requests per minute (global default, can be overridden per endpoint)
      },
    ]),
    UserModule,
    PrismaModule,
    AuthModule,
    RecoverypassModule,
    HubspotModule,
    GoogledriveModule,
    OrganizationModule,
    CandidatesModule,
    S3Module,
    OpenaiModule,
    OpenrouterModule,
    AiComparisonModule,
    DashboardModule,
    CronModule,
    HireRequestModule,
    TicketModule,
    UserAuditModule,
    StaffModule,
    NotificationsModule,
    EmailTestModule,
    PanelModule,
    TalentPoolLeadsModule,
    SqsModule,
    PositionRateConfigModule,
    MedAllianceModule,
    OfferPanelsModule,
    EmailTemplatesModule,
    BusinessUnitsModule,
    SecretsModule,
    HubstaffModule,
    RedisModule,
    PusherModule,
    InvoiceModule,
    StripeModule,
    SessionActivityModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
