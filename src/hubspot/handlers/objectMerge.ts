import { BadRequestException, Injectable } from '@nestjs/common';

import {
  mapDbToHubspot,
  mapHubspotToDb,
} from '../../common/utils/hubspot.util';
import { PrismaService } from '../../prisma/prisma.service';
import { CandidateAuditFieldGroup, CandidateAuditSource } from '@prisma/client';
import {
  CANDIDATE_AUDIT_EVENTS,
  CandidateAuditService,
} from '../../candidate/candidate-audit.service';

@Injectable()
export class HandlerObjectMerge {
  constructor(
    private readonly prisma: PrismaService,
    private readonly candidateAudit: CandidateAuditService,
  ) {}

  private mergeCandidateData(primary: any, merged: any): Partial<any> {
    const mergedAsHubspot = mapDbToHubspot(merged);

    const dbMapped = mapHubspotToDb(mergedAsHubspot);

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
      const primaryCandidate = await this.prisma.candidate.findUnique({
        where: { hubspot_id: String(event.primaryObjectId) },
      });
      if (!primaryCandidate) {
        throw new BadRequestException(
          `Primary candidate hubspotId=${event.primaryObjectId} not found in database.`,
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

      const mergedCandidates = await this.prisma.candidate.findMany({
        where: {
          hubspot_id: { in: otherMergedIds },
        },
      });

      if (mergedCandidates.length === 0) {
        throw new BadRequestException(
          `No merged companies found with the provided HubSpot IDs.`,
        );
      }

      let dataToUpdate: Record<string, any> = {};
      for (const merged of mergedCandidates) {
        const partialUpdate = this.mergeCandidateData(primaryCandidate, merged);

        dataToUpdate = {
          ...dataToUpdate,
          ...partialUpdate,
        };
      }

      if (Object.keys(dataToUpdate).length > 0) {
        await this.prisma.candidate.update({
          where: { hubspot_id: String(event.primaryObjectId) },
          data: dataToUpdate,
        });

        void this.candidateAudit.log({
          candidateId: primaryCandidate.id,
          hubspotId: primaryCandidate.hubspot_id,
          actorUserId: null,
          event: CANDIDATE_AUDIT_EVENTS.PROFILE_UPDATED,
          fieldGroup: CandidateAuditFieldGroup.hubspot_sync,
          before: Object.fromEntries(
            Object.keys(dataToUpdate).map((key) => [
              key,
              (primaryCandidate as Record<string, any>)[key],
            ]),
          ),
          after: dataToUpdate,
          source: CandidateAuditSource.webhook,
        });
      }

      await this.prisma.candidate.update({
        where: { hubspot_id: String(event.primaryObjectId) },
        data: {
          hubspot_id: String(event.newObjectId),
        },
      });

      void this.candidateAudit.log({
        candidateId: primaryCandidate.id,
        hubspotId: String(event.newObjectId),
        actorUserId: null,
        event: CANDIDATE_AUDIT_EVENTS.HUBSPOT_ID_MERGED,
        fieldGroup: CandidateAuditFieldGroup.hubspot_sync,
        before: { hubspot_id: primaryCandidate.hubspot_id },
        after: { hubspot_id: String(event.newObjectId) },
        source: CandidateAuditSource.webhook,
      });

      await this.prisma.candidate.deleteMany({
        where: {
          hubspot_id: { in: otherMergedIds },
        },
      });

      void this.candidateAudit.logMany(
        mergedCandidates.map((merged) => ({
          candidateId: merged.id,
          hubspotId: merged.hubspot_id,
          actorUserId: null,
          event: CANDIDATE_AUDIT_EVENTS.CANDIDATE_MERGED_AWAY,
          fieldGroup: CandidateAuditFieldGroup.lifecycle,
          before: merged as unknown as Record<string, any>,
          metadata: { merged_into_hubspot_id: String(event.newObjectId) },
          source: CandidateAuditSource.webhook,
        })),
      );
    } catch (error) {
      throw new BadRequestException(`HandlerObjectMerge: ${error.message}`);
    }
  }
}
