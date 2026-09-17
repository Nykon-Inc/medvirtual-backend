import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AuthService } from './auth.service';
import { UserService } from '../user/user.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AffiliateUpdateService } from '../hubspot/update/affiliate';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { generateVerificationCode } from '../common/utils/generateCode.util';

const mockEmailTemplates = {
  getTemplateContent: jest.fn().mockResolvedValue(null),
};

import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcryptjs';
import { first } from 'rxjs';

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'mocked-jwt-token'),
  verify: jest.fn(() => 'mocked-jwt-token-verify'),
}));

jest.mock('../common/utils/generateCode.util', () => ({
  generateVerificationCode: jest.fn(),
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn(() => 'hashed-password'),
  compare: jest.fn(() => true),
}));

describe('AuthService - signIn', () => {
  let service: AuthService;
  let user: UserService;
  let prisma: PrismaService;

  const userMock = {
    create: jest.fn(),
    findByEmail: jest.fn(),
  };

  const mailMock = { sendMail: jest.fn() };

  const prismaMock = {
    session: {
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    organization: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    affiliateProfile: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userMock },
        { provide: MailService, useValue: mailMock },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    user = module.get<UserService>(UserService);
    prisma = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  const dataFake = { email: 'test@test.com', password: 'testpassword' };
  const authenticationMethod = 'OwnSign';

  it('should throw if user not found', async () => {
    userMock.findByEmail.mockResolvedValue(null);

    await expect(service.signIn(dataFake)).rejects.toThrow(
      new UnauthorizedException('User not found with this email'),
    );
  });

  it('should throw if user is deleted', async () => {
    userMock.findByEmail.mockResolvedValue({ status: 'deleted' });

    await expect(service.signIn(dataFake)).rejects.toThrow(
      new UnauthorizedException(
        'This account has been deleted. Please contact support.',
      ),
    );
  });

  it('should throw if user is inactive', async () => {
    userMock.findByEmail.mockResolvedValue({ status: 'inactive' });

    await expect(service.signIn(dataFake)).rejects.toThrow(
      new UnauthorizedException(
        'Your account is inactive. Please contact your administrator to reactivate your account.',
      ),
    );
  });

  it('should throw if user is suspended', async () => {
    userMock.findByEmail.mockResolvedValue({ status: 'suspended' });

    await expect(service.signIn(dataFake)).rejects.toThrow(
      new UnauthorizedException(
        'Your account has been suspended. Please contact support for assistance.',
      ),
    );
  });

  it('should throw if user is pending verification', async () => {
    userMock.findByEmail.mockResolvedValue({ status: 'pending_verification' });

    await expect(service.signIn(dataFake)).rejects.toThrow(
      new UnauthorizedException(
        'Your account is pending verification. Please check your email and verify your account.',
      ),
    );
  });

  it('should throw if user is prospect', async () => {
    userMock.findByEmail.mockResolvedValue({ status: 'prospect' });

    await expect(service.signIn(dataFake)).rejects.toThrow(
      new UnauthorizedException(
        'Your account is not yet activated. Please contact support.',
      ),
    );
  });

  it('should throw if user is incomplete', async () => {
    userMock.findByEmail.mockResolvedValue({ status: 'incomplete' });

    await expect(service.signIn(dataFake)).rejects.toThrow(
      new UnauthorizedException(
        'Your account setup is incomplete. Please contact support.',
      ),
    );
  });

  it('should throw if user has no organization', async () => {
    userMock.findByEmail.mockResolvedValue({
      id: 'u1',
      status: 'active',
      organization_id: null,
    });

    await expect(service.signIn(dataFake)).rejects.toThrow(
      new UnauthorizedException(
        'User does not belong to any organization. Please contact support.',
      ),
    );
  });

  it('should throw if organization not found or inactive', async () => {
    userMock.findByEmail.mockResolvedValue({
      id: 'u1',
      status: 'active',
      organization_id: 'org1',
      authentication_method: 'OwnSign',
    });
    prismaMock.organization.findMany.mockResolvedValue([]);

    await expect(service.signIn(dataFake)).rejects.toThrow(
      new UnauthorizedException(
        'User organization not found or inactive. Please contact support.',
      ),
    );
  });

  it('should throw if user has wrong auth method', async () => {
    userMock.findByEmail.mockResolvedValue({
      id: 'u1',
      organization_id: 'org1',
      authentication_method: 'different',
      status: 'active',
    });
    prismaMock.organization.findUnique.mockResolvedValue({
      // Change from findMany to findUnique
      business_unit: 'Test Unit',
      status: 'active',
    });

    await expect(service.signIn(dataFake)).rejects.toThrow(
      new UnauthorizedException(
        'User does not use this authentication method. You need to Sign in with the first method you have used',
      ),
    );
  });

  it('should throw if user is not verified', async () => {
    userMock.findByEmail.mockResolvedValue({
      id: 'u1',
      organization_id: 'org1',
      authentication_method: authenticationMethod,
      verified: false,
      status: 'active',
    });
    prismaMock.organization.findUnique.mockResolvedValue({
      // Change from findMany to findUnique
      business_unit: 'Test Unit',
      status: 'active',
    });

    await expect(service.signIn(dataFake)).rejects.toThrow(
      new UnauthorizedException('User not verified'),
    );
  });

  it('should throw if password is invalid', async () => {
    userMock.findByEmail.mockResolvedValue({
      id: 'u1',
      email: dataFake.email,
      password: 'hashed-pass',
      authentication_method: authenticationMethod,
      verified: true,
      status: 'active',
      organization_id: 'org1',
    });
    prismaMock.organization.findUnique.mockResolvedValue({
      // Change from findMany to findUnique
      business_unit: 'Test Unit',
      status: 'active',
    });

    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(service.signIn(dataFake)).rejects.toThrow(
      new BadRequestException('Invalid password'),
    );
  });

  it('should throw if session creation fails', async () => {
    userMock.findByEmail.mockResolvedValue({
      id: 'u1',
      email: dataFake.email,
      password: 'hashed-pass',
      authentication_method: authenticationMethod,
      verified: true,
      status: 'active',
      organization_id: 'org1',
    });
    prismaMock.organization.findUnique.mockResolvedValue({
      // Change from findMany to findUnique
      business_unit: 'Test Unit',
      status: 'active',
    });

    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    (jwt.sign as jest.Mock).mockReturnValue('mocked-token');
    prismaMock.session.updateMany.mockResolvedValue({});
    prismaMock.session.create.mockResolvedValue(null);

    await expect(service.signIn(dataFake)).rejects.toThrow(
      new BadRequestException('Failed to create session'),
    );
  });

  it('should return token and user if everything is ok', async () => {
    const userObj = {
      id: 'u1',
      email: dataFake.email,
      password: 'hashed-pass',
      authentication_method: authenticationMethod,
      verified: true,
      status: 'active',
      organization_id: 'org1',
      first_name: 'Test',
      last_name: 'User',
      role: 'admin',
      affiliate_profile_id: null,
      onboarding_tour_dismissed: true,
    };
    userMock.findByEmail.mockResolvedValue(userObj);
    prismaMock.organization.findUnique.mockResolvedValue({
      // Change from findMany to findUnique
      business_unit: 'Berry Virtual',
      status: 'active',
    });

    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    (jwt.sign as jest.Mock).mockReturnValue('mocked-token');
    prismaMock.session.updateMany.mockResolvedValue({});
    prismaMock.session.create.mockResolvedValue({ id: 'session1' });

    const result = await service.signIn(dataFake);

    expect(result).toEqual({
      statusCode: 200,
      message: 'User authenticated successfully',
      token: 'mocked-token',
      user: {
        id: 'u1',
        firstName: 'Test',
        lastName: 'User',
        email: dataFake.email,
        role: 'admin',
        clientId: 'org1',
        business_unit: 'Berry Virtual',
        affiliate_profile_id: null,
        onboarding_tour_dismissed: true,
      },
    });
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { isRevoked: true },
    });
  });

  it('should prioritize Berry Virtual business unit over others', async () => {
    const userObj = {
      id: 'u1',
      email: dataFake.email,
      password: 'hashed-pass',
      authentication_method: authenticationMethod,
      verified: true,
      status: 'active',
      organization_id: 'org1',
      first_name: 'Test',
      last_name: 'User',
      role: 'admin',
    };
    userMock.findByEmail.mockResolvedValue(userObj);
    prismaMock.organization.findUnique.mockResolvedValue({
      // Change from findMany to findUnique
      business_unit: 'Berry Virtual',
      status: 'active',
    });

    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    (jwt.sign as jest.Mock).mockReturnValue('mocked-token');
    prismaMock.session.updateMany.mockResolvedValue({});
    prismaMock.session.create.mockResolvedValue({ id: 'session1' });

    const result = await service.signIn(dataFake);

    expect((result as any).user.business_unit).toBe('Berry Virtual');
  });
});

