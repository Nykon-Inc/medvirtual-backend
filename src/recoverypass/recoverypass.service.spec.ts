import { Test, TestingModule } from '@nestjs/testing';
import { RecoverypassService } from './recoverypass.service';
import { UserService } from '../user/user.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';

import * as bcrypt from 'bcryptjs';

jest.mock('bcryptjs', () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}));

const userServiceMock = {
  findByEmail: jest.fn(),
};

const mailServiceMock = {
  sendMail: jest.fn(),
};

const prismaServiceMock = {
  uSER: {
    update: jest.fn(),
  },
  passwordResetToken: {
    create: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('RecoverypassService', () => {
  let service: RecoverypassService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecoverypassService,
        { provide: UserService, useValue: userServiceMock },
        { provide: PrismaService, useValue: prismaServiceMock },
        { provide: MailService, useValue: mailServiceMock },
        {
          provide: EmailTemplatesService,
          useValue: { getTemplateContent: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get<RecoverypassService>(RecoverypassService);
  });

  // ============================
  // FORGOT PASSWORD
  // ============================

  describe('forgotPassword', () => {
    it('should throw 400 if email is empty', async () => {
      await expect(service.forgotPassword({ email: '' })).rejects.toThrow(
        'Email is required',
      );
    });

    it('should return Error if user does not exist (anti-enumeration)', async () => {
      userServiceMock.findByEmail.mockResolvedValue(null);

      await expect(
        service.forgotPassword({ email: 'notfound@test.com' }),
      ).rejects.toThrow('User not found');
    });

    it('should create reset token and send email successfully', async () => {
      const fakeUser = {
        id: '1',
        email: 'test@test.com',
        first_name: 'Test',
      };

      userServiceMock.findByEmail.mockResolvedValue(fakeUser);

      prismaServiceMock.passwordResetToken.updateMany.mockResolvedValue({});
      prismaServiceMock.passwordResetToken.create.mockResolvedValue({});
      mailServiceMock.sendMail.mockResolvedValue(true);

      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-token');

      const result = await service.forgotPassword({
        email: fakeUser.email,
      });

      expect(result).toBe(true);
      expect(prismaServiceMock.passwordResetToken.create).toHaveBeenCalled();
      expect(mailServiceMock.sendMail).toHaveBeenCalled();
    });
  });

  // ============================
  // SET PASSWORD
  // ============================

  describe('setPassword', () => {
    it('should throw 400 if token is missing', async () => {
      await expect(
        service.setPassword({ token: '', password: 'newPassword123' }),
      ).rejects.toThrow('Reset token is required');
    });

    it('should throw 400 if password is missing', async () => {
      await expect(
        service.setPassword({ token: 'valid-token', password: '' }),
      ).rejects.toThrow('New password is required');
    });

    it('should throw if reset token does not exist', async () => {
      prismaServiceMock.passwordResetToken.findFirst.mockResolvedValue(null);

      await expect(
        service.setPassword({ token: 'invalid', password: 'newPassword123' }),
      ).rejects.toThrow('Invalid or expired token');
    });

    it('should throw if token comparison fails', async () => {
      prismaServiceMock.passwordResetToken.findFirst.mockResolvedValue({
        id: '1',
        userId: '1',
        tokenHash: 'hashed-token',
      });

      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.setPassword({
          token: 'wrong-token',
          password: 'newPassword123',
        }),
      ).rejects.toThrow('Invalid or expired token');
    });

    it('should reset password successfully', async () => {
      prismaServiceMock.passwordResetToken.findFirst.mockResolvedValue({
        id: '1',
        userId: '1',
        tokenHash: 'hashed-token',
      });

      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-password');

      prismaServiceMock.$transaction.mockResolvedValue([]);

      const result = await service.setPassword({
        token: 'valid-token',
        password: 'newPassword123',
      });

      expect(result).toBe(true);
      expect(prismaServiceMock.$transaction).toHaveBeenCalled();
    });
  });
});
