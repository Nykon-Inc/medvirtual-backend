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
export class ContactCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: HubspotAuditService,
    private readonly userAudit: UserAuditService,
  ) {}

  async getOwnerId(userId: string): Promise<string | null> {
    if (!userId) return null;
    const user = await this.prisma.uSER.findUnique({
      where: { id: userId },
      select: {
        id: true,
        hubspot_id: true,
        first_name: true,
        last_name: true,
        email: true,
      },
    });

    /* => Commented because we cannot create owners using hubspot API
      if (user && !user.hubspot_id) {
      await this.ownerCreationService.execute(user)
      }
      */

    return user && user.hubspot_id ? user.hubspot_id : null;
  }

  async execute(
    data: any,
    actorUserId?: string,
    reason?: string,
  ): Promise<any> {
    const source = actorUserId
      ? HubspotAuditSource.user_action
      : HubspotAuditSource.cron;
    try {
      const response = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts',
        {
          properties: {
            account_type: data.organization.business_unit
              ? data.organization.business_unit === 'MedVirtual'
                ? 'Med Virtual'
                : data.organization.business_unit
              : 'Not Specified', //business_unit
            firstname: data.first_name,
            lastname: data.last_name,
            email: data.email,
            phone: data.phone || '',
            jobtitle: data.job_title || '',
            business_unit: data.organization.business_unit || '',
            company: data.organization.name || '',
            hubspot_owner_id: data.organization.admin_id
              ? await this.getOwnerId(data.organization.admin_id)
              : undefined,
            demo_owner: data.organization.admin_id
              ? await this.getOwnerId(data.organization.admin_id)
              : undefined,
            title: data.first_name + ' ' + data.last_name,
          },
          associations: data.organization.hubspot_id
            ? [
                {
                  to: { id: data.organization.hubspot_id },
                  types: [
                    {
                      associationCategory: 'HUBSPOT_DEFINED',
                      associationTypeId: 279, // 279 = association contact → organization
                    },
                  ],
                },
              ]
            : undefined,
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
        data: { hubspot_contact_id: response.data.id },
      });

      await this.userAudit.logUpdate({
        before: data,
        after: { hubspot_contact_id: String(response.data.id) },
        source: actorUserId ? UserAuditSource.admin : UserAuditSource.system,
        actorUserId: actorUserId ?? null,
        metadata: { origin: 'hubspot_contact_created' },
      });

      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.contact,
        entityId: data.id,
        hubspotObjectId: response.data.id,
        hubspotObjectType: 'contacts',
        action: HubspotAuditAction.CREATE,
        source,
        success: true,
        payload: { email: data.email, ...(reason && { reason }) },
        response: { id: response.data.id },
      });

      return true;
    } catch (error) {
      if (error.response) {
        console.error('Error to created contact:', error.response.data);
      } else {
        console.error('Connection error:', error.message);
      }
      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.contact,
        entityId: data.id,
        hubspotObjectType: 'contacts',
        action: HubspotAuditAction.CREATE,
        source,
        success: false,
        errorCode: error.response?.status?.toString() ?? error.code,
        errorMessage: error.message,
        payload: { ...(reason && { reason }) },
      });
    }
  }
}
