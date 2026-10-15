import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { HandlerObjectMerge } from './objectMerge';
import { HandlerObjectCreation } from './objectCreation';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CANDIDATE_AUDIT_EVENTS,
  CandidateAuditService,
} from '../../candidate/candidate-audit.service';

const txMock = {
  candidate: { delete: jest.fn(), update: jest.fn() },
  candidateEducation: { deleteMany: jest.fn() },
  candidateExperience: { deleteMany: jest.fn() },
  candidateLanguage: { deleteMany: jest.fn() },
  candidateSkill: { deleteMany: jest.fn() },
  staff: { updateMany: jest.fn() },
  ticket: { updateMany: jest.fn() },
  organizationCandidate: { updateMany: jest.fn() },
  interview: { updateMany: jest.fn() },
  panelCandidate: {
    findMany: jest.fn(),
    deleteMany: jest.fn(),
    updateMany: jest.fn(),
  },
  offerPanelCandidate: {
    findMany: jest.fn(),
    deleteMany: jest.fn(),
    updateMany: jest.fn(),
  },
};

const prismaMock = {
  candidate: { findMany: jest.fn(), update: jest.fn() },
  $transaction: jest.fn((cb) => cb(txMock)),
};

const candidateAuditMock = {
  log: jest.fn(),
  logMany: jest.fn(),
};

const objectCreationMock = {
  fetchCandidateFromHubspot: jest.fn(),
};

const primary = {
  id: 'cand-primary',
  hubspot_id: '100',
  email: 'primary@va.com',
  tier_level: null,
};
const loser = {
  id: 'cand-loser',
  hubspot_id: '200',
  email: 'loser@va.com',
  tier_level: 'Tier 1',
};

function resetAllMocks() {
  for (const model of Object.values(txMock)) {
    for (const fn of Object.values(model)) {
      fn.mockReset();
      fn.mockResolvedValue({ count: 0 });
    }
  }
  txMock.panelCandidate.findMany.mockResolvedValue([]);
  txMock.offerPanelCandidate.findMany.mockResolvedValue([]);
  prismaMock.candidate.findMany.mockReset();
  prismaMock.candidate.update.mockReset();
  prismaMock.$transaction.mockClear();
  candidateAuditMock.log.mockReset();
  candidateAuditMock.logMany.mockReset();
  objectCreationMock.fetchCandidateFromHubspot.mockReset();
  objectCreationMock.fetchCandidateFromHubspot.mockResolvedValue({
    candidateData: { hubspot_id: '100', pipeline_status: 'Hired' },
    rawProperties: {},
  });
}

