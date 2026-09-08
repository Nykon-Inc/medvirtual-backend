import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { HandlerOrganizationCreation } from './organizationCreation';
import { organizationToDbDictionary } from '../../common/dictionaries/organization-dictionary';
import { HandlerOrganizationDeletion } from './organizationDeletion';
import { HandlerOrganizationReactivation } from './organizationReactivation';
import { OrganizationRole, OrganizationStatus } from '@prisma/client';
import { organizationIndustryToDbDictionary } from '../../common/dictionaries/organizationIndustry-dictionary';
import { BusinessUnitContext } from '../../business-units/business-unit-context.service';

@Injectable()
export class HandlerOrganizationPropertyChange {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizationCreation: HandlerOrganizationCreation,
    private readonly organizationDeletion: HandlerOrganizationDeletion,
    private readonly organizationReactivation: HandlerOrganizationReactivation,
    private readonly businessUnitContext: BusinessUnitContext,
  ) {}

  async execute(event) {
    let owner;
    const organization = await this.prisma.organization.findUnique({
      where: {
        hubspot_id: String(event.objectId),
      },
    });

    //Here I dont need to check if the organization is a client of MedVirtual, because inside the organizationCreation handler it already does that
    if (!organization) return await this.organizationCreation.execute(event);

    // A business_unit outside the valid brands soft-deletes the org; when it
    // changes back to a valid value we must reactivate a previously deleted org.
    if (event.propertyName === 'business_unit') {
      const isValidBusinessUnit =
        await this.businessUnitContext.isAllowedHubspotValue(
          event.propertyValue,
        );

      if (!isValidBusinessUnit) {
        return await this.organizationDeletion.execute(event);
      }

      if (organization.status === OrganizationStatus.deleted) {
        return await this.organizationReactivation.execute(event);
      }
      // else: valid business_unit, org not deleted -> fall through to generic update below
    }

    const fieldExists = Object.keys(organizationToDbDictionary).includes(
      event.propertyName,
    );
    if (!fieldExists && event.propertyName !== 'hubspot_owner_id') return;

    const fieldUpdated = organizationToDbDictionary[event.propertyName];
    let value = event.propertyValue;

    if (fieldUpdated === 'organization_role') {
      if (event.propertyValue.toLowerCase() === 'prospect') {
        value = OrganizationRole.prospect;
      } else {
        value = OrganizationRole.client;
      }
    }

    if (fieldUpdated === 'industry') {
      value = event.propertyValue
        ? (organizationIndustryToDbDictionary[event.propertyValue] ?? '')
        : '';
    }

    if (fieldUpdated === 'specialties') {
      value = event.propertyValue
        ?.split(',')
        .map((item: string) => item.trim())
        .filter((item: string) => item.length > 0);
    }

    if (fieldUpdated === 'number_of_employees') {
      value = event.propertyValue ? Number(event.propertyValue) : null;
    }

    if (fieldUpdated === 'deployment_date') {
      value = event.propertyValue
        ? new Date(Number(event.propertyValue))
        : null;
    }

    if (event.propertyName === 'hubspot_owner_id') {
      //check if the owner exists in the system
      owner = await this.prisma.uSER.findUnique({
        where: {
          hubspot_id: String(event.propertyValue),
        },
        select: {
          id: true,
        },
      });

      if (owner) {
        //if owner exists, update the organization admin with the new owner
        await this.prisma.organization.update({
          where: {
            id: organization.id,
          },
          data: {
            admin: { connect: { id: owner.id } },
          },
        });
      }
      return true;
    }

    // For deployment_date, fetch state needed for the eligibility branch BEFORE the generic
    // update below overwrites deployment_date — we need the prior value to detect a no-op
    // (unchanged) HubSpot re-delivery, which must never overwrite a manual admin decision.
    let priorDeploymentDate: Date | null = null;
    let referredByAffiliateId: string | null = null;
    let priorStatus: string | null = null;
    let priorStage: string | null = null;
    if (fieldUpdated === 'deployment_date') {
      const fullOrg = await this.prisma.organization.findUnique({
        where: { id: organization.id },
        select: {
          referred_by_affiliate_id: true,
          deployment_date: true,
          med_alliance_referral_status: true,
          referral_stage: true,
        },
      });
      priorDeploymentDate = fullOrg?.deployment_date ?? null;
      referredByAffiliateId = fullOrg?.referred_by_affiliate_id ?? null;
      priorStatus = fullOrg?.med_alliance_referral_status ?? null;
      priorStage = fullOrg?.referral_stage ?? null;
    }

    if (event.propertyName !== 'hubspot_owner_id') {
      await this.prisma.organization.update({
        where: {
          id: organization.id,
        },
        data: {
          [fieldUpdated]: value,
        },
      });
    }

    if (fieldUpdated === 'deployment_date') {
      if (!referredByAffiliateId) return true;

      // A deleted org must never re-enter the referral pipeline via a stray
      // deployment_date webhook — reactivation is the only way back.
      if (organization.status === OrganizationStatus.deleted) return true;

      // No-op guard: HubSpot can re-deliver a webhook for a value that hasn't actually changed.
      // Never let that spurious re-delivery overwrite a manual admin decision (eligible/not_eligible).
      const unchanged =
        (value === null && priorDeploymentDate === null) ||
        (value !== null &&
          priorDeploymentDate !== null &&
          (value as Date).getTime() === priorDeploymentDate.getTime());
      if (unchanged) return true;

      const now = new Date();

      if (value === null) {
        // deployment_date cleared — company goes back into negotiation.
        // DISABLED (per-collaborator commission plan, company-eligibility-manual-only
        // change, spec doc §4.6): med_alliance_referral_status is no longer auto-set here
        // — it's exclusively a manual admin decision via Confirm/Block. referral_stage
        // itself stays automatic (it's the prerequisite signal that surfaces a company for
        // the admin's decision, not the decision itself).
        await this.prisma.organization.update({
          where: { id: organization.id },
          data: {
            referral_stage: 'in_negotiation' as any,
            // med_alliance_referral_status: 'pending_confirmation' as any,
            eligibility_start_at: null,
            med_alliance_block_reason: null,
          },
        });

        await this.prisma.medAllianceAuditLog.create({
          data: {
            entity_type: 'referred_company',
            entity_id: organization.id,
            event: 'deployment_date_cleared',
            old_status: priorStatus,
            // new_status intentionally null — med_alliance_referral_status is no longer
            // auto-set here (§4.6); only referral_stage/eligibility_start_at changed.
            new_status: null,
            reason: 'deployment_date removed in HubSpot — reopened for review',
            source: 'sync',
            actor_user_id: null,
            metadata: {
              referral_stage: 'in_negotiation',
              prior_stage: priorStage,
            } as any,
          },
        });
      } else {
        const deployDate = value as Date;
        const daysSinceDeploy =
          (now.getTime() - deployDate.getTime()) / (24 * 60 * 60 * 1000);

        if (daysSinceDeploy > 365) {
          // More than 365 days in the past.
          // DISABLED (spec doc §4.6): this used to auto-set med_alliance_referral_status
          // ='expired' directly, skipping the admin's decision window entirely — the most
          // damaging of the three branches, since the company never got a pending_confirmation
          // state to react to. Status is now exclusively a manual admin decision. referral_stage
          // /eligibility_start_at stay automatic — they surface the company as deployed so the
          // admin's Confirm/Block buttons become reachable.
          await this.prisma.organization.update({
            where: { id: organization.id },
            data: {
              referral_stage: 'deployed' as any,
              // med_alliance_referral_status: 'expired' as any,
              eligibility_start_at: deployDate,
              med_alliance_block_reason: null,
            },
          });

          await this.prisma.medAllianceAuditLog.create({
            data: {
              entity_type: 'referred_company',
              entity_id: organization.id,
              // Renamed from 'eligibility_expired' — no status transition happens here
              // anymore (§4.6); this logs the automatic deployed-stage detection only.
              event: 'deployed_stage_detected_over_365_days',
              old_status: priorStatus,
              // new_status intentionally null — med_alliance_referral_status is no longer
              // auto-set; the admin must Confirm/Block explicitly once the company shows
              // as deployed.
              new_status: null,
              reason:
                'deployment_date synced from HubSpot — already more than 365 days in the past; admin decision required (status is manual-only)' +
                (priorStage === 'canceled'
                  ? ' — company re-opened from canceled'
                  : ''),
              source: 'sync',
              actor_user_id: null,
              metadata: {
                deployment_date: deployDate.toISOString(),
                prior_stage: priorStage,
              } as any,
            },
          });
        } else {
          // Within 365 days in the past, or a future date.
          // DISABLED (spec doc §4.6): med_alliance_referral_status is no longer auto-set —
          // exclusively a manual admin decision. referral_stage/eligibility_start_at stay
          // automatic (approveEligibility rejects future dates itself, and requires
          // referral_stage='deployed' server-side before Confirm/Block are reachable).
          await this.prisma.organization.update({
            where: { id: organization.id },
            data: {
              referral_stage: 'deployed' as any,
              // med_alliance_referral_status: 'pending_confirmation' as any,
              eligibility_start_at: deployDate,
              med_alliance_block_reason: null,
            },
          });

          await this.prisma.medAllianceAuditLog.create({
            data: {
              entity_type: 'referred_company',
              entity_id: organization.id,
              // Renamed from 'eligibility_pending_confirmation' — no status transition
              // happens here anymore (§4.6); this logs the automatic deployed-stage
              // detection only.
              event: 'deployed_stage_detected',
              old_status: priorStatus,
              // new_status intentionally null — see the >365-days branch above.
              new_status: null,
              reason:
                'deployment_date synced from HubSpot deploy_date_of_first_va; admin decision required (status is manual-only)' +
                (priorStage === 'canceled'
                  ? ' — company re-opened from canceled'
                  : ''),
              source: 'sync',
              actor_user_id: null,
              metadata: {
                deployment_date: deployDate.toISOString(),
                prior_stage: priorStage,
              } as any,
            },
          });
        }
      }
    }

    return true;
  }
}
