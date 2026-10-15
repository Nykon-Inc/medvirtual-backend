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

    beforeEach(() => {
      (fs.readFileSync as jest.Mock).mockReturnValue(
        Buffer.from('mock-image-data'),
      );
      // OpenRouter is primary for this pipeline — it's free — so it must be
      // enabled by default here, unlike the rest of the suite.
      process.env.OPENROUTER_API_KEY = 'or-key';
    });

    it('should successfully extract data via OpenRouter without touching OpenAI', async () => {
      mockOpenrouterService.chatJson.mockResolvedValue({
        data: { bio: 'from openrouter', experience: [{ company: 'X' }] },
        cost: 0,
        model: 'google/gemma-4-26b-a4b-it:free',
        latencyMs: 1200,
      });

      const result = await service.extractDataFromResumeImages(mockImagePaths);

      expect(result.cost).toBe(0);
      expect(result.data.bio).toBe('from openrouter');
      expect(result.data.experience[0].company).toBe('X');
      expect(mockOpenrouterService.chatJson).toHaveBeenCalled();
      expect(mockChatCreate).not.toHaveBeenCalled();
      expect(mockMailService.sendMail).not.toHaveBeenCalled();
    });

    it('should unwrap an OpenRouter payload nested under a "0" key', async () => {
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
      expect(mockChatCreate).not.toHaveBeenCalled();
    });

    it('should fall back to OpenAI when OpenRouter returns an empty extraction', async () => {
      // Must reject rather than return: updateFromJson deletes the
      // candidate's education/experience before reinserting, so an empty
      // result would wipe real data and still mark them `completed`.
      chatJsonHonouringValidate({});
      mockChatCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                bio: 'from openai',
                experience: [],
                education: [],
                skills: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });

      const result = await service.extractDataFromResumeImages(mockImagePaths);

      expect(result.data.bio).toBe('from openai');
      expect(mockChatCreate).toHaveBeenCalled();
    });

    it('should fall back to OpenAI on ANY OpenRouter error, not just quota', async () => {
      mockOpenrouterService.chatJson.mockRejectedValue(
        new Error('free model timed out'),
      );
      mockChatCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                bio: 'from openai',
                experience: [],
                education: [],
                skills: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });

      const result = await service.extractDataFromResumeImages(mockImagePaths);

      expect(result.data.bio).toBe('from openai');
      expect(mockChatCreate).toHaveBeenCalled();
      // No quota/credits alert — OpenRouter failing is not an OpenAI billing event.
      expect(mockMailService.sendMail).not.toHaveBeenCalled();
    });

    it('should compute OpenAI fallback cost from usage', async () => {
      mockOpenrouterService.chatJson.mockRejectedValue(new Error('or down'));
      mockChatCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                bio: 'from openai',
                experience: [],
                education: [],
                skills: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 1000 },
      });

      const result = await service.extractDataFromResumeImages(mockImagePaths);

      expect(result.cost).toBeCloseTo(0.00015 + 0.0006, 6);
    });

    it('should go straight to OpenAI when OPENROUTER_API_KEY is absent', async () => {
      delete process.env.OPENROUTER_API_KEY;
      mockChatCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                bio: 'from openai',
                experience: [],
                education: [],
                skills: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });

      const result = await service.extractDataFromResumeImages(mockImagePaths);

      expect(result.data.bio).toBe('from openai');
      expect(mockOpenrouterService.chatJson).not.toHaveBeenCalled();
    });

    it('should throw and alert paulo@regenta.ai when both providers fail', async () => {
      mockOpenrouterService.chatJson.mockRejectedValue(
        new Error('openrouter exploded'),
      );
      mockChatCreate.mockRejectedValue(new Error('openai also down'));
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      mockMailService.sendMail.mockResolvedValue(true);

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow('openai also down');

      expect(mockMailService.sendMail).toHaveBeenCalledTimes(1);
      const failureMail = mockMailService.sendMail.mock.calls[0][0];
      expect(failureMail.to).toBe('paulo@regenta.ai');
      expect(failureMail.subject).toBe(
        'OpenRouter Fallback Failed - Both AI Providers Down',
      );
      expect(failureMail.html).toContain('openai also down');
      expect(failureMail.html).toContain('extractDataFromResumeImages');
      expect(failureMail.html).toContain('OpenAI Error');

      expect(mockPrismaService.mail_Settings.create).toHaveBeenCalledWith({
        data: { title: 'openrouter_fallback_failed' },
      });
    });

    it('should dedupe the fallback failure alert within the same day', async () => {
      mockOpenrouterService.chatJson.mockRejectedValue(new Error('or down'));
      mockChatCreate.mockRejectedValue(new Error('openai also down'));
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue({
        id: 'already-sent',
      });

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow('openai also down');

      expect(mockMailService.sendMail).not.toHaveBeenCalled();
    });

    it('should still throw the underlying OpenAI error if the alert itself fails', async () => {
      mockOpenrouterService.chatJson.mockRejectedValue(new Error('or down'));
      mockChatCreate.mockRejectedValue(new Error('openai also down'));
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      mockMailService.sendMail.mockRejectedValue(new Error('resend down'));

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow('openai also down');
    });

    it('should throw when OPENAI_API_KEY is missing and OpenRouter also failed', async () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY_RESUME_EXTRACTION;
      mockOpenrouterService.chatJson.mockRejectedValue(new Error('or down'));
      mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);

      await expect(
        service.extractDataFromResumeImages(mockImagePaths),
      ).rejects.toThrow(
        'OPENAI_API_KEY is not defined in environment variables',
      );
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
    const openRouterResult = (data = 'An OpenRouter summary.') => ({
      data,
      cost: 0,
      model: 'openrouter/free',
      latencyMs: 900,
    });

    describe('with OpenRouter enabled', () => {
      beforeEach(() => {
        process.env.OPENROUTER_API_KEY = 'or-key';
        mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      });

      it('should use OpenRouter first and not call OpenAI', async () => {
        mockOpenrouterService.chatText.mockResolvedValueOnce(
          openRouterResult('  An OpenRouter summary.  '),
        );

        const result = await service.generateTextSummary(mockDescription);

        expect(result).toBe('An OpenRouter summary.');
        expect(mockChatCreate).not.toHaveBeenCalled();
      });

      it('should fall back to OpenAI when OpenRouter fails', async () => {
        mockOpenrouterService.chatText.mockRejectedValueOnce(
          new Error('all free models failed'),
        );
        mockChatCreate.mockResolvedValueOnce({
          choices: [{ message: { content: 'OpenAI fallback summary.' } }],
        });

        const result = await service.generateTextSummary(mockDescription);

        expect(result).toBe('OpenAI fallback summary.');
        expect(mockChatCreate).toHaveBeenCalledTimes(1);
      });

      it('should fall back to OpenAI when OpenRouter returns an empty summary', async () => {
        mockOpenrouterService.chatText.mockResolvedValueOnce(
          openRouterResult('   '),
        );
        mockChatCreate.mockResolvedValueOnce({
          choices: [{ message: { content: 'OpenAI fallback summary.' } }],
        });

        const result = await service.generateTextSummary(mockDescription);

        expect(result).toBe('OpenAI fallback summary.');
      });

      it('should use the model from OPENAI_MODEL_TO_TEXT on fallback', async () => {
        process.env.OPENAI_MODEL_TO_TEXT = 'custom-text-model';
        mockOpenrouterService.chatText.mockRejectedValueOnce(new Error('down'));
        mockChatCreate.mockResolvedValueOnce({
          choices: [{ message: { content: 'ok' } }],
        });

        await service.generateTextSummary(mockDescription);

        expect(mockChatCreate).toHaveBeenCalledWith(
          expect.objectContaining({ model: 'custom-text-model' }),
        );
        delete process.env.OPENAI_MODEL_TO_TEXT;
      });

      it('should use the default model when OPENAI_MODEL_TO_TEXT is unset', async () => {
        delete process.env.OPENAI_MODEL_TO_TEXT;
        mockOpenrouterService.chatText.mockRejectedValueOnce(new Error('down'));
        mockChatCreate.mockResolvedValueOnce({
          choices: [{ message: { content: 'ok' } }],
        });

        await service.generateTextSummary(mockDescription);

        expect(mockChatCreate).toHaveBeenCalledWith(
          expect.objectContaining({ model: 'gpt-4o-mini' }),
        );
      });

      it('should throw when both providers fail', async () => {
        mockOpenrouterService.chatText.mockRejectedValueOnce(new Error('down'));
        mockChatCreate.mockRejectedValueOnce(new Error('Network failure'));

        await expect(
          service.generateTextSummary(mockDescription),
        ).rejects.toThrow('Network failure');
      });

      it('should throw when OpenRouter fails and OpenAI returns no content', async () => {
        mockOpenrouterService.chatText.mockRejectedValueOnce(new Error('down'));
        mockChatCreate.mockResolvedValueOnce({ choices: [] });

        await expect(
          service.generateTextSummary(mockDescription),
        ).rejects.toThrow('OpenAI did not return a valid summary.');
      });
    });

    describe('with OpenRouter disabled', () => {
      beforeEach(() => {
        delete process.env.OPENROUTER_API_KEY;
      });

      it('should throw BadRequestException if OPENAI_API_KEY is not set', async () => {
        delete process.env.OPENAI_API_KEY;
        await expect(
          service.generateTextSummary(mockDescription),
        ).rejects.toThrow(
          'OPENAI_API_KEY is not defined in environment variables',
        );
        expect(mockOpenrouterService.chatText).not.toHaveBeenCalled();
      });

      it('should go straight to OpenAI', async () => {
        mockChatCreate.mockResolvedValueOnce({
          choices: [{ message: { content: 'Senior medical assistant role.' } }],
        });

        const result = await service.generateTextSummary(mockDescription);

        expect(result).toBe('Senior medical assistant role.');
        expect(mockOpenrouterService.chatText).not.toHaveBeenCalled();
      });
    });
  });

  describe('generateAvatarWithScreenshoot', () => {
    const mockCandidate = { id: 'cand-1' };

    beforeEach(() => {
      (fs.createReadStream as jest.Mock).mockReturnValue({});
      (fs.writeFileSync as jest.Mock).mockReturnValue(undefined);
    });

    const openRouterAvatar = {
      imagePath: '/tmp/123_avatarOR.png',
      cost: 0.0392,
      model: 'google/gemini-2.5-flash-image',
      latencyMs: 3000,
    };

    describe('with OpenRouter enabled', () => {
      beforeEach(() => {
        process.env.OPENROUTER_API_KEY = 'or-key';
        mockPrismaService.mail_Settings.findFirst.mockResolvedValue(null);
      });

      it('should use OpenRouter first and not call OpenAI', async () => {
        mockOpenrouterService.editImage.mockResolvedValueOnce(openRouterAvatar);

        const result = await service.generateAvatarWithScreenshoot(
          mockCandidate,
          '/tmp/screenshot.png',
        );

        expect(result).toEqual({
          imagePath: '/tmp/123_avatarOR.png',
          cost: 0.0392,
        });
        expect(mockImagesEdit).not.toHaveBeenCalled();
      });

      it('should fall back to OpenAI when OpenRouter fails', async () => {
        mockOpenrouterService.editImage.mockRejectedValueOnce(
          new Error('image model unavailable'),
        );
        mockImagesEdit.mockResolvedValueOnce({
          data: [{ b64_json: 'aW1hZ2VkYXRh' }],
        });

        const result = await service.generateAvatarWithScreenshoot(
          mockCandidate,
          '/tmp/screenshot.png',
        );

        expect(result.imagePath).toMatch(/avatarX\.png$/);
        expect(mockImagesEdit).toHaveBeenCalledWith(
          expect.objectContaining({ model: 'gpt-image-2.5-flare' }),
        );
      });

      it('should throw when both providers fail', async () => {
        mockOpenrouterService.editImage.mockRejectedValueOnce(
          new Error('openrouter down'),
        );
        mockImagesEdit.mockRejectedValueOnce(new Error('openai down'));

        await expect(
          service.generateAvatarWithScreenshoot(
            mockCandidate,
            '/tmp/screenshot.png',
          ),
        ).rejects.toThrow('openai down');
      });
    });

    describe('with OpenRouter disabled', () => {
      beforeEach(() => {
        delete process.env.OPENROUTER_API_KEY;
      });

      it('should generate avatar and return imagePath and cost', async () => {
        mockImagesEdit.mockResolvedValueOnce({
          data: [{ b64_json: 'aW1hZ2VkYXRh' }],
        });

        const result = await service.generateAvatarWithScreenshoot(
          mockCandidate,
          '/tmp/screenshot.png',
        );

        expect(result.cost).toBe(0.02);
        expect(result.imagePath).toMatch(/avatarX\.png$/);
        expect(fs.writeFileSync).toHaveBeenCalled();
        expect(mockImagesEdit).toHaveBeenCalledWith(
          expect.objectContaining({
            model: 'gpt-image-2.5-flare',
            size: '1024x1024',
            quality: 'medium',
          }),
        );
      });

      it('should compute cost from usage tokens', async () => {
        mockImagesEdit.mockResolvedValueOnce({
          data: [{ b64_json: 'aW1hZ2VkYXRh' }],
          usage: {
            input_tokens_details: { text_tokens: 100, image_tokens: 1000 },
            output_tokens: 440,
          },
        });

        const result = await service.generateAvatarWithScreenshoot(
          mockCandidate,
          '/tmp/screenshot.png',
        );

        // (100*5 + 1000*8 + 440*30) / 1e6
        expect(result.cost).toBe(0.0217);
      });

      it('should throw when result.data is empty or missing b64_json', async () => {
        mockImagesEdit.mockResolvedValueOnce({ data: [] });

        await expect(
          service.generateAvatarWithScreenshoot(
            mockCandidate,
            '/tmp/screenshot.png',
          ),
        ).rejects.toThrow(
          'The OpenAI API response did not contain the expected image data.',
        );
      });
    });
  });
});