describe('AuthService - Signup', () => {
  let service: AuthService;
  let user: UserService;
  let mail: MailService;
  let prisma: PrismaService;

  const userServiceMock = {
    findByEmail: jest.fn(),
  };

  const mailmock = {
    sendMail: jest.fn(),
  };

  const prismamock = {
    emailVerification: {
      create: jest.fn(),
    },
    organization: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  };

  const datafake = {
    firstName: 'Test',
    lastName: 'User',
    password: 'testpassword',
    role: 'User',
    jobTitle: 'Tester',
    companyName: 'TestCompany',
    organizationId: 'org-123`',
    email: 'test@test.com',
    status: 'prospect',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userServiceMock },
        { provide: MailService, useValue: mailmock },
        { provide: PrismaService, useValue: prismamock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    user = module.get<UserService>(UserService);
    mail = module.get<MailService>(MailService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  //should return 400 if Failed to store verification code
  //should return 200 if everything is ok

  it('should return 400 if User already exists with this email', async () => {
    user.findByEmail = jest.fn().mockResolvedValue({ id: 'existing-userId' });
    await expect(service.signUp(datafake)).rejects.toThrow(
      new BadRequestException('User already exists with this email'),
    );
  });

  it('should return 400 if Failed to create user', async () => {
    user.findByEmail = jest.fn().mockResolvedValue(null);
    prisma.organization.create = jest.fn().mockResolvedValue(true);
    user.create = jest.fn().mockResolvedValue(null);

    await expect(service.signUp(datafake)).rejects.toThrow(
      new BadRequestException('Failed to create user'),
    );
  });

  it('should return 400 if Failed to generate verification code', async () => {
    user.findByEmail = jest.fn().mockResolvedValue(null);
    prisma.organization.create = jest.fn().mockResolvedValue(true);
    user.create = jest.fn().mockResolvedValue(true);
    (generateVerificationCode as jest.Mock).mockReturnValue(null);
    await expect(service.signUp(datafake)).rejects.toThrow(
      new BadRequestException('Failed to generate verification code'),
    );
  });

  it('should return 400 if failed to send verification email', async () => {
    user.findByEmail = jest.fn().mockResolvedValue(null);
    prisma.organization.create = jest.fn().mockResolvedValue(true);
    user.create = jest.fn().mockResolvedValue(true);
    (generateVerificationCode as jest.Mock).mockReturnValue('12345');
    mail.sendMail = jest.fn().mockResolvedValue(false);

    await expect(service.signUp(datafake)).rejects.toThrow(
      new BadRequestException('Failed to send verification email'),
    );
  });

  it('should return 400 if failed to store verification code', async () => {
    user.findByEmail = jest.fn().mockResolvedValue(null);
    prisma.organization.create = jest.fn().mockResolvedValue(true);
    user.create = jest.fn().mockResolvedValue(true);
    (generateVerificationCode as jest.Mock).mockReturnValue('12345');
    mail.sendMail = jest.fn().mockResolvedValue(true);

    prisma.emailVerification.create = jest.fn().mockResolvedValue(null);

    await expect(service.signUp(datafake)).rejects.toThrow(
      new BadRequestException('Failed to store verification code'),
    );
  });

  it('should return 200 if everything is ok', async () => {
    user.findByEmail = jest.fn().mockResolvedValue(null);
    prisma.organization.create = jest.fn().mockResolvedValue(true);
    user.create = jest.fn().mockResolvedValue(true);
    (generateVerificationCode as jest.Mock).mockReturnValue('12345');
    mail.sendMail = jest.fn().mockResolvedValue(true);

    prisma.emailVerification.create = jest.fn().mockResolvedValue(true);

    jest.spyOn(jwt, 'sign').mockImplementation(() => 'mocked-jwt-token');

    await expect(service.signUp(datafake)).resolves.toEqual({
      token: 'mocked-jwt-token',
    });
  });
});

describe('AuthService - inviteUser', () => {
  let service: AuthService;
  let userServiceMock: {
    findByEmail: jest.Mock;
    create: jest.Mock;
  };
  let mailServiceMock: {
    sendMail: jest.Mock;
  };
  let prismaMock: {
    emailInvitation: { create: jest.Mock };
  };

  beforeEach(async () => {
    userServiceMock = {
      findByEmail: jest.fn(),
      create: jest.fn(),
    };

    mailServiceMock = {
      sendMail: jest.fn(),
    };

    prismaMock = {
      emailInvitation: {
        create: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userServiceMock },
        { provide: MailService, useValue: mailServiceMock },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should throw if user already exists', async () => {
    const dataFake = {
      email: 'test@test.com',
      role: 'RoleExample',
      companyName: 'Company',
      organizationId: 'org-123',
    };

    userServiceMock.findByEmail.mockResolvedValue({ id: 'existing-user-id' });

    await expect(service.inviteUser(dataFake)).rejects.toThrow(
      'User already exists',
    );
  });

  it('should send invitation email successfully', async () => {
    const dataFake = {
      email: 'newuser@test.com',
      role: 'RoleExample',
      companyName: 'Company',
      organizationId: 'org-123',
    };

    userServiceMock.findByEmail.mockResolvedValue(null);
    userServiceMock.create.mockResolvedValue({ id: 'new-user-id' });
    mailServiceMock.sendMail.mockResolvedValue(true);
    prismaMock.emailInvitation.create.mockResolvedValue({ id: 'invite-id' });

    const result = await service.inviteUser(dataFake);

    expect(result).toBe(`Invitation sent successfully to ${dataFake.email}`);
    expect(userServiceMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: dataFake.email,
      }),
    );
    expect(mailServiceMock.sendMail).toHaveBeenCalled();
    expect(prismaMock.emailInvitation.create).toHaveBeenCalled();
  });
});

describe('AuthService - getUser', () => {
  let service: AuthService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const prismamock = {
      emailInvitation: {
        findFirst: jest.fn(),
      },
      uSER: {
        findFirst: jest.fn(),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: PrismaService, useValue: prismamock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('should return 400 if the token is not provided', async () => {
    await expect(service.getUser({ token: '' })).rejects.toThrow(
      new BadRequestException('Token is required'),
    );
  });

  it('should return 404 if the token is not found', async () => {
    const token = 'tokenFake';
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new UnauthorizedException('Invalid token');
    });
  });

  it('should return 404 if the token is not found', async () => {
    (jwt.verify as jest.Mock).mockImplementation(() => {
      return { id: 'UserIdfake' };
    });
    prisma.emailInvitation.findFirst = jest.fn().mockResolvedValue(null);

    await expect(service.getUser({ token: 'valid-token' })).rejects.toThrow(
      new BadRequestException('Token not found!'),
    );
  });

  it('should return 404 if the user is not found', async () => {
    (jwt.verify as jest.Mock).mockImplementation(() => {
      return { id: 'UserIdfake' };
    });
    prisma.emailInvitation.findFirst = jest.fn().mockResolvedValue(true);
    prisma.uSER.findFirst = jest.fn().mockResolvedValue(false);

    await expect(service.getUser({ token: 'valid-token' })).rejects.toThrow(
      new BadRequestException('User not found!'),
    );
  });

  it('should return user object if everything is ok', async () => {
    (jwt.verify as jest.Mock).mockImplementation(() => {
      return { id: 'UserIdfake' };
    });
    prisma.emailInvitation.findFirst = jest.fn().mockResolvedValue(true);
    prisma.uSER.findFirst = jest.fn().mockResolvedValue(true);

    const result = await service.getUser({ token: 'valid-token' });
    expect(result).toBeTruthy(); // Assuming the user object is returned as true for simplicity
  });
});

describe('AuthService - invitedUserSignup', () => {
  let service: AuthService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const prismamock = {
      emailInvitation: {
        findFirst: jest.fn(),
      },
      uSER: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      affiliateProfile: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      session: {
        updateMany: jest.fn(),
        create: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: PrismaService, useValue: prismamock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('should return 404 if the token is not found', async () => {
    const token = 'tokenFake';
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new UnauthorizedException('Invalid token');
    });
  });

  it('should return 404 if the token is not found', async () => {
    (jwt.verify as jest.Mock).mockImplementation(() => {
      return { id: 'UserIdfake' };
    });
    prisma.emailInvitation.findFirst = jest.fn().mockResolvedValue(null);

    await expect(service.getUser({ token: 'valid-token' })).rejects.toThrow(
      new BadRequestException('Token not found!'),
    );
  });

  it('should return 404 if the user is not found', async () => {
    (jwt.verify as jest.Mock).mockImplementation(() => {
      return { id: 'UserIdfake' };
    });
    prisma.emailInvitation.findFirst = jest.fn().mockResolvedValue(true);
    prisma.uSER.findFirst = jest.fn().mockResolvedValue(false);

    await expect(service.getUser({ token: 'valid-token' })).rejects.toThrow(
      new BadRequestException('User not found!'),
    );
  });

  it('should return 400 if there error in set user password', async () => {
    const dataFake = {
      token: 'valid-token',
      password: 'valid-password',
      confirmPassword: 'valid-password',
      firstName: 'Test',
      lastName: 'User',
      jobTitle: 'Tester',
      status: 'prospect',
    };
    (jwt.verify as jest.Mock).mockImplementation(() => {
      return { id: 'UserIdfake' };
    });
    prisma.emailInvitation.findFirst = jest.fn().mockResolvedValue(true);
    prisma.uSER.findFirst = jest.fn().mockResolvedValue(true);
    prisma.uSER.update = jest.fn().mockResolvedValue(false);
    prisma.affiliateProfile.findUnique = jest.fn().mockResolvedValue(null);
    prisma.affiliateProfile.update = jest.fn().mockResolvedValue(true);

    await expect(service.invitedUserSignup(dataFake)).rejects.toThrow(
      new BadRequestException('Error in set user password'),
    );
  });

  it('should return message if everything is ok', async () => {
    const dataFake = {
      token: 'valid-token',
      password: 'valid-password',
      confirmPassword: 'valid-password',
      firstName: 'Test',
      lastName: 'User',
      jobTitle: 'Tester',
      status: 'prospect',
    };
    (jwt.verify as jest.Mock).mockImplementation(() => {
      return { id: 'UserIdfake' };
    });
    prisma.emailInvitation.findFirst = jest.fn().mockResolvedValue(true);
    prisma.uSER.findFirst = jest.fn().mockResolvedValue(true);
    prisma.uSER.update = jest.fn().mockResolvedValue(true);
    prisma.affiliateProfile.findUnique = jest.fn().mockResolvedValue(null);
    prisma.affiliateProfile.update = jest.fn().mockResolvedValue(true);

    jest.spyOn(jwt, 'sign').mockImplementation(() => 'mocked-jwt-token');

    prisma.session.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.session.create = jest.fn().mockResolvedValue(true);

    await expect(service.invitedUserSignup(dataFake)).resolves.toEqual(
      'mocked-jwt-token',
    );
  });

  it('should activate affiliate profile when user has one', async () => {
    const dataFake = {
      token: 'valid-token',
      password: 'valid-password',
      firstName: 'Test',
      lastName: 'User',
    };
    (jwt.verify as jest.Mock).mockImplementation(() => ({ id: 'UserIdfake' }));
    prisma.emailInvitation.findFirst = jest.fn().mockResolvedValue(true);
    prisma.uSER.findFirst = jest
      .fn()
      .mockResolvedValue({ id: 'UserIdfake', email: 'test@test.com' });
    prisma.uSER.update = jest.fn().mockResolvedValue(true);
    prisma.affiliateProfile.findUnique = jest
      .fn()
      .mockResolvedValue({ user_id: 'UserIdfake', hubspot_id: 'hs-1' });
    prisma.affiliateProfile.update = jest.fn().mockResolvedValue(true);
    jest.spyOn(jwt, 'sign').mockImplementation(() => 'mocked-jwt-token');
    prisma.session.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.session.create = jest.fn().mockResolvedValue(true);

    const result = await service.invitedUserSignup(dataFake as any);

    expect(result).toBe('mocked-jwt-token');
    expect(prisma.affiliateProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'active' } }),
    );
  });
});

