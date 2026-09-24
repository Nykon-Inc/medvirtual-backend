import { Injectable } from '@nestjs/common';
import axios from 'axios';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { HubspotAuditService } from '../hubspot-audit.service';
import { BusinessUnitContext } from '../../business-units/business-unit-context.service';

/**
 * HubSpot `business_unit` labels for the two legacy BUs, keyed by the
 * normalized BU name. Used only when the matched BusinessUnit row has no
 * `hubspot_value` yet — without it the outbound value fell back to the display
 * name ("Med Virtual"), which HubSpot rejects with INVALID_OPTION and silently
 * left referred companies without a HubSpot company record.
 */
const LEGACY_HUBSPOT_BUSINESS_UNITS: Record<string, string> = {
  medvirtual: 'MedVirtual',
  berryvirtual: 'Berry Virtual',
};

@Injectable()
export class OrganizationCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: HubspotAuditService,
    private readonly businessUnitContext: BusinessUnitContext,
  ) {}

  /**
   * Normalize the outbound `business_unit` we push to HubSpot for an
   * app-created company. Resolves through `BusinessUnitContext` (the same
   * data-driven table used by the intake gates) so ANY visible BU — not just
   * Med/Berry — round-trips with the exact `hubspot_value` HubSpot expects.
   *
   * Kept behavior-identical for the historical case: the old hardcoded rule
   * only special-cased the literal `'Med Virtual'` (mapping it to
   * `'MedVirtual'`); every other input (including `'MedVirtual'` and
   * `'Berry Virtual'`) passed through unchanged. `resolveByHubspotValue`
   * normalizes spacing/case, so `'Med Virtual'` still resolves to the
   * `hubspot_value` `'MedVirtual'` and Berry/other known values resolve to
   * their own `hubspot_value` — an unrecognized value falls back to the
   * raw input (same as before, no destructive rewrite).
   */
  private async resolveOutboundBusinessUnit(
    businessUnit: string | undefined,
  ): Promise<string> {
    if (!businessUnit) return '';
    const bu =
      await this.businessUnitContext.resolveByHubspotValue(businessUnit);
    if (bu?.hubspot_value) return bu.hubspot_value;
    const fallback = bu?.name ?? businessUnit;
    return (
      LEGACY_HUBSPOT_BUSINESS_UNITS[
        this.businessUnitContext.normalizeBusinessUnit(fallback)
      ] ?? fallback
    );
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

  async getAfiliateId(affiliateId: string): Promise<string | null> {
    if (!affiliateId) return null;
    const affiliate = await this.prisma.affiliateProfile.findUnique({
      where: { user_id: affiliateId },
      select: {
        hubspot_id: true,
      },
    });
    return affiliate && affiliate.hubspot_id ? affiliate.hubspot_id : null;
  }

  async getAffiliateEmail(affiliateUserId: string): Promise<string | null> {
    if (!affiliateUserId) return null;
    const user = await this.prisma.uSER.findUnique({
      where: { id: affiliateUserId },
      select: { email: true },
    });
    return user?.email ?? null;
  }

  /**
   * Creates the HubSpot company for an app-created organization and stores its
   * id on the organization. Returns the HubSpot company id, or null when the
   * creation failed (the failure is logged, never thrown — callers that need the
   * company must check the return value).
   */
  async execute(
    data: any,
    actorUserId?: string,
    reason?: string,
  ): Promise<string | null> {
    const source = actorUserId
      ? HubspotAuditSource.user_action
      : HubspotAuditSource.cron;
    try {
      const businessUnit = await this.resolveOutboundBusinessUnit(
        data.business_unit,
      );
      // Only associate the growth partner when it exists in HubSpot — a null id
      // makes HubSpot reject the whole company creation.
      const growthPartnerHubspotId = data.referred_by_affiliate_id
        ? await this.getAfiliateId(data.referred_by_affiliate_id)
        : null;
      const response = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/companies',
        {
          properties: {
            name: data.name,
            about_us: data.description,
            address: data.address,
            city: data.city,
            state: data.state || '',
            zip: data.postal_code || '',
            country: data.location || '',
            domain: data.website_url || '',
            description: data.description || '',
            //industry: data.industry || '',
            numberofemployees: Number(data.number_of_employees),
            phone: data.phone || '',
            referral_email: data.email || '',
            type: data.type || '',
            business_unit: businessUnit,
            hubspot_owner_id: data.admin_id
              ? await this.getOwnerId(data.admin_id)
              : undefined,
            referral_source: data.referred_by_affiliate_id
              ? 'Alliance Partner'
              : undefined,
            referral_partners_email: data.referred_by_affiliate_id
              ? await this.getAffiliateEmail(data.referred_by_affiliate_id)
              : undefined,
          },
          associations: growthPartnerHubspotId
            ? [
                {
                  to: {
                    id: growthPartnerHubspotId,
                  },
                  types: [
                    {
                      associationCategory: 'USER_DEFINED',
                      associationTypeId: 118, // 118 = association company → growth Partner (affiliate)
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

      //update organization with the hubspot_id
      await this.prisma.organization.update({
        where: { id: data.id },
        data: { hubspot_id: response.data.id },
      });

      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.organization,
        entityId: data.id,
        hubspotObjectId: response.data.id,
        hubspotObjectType: 'companies',
        action: HubspotAuditAction.CREATE,
        source,
        success: true,
        payload: { name: data.name, ...(reason && { reason }) },
        response: { id: response.data.id },
      });

      return String(response.data.id);
    } catch (error) {
      if (error.response) {
        console.error('Error to created organization:', error.response.data);
      } else {
        console.error('Connection error:', error.message);
      }
      void this.audit.log({
        actorUserId,
        entityType: HubspotEntityType.organization,
        entityId: data.id,
        hubspotObjectType: 'companies',
        action: HubspotAuditAction.CREATE,
        source,
        success: false,
        errorCode: error.response?.status?.toString() ?? error.code,
        // HubSpot's validation detail lives in the response body — error.message
        // is only the generic "Request failed with status code 400".
        errorMessage: error.response?.data?.message ?? error.message,
        payload: { ...(reason && { reason }) },
        response: error.response?.data,
      });
      return null;
    }
  }
}
