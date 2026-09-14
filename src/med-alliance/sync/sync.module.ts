import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MailModule } from '../../mail/mail.module';
import { HubspotMatchingService } from './hubspot-matching.service';
import { InvoiceIngestionService } from './invoice-ingestion.service';
import { StaffMatchingService } from './staff-matching.service';
import { CommissionDetectionService } from './commission-detection.service';
import { ReferralSyncService } from './referral-sync.service';
import { EligibilityCheckService } from '../referred-companies/eligibility-check.service';
import { ReviewCasesModule } from '../review-cases/review-cases.module';
import { AllianceNotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../../email-templates/email-templates.module';

@Module({
  imports: [
    PrismaModule,
    MailModule,
    ReviewCasesModule,
    AllianceNotificationsModule,
    EmailTemplatesModule,
  ],
  providers: [
    HubspotMatchingService,
    InvoiceIngestionService,
    StaffMatchingService,
    CommissionDetectionService,
    ReferralSyncService,
    // EligibilityCheckService is used by HubspotMatchingService after a match is resolved
    EligibilityCheckService,
  ],
  exports: [
    ReferralSyncService,
    InvoiceIngestionService,
    StaffMatchingService,
    CommissionDetectionService,
  ],
})
export class SyncModule {}