describe('AuthService - resendCode', () => {
  let service: AuthService;
  let prisma: PrismaService;
  let userServiceMock: any;
  let mailServiceMock: any;

  beforeEach(async () => {
    userServiceMock = { findById: jest.fn() };
    mailServiceMock = { sendMail: jest.fn() };
    const prismaMock: any = {
      emailVerification: {
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      organization: { findUnique: jest.fn() },
    };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userServiceMock },
        { provide: MailService, useValue: mailServiceMock },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  it('should throw BadRequestException when no token', async () => {
    await expect(service.resendCode({ token: '' } as any)).rejects.toThrow(
      'Token are required',
    );
  });

  it('should throw UnauthorizedException when jwt.verify fails', async () => {
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error('bad');
    });
    await expect(service.resendCode({ token: 'bad' } as any)).rejects.toThrow(
      'Invalid token',
    );
  });

  it('should throw when user not found', async () => {
    (jwt.verify as jest.Mock).mockReturnValue({ id: 'u1' });
    userServiceMock.findById.mockResolvedValue(null);
    await expect(service.resendCode({ token: 'tok' } as any)).rejects.toThrow(
      'User not found',
    );
  });

  it('should resend code and return new token on success', async () => {
    (jwt.verify as jest.Mock).mockReturnValue({ id: 'u1' });
    (jwt.sign as jest.Mock).mockReturnValue('new-jwt');
    (generateVerificationCode as jest.Mock).mockReturnValue('654321');
    userServiceMock.findById.mockResolvedValue({
      id: 'u1',
      email: 'u@test.com',
      organization_id: 'org1',
    });
    (prisma.emailVerification as any).updateMany.mockResolvedValue({
      count: 1,
    });
    (prisma.emailVerification as any).create.mockResolvedValue({
      id: 'code-1',
    });
    (prisma.organization as any).findUnique.mockResolvedValue({
      name: 'MedVirtual',
      status: 'active',
      business_unit: 'MedVirtual',
    });
    mailServiceMock.sendMail.mockResolvedValue(true);

    const result = await service.resendCode({ token: 'tok' } as any);
    expect(result).toEqual({ token: 'new-jwt' });
  });
});

