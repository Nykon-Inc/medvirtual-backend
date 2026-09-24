import { BadRequestException, Injectable } from '@nestjs/common';
import axios from 'axios';
import { ownerToDbDictionary } from '../../common/dictionaries/owner-dictionary';
import { mapOwnerToDb } from '../../common/utils/hubspot.util';
import { PrismaService } from '../../prisma/prisma.service';
import { UserAuditSource } from '@prisma/client';
import {
  USER_AUDIT_EVENTS,
  UserAuditService,
} from '../../user-audit/user-audit.service';

@Injectable()
export class HandlerOwnerCreation {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userAudit: UserAuditService,
  ) {}

  async execute(event) {
    const properties = Object.keys(ownerToDbDictionary).join(',');
    try {
      const getObject = await axios.get(
        `https://api.hubapi.com/crm/v3/owner/${event.id}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      if (!getObject) {
        throw new BadRequestException('No object data found');
      }
      console.log('Fetched Owner Data from HubSpot:', getObject.data);
      const ownerData = mapOwnerToDb(getObject.data.results[0].properties);
      ownerData.role = 'system_super_admin';
      ownerData.verified = false;
      ownerData.is_organization_owner = true;
      ownerData.createdByMethod = 'hubspot';

      const ownerExists = await this.prisma.uSER.findUnique({
        where: {
          hubspot_id: String(event.id),
        },
      });
      if (ownerExists)
        throw new BadRequestException('Owner already exists on the database');

      const ownerOrganization = await this.prisma.uSER.create(ownerData);
      if (!ownerOrganization) {
        throw new BadRequestException('Error creating Owner in the database');
      }

      await this.userAudit.log({
        subject: ownerOrganization,
        event: USER_AUDIT_EVENTS.CREATED,
        source: UserAuditSource.webhook,
        actorLabel: 'HubSpot',
        after: {
          status: ownerOrganization.status,
          role: ownerOrganization.role,
        },
        metadata: {
          origin: 'hubspot_owner_creation',
          createdByMethod: 'hubspot',
          hubspot_owner_id: String(event.id),
        },
      });

      return true;
    } catch (error) {
      throw new BadRequestException(
        `Error fetching object creation Owner: ${error.message}`,
      );
    }
  }
}
