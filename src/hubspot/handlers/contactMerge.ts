import { BadRequestException, Injectable } from '@nestjs/common';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
  USER,
  UserAuditSource,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { HubspotAuditService } from '../hubspot-audit.service';
import { UserAuditService } from '../../user-audit/user-audit.service';

@Injectable()
export class HandlerContactMerge {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: HubspotAuditService,
    private readonly userAudit: UserAuditService,
  ) {}

  async execute(event) {
    // USER hubspot_contact_id re-points — collected in the tx, audited after it commits.
    const relinked: { before: USER; hubspot_contact_id: string | null }[] = [];
    try {
      await this.prisma.$transaction(async (tx) => {
        const primaryContact = await tx.contact.findUnique({
          where: { hubspot_id: String(event.primaryObjectId) },
        });
        if (!primaryContact) {
          throw new BadRequestException(
            `Primary contact hubspotId=${event.primaryObjectId} not found in database.`,
          );
        }

        // HubSpot sometimes serializes mergedObjectIds as a string
        // (e.g. "[ 123, 456 ]") instead of a real array.
        const mergedObjectIdsList: unknown[] = Array.isArray(
          event.mergedObjectIds,
        )
          ? event.mergedObjectIds
          : String(event.mergedObjectIds)
              .replace(/[[\]]/g, '')
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean);

        const otherMergedIds = mergedObjectIdsList
          .map((id) => String(id))
          .filter((id) => id !== String(event.primaryObjectId));

        const mergedContacts = await tx.contact.findMany({
          where: { hubspot_id: { in: otherMergedIds } },
        });

        await tx.contact.update({
          where: { id: primaryContact.id },
          data: { hubspot_id: String(event.newObjectId) },
        });

        if (primaryContact.user_id) {
          const before = await tx.uSER.findUnique({
            where: { id: primaryContact.user_id },
          });
          await tx.uSER.update({
            where: { id: primaryContact.user_id },
            data: { hubspot_contact_id: String(event.newObjectId) },
          });
          if (before) {
            relinked.push({
              before,
              hubspot_contact_id: String(event.newObjectId),
            });
          }
        }

        for (const merged of mergedContacts) {
          // A Contact is an extension of a specific USER/AffiliateProfile
          // identity (unique 1:1 FK), unlike Organization duplicates — so
          // losing rows are re-pointed and nulled, never hard-deleted, to
          // avoid destroying another user's only link if this ever turns
          // out not to be a true duplicate.
          await tx.affiliateProfile.updateMany({
            where: { contact_id: merged.id },
            data: { contact_id: primaryContact.id },
          });

          if (merged.user_id) {
            const before = await tx.uSER.findUnique({
              where: { id: merged.user_id },
            });
            await tx.uSER.update({
              where: { id: merged.user_id },
              data: { hubspot_contact_id: null },
            });
            if (before) relinked.push({ before, hubspot_contact_id: null });
          }

          await tx.contact.update({
            where: { id: merged.id },
            data: {
              hubspot_id: null,
              hubspot_id_before_deletion: merged.hubspot_id,
            },
          });
        }

        void this.audit.log({
          entityType: HubspotEntityType.contact,
          entityId: primaryContact.id,
          hubspotObjectId: String(event.newObjectId),
          hubspotObjectType: 'contacts',
          action: HubspotAuditAction.SYNC,
          source: HubspotAuditSource.webhook,
          success: true,
          payload: {
            primaryContactId: primaryContact.id,
            mergedContactIds: mergedContacts.map((c) => c.id),
            oldPrimaryHubspotId: String(event.primaryObjectId),
            newHubspotId: String(event.newObjectId),
          },
        });
      });

      await this.userAudit.logMany(
        relinked.flatMap(({ before, hubspot_contact_id }) =>
          this.userAudit.buildUpdateEntries({
            before,
            after: { hubspot_contact_id },
            source: UserAuditSource.webhook,
            actorLabel: 'HubSpot',
            reason: 'hubspot_contact_merged',
            metadata: { origin: 'hubspot_contact_merge' },
          }),
        ),
      );
    } catch (error) {
      throw new BadRequestException(`HandlerContactMerge: ${error.message}`);
    }
  }
}