describe('AuthService - reInviteUser', () => {
  let service: AuthService;
  let prisma: PrismaService;
  let userServiceMock: any;
  let mailServiceMock: any;

  beforeEach(async () => {
    userServiceMock = { findById: jest.fn() };
    mailServiceMock = { sendMail: jest.fn() };
    const prismaMock: any = {
      emailInvitation: { create: jest.fn() },
      organization: { findUnique: jest.fn() },
    };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userServiceMock },
        { provide: MailService, useValue: mailServiceMock },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  it('should throw NotFoundException when user does not exist', async () => {
    userServiceMock.findById.mockResolvedValue(null);
    await expect(service.reInviteUser('u-not-found')).rejects.toThrow(
      'User not found',
    );
  });

  it('should send reinvite email and return success message', async () => {
    (jwt.sign as jest.Mock).mockReturnValue('invite-code');
    userServiceMock.findById.mockResolvedValue({
      id: 'u1',
      email: 'u@test.com',
      organization_id: 'org1',
    });
    (prisma.organization as any).findUnique.mockResolvedValue({
      name: 'MedVirtual',
      status: 'active',
      business_unit: 'MedVirtual',
    });
    mailServiceMock.sendMail.mockResolvedValue(true);
    (prisma.emailInvitation as any).create.mockResolvedValue({ id: 'inv-1' });

    const result = await service.reInviteUser('u1');
    expect(result).toContain('u@test.com');
  });
});

describe('AuthService - verifyCode', () => {
  let service: AuthService;
  let prisma: PrismaService;
  let userServiceMock: any;

  beforeEach(async () => {
    userServiceMock = { findById: jest.fn() };
    const prismaMock: any = {
      emailVerification: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      uSER: { update: jest.fn() },
      session: {
        updateMany: jest.fn(),
        create: jest.fn(),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userServiceMock },
        { provide: MailService, useValue: { sendMail: jest.fn() } },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  it('should throw BadRequestException when code or token is missing', async () => {
    await expect(
      service.verifyCode({ code: '', token: '' } as any),
    ).rejects.toThrow('Code and token are required');
  });

  it('should throw UnauthorizedException when jwt.verify throws', async () => {
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error('bad token');
    });
    await expect(
      service.verifyCode({ code: '123456', token: 'bad' } as any),
    ).rejects.toThrow('Invalid token');
  });

  it('should throw BadRequestException when user is not found', async () => {
    (jwt.verify as jest.Mock).mockReturnValue({ id: 'u1' });
    userServiceMock.findById.mockResolvedValue(null);
    await expect(
      service.verifyCode({ code: '123456', token: 'tok' } as any),
    ).rejects.toThrow('User not found');
  });

  it('should throw when verification code is not found', async () => {
    (jwt.verify as jest.Mock).mockReturnValue({ id: 'u1' });
    userServiceMock.findById.mockResolvedValue({ id: 'u1' });
    (prisma.emailVerification as any).findFirst.mockResolvedValue(null);
    await expect(
      service.verifyCode({ code: '123456', token: 'tok' } as any),
    ).rejects.toThrow('Invalid verification code');
  });

  it('should verify code and return token on success', async () => {
    (jwt.verify as jest.Mock).mockReturnValue({ id: 'u1' });
    (jwt.sign as jest.Mock).mockReturnValue('jwt-out');
    userServiceMock.findById.mockResolvedValue({
      id: 'u1',
      email: 'u@test.com',
    });
    (prisma.emailVerification as any).findFirst.mockResolvedValue({
      id: 'code-1',
      verified: false,
    });
    (prisma.emailVerification as any).update.mockResolvedValue({
      id: 'code-1',
      verified: true,
    });
    (prisma.uSER as any).update.mockResolvedValue({});
    (prisma.session as any).updateMany.mockResolvedValue({});
    (prisma.session as any).create.mockResolvedValue({ id: 'sess-1' });

    const result = await service.verifyCode({
      code: '123456',
      token: 'tok',
    } as any);
    expect(result).toBe('jwt-out');
  });
});

describe('AuthService - logout', () => {
  let service: AuthService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const prismaMock: any = {
      session: { updateMany: jest.fn() },
      uSER: { update: jest.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  it('should revoke all active sessions for the authenticated user and return true', async () => {
    (prisma.session as any).updateMany.mockResolvedValue({ count: 1 });
    (prisma.uSER as any).update.mockResolvedValue({});

    const result = await service.logout('user-1');

    expect(result).toBe(true);
    expect((prisma.session as any).updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isRevoked: false },
      data: { isRevoked: true },
    });
  });

  it('should clear the bill.com session for the logged-out user (this is the fix requested: billcom_session_id must be cleared on MedVirtual logout)', async () => {
    (prisma.session as any).updateMany.mockResolvedValue({ count: 1 });
    (prisma.uSER as any).update.mockResolvedValue({});

    await service.logout('user-1');

    expect((prisma.uSER as any).update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { billcom_session_id: null, billcom_session_expires: null },
    });
  });
});

describe('AuthService - updatePassword', () => {
  let service: AuthService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const prismaMock: any = {
      uSER: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  it('should throw BadRequestException when passwords are missing', async () => {
    await expect(
      service.updatePassword({ oldPassword: '', password: '' } as any, {
        id: 'u1',
      }),
    ).rejects.toThrow('Old password and new password are required');
  });

  it('should throw NotFoundException when user is not found', async () => {
    (prisma.uSER as any).findUnique.mockResolvedValue(null);
    await expect(
      service.updatePassword({ oldPassword: 'old', password: 'new' } as any, {
        id: 'u1',
      }),
    ).rejects.toThrow('User not found');
  });

  it('should throw BadRequestException when old password is invalid', async () => {
    (prisma.uSER as any).findUnique.mockResolvedValue({
      id: 'u1',
      password: 'hashed',
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    await expect(
      service.updatePassword({ oldPassword: 'wrong', password: 'new' } as any, {
        id: 'u1',
      }),
    ).rejects.toThrow('Invalid old password');
  });

  it('should update password and return true', async () => {
    (prisma.uSER as any).findUnique.mockResolvedValue({
      id: 'u1',
      password: 'hashed',
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    (bcrypt.hash as jest.Mock).mockResolvedValue('new-hashed');
    (prisma.uSER as any).update.mockResolvedValue({ id: 'u1' });

    const result = await service.updatePassword(
      { oldPassword: 'old', password: 'new' } as any,
      { id: 'u1' },
    );
    expect(result).toBe(true);
    expect((prisma.uSER as any).update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { password: 'new-hashed' },
    });
  });
});

describe('AuthService - signIn (additional branches)', () => {
  let service: AuthService;
  const userMock = { findByEmail: jest.fn() };
  const prismaMock = {
    session: { create: jest.fn(), updateMany: jest.fn() },
    organization: { findUnique: jest.fn(), findMany: jest.fn() },
    affiliateProfile: { findUnique: jest.fn(), update: jest.fn() },
    uSER: { findUnique: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userMock },
        { provide: MailService, useValue: { sendMail: jest.fn() } },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
  });

  const dataFake = { email: 'test@test.com', password: 'testpassword' };
  const authenticationMethod = 'OwnSign';

  it('should throw for unknown/default user status', async () => {
    userMock.findByEmail.mockResolvedValue({ status: 'unknown_custom_status' });
    await expect(service.signIn(dataFake)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should return active affiliateId when affiliate profile is active', async () => {
    userMock.findByEmail.mockResolvedValue({
      id: 'u1',
      email: dataFake.email,
      password: 'hashed-pass',
      authentication_method: authenticationMethod,
      verified: true,
      status: 'active',
      organization_id: 'org1',
      first_name: 'Test',
      last_name: 'User',
      role: 'admin',
      affiliateProfile: { id: 'aff-1' },
    });
    prismaMock.organization.findUnique.mockResolvedValue({
      business_unit: 'MedVirtual',
      status: 'active',
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    (jwt.sign as jest.Mock).mockReturnValue('mocked-token');
    prismaMock.session.updateMany.mockResolvedValue({});
    prismaMock.session.create.mockResolvedValue({ id: 'session1' });
    prismaMock.affiliateProfile.findUnique.mockResolvedValue({
      status: 'active',
    });

    const result = await service.signIn(dataFake);
    expect((result as any).user.affiliate_profile_id).toBe('aff-1');
  });

  it('should return null affiliateId when affiliate profile is inactive', async () => {
    userMock.findByEmail.mockResolvedValue({
      id: 'u1',
      email: dataFake.email,
      password: 'hashed-pass',
      authentication_method: authenticationMethod,
      verified: true,
      status: 'active',
      organization_id: 'org1',
      first_name: 'Test',
      last_name: 'User',
      role: 'admin',
      affiliateProfile: { id: 'aff-1' },
    });
    prismaMock.organization.findUnique.mockResolvedValue({
      business_unit: 'MedVirtual',
      status: 'active',
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    (jwt.sign as jest.Mock).mockReturnValue('mocked-token');
    prismaMock.session.updateMany.mockResolvedValue({});
    prismaMock.session.create.mockResolvedValue({ id: 'session1' });
    prismaMock.affiliateProfile.findUnique.mockResolvedValue({
      status: 'inactive',
    });

    const result = await service.signIn(dataFake);
    expect((result as any).user.affiliate_profile_id).toBeNull();
  });
});

describe('AuthService - verifyCode (additional branches)', () => {
  let service: AuthService;
  let prisma: PrismaService;
  let userServiceMock: any;

  beforeEach(async () => {
    userServiceMock = { findById: jest.fn() };
    const prismaMock: any = {
      emailVerification: { findFirst: jest.fn(), update: jest.fn() },
      uSER: { update: jest.fn() },
      session: { updateMany: jest.fn(), create: jest.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userServiceMock },
        { provide: MailService, useValue: { sendMail: jest.fn() } },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  it('should throw when verification code is already verified', async () => {
    (jwt.verify as jest.Mock).mockReturnValue({ id: 'u1' });
    userServiceMock.findById.mockResolvedValue({ id: 'u1' });
    (prisma.emailVerification as any).findFirst.mockResolvedValue({
      id: 'code-1',
      verified: true,
    });
    await expect(
      service.verifyCode({ code: '123456', token: 'tok' } as any),
    ).rejects.toThrow('Code already verified');
  });

  it('should throw when emailVerification.update returns null', async () => {
    (jwt.verify as jest.Mock).mockReturnValue({ id: 'u1' });
    userServiceMock.findById.mockResolvedValue({ id: 'u1' });
    (prisma.emailVerification as any).findFirst.mockResolvedValue({
      id: 'code-1',
      verified: false,
    });
    (prisma.emailVerification as any).update.mockResolvedValue(null);
    await expect(
      service.verifyCode({ code: '123456', token: 'tok' } as any),
    ).rejects.toThrow('Failed to verify code');
  });

  it('should throw when session.create returns null in verifyCode', async () => {
    (jwt.verify as jest.Mock).mockReturnValue({ id: 'u1' });
    (jwt.sign as jest.Mock).mockReturnValue('jwt-out');
    userServiceMock.findById.mockResolvedValue({
      id: 'u1',
      email: 'u@test.com',
    });
    (prisma.emailVerification as any).findFirst.mockResolvedValue({
      id: 'code-1',
      verified: false,
    });
    (prisma.emailVerification as any).update.mockResolvedValue({
      id: 'code-1',
      verified: true,
    });
    (prisma.uSER as any).update.mockResolvedValue({});
    (prisma.session as any).updateMany.mockResolvedValue({});
    (prisma.session as any).create.mockResolvedValue(null);
    await expect(
      service.verifyCode({ code: '123456', token: 'tok' } as any),
    ).rejects.toThrow('Failed to create session');
  });
});

describe('AuthService - logout (additional)', () => {
  let service: AuthService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const prismaMock: any = {
      session: { updateMany: jest.fn() },
      uSER: { update: jest.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  it('should throw when session.updateMany returns null', async () => {
    (prisma.session as any).updateMany.mockResolvedValue(null);
    await expect(service.logout('user-1')).rejects.toThrow(
      'Failed to revoke token',
    );
  });
});

describe('AuthService - inviteUser (additional branches)', () => {
  let service: AuthService;
  let userServiceMock: any;
  let mailServiceMock: any;
  let prismaMock: any;

  beforeEach(async () => {
    userServiceMock = { findByEmail: jest.fn(), create: jest.fn() };
    mailServiceMock = { sendMail: jest.fn() };
    prismaMock = {
      emailInvitation: { create: jest.fn() },
      organization: { findUnique: jest.fn() },
      uSER: { findUnique: jest.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userServiceMock },
        { provide: MailService, useValue: mailServiceMock },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
  });

  it('should throw when organizationId is missing for non-admin role', async () => {
    await expect(
      service.inviteUser({
        email: 'a@b.com',
        role: 'organization_admin',
      } as any),
    ).rejects.toThrow('Organization Id not provided');
  });

  it('should throw when mail send fails', async () => {
    userServiceMock.findByEmail.mockResolvedValue(null);
    userServiceMock.create.mockResolvedValue({ id: 'new-u', email: 'a@b.com' });
    (jwt.sign as jest.Mock).mockReturnValue('code-token');
    mailServiceMock.sendMail.mockResolvedValue(false);

    await expect(
      service.inviteUser({
        email: 'a@b.com',
        role: 'organization_admin',
        organizationId: 'org1',
        companyName: 'Co',
      } as any),
    ).rejects.toThrow('Failed to send invitation email');
  });

  it('should throw when emailInvitation.create returns null', async () => {
    userServiceMock.findByEmail.mockResolvedValue(null);
    userServiceMock.create.mockResolvedValue({ id: 'new-u', email: 'a@b.com' });
    (jwt.sign as jest.Mock).mockReturnValue('code-token');
    mailServiceMock.sendMail.mockResolvedValue(true);
    prismaMock.emailInvitation.create.mockResolvedValue(null);

    await expect(
      service.inviteUser({
        email: 'a@b.com',
        role: 'organization_admin',
        organizationId: 'org1',
        companyName: 'Co',
      } as any),
    ).rejects.toThrow('Failed to store invite code');
  });
});

describe('AuthService - getUser (additional)', () => {
  let service: AuthService;

  beforeEach(async () => {
    const prismaMock: any = {
      emailInvitation: { findFirst: jest.fn() },
      uSER: { findFirst: jest.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
  });

  it('should throw UnauthorizedException when jwt.verify throws', async () => {
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error('bad token');
    });
    await expect(service.getUser({ token: 'bad-token' })).rejects.toThrow(
      'Invalid token',
    );
  });
});

describe('AuthService - invitedUserSignup (additional branches)', () => {
  let service: AuthService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const prismaMock: any = {
      emailInvitation: { findFirst: jest.fn() },
      uSER: { findFirst: jest.fn(), update: jest.fn() },
      affiliateProfile: { findUnique: jest.fn(), update: jest.fn() },
      session: { updateMany: jest.fn(), create: jest.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  const dataFake: any = {
    token: 'valid-token',
    password: 'pass123',
    firstName: 'Test',
    lastName: 'User',
  };

  it('should throw UnauthorizedException when jwt.verify throws', async () => {
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error('bad');
    });
    await expect(service.invitedUserSignup({ ...dataFake })).rejects.toThrow(
      'Invalid token',
    );
  });

  it('should throw when invitation token not found in DB', async () => {
    (jwt.verify as jest.Mock).mockReturnValue({ id: 'u1' });
    (prisma.emailInvitation as any).findFirst.mockResolvedValue(null);
    await expect(service.invitedUserSignup({ ...dataFake })).rejects.toThrow(
      'Token not found!',
    );
  });

  it('should throw when user not found in DB', async () => {
    (jwt.verify as jest.Mock).mockReturnValue({ id: 'u1' });
    (prisma.emailInvitation as any).findFirst.mockResolvedValue({
      id: 'inv-1',
    });
    (prisma.uSER as any).findFirst.mockResolvedValue(null);
    await expect(service.invitedUserSignup({ ...dataFake })).rejects.toThrow(
      'User not found',
    );
  });

  it('should throw when session.create returns null', async () => {
    (jwt.verify as jest.Mock).mockReturnValue({ id: 'u1' });
    (jwt.sign as jest.Mock).mockReturnValue('jwt-out');
    (prisma.emailInvitation as any).findFirst.mockResolvedValue({
      id: 'inv-1',
    });
    (prisma.uSER as any).findFirst.mockResolvedValue({
      id: 'u1',
      email: 'u@test.com',
    });
    (prisma.uSER as any).update.mockResolvedValue({ id: 'u1' });
    (prisma.affiliateProfile as any).findUnique.mockResolvedValue(null);
    (prisma.session as any).updateMany.mockResolvedValue({});
    (prisma.session as any).create.mockResolvedValue(null);
    await expect(service.invitedUserSignup({ ...dataFake })).rejects.toThrow(
      'Failed to create session',
    );
  });

  it('should throw BadRequestException when completing signup for an inactive organization', async () => {
    (jwt.verify as jest.Mock).mockReturnValue({ id: 'u1' });
    (prisma.emailInvitation as any).findFirst.mockResolvedValue({
      id: 'inv-1',
    });
    (prisma.uSER as any).findFirst.mockResolvedValue({
      id: 'u1',
      email: 'u@test.com',
      organization_id: 'org-inactive',
    });
    (prisma as any).organization = {
      findUnique: jest.fn().mockResolvedValue({ status: 'inactive' }),
    };

    await expect(service.invitedUserSignup({ ...dataFake })).rejects.toThrow(
      'Cannot complete signup for an inactive organization',
    );
  });
});

describe('AuthService - reInviteUser (additional branches)', () => {
  let service: AuthService;
  let prisma: PrismaService;
  let userServiceMock: any;
  let mailServiceMock: any;

  beforeEach(async () => {
    userServiceMock = { findById: jest.fn() };
    mailServiceMock = { sendMail: jest.fn() };
    const prismaMock: any = {
      emailInvitation: { create: jest.fn() },
      organization: { findUnique: jest.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userServiceMock },
        { provide: MailService, useValue: mailServiceMock },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: AffiliateUpdateService,
          useValue: { reactivate: jest.fn() },
        },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  it('should throw when mail send fails in reInviteUser', async () => {
    (jwt.sign as jest.Mock).mockReturnValue('invite-code');
    userServiceMock.findById.mockResolvedValue({
      id: 'u1',
      email: 'u@test.com',
      organization_id: 'org1',
    });
    mailServiceMock.sendMail.mockResolvedValue(false);

    await expect(service.reInviteUser('u1')).rejects.toThrow(
      'Failed to send invitation email',
    );
  });

  it('should throw when emailInvitation.create returns null in reInviteUser', async () => {
    (jwt.sign as jest.Mock).mockReturnValue('invite-code');
    userServiceMock.findById.mockResolvedValue({
      id: 'u1',
      email: 'u@test.com',
      organization_id: 'org1',
    });
    mailServiceMock.sendMail.mockResolvedValue(true);
    (prisma.emailInvitation as any).create.mockResolvedValue(null);

    await expect(service.reInviteUser('u1')).rejects.toThrow(
      'Failed to store invite code',
    );
  });
});
