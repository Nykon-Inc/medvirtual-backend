import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import { GoogledriveService } from '../googledrive/googledrive.service';
import { OpenrouterService } from '../openrouter/openrouter.service';
import { PrismaService } from '../prisma/prisma.service';
import { AiComparisonService } from './ai-comparison.service';

const mockChatCreate = jest.fn();

jest.mock('openai', () => {
  const MockOpenAI = class OpenAI {
    chat = { completions: { create: mockChatCreate } };
  };
  return { default: MockOpenAI, __esModule: true };
});

jest.mock('node-poppler', () => ({
  Poppler: jest.fn().mockImplementation(() => ({
    pdfToCairo: jest.fn().mockResolvedValue('converted'),
  })),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  rmSync: jest.fn(),
  unlinkSync: jest.fn(),
  readdirSync: jest.fn(),
  readFileSync: jest.fn(),
}));

const mockPrisma = {
  candidate: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

const mockGoogle = { downloadFile: jest.fn() };
const mockOpenrouter = { chatJson: jest.fn(), chatText: jest.fn() };

const openaiExtraction = {
  bio: 'An experienced medical assistant.',
  experience: [{ company: 'A' }, { company: 'B' }, { company: 'C' }],
  education: [{ institution: 'Uni' }, { institution: 'College' }],
  skills: ['EMR', 'Scheduling', 'Billing'],
};

describe('AiComparisonService', () => {
  let service: AiComparisonService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiComparisonService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: GoogledriveService, useValue: mockGoogle },
        { provide: OpenrouterService, useValue: mockOpenrouter },
      ],
    }).compile();

    service = module.get<AiComparisonService>(AiComparisonService);
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key';

    mockPrisma.candidate.findUnique.mockResolvedValue({
      id: 'cand-1',
      // extractDriveFileId requires an id longer than 25 characters.
      resume_url:
        'https://drive.google.com/file/d/test-file-id-with-more-than-25-characters-123/view',
    });
    mockGoogle.downloadFile.mockResolvedValue('Download successful');
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readdirSync as jest.Mock).mockReturnValue(['page-1.png', 'page-2.png']);
    (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('img'));

    mockChatCreate.mockResolvedValue({
      model: 'gpt-4o-mini',
      choices: [{ message: { content: JSON.stringify(openaiExtraction) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    });
    mockOpenrouter.chatJson.mockResolvedValue({
      data: {
        bio: 'A medical assistant.',
        experience: [{ company: 'A' }, { company: 'B' }],
        education: [{ institution: 'Uni' }, { institution: 'College' }],
        skills: [],
      },
      cost: 0,
      model: 'google/gemma-4-26b-a4b-it:free',
      latencyMs: 20000,
    });
  });

  describe('compareResume', () => {
    it('should return both provider outputs and a diff', async () => {
      const result = await service.compareResume({ candidateId: 'cand-1' });

      expect(result.candidateId).toBe('cand-1');
      expect(result.pageCount).toBe(2);
      expect(result.openai.ok).toBe(true);
      expect(result.openrouter.ok).toBe(true);
      expect(result.openrouter.model).toBe('google/gemma-4-26b-a4b-it:free');

      expect(result.diff.experienceCount).toEqual({
        openai: 3,
        openrouter: 2,
        delta: 1,
      });
      expect(result.diff.educationCount).toEqual({
        openai: 2,
        openrouter: 2,
        delta: 0,
      });
      expect(result.diff.skillsCount).toEqual({
        openai: 3,
        openrouter: 0,
        delta: 3,
      });
      // skills is populated by OpenAI but empty in the OpenRouter output.
      expect(result.diff.missingInOpenrouter).toEqual(['skills']);
      expect(result.diff.missingInOpenai).toEqual([]);
    });

    // The whole point of this endpoint is that it is a dry run.
    it('should never write to the candidate record', async () => {
      await service.compareResume({ candidateId: 'cand-1' });
      expect(mockPrisma.candidate.update).not.toHaveBeenCalled();
    });

    it('should send byte-identical payloads to both providers', async () => {
      await service.compareResume({ candidateId: 'cand-1' });

      const openaiPayload = mockChatCreate.mock.calls[0][0].messages[0].content;
      const openrouterPayload = mockOpenrouter.chatJson.mock.calls[0][0];
      expect(openaiPayload).toEqual(openrouterPayload);
    });

    it('should respect maxPages', async () => {
      await service.compareResume({ candidateId: 'cand-1', maxPages: 1 });
      const payload = mockOpenrouter.chatJson.mock.calls[0][0];
      // One text part plus a single image part.
      expect(payload).toHaveLength(2);
    });

    it('should forward an explicit models override', async () => {
      await service.compareResume({
        candidateId: 'cand-1',
        models: ['custom/model'],
      });
      expect(mockOpenrouter.chatJson.mock.calls[0][1].models).toEqual([
        'custom/model',
      ]);
    });

    it('should still report when one provider fails', async () => {
      mockChatCreate.mockRejectedValue(new Error('openai exploded'));

      const result = await service.compareResume({ candidateId: 'cand-1' });

      expect(result.openai.ok).toBe(false);
      expect(result.openai.error).toContain('openai exploded');
      expect(result.openrouter.ok).toBe(true);
    });

    it('should clean up temp artifacts even when a provider throws', async () => {
      mockOpenrouter.chatJson.mockRejectedValue(new Error('boom'));
      await service.compareResume({ candidateId: 'cand-1' });
      expect(fs.rmSync).toHaveBeenCalled();
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should throw when the candidate does not exist', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(null);
      await expect(
        service.compareResume({ candidateId: 'missing' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw when the candidate has no resume URL', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue({
        id: 'cand-1',
        resume_url: 'N/A',
      });
      await expect(
        service.compareResume({ candidateId: 'cand-1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when the download fails', async () => {
      mockGoogle.downloadFile.mockResolvedValue('Permission denied');
      await expect(
        service.compareResume({ candidateId: 'cand-1' }),
      ).rejects.toThrow('Failed to download resume: Permission denied');
    });

    it('should throw when the PDF yields no images', async () => {
      (fs.readdirSync as jest.Mock).mockReturnValue([]);
      await expect(
        service.compareResume({ candidateId: 'cand-1' }),
      ).rejects.toThrow('No images could be converted from the PDF.');
    });
  });

  describe('resumeFromOpenRouterOnly', () => {
    // Regression guard: passing the raw result through `settled` (which only
    // understands the Promise.allSettled envelope) reported ok:false and
    // discarded the extraction even on a fully successful call.
    it('should report ok with the real extraction data', async () => {
      const result = await service.resumeFromOpenRouterOnly({
        candidateId: 'cand-1',
      });

      expect(result.openrouter.ok).toBe(true);
      expect(result.openrouter.model).toBe('google/gemma-4-26b-a4b-it:free');
      expect(result.openrouter.latencyMs).toBe(20000);
      expect(result.openrouter.cost).toBe(0);
      // Content assertions rather than a strict shape match: the result is
      // normalized, so canonical schema fields are filled in.
      expect(result.openrouter.data.bio).toBe('A medical assistant.');
      expect(
        result.openrouter.data.experience.map((e: any) => e.company),
      ).toEqual(['A', 'B']);
      expect(
        result.openrouter.data.education.map((e: any) => e.institution),
      ).toEqual(['Uni', 'College']);
      expect(result.openrouter.data.skills).toEqual([]);
      expect(result.openrouter.error).toBeUndefined();
      expect(result.candidateId).toBe('cand-1');
      expect(result.pageCount).toBe(2);
    });

    // The whole point of the endpoint: usable while OpenAI is out of credit.
    it('should never call OpenAI', async () => {
      await service.resumeFromOpenRouterOnly({ candidateId: 'cand-1' });
      expect(mockChatCreate).not.toHaveBeenCalled();
    });

    it('should never write to the candidate record', async () => {
      await service.resumeFromOpenRouterOnly({ candidateId: 'cand-1' });
      expect(mockPrisma.candidate.update).not.toHaveBeenCalled();
    });

    it('should respect maxPages and forward a models override', async () => {
      await service.resumeFromOpenRouterOnly({
        candidateId: 'cand-1',
        maxPages: 1,
        models: ['custom/model'],
      });

      const [payload, options] = mockOpenrouter.chatJson.mock.calls[0];
      expect(payload).toHaveLength(2);
      expect(options.models).toEqual(['custom/model']);
    });

    it('should clean up temp artifacts when OpenRouter throws', async () => {
      mockOpenrouter.chatJson.mockRejectedValue(new Error('or down'));

      await expect(
        service.resumeFromOpenRouterOnly({ candidateId: 'cand-1' }),
      ).rejects.toThrow('or down');
      expect(fs.rmSync).toHaveBeenCalled();
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should clean up when PDF conversion fails', async () => {
      (fs.readdirSync as jest.Mock).mockReturnValue([]);

      await expect(
        service.resumeFromOpenRouterOnly({ candidateId: 'cand-1' }),
      ).rejects.toThrow('No images could be converted from the PDF.');
      expect(fs.rmSync).toHaveBeenCalled();
    });

    it('should throw when the candidate does not exist', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(null);
      await expect(
        service.resumeFromOpenRouterOnly({ candidateId: 'missing' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw when the download fails', async () => {
      mockGoogle.downloadFile.mockResolvedValue('Permission denied');
      await expect(
        service.resumeFromOpenRouterOnly({ candidateId: 'cand-1' }),
      ).rejects.toThrow('Failed to download resume: Permission denied');
    });
  });

  describe('compareTextSummary', () => {
    beforeEach(() => {
      mockChatCreate.mockResolvedValue({
        model: 'gpt-4o-mini',
        choices: [{ message: { content: 'One. Two. Three.' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      mockOpenrouter.chatText.mockResolvedValue({
        data: 'One. Two.',
        cost: 0,
        model: 'openrouter/free',
        latencyMs: 5000,
      });
    });

    it('should compare both summaries', async () => {
      const result = await service.compareTextSummary({
        text: 'x'.repeat(60),
      });

      expect(result.openai.data).toBe('One. Two. Three.');
      expect(result.openrouter.data).toBe('One. Two.');
      expect(result.diff.sentenceCount).toEqual({
        openai: 3,
        openrouter: 2,
        delta: 1,
      });
      expect(result.diff.length.delta).toBe(
        'One. Two. Three.'.length - 'One. Two.'.length,
      );
    });

    it('should report a failing provider without throwing', async () => {
      mockOpenrouter.chatText.mockRejectedValue(new Error('or down'));
      const result = await service.compareTextSummary({ text: 'x'.repeat(60) });
      expect(result.openrouter.ok).toBe(false);
      expect(result.openai.ok).toBe(true);
    });
  });
});
