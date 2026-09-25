import { forwardRef, Module } from '@nestjs/common';
import { OfferPanelsController } from './offer-panels.controller';
import { PublicOfferPanelsController } from './public-offer-panels.controller';
import { OfferPanelsService } from './offer-panels.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CandidatesModule } from '../candidate/candidates.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { HubspotModule } from '../hubspot/hubspot.module';
import { HireRequestModule } from '../hire-request/hire-request.module';
import { BusinessUnitsModule } from '../business-units/business-units.module';
import { TicketAuditService } from '../ticket/ticket-audit.service';
import { OfferPanelsAuditService } from './offer-panels-audit.service';
import { OfferPanelRecipientInviteService } from './offer-panel-recipient-invite.service';
import { OrganizationModule } from '../organization/organization.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => CandidatesModule),
    NotificationsModule,
    forwardRef(() => HubspotModule),
    forwardRef(() => HireRequestModule),
    BusinessUnitsModule,
    // forwardRef: OrganizationModule → HubspotModule → HireRequestModule → OfferPanelsModule
    forwardRef(() => OrganizationModule),
    forwardRef(() => UserModule),
  ],
  controllers: [OfferPanelsController, PublicOfferPanelsController],
  providers: [
    OfferPanelsService,
    TicketAuditService,
    OfferPanelsAuditService,
    OfferPanelRecipientInviteService,
  ],
  exports: [OfferPanelsService, OfferPanelsAuditService],
})
export class OfferPanelsModule {}
