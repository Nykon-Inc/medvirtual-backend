import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { HandlerObjectDeletion } from './objectDeletion';
import { PrismaService } from '../../prisma/prisma.service';
import { CandidateAuditService } from '../../candidate/candidate-audit.service';

const prismaMock = {
  candidate: {
    findUnique: jest.fn(),
    delete: jest.fn(),
  },
  candidateSkill: { deleteMany: jest.fn() },
  candidateLanguage: { deleteMany: jest.fn() },
  candidateEducation: { deleteMany: jest.fn() },
  candidateExperience: { deleteMany: jest.fn() },
  panelCandidate: { deleteMany: jest.fn() },
  $transaction: jest.fn(),
};

const candidateAuditMock = {
  log: jest.fn(),
  logOrThrow: jest.fn(),
  logMany: jest.fn(),
};

describe('HandlerObjectDeletion', () => {
  let handler: HandlerObjectDeletion;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HandlerObjectDeletion,
        { provide: PrismaService, useValue: prismaMock },
        { provide: CandidateAuditService, useValue: candidateAuditMock },
      ],
    }).compile();

    handler = module.get<HandlerObjectDeletion>(HandlerObjectDeletion);

    jest.clearAllMocks();

    prismaMock.$transaction.mockImplementation((callback) =>
      callback(prismaMock),
    );
  });

  it('should no-op when the candidate no longer exists locally', async () => {
    prismaMock.candidate.findUnique.mockResolvedValue(null);

    await handler.execute({ objectId: 'hs-1' });

    expect(candidateAuditMock.logOrThrow).not.toHaveBeenCalled();
    expect(prismaMock.candidate.delete).not.toHaveBeenCalled();
  });

  it('should write a candidate_deleted audit log before hard-deleting the candidate', async () => {
    prismaMock.candidate.findUnique.mockResolvedValue({
      id: 'candidate-1',
      hubspot_id: 'hs-1',
      email: 'jane@example.com',
      name: 'Jane Doe',
    });

    const callOrder: string[] = [];
    candidateAuditMock.logOrThrow.mockImplementation(async () => {
      callOrder.push('logOrThrow');
    });
    prismaMock.candidate.delete.mockImplementation(async () => {
      callOrder.push('delete');
      return {};
    });

    await handler.execute({ objectId: 'hs-1' });

    expect(candidateAuditMock.logOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: 'candidate-1',
        hubspotId: 'hs-1',
        event: 'candidate_deleted',
      }),
      prismaMock,
    );
    expect(prismaMock.candidate.delete).toHaveBeenCalledWith({
      where: { id: 'candidate-1' },
    });
    expect(callOrder).toEqual(['delete', 'logOrThrow']);
  });

  it('should wrap unexpected errors in a BadRequestException', async () => {
    prismaMock.candidate.findUnique.mockRejectedValue(new Error('db down'));

    await expect(handler.execute({ objectId: 'hs-1' })).rejects.toThrow(
      BadRequestException,
    );
  });
});
