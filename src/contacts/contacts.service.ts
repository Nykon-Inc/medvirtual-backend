import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Contact } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { NotFound } from '@aws-sdk/client-s3';

@Injectable()
export class ContactService {
  constructor(private readonly prisma: PrismaService) {}

  private async getHubspotOwnerId(userId: string): Promise<string | null> {
    const user = await this.prisma.uSER.findUnique({
      where: { id: userId },
      select: { hubspot_id: true },
    });
    return user?.hubspot_id ?? null;
  }

  /**
   * Associates the organization's existing HubSpot contacts (contact → company, 279)
   * with a company created after the fact — used to repair organizations whose HubSpot
   * company creation failed while their contact was still created. Contacts come from
   * the org's DB Contact rows plus a HubSpot search by the org's contact_email (referred
   * companies have no DB Contact row). Returns the associated HubSpot contact ids.
   */
  async associateExistingContactsWithCompany(
    orgId: string,
    companyHubspotId: string,
  ): Promise<string[]> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        contact_email: true,
        contacts: { select: { hubspot_id: true } },
      },
    });
    if (!org) throw new NotFoundException('Organization not found');

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    };

    const contactIds = new Set(
      org.contacts.map((c) => c.hubspot_id).filter((id): id is string => !!id),
    );

    if (org.contact_email) {
      const search = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts/search',
        {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: 'email',
                  operator: 'EQ',
                  value: org.contact_email.toLowerCase(),
                },
              ],
            },
          ],
          properties: ['email'],
          limit: 10,
        },
        { headers },
      );
      for (const result of search.data?.results ?? []) {
        contactIds.add(String(result.id));
      }
    }

    for (const contactId of contactIds) {
      await axios.put(
        `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}/associations/companies/${companyHubspotId}/279`,
        {},
        { headers },
      );
    }

    return [...contactIds];
  }

  /**
   * Creates a Contact record in DB and syncs to HubSpot for the common org creation flow.
   * Association: contact → organization only (associationTypeId: 279).
   * Returns null silently if the org has no owner yet (owner_type: 'new' invitation pending).
   */
  async createForOrganization(orgId: string): Promise<Contact | null> {
    console.log(`[ContactService] Creating contact for organization ${orgId}`);
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      include: {
        owner: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            phone: true,
            job_title: true,
          },
        },
        admin: {
          select: { hubspot_id: true },
        },
      },
    });

    console.log(`[ContactService] Fetched organization:`, org);

    if (!org) throw new NotFoundException('Organization not found');

    const hubspotOwnerId = org.admin?.hubspot_id ?? null;
    const accountType =
      org.business_unit === 'MedVirtual'
        ? 'Med Virtual'
        : (org.business_unit ?? 'Not Specified');

    let contact: Contact;
    try {
      contact = await this.prisma.contact.create({
        data: {
          organization_id: orgId,
          first_name: org.contact_first_name,
          last_name: org.contact_last_name,
          email: org.contact_email,
          phone: org.phone,
          job_title: '',
          company_name: org.name,
          business_unit: org.business_unit,
          account_type: accountType,
          hubspot_owner_id: hubspotOwnerId,
        },
      });
      console.log(`[ContactService] Created contact in DB:`, contact);
    } catch {
      throw new BadRequestException('Failed to create contact in DB');
    }

    try {
      const response = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts',
        {
          properties: {
            account_type: accountType,
            firstname: org.contact_first_name,
            lastname: org.contact_last_name,
            email: org.contact_email,
            phone: org.phone ?? '',
            jobtitle: '',
            business_unit:
              org.business_unit === 'Med Virtual'
                ? 'MedVirtual'
                : (org.business_unit ?? ''),
            company: org.name ?? '',
            hubspot_owner_id: hubspotOwnerId ?? undefined,
            demo_owner: hubspotOwnerId ?? undefined,
            title:
              `${org.contact_first_name || ''} ${org.contact_last_name || ''}`.trim(),
          },
          // ⚠️ ASSOCIATION: only contact → organization (without growth partner)
          associations: org.hubspot_id
            ? [
                {
                  to: { id: org.hubspot_id },
                  types: [
                    {
                      associationCategory: 'HUBSPOT_DEFINED',
                      associationTypeId: 279,
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

      await this.prisma.contact.update({
        where: { id: contact.id },
        data: { hubspot_id: response.data.id },
      });

      return { ...contact, hubspot_id: response.data.id };
    } catch (error) {
      const errData = error.response?.data;
      //console.error('[ContactService.createForOrganization] HubSpot sync error:', errData ?? error.message);
      if (errData?.category === 'CONFLICT') {
        //Get existing hubspot_id from error message and update contact, then create association if org.hubspot_id is available
        const match = errData.message?.match(/Existing ID:\s*(\d+)/);
        console.log(
          '[ContactService.createForOrganization] Extracted HubSpot ID from error message:',
          match?.[1] ?? 'No match found',
        );
        const existingHubspotId = match?.[1] ?? null;
        console.log(
          '[ContactService.createForOrganization] Existing HubSpot ID:',
          existingHubspotId,
        );
        if (existingHubspotId) {
          await this.prisma.contact.update({
            where: { id: contact.id },
            data: { hubspot_id: existingHubspotId },
          });
          //send associate post to hubspot
          await axios.put(
            `https://api.hubapi.com/crm/v3/objects/contacts/${existingHubspotId}/associations/companies/${org.hubspot_id}/279`,
            {},
            {
              headers: {
                Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
              },
            },
          );
          return { ...contact, hubspot_id: existingHubspotId };
        }
      }
      console.error(
        '[ContactService.createForOrganization] HubSpot sync failed:',
        errData ?? error.message,
      );
      return contact;
    }
  }

  /**
   * Creates a Contact record in DB and syncs to HubSpot for the referred company creation flow.
   * Associations: contact → organization (279) AND contact → growth partner (120).
   * On HubSpot failure, rolls back the DB contact and re-throws for the caller to handle.
   */
  async createForReferredCompany(
    org: any,
  ): Promise<{ contact: Contact | null; hubspotId: string | null }> {
    let contact: Contact | null = null;

    // referToUser.hubspot_id is already available from the org query in referred-companies.service.ts
    const hubspotOwnerId = org.referToUser?.hubspot_id ?? null;
    const demoOwnerId = org.admin?.hubspot_id ?? null;
    const accountType =
      org.business_unit === 'Med Virtual' ? 'Med Virtual' : 'Berry Virtual';
    const businessUnitHubspot =
      org.business_unit === 'Med Virtual' ? 'MedVirtual' : 'Berry Virtual';

    if (org.owner_id) {
      try {
        contact = await this.prisma.contact.create({
          data: {
            organization_id: org.id,
            user_id: org.owner_id,
            first_name: org.contact_first_name,
            last_name: org.contact_last_name,
            email: org.contact_email ?? org.email,
            phone: org.phone,
            company_name: org.name,
            business_unit: org.business_unit,
            account_type: accountType,
            website_url: org.website_url,
            referral_source: 'Alliance - Partner',
            hubspot_owner_id: hubspotOwnerId,
          },
        });
      } catch {
        // Contact already exists for this user — proceed with HubSpot sync only
      }
    }

    // ⚠️ ASSOCIATIONS: contact → organization (279) + contact → growth partner (120)
    const associations = [
      org.hubspot_id
        ? {
            to: { id: org.hubspot_id },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED',
                associationTypeId: 279,
              },
            ],
          }
        : undefined,
      org.referredByAffiliate?.affiliateProfile?.hubspot_id
        ? {
            to: { id: org.referredByAffiliate.affiliateProfile.hubspot_id },
            types: [
              { associationCategory: 'USER_DEFINED', associationTypeId: 120 },
            ],
          }
        : undefined,
    ].filter(Boolean);

    try {
      const response = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts',
        {
          properties: {
            account_type: accountType,
            firstname: org.contact_first_name,
            lastname: org.contact_last_name,
            email: org.email ?? org.contact_email,
            phone: org.phone ?? '',
            website: org.website_url ?? '',
            jobtitle: org.job_title ?? '',
            business_unit: businessUnitHubspot,
            company: org.name ?? '',
            hubspot_owner_id: hubspotOwnerId ?? undefined,
            demo_owner: demoOwnerId ?? undefined,
            title: `${org.contact_first_name} ${org.contact_last_name}`,
            qualification_status: 'Referral',
            latest_lead_source: 'Referral',
            account_name: org.referredByAffiliate?.affiliateProfile?.full_name,
            account_number:
              org.referredByAffiliate?.affiliateProfile?.hubspot_id,
            alliance_commission:
              org.referredByAffiliate?.affiliateProfile
                ?.commission_percent_default ?? 7,
            growth_partner_company_name:
              org.referredByAffiliate?.organization?.name,
            growth_partner_email_address:
              org.referredByAffiliate?.organization?.email,
            preferred_payment_method:
              org.referredByAffiliate?.affiliateProfile
                ?.payout_preference_method,
            referral_partner:
              org.referredByAffiliate?.affiliateProfile?.full_name,
            referral_partners_email: org.referredByAffiliate?.email,
            referral_source: 'Alliance - Partner',
            referrals_industry:
              org.business_unit === 'Med Virtual' ? 'Medical' : 'Non-Medical',
            referred_to: hubspotOwnerId ?? '',
            type: 'Alliance',
          },
          associations: associations.length > 0 ? associations : undefined,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const hubspotId = response.data?.id ?? null;

      if (contact && hubspotId) {
        await this.prisma.contact.update({
          where: { id: contact.id },
          data: { hubspot_id: hubspotId },
        });
        contact = { ...contact, hubspot_id: hubspotId };
      }

      return { contact, hubspotId };
    } catch (error) {
      if (contact) {
        await this.prisma.contact
          .delete({ where: { id: contact.id } })
          .catch((e) =>
            console.error('[ContactService] Failed to rollback DB contact:', e),
          );
      }
      throw error;
    }
  }

  async deleteById(contactId: string): Promise<void> {
    await this.prisma.contact
      .delete({ where: { id: contactId } })
      .catch((e) =>
        console.error('[ContactService] Failed to delete contact:', e),
      );
  }
}
