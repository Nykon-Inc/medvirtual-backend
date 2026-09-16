import { forwardRef, Module } from '@nestjs/common';
import { HubspotController } from './hubspot.controller';
import { HubspotService } from './hubspot.service';
import { PrismaModule } from '../prisma/prisma.module';
import { GoogledriveModule } from '../googledrive/googledrive.module';
import { CandidatesModule } from '../candidate/candidates.module';
import { OrganizationModule } from '../organization/organization.module';

import { HandlerObjectCreation } from './handlers/objectCreation';
import { HandlerObjectPropertyChange } from './handlers/objectPropertyChange';
import { HandlerObjectDeletion } from './handlers/objectDeletion';

import { HandlerOrganizationCreation } from './handlers/organizationCreation';
import { HandlerOrganizationPropertyChange } from './handlers/organizationPropertyChange';
import { HandlerOrganizationDeletion } from './handlers/organizationDeletion';
import { HandlerOrganizationRestore } from './handlers/organizationRestore';
import { HandlerOrganizationReactivation } from './handlers/organizationReactivation';
import { HandlerOrganizationMerge } from './handlers/organizationMerge';
import { HandlerOrganizationAssociationChange } from './handlers/organizationAssociationChange';

import { HandlerOwnerCreation } from './handlers/ownerCreation';
import { HandlerOwnerDeletion } from './handlers/ownerDeletion';
import { HandlerOwnerPropertyChange } from './handlers/ownerPropertyChange';
import { HandlerDealCreation } from './handlers/dealCreation';
import { HandlerDealPropertyChange } from './handlers/dealPropertyChange';
import { HandlerDealDeletion } from './handlers/dealDeletion';

import { HandlerDealAssociationChange } from './handlers/dealAssociationChange';
import { HireRequestCreationService } from './create/hireRequest';
import { HireRequestUpdateService } from './update/hireRequest';
import { HandlerTicketCreation } from './handlers/ticketCreation';
import { HandlerTicketRestore } from './handlers/ticketRestore';
import { HandlerTicketDeletion } from './handlers/ticketDeletion';
import { HandlerTicketPropertyChange } from './handlers/ticketPropertyChange';

import { HandlerAffiliateCreation } from './handlers/affiliateCreation';
import { HandlerAffiliatePropertyChange } from './handlers/affiliatePropertyChange';
import { HandlerAffiliateDeletion } from './handlers/affiliateDeletion';
import { HandlerAffiliateAssociationChange } from './handlers/affiliateAssociationChange';

import { HandlerInvoiceCreation } from './handlers/invoiceCreation';
import { HandlerInvoicePropertyChange } from './handlers/invoicePropertyChange';
import { HandlerInvoiceAssociationChange } from './handlers/invoiceAssociationChange';

import { HandlerComissionCreation } from './handlers/comissionCreation';

import { HireRequestModule } from '../hire-request/hire-request.module';

import { OrganizationCreationService } from './create/Organization';
import { HandlerObjectMerge } from './handlers/objectMerge';
import { OwnerCreationService } from './create/Owner';
import { AffiliateCreationService } from './create/affiliate';
import { AffiliateUpdateService } from './update/affiliate';

import { OrganizationUpdateService } from './update/organization';
import { ContactCreationService } from './create/contact';
import { ContactUpdateService } from './update/contact';
import { ContactDeleteService } from './delete/contact';
import { HandlerContactCreation } from './handlers/contactCreation';
import { HandlerContactPropertyChange } from './handlers/contactPropertyChange';
import { HandlerContactDeletion } from './handlers/contactDeletion';
import { HandlerContactMerge } from './handlers/contactMerge';

import { CompanyDeleteService } from './delete/company';
import { MailModule } from '../mail/mail.module';
import { OrgDeletionModule } from '../med-alliance/org-deletion/org-deletion.module';
import { AllianceNotificationsModule } from '../med-alliance/notifications/notifications.module';
import { ContactFromCompanyCreationService } from './create/contactFromCompany';
import { HubspotAuditService } from './hubspot-audit.service';
import { BusinessUnitsModule } from '../business-units/business-units.module';
import { CandidateAuditModule } from '../candidate/candidate-audit.module';
import { SyncModule } from '../med-alliance/sync/sync.module';

@Module({
  controllers: [HubspotController],
  providers: [
    HubspotService,
    HandlerObjectCreation,
    HandlerObjectPropertyChange,
    HandlerObjectDeletion,
    HandlerObjectMerge,
    HandlerOrganizationCreation,
    HandlerOrganizationPropertyChange,
    HandlerOrganizationDeletion,
    HandlerOrganizationRestore,
    HandlerOrganizationReactivation,
    HandlerOrganizationMerge,
    HandlerOrganizationAssociationChange,
    HandlerOwnerCreation,
    HandlerOwnerDeletion,
    HandlerOwnerPropertyChange,
    HandlerDealCreation,
    HandlerDealPropertyChange,
    HandlerDealDeletion,
    HandlerDealAssociationChange,
    HandlerTicketCreation,
    HandlerTicketRestore,
    HandlerTicketDeletion,
    HandlerTicketPropertyChange,
    HandlerAffiliateCreation,
    HandlerAffiliateDeletion,
    HandlerAffiliatePropertyChange,
    HandlerAffiliateAssociationChange,
    HireRequestCreationService,
    HireRequestUpdateService,
    OrganizationCreationService,
    OwnerCreationService,
    OrganizationUpdateService,
    ContactCreationService,
    ContactFromCompanyCreationService,
    AffiliateCreationService,
    ContactUpdateService,
    ContactDeleteService,
    HandlerContactCreation,
    HandlerContactPropertyChange,
    HandlerContactDeletion,
    HandlerContactMerge,
    CompanyDeleteService,
    HandlerInvoiceCreation,
    HandlerInvoicePropertyChange,
    HandlerInvoiceAssociationChange,
    HandlerComissionCreation,
    AffiliateUpdateService,
    HubspotAuditService,
  ],
  imports: [
    PrismaModule,
    GoogledriveModule,
    MailModule,
    OrgDeletionModule,
    AllianceNotificationsModule,
    BusinessUnitsModule,
    CandidateAuditModule,
    SyncModule,
    forwardRef(() => CandidatesModule),
    forwardRef(() => OrganizationModule),
    forwardRef(() => HireRequestModule),
  ],
  exports: [
    HubspotService,
    HandlerOrganizationCreation,
    HandlerObjectCreation,
    HandlerDealCreation,
    HireRequestCreationService,
    HireRequestUpdateService,
    AffiliateCreationService,
    AffiliateUpdateService,
    HubspotAuditService,
    HandlerContactDeletion,
  ],
})
export class HubspotModule {}
