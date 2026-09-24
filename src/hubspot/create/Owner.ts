import { Injectable } from '@nestjs/common';
import axios from 'axios';
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
export class OwnerCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: HubspotAuditService,
    private readonly userAudit: UserAuditService,
  ) {}

  async execute(data: any, actorUserId?: string): Promise<any> {
    const source = actorUserId
      ? HubspotAuditSource.user_action
      : HubspotAuditSource.cron;
    try {
      const response = await axios.post(
        'https://api.hubapi.com/crm/v3/owners',
        {
          properties: {
            firstname: data.first_name,
            lastname: data.last_name,
            email: data.email,
            type: 'PERSON',
          },
          associations: [],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      await this.prisma.uSER.update({
        where: { id: data.id },
        data: { hubspot_id: response.data.id },
      });

      await this.userAudit.logUpdate({
        before: data,
        after: { hubspot_id: String(response.data.id) },
        source: actorUserId ? UserAuditSource.admin : UserAuditSource.system,
        actorUserId: actorUserId ?? null,
        metadata: { origin: 'hubspot_owner_created' },
      });

      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.owner,
        entityId: data.id,
        hubspotObjectId: response.data.id,
        hubspotObjectType: 'owners',
        action: HubspotAuditAction.CREATE,
        source,
        success: true,
        payload: { email: data.email },
        response: { id: response.data.id },
      });

      return true;
    } catch (error) {
      if (error.response) {
        console.error('Error to created OWNER:', error.response.data);
      } else {
        console.error('Connection error:', error.message);
      }
      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.owner,
        entityId: data.id,
        hubspotObjectType: 'owners',
        action: HubspotAuditAction.CREATE,
        source,
        success: false,
        errorCode: error.response?.status?.toString() ?? error.code,
        errorMessage: error.message,
      });
    }
  }
}
