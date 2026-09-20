import { BadRequestException, Injectable } from '@nestjs/common';

import {
  mapDbToOrganization,
  mapOrganizationToDb,
} from '../../common/utils/hubspot.util';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class HandlerOrganizationMerge {
  constructor(private readonly prisma: PrismaService) {}

  private mergeOrganizationData(primary: any, merged: any): Partial<any> {
    const mergedAsHubspot = mapDbToOrganization(merged);

    const dbMapped = mapOrganizationToDb(mergedAsHubspot);

    const updateData: Record<string, any> = {};

    for (const [key, value] of Object.entries(dbMapped)) {
      const primaryValue = primary[key];
      if (
        (primaryValue === null ||
          primaryValue === undefined ||
          primaryValue === '') &&
        value
      ) {
        updateData[key] = value;
      }
    }
    return updateData;
  }

  async execute(event) {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const primaryOrganization = await tx.organization.findUnique({
            where: { hubspot_id: String(event.primaryObjectId) },
          });
          if (!primaryOrganization) {
            throw new BadRequestException(
              `Primary company hubspotId=${event.primaryObjectId} not found in database.`,
            );
          }

          // HubSpot sometimes serializes mergedObjectIds as a string
          // (e.g. "[ 123, 456 ]") instead of a real array.
          const mergedObjectIdsList: unknown[] = Array.isArray(
            event.mergedObjectIds,
          )
            ? event.mergedObjectIds
            : String(event.mergedObjectIds)
                .replace(/[[\]]/g, '')
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean);

          const otherMergedIds = mergedObjectIdsList
            .map((id) => String(id))
            .filter((id) => id !== String(event.primaryObjectId));

          const mergedCompanies = await tx.organization.findMany({
            where: {
              hubspot_id: { in: otherMergedIds },
            },
          });

          if (mergedCompanies.length === 0) {
            throw new BadRequestException(
              `No merged companies found with the provided HubSpot IDs.`,
            );
          }

          let dataToUpdate: Record<string, any> = {};
          for (const merged of mergedCompanies) {
            const partialUpdate = this.mergeOrganizationData(
              primaryOrganization,
              merged,
            );

            dataToUpdate = {
              ...dataToUpdate,
              ...partialUpdate,
            };
          }

          if (Object.keys(dataToUpdate).length > 0) {
            await tx.organization.update({
              where: { hubspot_id: String(event.primaryObjectId) },
              data: dataToUpdate,
            });
          }

          await tx.organization.update({
            where: { hubspot_id: String(event.primaryObjectId) },
            data: {
              hubspot_id: String(event.newObjectId),
            },
          });

          for (const merged of mergedCompanies) {
            //update staffs from merged companies to primary company
            await tx.staff.updateMany({
              where: { organization_id: merged.id },
              data: {
                organization_id: primaryOrganization.id,
                hubspot_organization_id: String(event.newObjectId),
              },
            });

            //update candidates from merged companies to primary company
            await tx.candidate.updateMany({
              where: { organization_id: merged.id },
              data: { organization_id: primaryOrganization.id },
            });

            //update users from merged companies to primary company
            await tx.uSER.updateMany({
              where: { organization_id: merged.id },
              data: {
                organization_id: primaryOrganization.id,
                organization_name: primaryOrganization.name,
              },
            });

            //update hire requests from merged companies to primary company
            await tx.hireRequest.updateMany({
              where: { org_id: merged.id },
              data: { org_id: primaryOrganization.id },
            });

            //update tickets from merged companies to primary company
            //(Ticket.org_id has onDelete: Cascade — must be reassigned here or it
            //would be silently deleted along with the merged organization below)
            await tx.ticket.updateMany({
              where: { org_id: merged.id },
              data: { org_id: primaryOrganization.id },
            });

            //update contacts from merged companies to primary company
            await tx.contact.updateMany({
              where: { organization_id: merged.id },
              data: { organization_id: primaryOrganization.id },
            });

            //update organization-candidate links from merged companies to primary company
            await tx.organizationCandidate.updateMany({
              where: { organization_id: merged.id },
              data: { organization_id: primaryOrganization.id },
            });

            //update hubspot invoice snapshots from merged companies to primary company
            await tx.hubspotInvoiceSnapshot.updateMany({
              where: { organization_id: merged.id },
              data: { organization_id: primaryOrganization.id },
            });

            //update affiliate commissions from merged companies to primary company
            await tx.affiliateCommission.updateMany({
              where: { organization_id: merged.id },
              data: { organization_id: primaryOrganization.id },
            });

            //update invoices from merged companies to primary company
            await tx.invoice.updateMany({
              where: { organization_id: merged.id },
              data: { organization_id: primaryOrganization.id },
            });

            //update invoice line reconciliations from merged companies to primary company
            await tx.invoiceLineReconciliation.updateMany({
              where: { organization_id: merged.id },
              data: { organization_id: primaryOrganization.id },
            });

            //update billing ledger entries from merged companies to primary company
            await tx.billingLedgerEntry.updateMany({
              where: { organization_id: merged.id },
              data: { organization_id: primaryOrganization.id },
            });

            // MedAllianceAdminReviewCase has @@unique([organization_id, reason_code, status, hubspot_line_item_snapshot_id]) —
            // reassigning could collide if both orgs have an open case with the same reason_code
            // (and, for line-item-scoped cases, the same line item).
            // Case-by-case update lets us skip only the colliding rows instead of failing the merge.
            // findFirst (not findUnique) because Postgres treats NULLs in the compound unique as
            // distinct, so Prisma's compound-unique input can't be queried with a null line item.
            const reviewCases = await tx.medAllianceAdminReviewCase.findMany({
              where: { organization_id: merged.id },
            });
            for (const reviewCase of reviewCases) {
              const collision = await tx.medAllianceAdminReviewCase.findFirst({
                where: {
                  organization_id: primaryOrganization.id,
                  reason_code: reviewCase.reason_code,
                  status: reviewCase.status,
                  hubspot_line_item_snapshot_id:
                    reviewCase.hubspot_line_item_snapshot_id,
                },
              });
              if (!collision) {
                await tx.medAllianceAdminReviewCase.update({
                  where: { id: reviewCase.id },
                  data: { organization_id: primaryOrganization.id },
                });
              }
            }

            // InvoiceConfiguration.organization_id is @unique (1:1) — if the primary
            // organization already has its own configuration, the primary's wins and
            // the merged-away configuration is dropped rather than causing a unique
            // constraint violation on reassignment.
            const primaryInvoiceConfig =
              await tx.invoiceConfiguration.findUnique({
                where: { organization_id: primaryOrganization.id },
              });
            if (primaryInvoiceConfig) {
              await tx.invoiceConfiguration.deleteMany({
                where: { organization_id: merged.id },
              });
            } else {
              await tx.invoiceConfiguration.updateMany({
                where: { organization_id: merged.id },
                data: { organization_id: primaryOrganization.id },
              });
            }
          }

          await tx.organization.deleteMany({
            where: {
              hubspot_id: { in: otherMergedIds },
            },
          });
        },
        // Reassigning every Organization-linked table (staff, tickets, invoices,
        // Med Alliance records, etc.) for each merged company is many sequential
        // queries — the 5s default interactive-transaction timeout can be too
        // short once there is more than a couple of merged companies/related rows.
        { timeout: 30000, maxWait: 10000 },
      );
    } catch (error) {
      throw new BadRequestException(
        `HandlerOrganizationMerge: ${error.message}`,
      );
    }
  }
}
