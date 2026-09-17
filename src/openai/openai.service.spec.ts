import { Test, TestingModule } from '@nestjs/testing';
import { OpenaiService } from './openai.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import { OpenrouterService } from '../openrouter/openrouter.service';

// Mock OpenAI
const mockChatCreate = jest.fn();
const mockImagesEdit = jest.fn();

jest.mock('openai', () => {
  const MockOpenAI = class OpenAI {
    chat = { completions: { create: mockChatCreate } };
    images = { edit: mockImagesEdit };
  };
  return {
    default: MockOpenAI,
    toFile: jest.fn().mockResolvedValue({}),
    __esModule: true,
  };
});

// Mock fs — spread actual module so Prisma can still call existsSync etc.
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn(),
  createReadStream: jest.fn().mockReturnValue({}),
  writeFileSync: jest.fn(),
}));

const mockMailService = {
  sendMail: jest.fn(),
};

const mockOpenrouterService = {
  chatJson: jest.fn(),
  chatText: jest.fn(),
  editImage: jest.fn(),
};

/** Shape thrown by the OpenAI SDK v5 when the account is out of credit. */
const quotaError = () =>
  Object.assign(new Error('You exceeded your current quota'), {
    status: 429,
    code: 'insufficient_quota',
    error: { type: 'insufficient_quota' },
  });

const mockPrismaService = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  mail_Settings: {
    findFirst: jest.fn(),
    create: jest.fn(),
  },
};

