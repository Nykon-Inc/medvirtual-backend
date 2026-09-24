import { BadRequestException, Injectable } from '@nestjs/common';
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
export class AffiliateCreationService {
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

    return user && user.hubspot_id ? user.hubspot_id : null;
  }

  async createContactAndLinkToGrowthPartner(
    userId: string,
    firstName: string,
    lastName: string,
    email: string,
    growthPartnerHubspotId: string | null,
    phone?: string,
    companyName?: string,
  ): Promise<void> {
    try {
      let existingContactId: string | null = null;
      if (growthPartnerHubspotId) {
        const gpResponse = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/${process.env.HUBSPOT_GROWTH_PARTNER_CUSTOM_OBJECT}/${growthPartnerHubspotId}?associations=contacts`,
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            },
          },
        );
        existingContactId =
          gpResponse.data.associations?.contacts?.results?.[0]?.id ?? null;
      }

      const contactId = await this.ensureContact(
        userId,
        firstName,
        lastName,
        email,
        existingContactId,
        phone,
        companyName,
      );

      if (contactId && existingContactId) {
        await this.setUserHubspotContact(
          userId,
          contactId,
          'affiliate_contact_link',
        );
        await this.prisma.contact.updateMany({
          where: { user_id: userId, hubspot_id: null },
          data: { hubspot_id: contactId },
        });
      }

      // Link contact directly to AffiliateProfile regardless of whether it was new or reused
      if (contactId && growthPartnerHubspotId) {
        const dbContact = await this.prisma.contact.findUnique({
          where: { hubspot_id: contactId },
          select: { id: true },
        });
        if (dbContact) {
          await this.prisma.affiliateProfile.updateMany({
            where: { hubspot_id: growthPartnerHubspotId, contact_id: null },
            data: { contact_id: dbContact.id },
          });
        }
      }

      if (contactId && growthPartnerHubspotId && !existingContactId) {
        await axios.put(
          `https://api.hubapi.com/crm/v4/objects/p20630393_growth_partners/${growthPartnerHubspotId}/associations/contacts/${contactId}`,
          [{ associationCategory: 'USER_DEFINED', associationTypeId: 119 }],
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          },
        );
      }
    } catch (error) {
      console.error(
        '[HubSpot] Failed to create contact / link to growth partner:',
        error?.response?.data ?? error?.message,
      );
    }
  }

  private isNotFound(error: any): boolean {
    return error?.response?.status === 404;
  }

  private isConflict(error: any): boolean {
    return (
      error?.response?.status === 409 ||
      error?.response?.data?.category === 'CONFLICT'
    );
  }

  /** Writes USER.hubspot_contact_id and records the link change on the user audit trail. */
  private async setUserHubspotContact(
    userId: string,
    contactId: string,
    origin: string,
  ): Promise<void> {
    const before = await this.prisma.uSER.findUnique({ where: { id: userId } });
    await this.prisma.uSER.update({
      where: { id: userId },
      data: { hubspot_contact_id: contactId },
    });
    if (before) {
      await this.userAudit.logUpdate({
        before,
        after: { hubspot_contact_id: contactId },
        source: UserAuditSource.system,
        actorLabel: 'HubSpot sync',
        metadata: { origin },
      });
    }
  }

  private async relinkContact(
    userId: string,
    contactId: string,
  ): Promise<void> {
    await this.setUserHubspotContact(
      userId,
      contactId,
      'affiliate_contact_relink',
    );

    // Always overwrite (not just when null) — a non-null hubspot_id here can
    // itself be stale (contact deleted/merged in HubSpot), and leaving it in
    // place would silently keep the drift this relink is meant to fix.
    await this.prisma.contact.updateMany({
      where: { user_id: userId },
      data: { hubspot_id: contactId },
    });
  }

  private async findContactIdByEmail(email: string): Promise<string | null> {
    try {
      const response = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts/search',
        {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: 'email',
                  operator: 'EQ',
                  value: email.toLowerCase(),
                },
              ],
            },
          ],
          limit: 1,
          properties: ['email'],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );
      return response.data?.results?.[0]?.id ?? null;
    } catch {
      // Search failing should not itself throw — caller treats null as "not found".
      return null;
    }
  }

  private async ensureContact(
    userId: string,
    firstName: string,
    lastName: string,
    email: string,
    existingContactId: string | null,
    phone?: string,
    companyName?: string,
    actorUserId?: string,
    source?: HubspotAuditSource,
  ): Promise<string | null> {
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    };
    const contactProperties = {
      qualification_status: 'Referral',
      latest_lead_source: 'Referral',
    };

    if (existingContactId) {
      try {
        // Update existing contact with Referral qualification and lead source
        await axios.patch(
          `https://api.hubapi.com/crm/v3/objects/contacts/${existingContactId}`,
          { properties: contactProperties },
          { headers },
        );
        return existingContactId;
      } catch (error) {
        if (!this.isNotFound(error)) throw error;

        // Stale hubspot_contact_id (contact deleted/merged in HubSpot — BR-9).
        // Recover by email instead of failing the whole action.
        const foundId = await this.findContactIdByEmail(email);
        if (foundId) {
          await axios.patch(
            `https://api.hubapi.com/crm/v3/objects/contacts/${foundId}`,
            { properties: contactProperties },
            { headers },
          );
          await this.relinkContact(userId, foundId);
          void this.audit.log({
            actorUserId,
            entityType: HubspotEntityType.contact,
            entityId: userId,
            hubspotObjectId: foundId,
            hubspotObjectType: 'contacts',
            action: HubspotAuditAction.UPDATE,
            source: source ?? HubspotAuditSource.user_action,
            success: true,
            payload: {
              email,
              recovery: 'stale_contact_id',
              staleId: existingContactId,
            },
          });
          return foundId;
        }
        // No contact found by email either — fall through to create below.
      }
    }

    try {
      const response = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts',
        {
          properties: {
            firstname: firstName,
            lastname: lastName,
            email: email,
            phone: phone ?? '',
            company: companyName ?? '',
            ...contactProperties,
          },
        },
        { headers },
      );

      const contactId: string = response.data.id;
      await this.relinkContact(userId, contactId);
      return contactId;
    } catch (error) {
      if (!this.isConflict(error)) throw error;

      // HubSpot already has a contact with this email but we had no id on record.
      const foundId = await this.findContactIdByEmail(email);
      if (!foundId) throw error; // conflict claimed but unrecoverable — propagate

      await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${foundId}`,
        { properties: contactProperties },
        { headers },
      );
      await this.relinkContact(userId, foundId);
      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.contact,
        entityId: userId,
        hubspotObjectId: foundId,
        hubspotObjectType: 'contacts',
        action: HubspotAuditAction.UPDATE,
        source: source ?? HubspotAuditSource.user_action,
        success: true,
        payload: { email, recovery: 'untracked_duplicate_conflict' },
      });
      return foundId;
    }
  }

  async execute(data: any, actorUserId?: string): Promise<any> {
    const source = actorUserId
      ? HubspotAuditSource.user_action
      : HubspotAuditSource.cron;
    try {
      const contactHubspotId = await this.ensureContact(
        data.user.id,
        data.user.first_name,
        data.user.last_name,
        data.user.email,
        data.user.hubspot_contact_id ?? null,
        data.user.phone ?? undefined,
        data.user.contact?.company_name ?? undefined,
        actorUserId,
        source,
      );

      const associations: {
        to: { id: number };
        types: { associationCategory: string; associationTypeId: number }[];
      }[] = [];

      if (contactHubspotId) {
        associations.push({
          to: { id: Number(contactHubspotId) },
          types: [
            { associationCategory: 'USER_DEFINED', associationTypeId: 119 },
          ],
        });
      }

      if (data.user.organization?.hubspot_id) {
        associations.push({
          to: { id: Number(data.user.organization.hubspot_id) },
          types: [
            { associationCategory: 'USER_DEFINED', associationTypeId: 117 },
          ],
        });
      }

      const response = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/p20630393_growth_partners',
        {
          properties: {
            growth_partner_name:
              data.user.first_name + ' ' + data.user.last_name,
            growth_partner_email_address: data.user.email,
            hs_pipeline: '883841953',
            hs_pipeline_stage:
              data.status === 'invited' ? '1329066003' : '1329693870', //if invited, set to "Prospect", otherwise set to "Active"
            business_unit: data.user.organization?.business_unit,
            growth_partner_company_name: data.user.organization?.name,
            alliance_commission: 7,
            attribution_information: 'Alliance Partner',
            earning_status: 'Active',
            hubspot_owner_id: data.created_by
              ? await this.getOwnerId(data.created_by)
              : null,
            referral_role: 'Alliance Partner',
          },
          associations: associations.length ? associations : undefined,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      await this.prisma.affiliateProfile.update({
        where: { id: data.id },
        data: { hubspot_id: response.data.id },
      });

      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.affiliate,
        entityId: data.id,
        hubspotObjectId: response.data.id,
        hubspotObjectType: 'p20630393_growth_partners',
        action: HubspotAuditAction.CREATE,
        source,
        success: true,
        payload: { email: data.user.email },
        response: { id: response.data.id },
      });

      return true;
    } catch (error) {
      if (error.response) {
        console.error('Error creating affiliate:', error.response.data);
        void this.audit.log({
          actorUserId,
          entityType: HubspotEntityType.affiliate,
          entityId: data.id,
          hubspotObjectType: 'p20630393_growth_partners',
          action: HubspotAuditAction.CREATE,
          source,
          success: false,
          errorCode: error.response?.status?.toString(),
          errorMessage: error.message,
        });
        throw new BadRequestException(
          'Failed to create Growth Partner in Hubspot. Your affiliate profile has not been created. Please try again later.',
        );
      } else {
        console.error('Connection error:', error.message);
        void this.audit.log({
          actorUserId,
          entityType: HubspotEntityType.affiliate,
          entityId: data.id,
          hubspotObjectType: 'p20630393_growth_partners',
          action: HubspotAuditAction.CREATE,
          source,
          success: false,
          errorCode: error.code,
          errorMessage: error.message,
        });
        throw new BadRequestException(
          'Failed to create Growth Partner in Hubspot. Your affiliate profile has not been created. Please try again later.',
        );
      }
    }
  }
}
