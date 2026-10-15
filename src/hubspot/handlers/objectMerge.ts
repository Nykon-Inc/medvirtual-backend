import { BadRequestException, Injectable } from '@nestjs/common';

import {
  mapDbToHubspot,
  mapHubspotToDb,
} from '../../common/utils/hubspot.util';
import { PrismaService } from '../../prisma/prisma.service';
import {
  Candidate,
  CandidateAuditFieldGroup,
  CandidateAuditSource,
  Prisma,
} from '@prisma/client';
import {
  CANDIDATE_AUDIT_EVENTS,
  CandidateAuditService,
} from '../../candidate/candidate-audit.service';
import { HandlerObjectCreation } from './objectCreation';

@Injectable()
export class HandlerObjectMerge {
  constructor(
    private readonly prisma: PrismaService,
    private readonly candidateAudit: CandidateAuditService,
    private readonly objectCreation: HandlerObjectCreation,
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

  private parseMergedIds(
    mergedObjectIds: string | number[] | undefined,
  ): string[] {
    // HubSpot sometimes serializes mergedObjectIds as a string
    // (e.g. "[ 123, 456 ]") instead of a real array.
    const list: (string | number)[] = Array.isArray(mergedObjectIds)
      ? mergedObjectIds
      : String(mergedObjectIds ?? '')
          .replace(/[[\]]/g, '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
    return list.map((id) => String(id));
  }

  private async repointRelations(
    tx: Prisma.TransactionClient,
    loser: Candidate,
    primary: Candidate,
  ): Promise<Record<string, number>> {
    // Scorecard children of the losing record are discarded: the primary's
    // own rows win and the resume pipeline rebuilds them anyway.
    await tx.candidateEducation.deleteMany({
      where: { candidate_id: loser.id },
    });
    await tx.candidateExperience.deleteMany({
      where: { candidate_id: loser.id },
    });
    await tx.candidateLanguage.deleteMany({
      where: { candidate_id: loser.id },
    });
    await tx.candidateSkill.deleteMany({ where: { candidate_id: loser.id } });

    const staff = await tx.staff.updateMany({
      where: { candidate_id: loser.id },
      data: { candidate_id: primary.id },
    });
    const tickets = await tx.ticket.updateMany({
      where: { candidate_id: loser.id },
      data: { candidate_id: primary.id },
    });
    const organizationCandidates = await tx.organizationCandidate.updateMany({
      where: { candidate_id: loser.id },
      data: { candidate_id: primary.id },
    });
    const interviews = await tx.interview.updateMany({
      where: { selected_candidate_id: loser.id },
      data: { selected_candidate_id: primary.id },
    });

    // Panels where both records already participate would violate the
    // (panel_id, candidate_id) unique — the primary's row wins there.
    const primaryPanels = await tx.panelCandidate.findMany({
      where: { candidate_id: primary.id },
      select: { panel_id: true },
    });
    const primaryPanelIds = primaryPanels.map((p) => p.panel_id);
    await tx.panelCandidate.deleteMany({
      where: { candidate_id: loser.id, panel_id: { in: primaryPanelIds } },
    });
    const panelCandidates = await tx.panelCandidate.updateMany({
      where: { candidate_id: loser.id },
      data: { candidate_id: primary.id },
    });

    const primaryOfferPanels = await tx.offerPanelCandidate.findMany({
      where: { candidate_id: primary.id },
      select: { offer_panel_id: true },
    });
    const primaryOfferPanelIds = primaryOfferPanels.map(
      (p) => p.offer_panel_id,
    );
    await tx.offerPanelCandidate.deleteMany({
      where: {
        candidate_id: loser.id,
        offer_panel_id: { in: primaryOfferPanelIds },
      },
    });
    const offerPanelCandidates = await tx.offerPanelCandidate.updateMany({
      where: { candidate_id: loser.id },
      data: { candidate_id: primary.id },
    });

    return {
      staff: staff.count,
      tickets: tickets.count,
      organizationCandidates: organizationCandidates.count,
      interviews: interviews.count,
      panelCandidates: panelCandidates.count,
      offerPanelCandidates: offerPanelCandidates.count,
    };
  }

  private async resyncFromHubspot(
    primary: Candidate,
    newHubspotId: string,
  ): Promise<void> {
    try {
      const { candidateData } =
        await this.objectCreation.fetchCandidateFromHubspot(newHubspotId);
      delete candidateData.hubspot_id;
      if (Object.keys(candidateData).length === 0) return;

      await this.prisma.candidate.update({
        where: { id: primary.id },
        data: candidateData as Prisma.CandidateUpdateInput,
      });

      void this.candidateAudit.log({
        candidateId: primary.id,
        hubspotId: newHubspotId,
        actorUserId: null,
        event: CANDIDATE_AUDIT_EVENTS.PROFILE_UPDATED,
        fieldGroup: CandidateAuditFieldGroup.hubspot_sync,
        before: Object.fromEntries(
          Object.keys(candidateData).map((key) => [
            key,
            (primary as Record<string, any>)[key],
          ]),
        ),
        after: candidateData,
        source: CandidateAuditSource.webhook,
      });
    } catch (error) {
      // The merge itself is already committed; a failed resync must not make
      // HubSpot retry it. The next propertyChange webhook will catch up.
      console.warn(
        `HandlerObjectMerge: resync from HubSpot failed for ${newHubspotId}: ${error.message}`,
      );
    }
  }

  async execute(event) {
    try {
      const primaryHubspotId = String(event.primaryObjectId);
      const newHubspotId = String(event.newObjectId ?? event.primaryObjectId);
      const mergedIds = this.parseMergedIds(event.mergedObjectIds);

      const allIds = Array.from(
        new Set([primaryHubspotId, newHubspotId, ...mergedIds]),
      );
      const found = await this.prisma.candidate.findMany({
        where: { hubspot_id: { in: allIds } },
      });

      // A previous attempt may already have moved the primary to newObjectId,
      // or the primary may never have been synced — in that case a losing
      // record is promoted so the merge still converges.
      const primary =
        found.find((c) => c.hubspot_id === newHubspotId) ??
        found.find((c) => c.hubspot_id === primaryHubspotId) ??
        found[0];

      if (!primary) {
        console.warn(
          `HandlerObjectMerge: no candidate found for HubSpot ids ${allIds.join(', ')}; nothing to merge.`,
        );
        return;
      }

      const losers = found.filter((c) => c.id !== primary.id);

      let dataToUpdate: Record<string, any> = {};
      for (const loser of losers) {
        dataToUpdate = {
          ...dataToUpdate,
          ...this.mergeCandidateData(primary, loser),
        };
      }
      delete dataToUpdate.hubspot_id;

      const repointed: Record<string, Record<string, number>> = {};

      await this.prisma.$transaction(async (tx) => {
        for (const loser of losers) {
          repointed[loser.id] = await this.repointRelations(tx, loser, primary);
          await tx.candidate.delete({ where: { id: loser.id } });
        }

        await tx.candidate.update({
          where: { id: primary.id },
          data: { ...dataToUpdate, hubspot_id: newHubspotId },
        });
      });

      if (Object.keys(dataToUpdate).length > 0) {
        void this.candidateAudit.log({
          candidateId: primary.id,
          hubspotId: newHubspotId,
          actorUserId: null,
          event: CANDIDATE_AUDIT_EVENTS.PROFILE_UPDATED,
          fieldGroup: CandidateAuditFieldGroup.hubspot_sync,
          before: Object.fromEntries(
            Object.keys(dataToUpdate).map((key) => [
              key,
              (primary as Record<string, any>)[key],
            ]),
          ),
          after: dataToUpdate,
          source: CandidateAuditSource.webhook,
        });
      }

      if (primary.hubspot_id !== newHubspotId) {
        void this.candidateAudit.log({
          candidateId: primary.id,
          hubspotId: newHubspotId,
          actorUserId: null,
          event: CANDIDATE_AUDIT_EVENTS.HUBSPOT_ID_MERGED,
          fieldGroup: CandidateAuditFieldGroup.hubspot_sync,
          before: { hubspot_id: primary.hubspot_id },
          after: { hubspot_id: newHubspotId },
          source: CandidateAuditSource.webhook,
        });
      }

      if (losers.length > 0) {
        void this.candidateAudit.logMany(
          losers.map((loser) => ({
            candidateId: loser.id,
            hubspotId: loser.hubspot_id,
            actorUserId: null,
            event: CANDIDATE_AUDIT_EVENTS.CANDIDATE_MERGED_AWAY,
            fieldGroup: CandidateAuditFieldGroup.lifecycle,
            before: loser as unknown as Record<string, any>,
            metadata: {
              merged_into_hubspot_id: newHubspotId,
              merged_into_candidate_id: primary.id,
              repointed_relations: repointed[loser.id],
            },
            source: CandidateAuditSource.webhook,
          })),
        );
      }

      await this.resyncFromHubspot(primary, newHubspotId);
    } catch (error) {
      throw new BadRequestException(`HandlerObjectMerge: ${error.message}`);
    }
  }
}
