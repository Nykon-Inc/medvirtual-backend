import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { candidadeToDbDictionary } from '../../common/dictionaries/candidate-dictionary';
import { HandlerObjectCreation } from './objectCreation';
import { CandidatesService } from '../../candidate/candidates.service';
import {
  HireRequestStatus,
  PanelCandidateStatus,
  PanelStatus,
  CandidateAuditFieldGroup,
  CandidateAuditSource,
} from '@prisma/client';
import { read } from 'node:fs';
import {
  CANDIDATE_AUDIT_EVENTS,
  CandidateAuditService,
} from '../../candidate/candidate-audit.service';

@Injectable()
export class HandlerObjectPropertyChange {
  constructor(
    private readonly prisma: PrismaService,
    private readonly objectCreation: HandlerObjectCreation,
    private readonly candidateService: CandidatesService,
    private readonly candidateAudit: CandidateAuditService,
  ) {}

  async execute(event) {
    const ignoredObjectIds = [
      //test candidates id
      34854113885, 31392562945, 31413155696, 34624704579, 29875931213,
      35888726709,
    ];

    if (
      process.env.ENVIRONMENT === 'PROD' &&
      ignoredObjectIds.includes(event.objectId)
    ) {
      return false; // test candidate, ignore
    }

    const candidate = await this.prisma.candidate.findUnique({
      where: {
        hubspot_id: String(event.objectId),
      },
    });

    if (!candidate) return await this.objectCreation.execute(event);

    if (event.propertyName === 'language_spoken') {
      await this.prisma.candidateLanguage.deleteMany({
        where: {
          candidate_id: candidate.id,
        },
      });

      const languages = event.propertyValue
        .split('&')
        .map((lang: string) => lang.trim());
      for (const language of languages) {
        await this.prisma.candidateLanguage.create({
          data: {
            candidate_id: candidate.id,
            name: language,
          },
        });
      }

      return true;
    } else if (
      event.propertyName === 'career_highlights_relevant_job_experiences'
    ) {
      await this.prisma.candidateSkill.deleteMany({
        where: {
          candidate_id: candidate.id,
        },
      });

      const candidadeSkills = event.propertyValue
        .split(';')
        .map((skill: string) => skill.trim());
      for (const skill of candidadeSkills) {
        await this.prisma.candidateSkill.create({
          data: {
            candidate_id: candidate.id,
            skill_name: skill,
            skill_type: undefined, // This field is not used in the current implementation
          },
        });
      }
    } else {
      const fieldUpdated = candidadeToDbDictionary[event.propertyName];
      if (!fieldUpdated) return;

      const fields = Array.isArray(fieldUpdated)
        ? fieldUpdated
        : [fieldUpdated];

      const updateData = fields.reduce(
        (acc, field) => {
          if (field === 'approved_positions_pairing') {
            acc[field] = event.propertyValue
              ? event.propertyValue.split(';').map((v: string) => v.trim())
              : [];
          } else {
            acc[field] = event.propertyValue;
          }
          return acc;
        },
        {} as Record<string, any>,
      );

      await this.prisma.candidate.update({
        where: { id: candidate.id },
        data: updateData,
      });

      const isPipelineStatusChange = Object.prototype.hasOwnProperty.call(
        updateData,
        'pipeline_status',
      );
      void this.candidateAudit.log({
        candidateId: candidate.id,
        hubspotId: candidate.hubspot_id,
        actorUserId: null,
        event: isPipelineStatusChange
          ? CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED
          : CANDIDATE_AUDIT_EVENTS.PROFILE_UPDATED,
        fieldGroup: isPipelineStatusChange
          ? CandidateAuditFieldGroup.pipeline_status
          : CandidateAuditFieldGroup.hubspot_sync,
        before: Object.fromEntries(
          fields.map((field) => [
            field,
            (candidate as Record<string, any>)[field],
          ]),
        ),
        after: updateData,
        source: CandidateAuditSource.webhook,
      });

      // R9 — remove candidate from all OfferPanels when they become Hired or Lost
      if (
        event.propertyName === 'hs_pipeline_stage' &&
        CandidatesService.UNAVAILABLE_PIPELINE_STATUSES.includes(
          event.propertyValue,
        )
      ) {
        await this.candidateService.removeFromOfferPanels(candidate.id);
      }

      //if the property changed is related to pipeline stage, we need to remove this candidate from all panels
      if (
        event.propertyName === 'hs_pipeline_stage' &&
        event.propertyValue === '261173428' /*Lost*/
      ) {
        const candidatesToRemove = await this.prisma.panelCandidate.findMany({
          where: {
            candidate_id: candidate.id,
            status: { not: PanelCandidateStatus.selected_by_client },
          },
          select: {
            id: true,
            panel_id: true,
          },
        });

        for (const pc of candidatesToRemove) {
          await this.prisma.panelCandidate.delete({
            where: { id: pc.id },
          });

          const count = await this.prisma.panelCandidate.count({
            where: { panel_id: pc.panel_id },
          });

          if (count === 0) {
            const panel = await this.prisma.candidatePanel.findUnique({
              where: { id: pc.panel_id },
              select: { hire_request_id: true },
            });

            if (panel && panel.hire_request_id) {
              await this.prisma.candidatePanel.update({
                where: { id: pc.panel_id },
                data: {
                  status: PanelStatus.created,
                  readable: false,
                },
              });

              await this.prisma.hireRequest.update({
                where: { id: panel.hire_request_id },
                data: {
                  status: HireRequestStatus.sourcing,
                },
              });
            }
          }
        }
      }

      // Re-run the resume pipeline if this change is related to the resume
      if (process.env.ENVIRONMENT === 'PROD') {
        if (event.propertyName === 'resume_link') {
          await this.candidateService.processData(candidate.id);
        }
        if (event.propertyName === 'headshot_screenshot') {
          await this.candidateService.processAvatar(candidate.id);
        }
      } else {
        console.log('Environment is not PROD. Skipping re-run of pipelines.');
      }

      return true;
    }
  }
}