describe('OpenaiService', () => {
  let service: OpenaiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenaiService,
        { provide: MailService, useValue: mockMailService },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: OpenrouterService, useValue: mockOpenrouterService },
      ],
    }).compile();

    service = module.get<OpenaiService>(OpenaiService);
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key';
    // Default to the fallback being disabled; tests opt in explicitly.
    delete process.env.OPENROUTER_API_KEY;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('extractDataFromResumeImages', () => {
    const mockImagePaths = ['/path/to/image1.png'];
    const mockExtractedData = {
      bio: 'Test Bio',
      experience: [],
      education: [],
      skills: [],
    };

    beforeEach(() => {
      (fs.readFileSync as jest.Mock).mockReturnValue(
        Buffer.from('mock-image-data'),
      );
    });

    it('should successfully extract data from images', async () => {
      mockChatCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify(mockExtractedData),
            },
          },
        ],
      });

      const result = await service.extractDataFromResumeImages(mockImagePaths);

      expect(result).toEqual({ data: mockExtractedData, cost: 0 });
      expect(fs.readFileSync).toHaveBeenCalledWith(mockImagePaths[0]);
      expect(mockChatCreate).toHaveBeenCalled();
    });

    it('should handle insufficient quota error and send email', async () => {
      const error = { type: 'insufficient_quota' };
      mockChatCreate.mockRejectedValue(error);

      // Mock no email sent today
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      mockMailService.sendMail.mockResolvedValue(true);

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow('You dont have credits. Check your plan/billing.');

      expect(mockPrismaService.mail_Settings.findFirst).toHaveBeenCalled();
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'shayan@regenta.ai',
          subject: 'Insufficient Quota from OpenAI',
        }),
      );
      expect(mockPrismaService.mail_Settings.create).toHaveBeenCalledWith({
        data: { title: 'insufficient_quota' },
      });
    });

    it('should not send email if already sent today for insufficient quota', async () => {
      const error = { type: 'insufficient_quota' };
      mockChatCreate.mockRejectedValue(error);

      // Mock email already sent
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue({ id: '1' });

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow('You dont have credits. Check your plan/billing.');

      expect(mockPrismaService.mail_Settings.findFirst).toHaveBeenCalled();
      expect(mockMailService.sendMail).not.toHaveBeenCalled();
      expect(mockPrismaService.mail_Settings.create).not.toHaveBeenCalled();
    });

    it('should handle rate limit error without falling back', async () => {
      mockChatCreate.mockRejectedValue({
        status: 429,
        code: 'rate_limit_exceeded',
      });

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow('Rate limit exceeded. Please try again later.');
      expect(mockOpenrouterService.chatJson).not.toHaveBeenCalled();
    });

    it('should handle unexpected errors without falling back', async () => {
      mockChatCreate.mockRejectedValue(new Error('Unexpected error'));

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow(
        'Unexpected error requesting OpenAI on extractDataFromResumeImages.',
      );
      expect(mockOpenrouterService.chatJson).not.toHaveBeenCalled();
    });

    it('should NOT fall back on a 5xx error', async () => {
      mockChatCreate.mockRejectedValue({ status: 503 });

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow(BadRequestException);
      expect(mockOpenrouterService.chatJson).not.toHaveBeenCalled();
    });

    it('should fall back to OpenRouter on insufficient quota', async () => {
      process.env.OPENROUTER_API_KEY = 'or-key';
      mockChatCreate.mockRejectedValue(quotaError());
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      mockOpenrouterService.chatJson.mockResolvedValue({
        data: { bio: 'from openrouter', experience: [{ company: 'X' }] },
        cost: 0,
        model: 'google/gemma-4-26b-a4b-it:free',
        latencyMs: 1200,
      });

      const result = await service.extractDataFromResumeImages(mockImagePaths);

      // Contract preserved exactly, so processData needs no changes.
      expect(result.cost).toBe(0);
      expect(result.data.bio).toBe('from openrouter');
      expect(result.data.experience).toHaveLength(1);
      expect(result.data.experience[0].company).toBe('X');
      expect(mockOpenrouterService.chatJson).toHaveBeenCalled();
      // The alert still fires even though the fallback succeeded.
      expect(mockMailService.sendMail).toHaveBeenCalled();
    });

    /**
     * Mirrors the real chatJson, which runs `validate` inside the model
     * cascade. A mock that ignored it would skip the code path being tested.
     */
    const chatJsonHonouringValidate = (rawModelOutput: any) =>
      mockOpenrouterService.chatJson.mockImplementation(
        async (_payload: any, options: any) => ({
          data: options?.validate
            ? options.validate(rawModelOutput)
            : rawModelOutput,
          cost: 0,
          model: 'google/gemma-4-26b-a4b-it:free',
          latencyMs: 1200,
        }),
      );

    it('should unwrap a fallback payload nested under a "0" key', async () => {
      process.env.OPENROUTER_API_KEY = 'or-key';
      mockChatCreate.mockRejectedValue(quotaError());
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      // The exact schema violation seen in production.
      chatJsonHonouringValidate({
        '0': {
          bio: 'nested bio',
          experience: [{ company: 'Acme', role: 'Nurse' }],
          education: [{ institution: 'MIT', degree: 'BS' }],
          skills: ['Triage'],
        },
        education: [],
        experience: [],
      });

      const result = await service.extractDataFromResumeImages(mockImagePaths);

      expect(result.data.bio).toBe('nested bio');
      expect(result.data.experience).toHaveLength(1);
      expect(result.data.education).toHaveLength(1);
      expect(result.data['0']).toBeUndefined();
    });

    it('should reject an empty fallback extraction instead of returning it', async () => {
      process.env.OPENROUTER_API_KEY = 'or-key';
      mockChatCreate.mockRejectedValue(quotaError());
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      // Must reject: updateFromJson deletes education/experience before
      // reinserting, so returning this would wipe the candidate's real data
      // and still mark them `completed`.
      chatJsonHonouringValidate({});

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow();
    });

    it('should not fall back when OPENROUTER_API_KEY is absent', async () => {
      delete process.env.OPENROUTER_API_KEY;
      mockChatCreate.mockRejectedValue(quotaError());
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow('You dont have credits. Check your plan/billing.');
      expect(mockOpenrouterService.chatJson).not.toHaveBeenCalled();
    });

    it('should surface the credits message when the fallback also fails', async () => {
      process.env.OPENROUTER_API_KEY = 'or-key';
      mockChatCreate.mockRejectedValue(quotaError());
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      mockOpenrouterService.chatJson.mockRejectedValue(new Error('or down'));

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow('You dont have credits. Check your plan/billing.');
    });

    it('should alert paulo@regenta.ai when the fallback also fails', async () => {
      process.env.OPENROUTER_API_KEY = 'or-key';
      mockChatCreate.mockRejectedValue(quotaError());
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      mockOpenrouterService.chatJson.mockRejectedValue(
        new Error('openrouter exploded'),
      );

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow(BadRequestException);

      // Both alerts fire: the quota one, then the fallback-failure one.
      expect(mockMailService.sendMail).toHaveBeenCalledTimes(2);

      const failureMail = mockMailService.sendMail.mock.calls[1][0];
      expect(failureMail.to).toBe('paulo@regenta.ai');
      expect(failureMail.subject).toBe(
        'OpenRouter Fallback Failed - Both AI Providers Down',
      );
      expect(failureMail.html).toContain('openrouter exploded');
      expect(failureMail.html).toContain('extractDataFromResumeImages');

      expect(mockPrismaService.mail_Settings.create).toHaveBeenCalledWith({
        data: { title: 'openrouter_fallback_failed' },
      });
    });

    it('should dedupe the fallback failure alert within the same day', async () => {
      process.env.OPENROUTER_API_KEY = 'or-key';
      mockChatCreate.mockRejectedValue(quotaError());
      // Quota alert not yet sent, fallback-failure alert already sent today.
      mockPrismaService.mail_Settings.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'already-sent' });
      mockOpenrouterService.chatJson.mockRejectedValue(new Error('or down'));

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow(BadRequestException);

      // Only the quota alert went out.
      expect(mockMailService.sendMail).toHaveBeenCalledTimes(1);
    });

    it('should not alert about the fallback when it succeeds', async () => {
      process.env.OPENROUTER_API_KEY = 'or-key';
      mockChatCreate.mockRejectedValue(quotaError());
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      mockOpenrouterService.chatJson.mockResolvedValue({
        data: { bio: 'ok' },
        cost: 0,
        model: 'google/gemma-4-26b-a4b-it:free',
        latencyMs: 100,
      });

      await service.extractDataFromResumeImages(mockImagePaths);

      expect(mockMailService.sendMail).toHaveBeenCalledTimes(1);
      expect(mockMailService.sendMail.mock.calls[0][0].subject).toBe(
        'Insufficient Quota from OpenAI',
      );
    });

    it('should still throw the credits error if the alert itself fails', async () => {
      process.env.OPENROUTER_API_KEY = 'or-key';
      mockChatCreate.mockRejectedValue(quotaError());
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      mockOpenrouterService.chatJson.mockRejectedValue(new Error('or down'));
      mockMailService.sendMail.mockRejectedValue(new Error('resend down'));

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow('You dont have credits. Check your plan/billing.');
    });
  });

  describe('organizeText', () => {
    const mockText = 'Resume plain text content';
    const mockCandidate = {
      name: 'John Doe',
      specialization: 'Medical Assistant',
    };

    it('should throw BadRequestException if OPENAI_API_KEY is not set', async () => {
      delete process.env.OPENAI_API_KEY;
      await expect(
        service.organizeText(mockText, mockCandidate),
      ).rejects.toThrow(
        'OPENAI_API_KEY is not defined in environment variables',
      );
    });

    it('should return organized text when OpenAI responds with valid JSON', async () => {
      const mockData = {
        bio: 'Professional bio',
        experience: [],
        education: [],
      };
      mockChatCreate.mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(mockData) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });

      const result = await service.organizeText(mockText, mockCandidate);
      const parsed = JSON.parse(result);

      expect(parsed.bio).toBe('Professional bio');
      expect(parsed.cost).toBeDefined();
    });

    it('should throw if OpenAI returns empty choices', async () => {
      mockChatCreate.mockResolvedValueOnce({ choices: [] });
      await expect(
        service.organizeText(mockText, mockCandidate),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw on insufficient_quota error', async () => {
      mockChatCreate.mockRejectedValueOnce({ type: 'insufficient_quota' });
      mockPrismaService.mail_Settings.findFirst.mockResolvedValueOnce(null);
      mockMailService.sendMail.mockResolvedValueOnce(true);

      await expect(
        service.organizeText(mockText, mockCandidate),
      ).rejects.toThrow('You dont have credits. Check your plan/billing.');
    });

    it('should throw on rate_limit_error', async () => {
      mockChatCreate.mockRejectedValueOnce({ type: 'rate_limit_error' });
      await expect(
        service.organizeText(mockText, mockCandidate),
      ).rejects.toThrow('Rate limit exceeded. Please try again later.');
    });
  });

  describe('generateTextSummary', () => {
    const mockDescription =
      'Looking for a senior medical assistant for a busy clinic.';

    it('should throw BadRequestException if OPENAI_API_KEY is not set', async () => {
      delete process.env.OPENAI_API_KEY;
      await expect(
        service.generateTextSummary(mockDescription),
      ).rejects.toThrow(
        'OPENAI_API_KEY is not defined in environment variables',
      );
    });

    it('should return summary string when OpenAI responds with content', async () => {
      mockChatCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'Senior medical assistant role.' } }],
      });

      const result = await service.generateTextSummary(mockDescription);
      expect(result).toBe('Senior medical assistant role.');
    });

    it('should throw on insufficient_quota error', async () => {
      mockChatCreate.mockRejectedValueOnce({ type: 'insufficient_quota' });
      await expect(
        service.generateTextSummary(mockDescription),
      ).rejects.toThrow('You dont have credits. Check your plan/billing.');
    });

    it('should throw on a rate limit without falling back', async () => {
      mockChatCreate.mockRejectedValueOnce({
        status: 429,
        code: 'rate_limit_exceeded',
      });
      await expect(
        service.generateTextSummary(mockDescription),
      ).rejects.toThrow('Rate limit exceeded. Please try again later.');
      expect(mockOpenrouterService.chatText).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException on unexpected error', async () => {
      mockChatCreate.mockRejectedValueOnce(new Error('Network failure'));
      await expect(
        service.generateTextSummary(mockDescription),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fall back to OpenRouter on insufficient quota', async () => {
      process.env.OPENROUTER_API_KEY = 'or-key';
      mockChatCreate.mockRejectedValueOnce(quotaError());
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      mockOpenrouterService.chatText.mockResolvedValue({
        data: 'A fallback summary.',
        cost: 0,
        model: 'openrouter/free',
        latencyMs: 900,
      });

      const result = await service.generateTextSummary(mockDescription);

      expect(result).toBe('A fallback summary.');
      expect(mockOpenrouterService.chatText).toHaveBeenCalled();
    });
  });

  describe('generateAvatarWithScreenshoot', () => {
    const mockCandidate = { id: 'cand-1' };

    beforeEach(() => {
      (fs.createReadStream as jest.Mock).mockReturnValue({});
      (fs.writeFileSync as jest.Mock).mockReturnValue(undefined);
    });

    it('should generate avatar and return imagePath and cost', async () => {
      mockImagesEdit.mockResolvedValueOnce({
        data: [{ b64_json: 'aW1hZ2VkYXRh' }],
      });

      const result = await service.generateAvatarWithScreenshoot(
        mockCandidate,
        '/tmp/screenshot.png',
      );

      expect(result.cost).toBe(0.04);
      expect(result.imagePath).toMatch(/avatarX\.png$/);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should throw when result.data is empty or missing b64_json', async () => {
      mockImagesEdit.mockResolvedValueOnce({ data: [] });

      await expect(
        service.generateAvatarWithScreenshoot(
          mockCandidate,
          '/tmp/screenshot.png',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fall back to OpenRouter on insufficient quota', async () => {
      process.env.OPENROUTER_API_KEY = 'or-key';
      mockImagesEdit.mockRejectedValueOnce(quotaError());
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      mockOpenrouterService.editImage.mockResolvedValue({
        imagePath: '/tmp/123_avatarOR.png',
        cost: 0.00003,
        model: 'google/gemini-2.5-flash-image',
        latencyMs: 3000,
      });

      const result = await service.generateAvatarWithScreenshoot(
        mockCandidate,
        '/tmp/screenshot.png',
      );

      expect(result).toEqual({
        imagePath: '/tmp/123_avatarOR.png',
        cost: 0.00003,
      });
      expect(mockOpenrouterService.editImage).toHaveBeenCalled();
    });
  });
});
