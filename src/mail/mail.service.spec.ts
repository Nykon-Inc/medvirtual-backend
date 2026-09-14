import { BadRequestException, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MailService } from './mail.service';

jest.mock('resend');

describe('MailService', () => {
  let service: MailService;
  let mockEmailsSend: jest.Mock;

  beforeEach(async () => {
    mockEmailsSend = jest.fn();
    const { Resend } = require('resend');
    (Resend as jest.Mock).mockImplementation(() => ({
      emails: { send: mockEmailsSend },
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [MailService],
    }).compile();

    service = module.get<MailService>(MailService);
    process.env.RESEND_API_KEY = 'test-resend-key';
  });

  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('sendMail', () => {
    const validOptions = {
      from: 'noreply@medvirtual.ai',
      to: 'user@test.com',
      subject: 'Test Subject',
      html: '<p>Hello</p>',
    };

    it('should throw BadRequestException if RESEND_API_KEY is not set', async () => {
      delete process.env.RESEND_API_KEY;
      await expect(service.sendMail(validOptions)).rejects.toThrow(
        'RESEND_API_KEY is not set in environment variables',
      );
    });

    it('should throw BadRequestException if options are missing required fields', async () => {
      const invalidOptions = {
        to: 'user@test.com',
        subject: 'Test',
        html: '<p>hi</p>',
      } as any;
      await expect(service.sendMail(invalidOptions)).rejects.toThrow(
        'Invalid email options provided',
      );
    });

    it('should throw BadRequestException if Resend returns no data', async () => {
      mockEmailsSend.mockResolvedValueOnce({
        data: null,
        error: { message: 'Resend API error' },
      });
      await expect(service.sendMail(validOptions)).rejects.toThrow(
        'Failed to send email',
      );
    });

    it('should throw BadRequestException if Resend throws an error', async () => {
      mockEmailsSend.mockRejectedValueOnce(new Error('Network error'));
      await expect(service.sendMail(validOptions)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return true when email is sent successfully', async () => {
      process.env.ENVIRONMENT = 'PROD';
      mockEmailsSend.mockResolvedValueOnce({
        data: { id: 'email-123' },
        error: null,
      });
      const result = await service.sendMail(validOptions);
      expect(result).toBe(true);
      expect(mockEmailsSend).toHaveBeenCalledWith(
        expect.objectContaining({
          from: validOptions.from,
          to: validOptions.to,
        }),
      );
    });

    it('should use default tags when none are provided', async () => {
      mockEmailsSend.mockResolvedValueOnce({ data: { id: 'email-123' } });
      await service.sendMail(validOptions);
      expect(mockEmailsSend).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: [
            { name: 'type', value: 'general' },
            { name: 'source', value: 'medvirtual' },
          ],
        }),
      );
    });

    it('should use custom tags when provided', async () => {
      const customTags = [{ name: 'env', value: 'test' }];
      mockEmailsSend.mockResolvedValueOnce({ data: { id: 'email-124' } });
      await service.sendMail({ ...validOptions, tags: customTags });
      expect(mockEmailsSend).toHaveBeenCalledWith(
        expect.objectContaining({ tags: customTags }),
      );
    });

    describe('[DEV] prefix', () => {
      afterEach(() => {
        delete process.env.ENVIRONMENT;
      });

      it('adds [DEV] prefix to from when ENVIRONMENT is not PROD', async () => {
        process.env.ENVIRONMENT = 'STAGING';
        mockEmailsSend.mockResolvedValueOnce({ data: { id: 'e1' } });

        await service.sendMail(validOptions);

        expect(mockEmailsSend).toHaveBeenCalledWith(
          expect.objectContaining({ from: `[DEV] ${validOptions.from}` }),
        );
      });

      it('adds [DEV] prefix when ENVIRONMENT is undefined', async () => {
        delete process.env.ENVIRONMENT;
        mockEmailsSend.mockResolvedValueOnce({ data: { id: 'e2' } });

        await service.sendMail(validOptions);

        expect(mockEmailsSend).toHaveBeenCalledWith(
          expect.objectContaining({ from: `[DEV] ${validOptions.from}` }),
        );
      });

      it('does NOT add [DEV] prefix when ENVIRONMENT is PROD', async () => {
        process.env.ENVIRONMENT = 'PROD';
        mockEmailsSend.mockResolvedValueOnce({ data: { id: 'e3' } });

        await service.sendMail(validOptions);

        expect(mockEmailsSend).toHaveBeenCalledWith(
          expect.objectContaining({ from: validOptions.from }),
        );
      });

      it('preserves custom from value unchanged in PROD', async () => {
        process.env.ENVIRONMENT = 'PROD';
        mockEmailsSend.mockResolvedValueOnce({ data: { id: 'e4' } });

        await service.sendMail({
          ...validOptions,
          from: 'Berry Virtual <noreply@medvirtual.ai>',
        });

        expect(mockEmailsSend).toHaveBeenCalledWith(
          expect.objectContaining({
            from: 'Berry Virtual <noreply@medvirtual.ai>',
          }),
        );
      });
    });

    describe('unresolved placeholder scrub', () => {
      let warnSpy: jest.SpyInstance;

      beforeEach(() => {
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      });

      afterEach(() => {
        warnSpy.mockRestore();
      });

      it('strips {{token}} placeholders and cleans dangling punctuation', async () => {
        mockEmailsSend.mockResolvedValueOnce({ data: { id: 'e5' } });

        await service.sendMail({
          ...validOptions,
          subject: 'Hi {{firstName}}',
          html: '<p>Hello, {{firstName}}! Welcome to {{companyName}}.</p>',
        });

        expect(mockEmailsSend).toHaveBeenCalledWith(
          expect.objectContaining({
            subject: 'Hi',
            html: '<p>Hello! Welcome to.</p>',
          }),
        );
      });

      it('strips [[token]] and word-like [Token] placeholders', async () => {
        mockEmailsSend.mockResolvedValueOnce({ data: { id: 'e6' } });

        await service.sendMail({
          ...validOptions,
          subject: 'Update on [[caseId]]',
          html: '<p>Status: [PendingReview]</p>',
        });

        expect(mockEmailsSend).toHaveBeenCalledWith(
          expect.objectContaining({
            subject: 'Update on',
            html: '<p>Status:</p>',
          }),
        );
      });

      it('logs a warning naming the unresolved token(s) when the scrub triggers', async () => {
        mockEmailsSend.mockResolvedValueOnce({ data: { id: 'e7' } });

        await service.sendMail({
          ...validOptions,
          subject: 'Hi {{firstName}}',
          html: '<p>Hello</p>',
        });

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('{{firstName}}'),
        );
      });

      it('leaves clean text untouched and does not log a warning', async () => {
        mockEmailsSend.mockResolvedValueOnce({ data: { id: 'e8' } });

        await service.sendMail(validOptions);

        expect(mockEmailsSend).toHaveBeenCalledWith(
          expect.objectContaining({
            subject: validOptions.subject,
            html: validOptions.html,
          }),
        );
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('does not strip markdown-style links', async () => {
        mockEmailsSend.mockResolvedValueOnce({ data: { id: 'e9' } });

        await service.sendMail({
          ...validOptions,
          html: '<p>See [our docs](https://example.com) for details.</p>',
        });

        expect(mockEmailsSend).toHaveBeenCalledWith(
          expect.objectContaining({
            html: '<p>See [our docs](https://example.com) for details.</p>',
          }),
        );
      });
    });
  });
});
