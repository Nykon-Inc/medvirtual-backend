import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import * as fs from 'fs';
import {
  OpenrouterService,
  parseJsonLoose,
  stripPlainTextArtifacts,
} from './openrouter.service';

const mockChatCreate = jest.fn();

jest.mock('openai', () => {
  const MockOpenAI = class OpenAI {
    chat = { completions: { create: mockChatCreate } };
  };
  return { default: MockOpenAI, __esModule: true };
});

jest.mock('axios');

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

const chatResponse = (
  content: string,
  model = 'google/gemma-4-26b-a4b-it:free',
) => ({
  model,
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
});

describe('OpenrouterService', () => {
  let service: OpenrouterService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OpenrouterService],
    }).compile();

    service = module.get<OpenrouterService>(OpenrouterService);
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'test-key';
    delete process.env.OPENROUTER_VISION_MODELS;
    delete process.env.OPENROUTER_TEXT_MODELS;
    delete process.env.OPENROUTER_IMAGE_MODEL;
  });

  describe('parseJsonLoose', () => {
    it('should parse plain JSON', () => {
      expect(parseJsonLoose('{"bio":"hello"}')).toEqual({ bio: 'hello' });
    });

    it('should strip ```json fences', () => {
      expect(parseJsonLoose('```json\n{"bio":"hi"}\n```')).toEqual({
        bio: 'hi',
      });
    });

    it('should strip bare ``` fences', () => {
      expect(parseJsonLoose('```\n{"bio":"hi"}\n```')).toEqual({ bio: 'hi' });
    });

    it('should salvage JSON surrounded by prose', () => {
      expect(
        parseJsonLoose('Here is the result:\n{"bio":"hi"}\nHope that helps!'),
      ).toEqual({ bio: 'hi' });
    });

    it('should throw on unrecoverable garbage', () => {
      expect(() => parseJsonLoose('not json at all')).toThrow(
        BadRequestException,
      );
    });
  });

  describe('stripPlainTextArtifacts', () => {
    it('should remove fences and a Summary: preamble', () => {
      expect(stripPlainTextArtifacts('```\nSummary: A nurse.\n```')).toBe(
        'A nurse.',
      );
    });
  });

  describe('chatJson validate', () => {
    it('should apply the validator to the parsed data', async () => {
      mockChatCreate.mockResolvedValue(chatResponse('{"bio":"ok"}'));

      const result = await service.chatJson('prompt', {
        validate: (data) => ({ ...data, normalized: true }),
      });

      expect(result.data).toEqual({ bio: 'ok', normalized: true });
    });

    it('should try the next model when the validator rejects', async () => {
      // A 200 response carrying unusable JSON must be treated like a transport
      // failure, otherwise the first bad free model ends the cascade.
      mockChatCreate
        .mockResolvedValueOnce(chatResponse('{}', 'model-a'))
        .mockResolvedValueOnce(chatResponse('{"bio":"good"}', 'model-b'));

      const result = await service.chatJson('prompt', {
        models: ['model-a', 'model-b'],
        validate: (data) => {
          if (!data?.bio) throw new Error('empty extraction');
          return data;
        },
      });

      expect(mockChatCreate).toHaveBeenCalledTimes(2);
      expect(result.data).toEqual({ bio: 'good' });
      expect(result.model).toBe('model-b');
    });

    it('should reject when every model fails validation', async () => {
      mockChatCreate.mockResolvedValue(chatResponse('{}'));

      await expect(
        service.chatJson('prompt', {
          models: ['model-a', 'model-b'],
          validate: () => {
            throw new Error('empty extraction');
          },
        }),
      ).rejects.toThrow('empty extraction');
      expect(mockChatCreate).toHaveBeenCalledTimes(2);
    });
  });

  describe('chatJson', () => {
    it('should send the models cascade and request json_object', async () => {
      mockChatCreate.mockResolvedValue(chatResponse('{"bio":"ok"}'));

      const result = await service.chatJson('prompt');

      expect(result.data).toEqual({ bio: 'ok' });
      const body = mockChatCreate.mock.calls[0][0];
      expect(body.models).toEqual([
        'google/gemma-4-26b-a4b-it:free',
        'google/gemma-4-31b-it:free',
        'openrouter/free',
      ]);
      expect(body.model).toBe('google/gemma-4-26b-a4b-it:free');
      expect(body.response_format).toEqual({ type: 'json_object' });
    });

    it('should report zero cost for a :free model', async () => {
      mockChatCreate.mockResolvedValue(chatResponse('{"bio":"ok"}'));
      const result = await service.chatJson('prompt');
      expect(result.cost).toBe(0);
    });

    it('should use usage.cost for a paid model', async () => {
      mockChatCreate.mockResolvedValue({
        model: 'paid/model',
        choices: [{ message: { content: '{"a":1}' } }],
        usage: { cost: 0.0042 },
      });
      const result = await service.chatJson('prompt');
      expect(result.cost).toBe(0.0042);
    });

    it('should return the serving model and latency', async () => {
      mockChatCreate.mockResolvedValue(chatResponse('{"bio":"ok"}'));
      const result = await service.chatJson('prompt');
      expect(result.model).toBe('google/gemma-4-26b-a4b-it:free');
      expect(typeof result.latencyMs).toBe('number');
    });

    it('should advance the cascade when the first model fails', async () => {
      mockChatCreate
        .mockRejectedValueOnce(new Error('model down'))
        .mockResolvedValueOnce(
          chatResponse('{"bio":"second"}', 'google/gemma-4-31b-it:free'),
        );

      const result = await service.chatJson('prompt');

      expect(result.data).toEqual({ bio: 'second' });
      expect(mockChatCreate).toHaveBeenCalledTimes(2);
      // Second attempt drops the failed model from the list.
      expect(mockChatCreate.mock.calls[1][0].models).toEqual([
        'google/gemma-4-31b-it:free',
        'openrouter/free',
      ]);
    });

    it('should rethrow when every model in the cascade fails', async () => {
      mockChatCreate.mockRejectedValue(new Error('all down'));
      await expect(service.chatJson('prompt')).rejects.toThrow('all down');
      expect(mockChatCreate).toHaveBeenCalledTimes(3);
    });

    it('should honour an explicit models override', async () => {
      mockChatCreate.mockResolvedValue(chatResponse('{"a":1}', 'custom/model'));
      await service.chatJson('prompt', { models: ['custom/model'] });
      expect(mockChatCreate.mock.calls[0][0].models).toEqual(['custom/model']);
    });

    it('should throw when the API key is missing', async () => {
      delete process.env.OPENROUTER_API_KEY;
      await expect(service.chatJson('prompt')).rejects.toThrow(
        'OPENROUTER_API_KEY is not defined in environment variables',
      );
    });

    it('should throw when the response has no content', async () => {
      mockChatCreate.mockResolvedValue({ model: 'm', choices: [], usage: {} });
      await expect(service.chatJson('prompt')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('chatText', () => {
    it('should return cleaned plain text without json mode', async () => {
      mockChatCreate.mockResolvedValue(chatResponse('  A short summary.  '));

      const result = await service.chatText('prompt', {
        systemPrompt: 'be brief',
      });

      expect(result.data).toBe('A short summary.');
      const body = mockChatCreate.mock.calls[0][0];
      expect(body.response_format).toBeUndefined();
      expect(body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    });

    it('should throw when the model returns only whitespace', async () => {
      mockChatCreate.mockResolvedValue(chatResponse('   '));
      await expect(service.chatText('prompt')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('editImage', () => {
    beforeEach(() => {
      (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('source'));
    });

    it('should post to the images endpoint with input_references', async () => {
      (axios.post as jest.Mock).mockResolvedValue({
        data: { data: [{ b64_json: Buffer.from('img').toString('base64') }] },
      });

      const result = await service.editImage(
        '/tmp/in.png',
        'make it corporate',
      );

      const [url, body] = (axios.post as jest.Mock).mock.calls[0];
      expect(url).toBe('https://openrouter.ai/api/v1/images');
      expect(body.model).toBe('google/gemini-2.5-flash-image');
      expect(body.input_references[0].image_url.url).toContain(
        'data:image/png;base64,',
      );
      expect(result.cost).toBe(0.00003);
      expect(result.imagePath).toMatch(/_avatarOR\.png$/);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should accept the alternate images[] response shape', async () => {
      (axios.post as jest.Mock).mockResolvedValue({
        data: { images: [{ b64_json: Buffer.from('img').toString('base64') }] },
      });
      const result = await service.editImage('/tmp/in.png', 'prompt');
      expect(result.imagePath).toMatch(/_avatarOR\.png$/);
    });

    it('should throw when no image data comes back', async () => {
      (axios.post as jest.Mock).mockResolvedValue({ data: {} });
      await expect(service.editImage('/tmp/in.png', 'prompt')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
