import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { HandlerObjectCreation } from './objectCreation';
import { PrismaService } from '../../prisma/prisma.service';
import { CandidatesService } from '../../candidate/candidates.service';
import { CandidateAuditService } from '../../candidate/candidate-audit.service';

jest.mock('axios');

const prismaMock = {
  candidate: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  candidateSkill: { create: jest.fn() },
  candidateLanguage: { create: jest.fn() },
};

const candidateServiceMock = {
  processData: jest.fn(),
  ensureAvatar: jest.fn(),
};

const candidateAuditMock = {
  log: jest.fn(),
  logOrThrow: jest.fn(),
  logMany: jest.fn(),
};

describe('HandlerObjectCreation', () => {
  let handler: HandlerObjectCreation;
  const originalEnvironment = process.env.ENVIRONMENT;

  const mockHubspotObject = (properties: Record<string, string>) => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { properties } });
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HandlerObjectCreation,
        { provide: PrismaService, useValue: prismaMock },
        { provide: CandidatesService, useValue: candidateServiceMock },
        { provide: CandidateAuditService, useValue: candidateAuditMock },
      ],
    }).compile();

    handler = module.get<HandlerObjectCreation>(HandlerObjectCreation);

    jest.clearAllMocks();
    process.env.ENVIRONMENT = 'PROD';
    prismaMock.candidate.findUnique.mockResolvedValue(null);
    prismaMock.candidate.create.mockResolvedValue({
      id: 'candidate-1',
      hubspot_id: 'hs-1',
    });
  });

  afterEach(() => {
    process.env.ENVIRONMENT = originalEnvironment;
  });

  it('should create the candidate and hand avatar generation to the gated ensureAvatar', async () => {
    mockHubspotObject({
      hs_pipeline_stage: '942502182', // "New Candidates"
      headshot_screenshot: 'https://drive.google.com/file/d/abc/view',
    });

    const result = await handler.execute({ objectId: 'hs-1' });

    expect(result).toBe(true);
    expect(prismaMock.candidate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pipeline_status: '942502182',
        headshot_url: 'https://drive.google.com/file/d/abc/view',
      }),
    });
    expect(candidateServiceMock.processData).toHaveBeenCalledWith(
      'candidate-1',
    );
    expect(candidateServiceMock.ensureAvatar).toHaveBeenCalledWith(
      'candidate-1',
    );
  });

  it('should stamp origin and first_available_at when created directly in an available stage', async () => {
    mockHubspotObject({ hs_pipeline_stage: '261075105' });

    await handler.execute({ objectId: 'hs-1' });

    const createArgs = prismaMock.candidate.create.mock.calls[0][0];
    expect(createArgs.data.pipeline_status_origin).toBe('261075105');
    expect(createArgs.data.first_available_at).toBeInstanceOf(Date);
  });

  it('should create skills and languages from the HubSpot properties', async () => {
    mockHubspotObject({
      career_highlights_relevant_job_experiences: 'Billing; Scheduling',
      language_spoken: 'English & Spanish',
    });

    await handler.execute({ objectId: 'hs-1' });

    expect(prismaMock.candidateSkill.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.candidateLanguage.create).toHaveBeenCalledTimes(2);
  });

  it('should not run the processing pipelines outside PROD', async () => {
    process.env.ENVIRONMENT = 'DEV';
    mockHubspotObject({ hs_pipeline_stage: '261075105' });

    await handler.execute({ objectId: 'hs-1' });

    expect(candidateServiceMock.processData).not.toHaveBeenCalled();
    expect(candidateServiceMock.ensureAvatar).not.toHaveBeenCalled();
  });

  it('should throw when the candidate already exists', async () => {
    mockHubspotObject({ hs_pipeline_stage: '261075105' });
    prismaMock.candidate.findUnique.mockResolvedValue({ id: 'candidate-1' });

    await expect(handler.execute({ objectId: 'hs-1' })).rejects.toThrow(
      'Candidate already exists on the database',
    );
    expect(candidateServiceMock.ensureAvatar).not.toHaveBeenCalled();
  });
});