describe('HandlerObjectMerge', () => {
  let handler: HandlerObjectMerge;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HandlerObjectMerge,
        { provide: PrismaService, useValue: prismaMock },
        { provide: CandidateAuditService, useValue: candidateAuditMock },
        { provide: HandlerObjectCreation, useValue: objectCreationMock },
      ],
    }).compile();

    handler = module.get<HandlerObjectMerge>(HandlerObjectMerge);
    resetAllMocks();
  });

  describe('execute', () => {
    it('should re-point relations, delete the loser and keep the primary inside one transaction', async () => {
      prismaMock.candidate.findMany.mockResolvedValue([primary, loser]);
      txMock.staff.updateMany.mockResolvedValue({ count: 1 });

      await handler.execute({
        primaryObjectId: 100,
        newObjectId: 100,
        mergedObjectIds: [100, 200],
      });

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      for (const model of [
        txMock.candidateEducation,
        txMock.candidateExperience,
        txMock.candidateLanguage,
        txMock.candidateSkill,
      ]) {
        expect(model.deleteMany).toHaveBeenCalledWith({
          where: { candidate_id: loser.id },
        });
      }
      for (const model of [
        txMock.staff,
        txMock.ticket,
        txMock.organizationCandidate,
        txMock.panelCandidate,
        txMock.offerPanelCandidate,
      ]) {
        expect(model.updateMany).toHaveBeenCalledWith({
          where: { candidate_id: loser.id },
          data: { candidate_id: primary.id },
        });
      }
      expect(txMock.interview.updateMany).toHaveBeenCalledWith({
        where: { selected_candidate_id: loser.id },
        data: { selected_candidate_id: primary.id },
      });
      expect(txMock.candidate.delete).toHaveBeenCalledWith({
        where: { id: loser.id },
      });
      expect(txMock.candidate.update).toHaveBeenCalledWith({
        where: { id: primary.id },
        data: expect.objectContaining({
          tier_level: 'Tier 1',
          hubspot_id: '100',
        }),
      });
      expect(candidateAuditMock.logMany).toHaveBeenCalledWith([
        expect.objectContaining({
          candidateId: loser.id,
          event: CANDIDATE_AUDIT_EVENTS.CANDIDATE_MERGED_AWAY,
          metadata: expect.objectContaining({
            merged_into_candidate_id: primary.id,
            repointed_relations: expect.objectContaining({ staff: 1 }),
          }),
        }),
      ]);
    });

    it('should resync the primary from HubSpot without overwriting hubspot_id', async () => {
      prismaMock.candidate.findMany.mockResolvedValue([primary, loser]);

      await handler.execute({
        primaryObjectId: 100,
        newObjectId: 100,
        mergedObjectIds: [100, 200],
      });

      expect(objectCreationMock.fetchCandidateFromHubspot).toHaveBeenCalledWith(
        '100',
      );
      expect(prismaMock.candidate.update).toHaveBeenCalledWith({
        where: { id: primary.id },
        data: { pipeline_status: 'Hired' },
      });
    });

    it('should not fail the merge when the HubSpot resync fails', async () => {
      prismaMock.candidate.findMany.mockResolvedValue([primary, loser]);
      objectCreationMock.fetchCandidateFromHubspot.mockRejectedValue(
        new Error('HubSpot down'),
      );
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        handler.execute({
          primaryObjectId: 100,
          newObjectId: 100,
          mergedObjectIds: [100, 200],
        }),
      ).resolves.toBeUndefined();

      expect(txMock.candidate.delete).toHaveBeenCalled();
      expect(prismaMock.candidate.update).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('should delete colliding panel rows of the loser instead of re-pointing them', async () => {
      prismaMock.candidate.findMany.mockResolvedValue([primary, loser]);
      txMock.panelCandidate.findMany.mockResolvedValue([{ panel_id: 'p1' }]);
      txMock.offerPanelCandidate.findMany.mockResolvedValue([
        { offer_panel_id: 'op1' },
      ]);

      await handler.execute({
        primaryObjectId: 100,
        newObjectId: 100,
        mergedObjectIds: [100, 200],
      });

      expect(txMock.panelCandidate.deleteMany).toHaveBeenCalledWith({
        where: { candidate_id: loser.id, panel_id: { in: ['p1'] } },
      });
      expect(txMock.offerPanelCandidate.deleteMany).toHaveBeenCalledWith({
        where: { candidate_id: loser.id, offer_panel_id: { in: ['op1'] } },
      });
    });

    it('should pick the candidate already holding newObjectId as primary on a retry', async () => {
      const alreadyMoved = { ...primary, hubspot_id: '300' };
      prismaMock.candidate.findMany.mockResolvedValue([loser, alreadyMoved]);

      await handler.execute({
        primaryObjectId: 100,
        newObjectId: 300,
        mergedObjectIds: [100, 200],
      });

      expect(txMock.candidate.delete).toHaveBeenCalledWith({
        where: { id: loser.id },
      });
      expect(txMock.candidate.update).toHaveBeenCalledWith({
        where: { id: alreadyMoved.id },
        data: expect.objectContaining({ hubspot_id: '300' }),
      });
      expect(candidateAuditMock.log).not.toHaveBeenCalledWith(
        expect.objectContaining({
          event: CANDIDATE_AUDIT_EVENTS.HUBSPOT_ID_MERGED,
        }),
      );
    });

    it('should promote a losing record when the primary was never synced', async () => {
      prismaMock.candidate.findMany.mockResolvedValue([loser]);

      await handler.execute({
        primaryObjectId: 100,
        newObjectId: 100,
        mergedObjectIds: [100, 200],
      });

      expect(txMock.candidate.delete).not.toHaveBeenCalled();
      expect(txMock.candidate.update).toHaveBeenCalledWith({
        where: { id: loser.id },
        data: { hubspot_id: '100' },
      });
      expect(candidateAuditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: CANDIDATE_AUDIT_EVENTS.HUBSPOT_ID_MERGED,
          before: { hubspot_id: '200' },
          after: { hubspot_id: '100' },
        }),
      );
    });

    it('should return without throwing when no candidate is found', async () => {
      prismaMock.candidate.findMany.mockResolvedValue([]);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        handler.execute({
          primaryObjectId: 100,
          newObjectId: 100,
          mergedObjectIds: [100, 200],
        }),
      ).resolves.toBeUndefined();

      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('should parse mergedObjectIds sent as a string', async () => {
      prismaMock.candidate.findMany.mockResolvedValue([primary, loser]);

      await handler.execute({
        primaryObjectId: 100,
        newObjectId: 100,
        mergedObjectIds: '[ 100, 200 ]',
      });

      expect(prismaMock.candidate.findMany).toHaveBeenCalledWith({
        where: { hubspot_id: { in: ['100', '200'] } },
      });
    });

    it('should wrap transaction errors in a BadRequestException', async () => {
      prismaMock.candidate.findMany.mockResolvedValue([primary, loser]);
      txMock.candidate.delete.mockRejectedValue(new Error('FK violated'));

      await expect(
        handler.execute({
          primaryObjectId: 100,
          newObjectId: 100,
          mergedObjectIds: [100, 200],
        }),
      ).rejects.toThrow(
        new BadRequestException('HandlerObjectMerge: FK violated'),
      );
    });
  });
});
