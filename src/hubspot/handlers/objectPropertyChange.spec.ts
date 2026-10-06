import { Test, TestingModule } from '@nestjs/testing';
import { HandlerObjectPropertyChange } from './objectPropertyChange';
import { PrismaService } from '../../prisma/prisma.service';
import { HandlerObjectCreation } from './objectCreation';
import { CandidatesService } from '../../candidate/candidates.service';
import { CandidateAuditService } from '../../candidate/candidate-audit.service';

const prismaMock = {
  candidate: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  candidateLanguage: { deleteMany: jest.fn(), create: jest.fn() },
  candidateSkill: { deleteMany: jest.fn(), create: jest.fn() },
  panelCandidate: { findMany: jest.fn(), delete: jest.fn(), count: jest.fn() },
  candidatePanel: { findUnique: jest.fn(), update: jest.fn() },
  hireRequest: { update: jest.fn() },
};

const objectCreationMock = { execute: jest.fn() };
const candidateServiceMock = {
  removeFromOfferPanels: jest.fn(),
  processData: jest.fn(),
  processAvatar: jest.fn(),
};
const candidateAuditMock = {
  log: jest.fn(),
  logOrThrow: jest.fn(),
  logMany: jest.fn(),
};

describe('HandlerObjectPropertyChange', () => {
  let handler: HandlerObjectPropertyChange;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HandlerObjectPropertyChange,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HandlerObjectCreation, useValue: objectCreationMock },
        { provide: CandidatesService, useValue: candidateServiceMock },
        { provide: CandidateAuditService, useValue: candidateAuditMock },
      ],
    }).compile();

    handler = module.get<HandlerObjectPropertyChange>(
      HandlerObjectPropertyChange,
    );

    jest.clearAllMocks();
    prismaMock.candidate.update.mockResolvedValue({});
    prismaMock.panelCandidate.findMany.mockResolvedValue([]);
  });

  it('should record a pipeline_status_changed audit log with the Lost stage id when moved to the Lost pipeline stage', async () => {
    prismaMock.candidate.findUnique.mockResolvedValue({
      id: 'candidate-1',
      hubspot_id: 'hs-1',
      email: 'jane@example.com',
      name: 'Jane Doe',
    });

    await handler.execute({
      objectId: 'hs-1',
      propertyName: 'hs_pipeline_stage',
      propertyValue: '261173428',
    });

    expect(candidateAuditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: 'candidate-1',
        event: 'pipeline_status_changed',
        after: expect.objectContaining({ pipeline_status: '261173428' }),
      }),
    );
  });

  it('should NOT record a pipeline_status_changed audit log for unrelated property changes', async () => {
    prismaMock.candidate.findUnique.mockResolvedValue({
      id: 'candidate-1',
      hubspot_id: 'hs-1',
      email: 'jane@example.com',
      name: 'Jane Doe',
    });

    await handler.execute({
      objectId: 'hs-1',
      propertyName: 'language_spoken',
      propertyValue: 'English',
    });

    expect(candidateAuditMock.log).not.toHaveBeenCalled();
  });

  it('should backfill pipeline_status_origin when a candidate with no origin moves into an "available" stage', async () => {
    prismaMock.candidate.findUnique.mockResolvedValue({
      id: 'candidate-1',
      hubspot_id: 'hs-1',
      email: 'jane@example.com',
      name: 'Jane Doe',
      pipeline_status_origin: null,
    });

    await handler.execute({
      objectId: 'hs-1',
      propertyName: 'hs_pipeline_stage',
      propertyValue: '1087596819', // "Available Candidates - Part Time"
    });

    expect(prismaMock.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pipeline_status: '1087596819',
          pipeline_status_origin: '1087596819',
        }),
      }),
    );
  });

  it('should stamp first_available_at the first time a candidate enters an "available" stage', async () => {
    prismaMock.candidate.findUnique.mockResolvedValue({
      id: 'candidate-1',
      hubspot_id: 'hs-1',
      pipeline_status: '942502182', // "New Candidates"
      first_available_at: null,
    });

    await handler.execute({
      objectId: 'hs-1',
      propertyName: 'hs_pipeline_stage',
      propertyValue: '261075105',
    });

    const updateArgs = prismaMock.candidate.update.mock.calls[0][0];
    expect(updateArgs.data.first_available_at).toBeInstanceOf(Date);
  });

  it('should NOT move first_available_at when a candidate returns to an "available" stage', async () => {
    prismaMock.candidate.findUnique.mockResolvedValue({
      id: 'candidate-1',
      hubspot_id: 'hs-1',
      pipeline_status: '1172847191', // "Endorsed via Platform"
      pipeline_status_origin: '261075105',
      first_available_at: new Date('2026-01-10T00:00:00.000Z'),
    });

    await handler.execute({
      objectId: 'hs-1',
      propertyName: 'hs_pipeline_stage',
      propertyValue: '261075105',
      changeSource: 'CRM_UI',
    });

    const updateArgs = prismaMock.candidate.update.mock.calls[0][0];
    expect(updateArgs.data).not.toHaveProperty('first_available_at');
  });

  it('should NOT stamp first_available_at when the new stage is not "available"', async () => {
    prismaMock.candidate.findUnique.mockResolvedValue({
      id: 'candidate-1',
      hubspot_id: 'hs-1',
      pipeline_status: '942502182',
      first_available_at: null,
    });

    await handler.execute({
      objectId: 'hs-1',
      propertyName: 'hs_pipeline_stage',
      propertyValue: '1172847191',
    });

    const updateArgs = prismaMock.candidate.update.mock.calls[0][0];
    expect(updateArgs.data).not.toHaveProperty('first_available_at');
  });

  it.each([
    ['full-time to part-time', '261075105', '261075105', '1087596819'],
    ['part-time to full-time', '1087596819', '1087596819', '261075105'],
    ['Lost back to part-time', '261173428', '261075105', '1087596819'],
    ['Hired back to part-time', '261214844', '261075105', '1087596819'],
    [
      'Endorsed via Platform to part-time',
      '1172847191',
      '261075105',
      '1087596819',
    ],
  ])(
    'should overwrite pipeline_status_origin when a recruiter moves the candidate %s in HubSpot',
    async (_label, currentStatus, currentOrigin, newStage) => {
      prismaMock.candidate.findUnique.mockResolvedValue({
        id: 'candidate-1',
        hubspot_id: 'hs-1',
        pipeline_status: currentStatus,
        pipeline_status_origin: currentOrigin,
      });

      await handler.execute({
        objectId: 'hs-1',
        propertyName: 'hs_pipeline_stage',
        propertyValue: newStage,
        changeSource: 'CRM_UI',
      });

      const updateArgs = prismaMock.candidate.update.mock.calls[0][0];
      expect(updateArgs.data.pipeline_status).toBe(newStage);
      expect(updateArgs.data.pipeline_status_origin).toBe(newStage);
      expect(candidateAuditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          before: expect.objectContaining({
            pipeline_status_origin: currentOrigin,
          }),
          after: expect.objectContaining({ pipeline_status_origin: newStage }),
        }),
      );
    },
  );

  it('should NOT touch pipeline_status_origin on the INTEGRATION echo of our own push', async () => {
    prismaMock.candidate.findUnique.mockResolvedValue({
      id: 'candidate-1',
      hubspot_id: 'hs-1',
      pipeline_status: '1172847191', // "Endorsed via Platform"
      pipeline_status_origin: '261075105',
    });

    await handler.execute({
      objectId: 'hs-1',
      propertyName: 'hs_pipeline_stage',
      propertyValue: '1087596819',
      changeSource: 'INTEGRATION',
    });

    const updateArgs = prismaMock.candidate.update.mock.calls[0][0];
    expect(updateArgs.data.pipeline_status).toBe('1087596819');
    expect(updateArgs.data.pipeline_status_origin).toBeUndefined();
  });

  it('should NOT touch pipeline_status_origin when the stage already matches pipeline_status (internal return to origin)', async () => {
    prismaMock.candidate.findUnique.mockResolvedValue({
      id: 'candidate-1',
      hubspot_id: 'hs-1',
      pipeline_status: '261075105',
      pipeline_status_origin: '261075105',
    });

    await handler.execute({
      objectId: 'hs-1',
      propertyName: 'hs_pipeline_stage',
      propertyValue: '261075105',
      changeSource: 'CRM_UI',
    });

    const updateArgs = prismaMock.candidate.update.mock.calls[0][0];
    expect(updateArgs.data.pipeline_status_origin).toBeUndefined();
  });

  it('should NOT set pipeline_status_origin when the candidate moves into a non-available stage', async () => {
    prismaMock.candidate.findUnique.mockResolvedValue({
      id: 'candidate-1',
      hubspot_id: 'hs-1',
      email: 'jane@example.com',
      name: 'Jane Doe',
      pipeline_status_origin: null,
    });

    await handler.execute({
      objectId: 'hs-1',
      propertyName: 'hs_pipeline_stage',
      propertyValue: '942502182', // "New Candidates"
    });

    const updateArgs = prismaMock.candidate.update.mock.calls[0][0];
    expect(updateArgs.data.pipeline_status).toBe('942502182');
    expect(updateArgs.data.pipeline_status_origin).toBeUndefined();
  });
});
