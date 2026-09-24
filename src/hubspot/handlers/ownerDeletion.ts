import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserAuditSource } from '@prisma/client';
import {
  USER_AUDIT_EVENTS,
  UserAuditService,
  snapshotUser,
} from '../../user-audit/user-audit.service';

@Injectable()
export class HandlerOwnerDeletion {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userAudit: UserAuditService,
  ) {}

  async execute(event) {
    try {
      const ownerExists = await this.prisma.uSER.findUnique({
        where: {
          hubspot_id: String(event.objectId),
        },
      });
      if (!ownerExists) return;

      // Tombstone commits atomically with the delete.
      await this.prisma.$transaction(async (tx) => {
        await this.userAudit.logOrThrow(
          {
            subject: ownerExists,
            event: USER_AUDIT_EVENTS.DELETED,
            source: UserAuditSource.webhook,
            actorLabel: 'HubSpot',
            oldStatus: ownerExists.status,
            before: snapshotUser(ownerExists),
            metadata: {
              origin: 'hubspot_owner_deletion',
              hubspot_owner_id: String(event.objectId),
            },
          },
          tx,
        );
        await tx.uSER.delete({
          where: {
            id: ownerExists.id,
          },
        });
      });
    } catch (error) {
      throw new BadRequestException('Error deleting owner', error);
    }
  }
}
