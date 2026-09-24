import { BadRequestException, Injectable } from '@nestjs/common';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
  UserAuditSource,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { HubspotAuditService } from '../hubspot-audit.service';
import { UserAuditService } from '../../user-audit/user-audit.service';

@Injectable()
export class HandlerContactDeletion {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: HubspotAuditService,
    private readonly userAudit: UserAuditService,
  ) {}

  async execute(
    event,
    source: HubspotAuditSource = HubspotAuditSource.webhook,
  ) {
    const hubspotContactId = String(event.objectId);
    try {
      const contact = await this.prisma.contact.findUnique({
        where: { hubspot_id: hubspotContactId },
      });

      // USER is looked up independently by hubspot_contact_id (not only via
      // contact.user_id) because the two pointers are denormalized copies
      // that can already be out of sync with each other.
      const user = await this.prisma.uSER.findUnique({
        where: { hubspot_contact_id: hubspotContactId },
      });

      if (!contact && !user) return;

      if (contact) {
        await this.prisma.contact.update({
          where: { id: contact.id },
          data: {
            hubspot_id: null,
            hubspot_id_before_deletion: hubspotContactId,
          },
        });
      }

      if (user) {
        await this.prisma.uSER.update({
          where: { id: user.id },
          data: { hubspot_contact_id: null },
        });
        await this.userAudit.logUpdate({
          before: user,
          after: { hubspot_contact_id: null },
          source:
            source === HubspotAuditSource.webhook
              ? UserAuditSource.webhook
              : source === HubspotAuditSource.cron
                ? UserAuditSource.cron
                : UserAuditSource.system,
          actorLabel: 'HubSpot',
          reason: 'hubspot_contact_deleted',
          metadata: { origin: 'hubspot_contact_deletion' },
        });
      }

      void this.audit.log({
        entityType: HubspotEntityType.contact,
        entityId: contact?.id ?? user?.id ?? hubspotContactId,
        hubspotObjectId: hubspotContactId,
        hubspotObjectType: 'contacts',
        action: HubspotAuditAction.DELETE,
        source,
        success: true,
        payload: {
          contactId: contact?.id ?? null,
          userId: user?.id ?? null,
          clearedStaleId: hubspotContactId,
        },
      });
    } catch (error) {
      throw new BadRequestException(`HandlerContactDeletion: ${error.message}`);
    }
  }
}
