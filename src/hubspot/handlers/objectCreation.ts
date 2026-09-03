import { BadRequestException, Injectable } from '@nestjs/common';
import axios from 'axios';

import { candidadeToDbDictionary } from '../../common/dictionaries/candidate-dictionary';
import { PrismaService } from '../../prisma/prisma.service';
import { CandidatesService } from '../../candidate/candidates.service';
import { Prisma, CandidateAuditFieldGroup, CandidateAuditSource } from '@prisma/client';
import {
  CANDIDATE_AUDIT_EVENTS,
  CandidateAuditService,
} from '../../candidate/candidate-audit.service';

@Injectable()
export class HandlerObjectCreation {
  constructor(
    private readonly prisma: PrismaService,
    private readonly candidateService: CandidatesService,
    private readonly candidateAudit: CandidateAuditService,
  ) {}

  async execute(event) {
    const properties = Object.keys(candidadeToDbDictionary).join(',');
    try {
      const getObject = await axios.get(
        `https://api.hubapi.com/crm/v3/objects/${process.env.HUBSPOT_CUSTOM_OBJECT}/${event.objectId}?properties=career_highlights_relevant_job_experiences,language_spoken,${properties}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );
      if (!getObject) {
        throw new BadRequestException('No object data found');
      }
      const rawProperties = getObject.data.properties;

      const candidateData: Record<string, any> = {};
      for (const [hubspotKey, dbField] of Object.entries(
        candidadeToDbDictionary,
      )) {
        const value = rawProperties[hubspotKey];
        if (value === undefined) continue;

        if (Array.isArray(dbField)) {
          dbField.forEach((field) => {
            candidateData[field] = value;
          });
        } else {
          candidateData[dbField] = value;
        }
      }
      if (candidateData.pipeline_status) {
        candidateData.pipeline_status = String(candidateData.pipeline_status)
          .split(';')[0]
          .trim();
        candidateData.pipeline_status_origin = candidateData.pipeline_status;
      }
      if (candidateData.employment_type) {
        candidateData.employment_type = String(candidateData.employment_type)
          .split(';')[0]
          .trim();
      }

      candidateData.processing_status = 'pending';

      if (candidateData.approved_positions_pairing) {
        candidateData.approved_positions_pairing = (
          candidateData.approved_positions_pairing as string
        )
          .split(';')
          .map((s) => s.trim());
      } else {
        candidateData.approved_positions_pairing = [];
      }

      const candidateExists = await this.prisma.candidate.findUnique({
        where: {
          hubspot_id: String(event.objectId),
        },
      });
      if (candidateExists)
        throw new BadRequestException(
          'Candidate already exists on the database',
        );

      const createCandidate = await this.prisma.candidate.create({
        data: candidateData as Prisma.CandidateCreateInput,
      });
      if (!createCandidate) {
        throw new BadRequestException(
          'Error creating candidate in the database',
        );
      }

      void this.candidateAudit.log({
        candidateId: createCandidate.id,
        hubspotId: createCandidate.hubspot_id,
        actorUserId: null,
        event: CANDIDATE_AUDIT_EVENTS.CANDIDATE_CREATED,
        fieldGroup: CandidateAuditFieldGroup.profile,
        after: candidateData,
        source: CandidateAuditSource.webhook,
      });

      //Here, I start to work with the skills
      if (rawProperties.career_highlights_relevant_job_experiences) {
        const candidadeSkills =
          rawProperties.career_highlights_relevant_job_experiences
            .split(';')
            .map((skill: string) => skill.trim());

        for (const skill of candidadeSkills) {
          await this.prisma.candidateSkill.create({
            data: {
              candidate_id: createCandidate.id,
              skill_name: skill,
              skill_type: undefined, // This field is not used in the current implementation
            },
          });
        }
      }

      //here I start to work with the language
      if (rawProperties.language_spoken) {
        const languageCandidateSpoken = rawProperties.language_spoken
          .split('&')
          .map((lang: string) => lang.trim());

        for (const language of languageCandidateSpoken) {
          await this.prisma.candidateLanguage.create({
            data: {
              candidate_id: createCandidate.id,
              name: language,
            },
          });
        }
      }
      console.log(
        `Candidate created with ID: ${createCandidate.id}, Name: ${createCandidate.first_name} ${createCandidate.last_name}`,
      );
      // Run the resume pipeline when the candidate is created
      if (process.env.ENVIRONMENT === 'PROD') {
        await this.candidateService.processData(createCandidate.id);
        await this.candidateService.processAvatar(createCandidate.id);
      } else {
        console.log(
          'Environment is not PROD. Skipping resume processing pipeline.',
        );
      }

      return true;
    } catch (error) {
      throw new BadRequestException(
        `Error fetching object creation data: ${error.message}`,
      );
    }
  }
}
