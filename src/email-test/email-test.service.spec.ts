import { Test, TestingModule } from '@nestjs/testing';
import { EmailTestService } from './email-test.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';

const mockMailService = {
  sendMail: jest.fn(),
};

const mockNotificationsService = {
  buildEmail: jest.fn().mockReturnValue('<html>notification</html>'),
};

describe('EmailTestService', () => {
  let service: EmailTestService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailTestService,
        { provide: MailService, useValue: mockMailService },
        { provide: NotificationsService, useValue: mockNotificationsService },
      ],
    }).compile();

    service = module.get<EmailTestService>(EmailTestService);
    jest.clearAllMocks();
    mockNotificationsService.buildEmail.mockReturnValue(
      '<html>notification</html>',
    );

    jest.spyOn(service as any, 'delay').mockResolvedValue(undefined);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('testVerificationCode', () => {
    it('should return success true when email is sent', async () => {
      mockMailService.sendMail.mockResolvedValueOnce(true);

      const result = await service.testVerificationCode(
        'medvirtual',
        false,
        'test@test.com',
      );

      expect(result.success).toBe(true);
      expect(result.verificationCode).toBe('123456');
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'test@test.com' }),
      );
    });

    it('should return success false when sendMail throws', async () => {
      mockMailService.sendMail.mockRejectedValueOnce(new Error('mail error'));

      const result = await service.testVerificationCode(
        'medvirtual',
        false,
        'test@test.com',
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('mail error');
    });

    it('should use Berry Virtual theme when themeName is berry', async () => {
      mockMailService.sendMail.mockResolvedValueOnce(true);

      const result = await service.testVerificationCode(
        'berry',
        true,
        'test@test.com',
      );

      expect(result.success).toBe(true);
      expect(result.theme).toBe('Berry Virtual');
    });
  });

  describe('testInviteSignup', () => {
    it('should return success true when email is sent', async () => {
      mockMailService.sendMail.mockResolvedValueOnce(true);

      const result = await service.testInviteSignup(
        'medvirtual',
        'test@test.com',
      );

      expect(result.success).toBe(true);
      expect(result.inviteLink).toContain('/signup?token=');
    });

    it('should return success false when sendMail throws', async () => {
      mockMailService.sendMail.mockRejectedValueOnce(new Error('SMTP error'));

      const result = await service.testInviteSignup(
        'medvirtual',
        'test@test.com',
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('SMTP error');
    });
  });

  describe('testResetPassword', () => {
    it('should return success true when email is sent', async () => {
      mockMailService.sendMail.mockResolvedValueOnce(true);

      const result = await service.testResetPassword(
        'medvirtual',
        'test@test.com',
      );

      expect(result.success).toBe(true);
      expect(result.resetLink).toContain('/set-password');
    });

    it('should return success false when sendMail throws', async () => {
      mockMailService.sendMail.mockRejectedValueOnce(new Error('timeout'));

      const result = await service.testResetPassword(
        'medvirtual',
        'test@test.com',
      );

      expect(result.success).toBe(false);
    });
  });

  describe('testNotification', () => {
    it('should return success true and call buildEmail', async () => {
      mockMailService.sendMail.mockResolvedValueOnce(true);

      const result = await service.testNotification(
        'medvirtual',
        'test@test.com',
      );

      expect(result.success).toBe(true);
      expect(mockNotificationsService.buildEmail).toHaveBeenCalled();
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ html: '<html>notification</html>' }),
      );
    });

    it('should return success false when sendMail throws', async () => {
      mockMailService.sendMail.mockRejectedValueOnce(new Error('send error'));

      const result = await service.testNotification(
        'medvirtual',
        'test@test.com',
      );

      expect(result.success).toBe(false);
    });
  });

  describe('testAllTemplates', () => {
    it('should return success true when all emails are sent', async () => {
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.testAllTemplates(
        'medvirtual',
        'test@test.com',
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('All email templates sent successfully');
      expect(result.results.verificationCode.success).toBe(true);
      expect(result.results.inviteSignup.success).toBe(true);
      expect(result.results.resetPassword.success).toBe(true);
      expect(result.results.notification.success).toBe(true);
    });

    it('should return success false when at least one email fails', async () => {
      mockMailService.sendMail
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('invite failed'))
        .mockResolvedValue(true);

      const result = await service.testAllTemplates(
        'medvirtual',
        'test@test.com',
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Some email templates failed');
    });

    it('should call delay between emails', async () => {
      mockMailService.sendMail.mockResolvedValue(true);
      const delaySpy = jest.spyOn(service as any, 'delay');

      await service.testAllTemplates('medvirtual', 'test@test.com');

      expect(delaySpy).toHaveBeenCalledTimes(3);
      expect(delaySpy).toHaveBeenCalledWith(600);
    });
  });
});
