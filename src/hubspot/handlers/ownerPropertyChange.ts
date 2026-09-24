import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { HandlerOwnerCreation } from './ownerCreation';
import { ownerToDbDictionary } from '../../common/dictionaries/owner-dictionary';
import { UserAuditSource } from '@prisma/client';
import { UserAuditService } from '../../user-audit/user-audit.service';

@Injectable()
export class HandlerOwnerPropertyChange {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerCreation: HandlerOwnerCreation,
    private readonly userAudit: UserAuditService,
  ) {}

  async execute(event) {
    const owner = await this.prisma.uSER.findUnique({
      where: {
        hubspot_id: String(event.objectId),
      },
    });

    if (!owner) return await this.ownerCreation.execute(event);

    const fieldExists = Object.keys(ownerToDbDictionary).includes(
      event.propertyName,
    );
    if (!fieldExists) return;

    const fieldUpdated = ownerToDbDictionary[event.propertyName];

    const updated = await this.prisma.uSER.update({
      where: {
        id: owner.id,
      },
      data: {
        [fieldUpdated]: event.propertyValue,
      },
    });

    await this.userAudit.logUpdate({
      before: owner,
      after: updated,
      source: UserAuditSource.webhook,
      actorLabel: 'HubSpot',
      metadata: {
        origin: 'hubspot_owner_property_change',
        hubspot_property: event.propertyName,
      },
    });

    return true;
  }
}
