import { Injectable } from '@nestjs/common';
import axios from 'axios';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OwnerCreationService } from '../create/Owner';
import { HubspotAuditService } from '../hubspot-audit.service';

@Injectable()
export class OrganizationUpdateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerCreationService: OwnerCreationService,
    private readonly audit: HubspotAuditService,
  ) {}

  private async getAffiliateHubspotId(
    affiliateUserId: string,
  ): Promise<string | null> {
    if (!affiliateUserId) return null;
    const profile = await this.prisma.affiliateProfile.findUnique({
      where: { user_id: affiliateUserId },
      select: { hubspot_id: true },
    });
    return profile?.hubspot_id ?? null;
  }

  private async getAffiliateEmail(
    affiliateUserId: string,
  ): Promise<string | null> {
    if (!affiliateUserId) return null;
    const user = await this.prisma.uSER.findUnique({
      where: { id: affiliateUserId },
      select: { email: true },
    });
    return user?.email ?? null;
  }

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
      const hubspotProperties: Record<string, any> = {};
      //We are using just hubspot_owner_id because it's the only field that we need to update in hire request for now
      hubspotProperties.hubspot_owner_id = data.admin.id
        ? await this.getOwnerId(data.admin.id)
        : undefined;

      //console.log(hubspotProperties)
      const response = await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/companies/${Number(data.hubspot_id)}`,
        {
          properties: hubspotProperties,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.organization,
        entityId: data.id ?? data.hubspot_id,
        hubspotObjectId: data.hubspot_id,
        hubspotObjectType: 'companies',
        action: HubspotAuditAction.UPDATE,
        source,
        success: true,
        payload: {
          fields: Object.keys(hubspotProperties),
          ...(reason && { reason }),
        },
      });

      return true;
    } catch (error) {
      if (error.response) {
        console.error('Error to update organization:', error.response.data);
      } else {
        console.error('Connection error:', error.message);
      }
      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.organization,
        entityId: data.id ?? data.hubspot_id,
        hubspotObjectId: data.hubspot_id,
        hubspotObjectType: 'companies',
        action: HubspotAuditAction.UPDATE,
        source,
        success: false,
        errorCode: error.response?.status?.toString() ?? error.code,
        errorMessage: error.message,
        payload: { ...(reason && { reason }) },
      });
    }
  }

  async setHubstaffProjectId(
    organizationId: string,
    hubstaffId: string | null,
    actorUserId?: string,
    reason?: string,
  ): Promise<void> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { hubspot_id: true },
    });
    if (!org?.hubspot_id) return;

    const source = actorUserId
      ? HubspotAuditSource.user_action
      : HubspotAuditSource.cron;

    try {
      await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/companies/${Number(org.hubspot_id)}`,
        {
          properties: {
            // HubSpot clears a property when it receives an empty string, not null
            hubspot_project_id: hubstaffId ?? '',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );
      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.organization,
        entityId: organizationId,
        hubspotObjectId: org.hubspot_id,
        hubspotObjectType: 'companies',
        action: HubspotAuditAction.UPDATE,
        source,
        success: true,
        payload: {
          fields: ['hubspot_project_id'],
          ...(reason && { reason }),
        },
      });
    } catch (error) {
      if (error.response) {
        console.error(
          'Error to update hubspot_project_id:',
          error.response.data,
        );
      } else {
        console.error('Connection error:', error.message);
      }
      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.organization,
        entityId: organizationId,
        hubspotObjectId: org.hubspot_id,
        hubspotObjectType: 'companies',
        action: HubspotAuditAction.UPDATE,
        source,
        success: false,
        errorCode: error.response?.status?.toString() ?? error.code,
        errorMessage: error.message,
        payload: { ...(reason && { reason }) },
      });
    }
  }

  async setAffiliateReferral(
    organizationId: string,
    affiliateUserId: string,
    actorUserId?: string,
    reason?: string,
  ): Promise<void> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { hubspot_id: true },
    });
    if (!org?.hubspot_id) return;

    const [affiliateEmail, affiliateHubspotId] = await Promise.all([
      this.getAffiliateEmail(affiliateUserId),
      this.getAffiliateHubspotId(affiliateUserId),
    ]);

    const source = actorUserId
      ? HubspotAuditSource.user_action
      : HubspotAuditSource.cron;

    try {
      await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/companies/${Number(org.hubspot_id)}`,
        {
          properties: {
            referral_source: 'Referral - Partner',
            referral_partners_email: affiliateEmail ?? '',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );
      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.organization,
        entityId: organizationId,
        hubspotObjectId: org.hubspot_id,
        hubspotObjectType: 'companies',
        action: HubspotAuditAction.UPDATE,
        source,
        success: true,
        payload: {
          fields: ['referral_source', 'referral_partners_email'],
          ...(reason && { reason }),
        },
      });
    } catch (error) {
      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.organization,
        entityId: organizationId,
        hubspotObjectId: org.hubspot_id,
        hubspotObjectType: 'companies',
        action: HubspotAuditAction.UPDATE,
        source,
        success: false,
        errorCode: error.response?.status?.toString() ?? error.code,
        errorMessage: error.message,
        payload: { ...(reason && { reason }) },
      });
    }

    if (!affiliateHubspotId) return;
    try {
      await axios.put(
        `https://api.hubapi.com/crm/v4/objects/companies/${Number(org.hubspot_id)}/associations/p20630393_growth_partners/${Number(affiliateHubspotId)}`,
        [{ associationCategory: 'USER_DEFINED', associationTypeId: 118 }],
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );
    } catch (error) {
      console.error(
        'Failed to create HubSpot company→affiliate association:',
        error.response?.data ?? error.message,
      );
    }
  }
}
