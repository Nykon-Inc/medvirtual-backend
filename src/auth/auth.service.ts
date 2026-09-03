import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcryptjs';

import { UserService } from '../user/user.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { generateVerificationCode } from '../common/utils/generateCode.util';
import { AuthSignUpReturnDto } from './dto/authSignupReturn.dto';
import { AuthResendCodeDto } from './dto/authResendCode.dto';
import { AuthSignInDto } from './dto/authSignIn.dto';
import { AuthInviteUserDto } from './dto/authInviteUser.dto';
import { AuthVerifyCodeDto } from './dto/authVerifyCode.dto';
import getVerificationCodeTemplate from '../common/utils/email-templates/verification-code';
import InviteSignup from '../common/utils/email-templates/invite-signup';
import {
  getUserEmailTheme,
  isUserBerryVirtual,
} from '../common/utils/email-templates/theme-helper';
import { AuthSignUpDto } from './dto/authSignUp.dto';
import { AuthVerifyCodeDtoReturn } from './dto/authVerifyCodeReturn.dto';
import { AuthinvitedUserSignupDto } from './dto/invitedUserSignup.dto';
import { AuthGetInviteDto } from './dto/authGetInvite.dto';
import { AuthResendCodeReturnDto } from './dto/authResendCodeReturn.dto';
import { AuthUpdatePasswordDto } from './dto/authSetPassword.dto';
import { AffiliateUpdateService } from '../hubspot/update/affiliate';
import { EmailTemplatesService } from '../email-templates/email-templates.service';

@Injectable()
export class AuthService {
  constructor(
    @Inject(forwardRef(() => UserService))
    private readonly userService: UserService,
    private readonly mailService: MailService,
    private readonly prisma: PrismaService,
    private readonly affiliateUpdateService: AffiliateUpdateService,
    private readonly emailTemplates: EmailTemplatesService,
  ) {}

  async signIn(data: AuthSignInDto): Promise<object> {
    const timeToExpires = data.rememberMe
      ? 7 * 24 * 60 * 60 * 1000
      : 8 * 60 * 60 * 1000;
    const authenticationMethod = 'OwnSign';
    const user = await this.userService.findByEmail(data.email);
    if (!user) {
      throw new UnauthorizedException('User not found with this email');
    }
    // Check user status - only allow active users to login
    if (user.status !== 'active') {
      let errorMessage = 'This user does not have permission to log in.';

      switch (user.status) {
        case 'deleted':
          errorMessage =
            'This account has been deleted. Please contact support.';
          break;
        case 'inactive':
          errorMessage =
            'Your account is inactive. Please contact your administrator to reactivate your account.';
          break;
        case 'suspended':
          errorMessage =
            'Your account has been suspended. Please contact support for assistance.';
          break;
        case 'pending_verification':
          errorMessage =
            'Your account is pending verification. Please check your email and verify your account.';
          break;
        case 'prospect':
          errorMessage =
            'Your account is not yet activated. Please contact support.';
          break;
        case 'incomplete':
          errorMessage =
            'Your account setup is incomplete. Please contact support.';
          break;
        default:
          errorMessage = 'This user does not have permission to log in.';
      }

      throw new UnauthorizedException(errorMessage);
    }
    // System admins don't need to belong to an organization
    if (
      !user.organization_id &&
      !['system_super_admin', 'system_admin', 'affiliate'].includes(user.role)
    ) {
      throw new UnauthorizedException(
        'User does not belong to any organization. Please contact support.',
      );
    }

    let business_unit: string | null = null;
    // Only check organization status for users who belong to an organization
    if (user.organization_id) {
      const organization = await this.prisma.organization.findUnique({
        where: { id: user.organization_id },
        select: {
          business_unit: true,
          status: true,
        },
      });
      if (!organization || organization.status === 'inactive') {
        throw new UnauthorizedException(
          'User organization not found or inactive. Please contact support.',
        );
      }
      business_unit = organization.business_unit;
    }

    if (user.authentication_method !== authenticationMethod) {
      throw new UnauthorizedException(
        'User does not use this authentication method. You need to Sign in with the first method you have used',
      );
    }

    if (!user.verified) {
      throw new UnauthorizedException('User not verified');
    }

    const isMatch = await bcrypt.compare(data.password, user.password);

    if (!isMatch) {
      throw new BadRequestException('Invalid password');
    }

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: data.rememberMe ? '7d' : '8h',
    });

    //revoke previous sessions of this user before I create the new session
    await this.prisma.session.updateMany({
      where: { userId: user.id },
      data: { isRevoked: true },
    });

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        token: token,
        expiresAt: new Date(Date.now() + timeToExpires),
      },
    });

    if (!session) {
      throw new BadRequestException('Failed to create session');
    }

    let affiliateId;
    // lets check if the affiliate is active. If not, we cannot send the affiliate profile id in the response, because the frontend need to know if the affiliate is active or not
    if (user.affiliateProfile?.id) {
      const affiliate = await this.prisma.affiliateProfile.findUnique({
        where: {
          id: user.affiliateProfile.id,
        },
        select: {
          status: true,
        },
      });
      if (affiliate?.status !== 'active') {
        affiliateId = null; // Set to null if affiliate is not active
      } else {
        affiliateId = user.affiliateProfile.id; // Set to the actual ID if affiliate is active
      }
    } else {
      affiliateId = null; // Ensure affiliateProfile is null if no profile exists
    }
    return {
      statusCode: 200,
      message: 'User authenticated successfully',
      token: token,
      user: {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        role: user.role,
        clientId: user.organization_id,
        business_unit: business_unit,
        affiliate_profile_id: affiliateId,
        onboarding_tour_dismissed: user.onboarding_tour_dismissed,
      },
    };
  }

  async signUp(data: AuthSignUpDto): Promise<AuthSignUpReturnDto> {
    const authenticationMethod = 'OwnSign';
    const user = await this.userService.findByEmail(data.email);

    if (user) {
      throw new BadRequestException('User already exists with this email');
    }

    //when a user use the direct signup route, it means that this user don't have organization previously created
    const organization = await this.prisma.organization.create({
      data: {
        name: data.companyName || 'Default Organization',
        email: data.email,
        status: 'active',
        admin: {
          connect: { id: data.organizationId }, // Connect to the user who is signing up
        },
      },
    });

    const newUser = await this.userService.create({
      email: data.email,
      organization_id: organization.id,
      first_name: data.firstName,
      last_name: data.lastName,
      phone: '',
      avatar: '',
      job_title: data.jobTitle,
      organization_name: data.companyName,
      role: data.role || 'user',
      workos_id: '',
      password: data.password, // Password is not used for SSO users
      authentication_method: authenticationMethod,
      status: 'active',
      verified: false, // Initially set to false until the user verifies their email
      createdByMethod: 'self_signup',
      createdByUserId: null,
    });
    if (!newUser) {
      throw new BadRequestException('Failed to create user');
    }

    const code = generateVerificationCode(6);
    if (!code) {
      throw new BadRequestException('Failed to generate verification code');
    }

    const emailTheme = await getUserEmailTheme(this.prisma, newUser.id);
    const isBerryVirtual = await isUserBerryVirtual(this.prisma, newUser.id);
    const verificationUrl = `${process.env.FRONTEND_URL}/signup/verification-code?t=${code}&berry=${isBerryVirtual ? 'true' : 'false'}`;

    const fallbackSubject = 'Verification Code';
    const fallbackHtml = getVerificationCodeTemplate(
      code,
      emailTheme || undefined,
      isBerryVirtual,
      verificationUrl,
    );
    const tplContent = await this.emailTemplates.getTemplateContent(
      'verification-code',
      {
        '{{verificationCode}}': code,
        '{{verificationUrl}}': verificationUrl,
        '{{companyName}}': emailTheme?.companyName || 'MedVirtual',
      },
      emailTheme || {
        primaryColor: '#01546B',
        primaryColorHover: '#013A4F',
        secondaryColor: '#F8F9FA',
        accentColor: '#00B2E2',
        companyName: 'MedVirtual',
      },
    );
    const mailSent = await this.mailService.sendMail({
      from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: data.email,
      subject: tplContent?.subject ?? fallbackSubject,
      html: tplContent?.html ?? fallbackHtml,
    });

    if (!mailSent) {
      throw new BadRequestException('Failed to send verification email');
    }

    // Store the verification code in the database with an expiration time
    const codeExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos
    const storeCode = await this.prisma.emailVerification.create({
      data: {
        userId: newUser.id,
        code: code,
        expiresAt: codeExpiresAt,
      },
    });
    if (!storeCode) {
      throw new BadRequestException('Failed to store verification code');
    }

    const token = jwt.sign({ id: newUser.id }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });

    return {
      token: token,
    };
  }

  async verifyCode(data: AuthVerifyCodeDto): Promise<AuthVerifyCodeDtoReturn> {
    if (!data.code || !data.token) {
      throw new BadRequestException('Code and token are required');
    }

    //Verify if the token is valid
    let decodedToken;
    try {
      decodedToken = jwt.verify(data.token, process.env.JWT_SECRET);
    } catch (error) {
      throw new UnauthorizedException('Invalid token');
    }

    const user = await this.userService.findById(decodedToken.id);
    if (!user) {
      throw new BadRequestException('User not found');
    }
    //Verify if the code exists for this user
    const verificationCode = await this.prisma.emailVerification.findFirst({
      where: {
        userId: user.id,
        code: data.code,
        verified: false, //return just if the code is not verified yet
      },
    });
    if (!verificationCode) {
      throw new BadRequestException('Invalid verification code');
    }
    if (verificationCode.verified !== false) {
      throw new BadRequestException('Code already verified');
    }

    //Update code status to verified
    const updatedCode = await this.prisma.emailVerification.update({
      where: { id: verificationCode.id },
      data: { verified: true },
    });
    if (!updatedCode) {
      throw new BadRequestException('Failed to verify code');
    }

    //Update user verified to true
    await this.prisma.uSER.update({
      where: {
        id: user.id,
      },
      data: {
        verified: true,
      },
    });

    //Create a new JWT for keep the user logged in
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });

    //revoke previous sessions of this user before I create the new session
    await this.prisma.session.updateMany({
      where: { userId: user.id },
      data: { isRevoked: true },
    });

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        token: token,
        expiresAt: new Date(
          Date.now() + Number(process.env.TOKEN_TIME_EXPIRED) || 60 * 60 * 1000,
        ),
      },
    });

    if (!session) {
      throw new BadRequestException('Failed to create session');
    }
    return token;
  }

  async resendCode(data: AuthResendCodeDto): Promise<AuthResendCodeReturnDto> {
    if (!data.token) {
      throw new BadRequestException('Token are required');
    }
    //Verify if the token is valid
    let decodedToken;
    try {
      decodedToken = jwt.verify(data.token, process.env.JWT_SECRET);
    } catch (error) {
      throw new UnauthorizedException('Invalid token');
    }

    const user = await this.userService.findById(decodedToken.id);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    //here I need to hash the userId
    const invalidateCode = await this.prisma.emailVerification.updateMany({
      where: {
        userId: user.id,
      },
      data: {
        verified: true, // Mark as verified to invalidate
      },
    });
    if (!invalidateCode) {
      throw new BadRequestException(
        'Failed to invalidate previous verification code',
      );
    }

    //generate new code
    const code = generateVerificationCode(6);
    if (!code) {
      throw new BadRequestException('Failed to generate verification code');
    }

    const codeExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos
    const storeCode = await this.prisma.emailVerification.create({
      data: {
        userId: user.id,
        code: code,
        expiresAt: codeExpiresAt,
      },
    });
    if (!storeCode) {
      throw new BadRequestException('Failed to store verification code');
    }

    const emailTheme = await getUserEmailTheme(this.prisma, user.id);
    const isBerryVirtual = await isUserBerryVirtual(this.prisma, user.id);
    const verificationUrl = `${process.env.FRONTEND_URL}/signup/verification-code?t=${code}&berry=${isBerryVirtual ? 'true' : 'false'}`;

    const fallbackSubject =
      'Verify Your MedVirtual Account - Verification Code';
    const fallbackHtml = getVerificationCodeTemplate(
      code,
      emailTheme || undefined,
      isBerryVirtual,
      verificationUrl,
    );
    const tplContent = await this.emailTemplates.getTemplateContent(
      'verification-code',
      {
        '{{verificationCode}}': code,
        '{{verificationUrl}}': verificationUrl,
        '{{companyName}}': emailTheme?.companyName || 'MedVirtual',
      },
      emailTheme || {
        primaryColor: '#01546B',
        primaryColorHover: '#013A4F',
        secondaryColor: '#F8F9FA',
        accentColor: '#00B2E2',
        companyName: 'MedVirtual',
      },
    );
    const mailSent = await this.mailService.sendMail({
      from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: user.email,
      subject: tplContent?.subject ?? fallbackSubject,
      html: tplContent?.html ?? fallbackHtml,
      headers: {
        'X-Mailer': 'MedVirtual Platform',
        'X-Priority': '3',
        'List-Unsubscribe': '<mailto:unsubscribe@medvirtual.ai>',
        'X-Entity-Ref-ID': `verify-${user.id}`,
      },
      tags: [
        { name: 'type', value: 'verification_code' },
        { name: 'source', value: 'medvirtual' },
      ],
    });

    if (!mailSent) {
      throw new BadRequestException('Failed to send verification email');
    }

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });

    return {
      token: token,
    };
  }

  async logout(userId: string): Promise<boolean> {
    const revokeToken = await this.prisma.session.updateMany({
      where: { userId, isRevoked: false },
      data: { isRevoked: true },
    });

    if (!revokeToken) {
      throw new BadRequestException('Failed to revoke token');
    }

    await this.prisma.uSER.update({
      where: { id: userId },
      data: {
        billcom_session_id: null,
        billcom_session_expires: null,
      },
    });

    return true;
  }

  async inviteUser(data: AuthInviteUserDto): Promise<string> {
    const authenticationMethod = 'OwnSign';

    if (
      data.role != 'system_super_admin' &&
      data.role != 'system_admin' &&
      !data.organizationId
    ) {
      throw new BadRequestException('Organization Id not provided');
    }

    const user = await this.userService.findByEmail(data.email);
    if (user) {
      throw new BadRequestException('User already exists');
    }

    const newUser = await this.userService.create({
      email: data.email,
      organization_id: data.organizationId || null,
      first_name: data.first_name || '',
      last_name: data.last_name || '',
      phone: data.phone || '',
      avatar: '',
      job_title: data.job_title || '',
      organization_name: data.companyName,
      role: data.role || 'organization_admin',
      workos_id: '',
      password: '', // Password is not used for SSO users
      authentication_method: authenticationMethod,
      status: 'invited',
      verified: false, // Initially set to false until the user verifies their email
      createdByMethod: 'admin_invite',
      createdByUserId: data.createdByUserId || null,
    });

    const code = jwt.sign({ id: newUser.id }, process.env.JWT_SECRET, {
      expiresIn: '48h',
    });

    if (!code) {
      throw new BadRequestException('Failed to generate invite code');
    }

    const emailTheme = await getUserEmailTheme(this.prisma, newUser.id);
    const baseInviteLink = `${process.env.FRONTEND_URL}/invite-signup?code=${code}`;
    const inviteLink =
      emailTheme?.companyName === 'Berry Virtual'
        ? `${baseInviteLink}&company=berry`
        : baseInviteLink;

    const fallbackSubject = `Welcome to ${emailTheme?.companyName || 'MedVirtual'} - Complete Your Account Setup`;
    const fallbackHtml = InviteSignup(inviteLink, emailTheme || undefined);
    const tplContent = await this.emailTemplates.getTemplateContent(
      'invite-signup',
      {
        '{{inviteLink}}': inviteLink,
        '{{companyName}}': emailTheme?.companyName || 'MedVirtual',
      },
      emailTheme || {
        primaryColor: '#01546B',
        primaryColorHover: '#013A4F',
        secondaryColor: '#F8F9FA',
        accentColor: '#00B2E2',
        companyName: 'MedVirtual',
      },
    );
    const mailSent = await this.mailService.sendMail({
      from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: data.email,
      subject: tplContent?.subject ?? fallbackSubject,
      html: tplContent?.html ?? fallbackHtml,
      headers: {
        'X-Mailer': `${emailTheme?.companyName || 'MedVirtual'} Platform`,
        'X-Priority': '3',
        'List-Unsubscribe': '<mailto:unsubscribe@medvirtual.ai>',
        'X-Entity-Ref-ID': `invite-${newUser.id}`,
      },
    });

    if (!mailSent) {
      throw new BadRequestException('Failed to send invitation email');
    }

    // Store the verification code in the database with an expiration time
    const codeExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours - same time as JWT
    const storeCode = await this.prisma.emailInvitation.create({
      data: {
        userId: newUser.id,
        email_from: data.email,
        code: code,
        expiresAt: codeExpiresAt,
      },
    });
    if (!storeCode) {
      throw new BadRequestException('Failed to store invite code');
    }

    return `Invitation sent successfully to ${data.email}`;
  }

  async reInviteUser(id: string): Promise<string> {
    const userToReInvite = await this.userService.findById(id);
    if (!userToReInvite) {
      throw new NotFoundException('User not found');
    }

    //check if the organization of this user is active, if not, I cannot send the invite link
    if (userToReInvite.organization_id) {
      const org = await this.prisma.organization.findUnique({
        where: { id: userToReInvite.organization_id },
        select: { status: true },
      });
      if (org?.status === 'inactive') {
        throw new BadRequestException(
          'Cannot re-invite user from an inactive organization',
        );
      }
    }

    const code = jwt.sign({ id: userToReInvite.id }, process.env.JWT_SECRET, {
      expiresIn: '48h',
    });

    if (!code) {
      throw new BadRequestException('Failed to generate invite code');
    }

    const emailTheme = await getUserEmailTheme(this.prisma, userToReInvite.id);
    const baseInviteLink = `${process.env.FRONTEND_URL}/invite-signup?code=${code}`;
    const inviteLink =
      emailTheme?.companyName === 'Berry Virtual'
        ? `${baseInviteLink}&company=berry`
        : baseInviteLink;

    const fallbackSubject = `Welcome to ${emailTheme?.companyName || 'MedVirtual'} - Complete Your Account Setup`;
    const fallbackHtml = InviteSignup(inviteLink, emailTheme || undefined);
    const tplContent = await this.emailTemplates.getTemplateContent(
      'invite-signup',
      {
        '{{inviteLink}}': inviteLink,
        '{{companyName}}': emailTheme?.companyName || 'MedVirtual',
      },
      emailTheme || {
        primaryColor: '#01546B',
        primaryColorHover: '#013A4F',
        secondaryColor: '#F8F9FA',
        accentColor: '#00B2E2',
        companyName: 'MedVirtual',
      },
    );
    const mailSent = await this.mailService.sendMail({
      from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: userToReInvite.email,
      subject: tplContent?.subject ?? fallbackSubject,
      html: tplContent?.html ?? fallbackHtml,
      headers: {
        'X-Mailer': `${emailTheme?.companyName || 'MedVirtual'} Platform`,
        'X-Priority': '3',
        'List-Unsubscribe': '<mailto:unsubscribe@medvirtual.ai>',
        'X-Entity-Ref-ID': `invite-${userToReInvite.id}`,
      },
    });

    if (!mailSent) {
      throw new BadRequestException('Failed to send invitation email');
    }

    // Store the verification code in the database with an expiration time
    const codeExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours - same time as JWT
    const storeCode = await this.prisma.emailInvitation.create({
      data: {
        userId: userToReInvite.id,
        email_from: userToReInvite.email,
        code: code,
        expiresAt: codeExpiresAt,
      },
    });
    if (!storeCode) {
      throw new BadRequestException('Failed to store invite code');
    }

    return `Invitation sent successfully to ${userToReInvite.email}`;
  }

  async getUser(data: AuthGetInviteDto): Promise<any> {
    const { token } = data;
    if (!token) {
      throw new BadRequestException('Token is required');
    }

    let decodedToken;
    try {
      decodedToken = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      throw new UnauthorizedException('Invalid token');
    }

    const emailInvitation = await this.prisma.emailInvitation.findFirst({
      where: {
        userId: decodedToken.id,
        code: token,
      },
    });

    if (!emailInvitation) {
      throw new NotFoundException('Token not found!');
    }

    const user = await this.prisma.uSER.findFirst({
      where: {
        id: decodedToken.id,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found!');
    }

    return {
      email: user.email,
      role: user.role,
      companyName: user.organization_name,
    };
  }

  async invitedUserSignup(data: AuthinvitedUserSignupDto): Promise<string> {
    let decodedToken;
    try {
      decodedToken = jwt.verify(data.token, process.env.JWT_SECRET);
    } catch (error) {
      throw new UnauthorizedException('Invalid token');
    }
    //verify again if this token exists in our database:
    const emailInvitation = await this.prisma.emailInvitation.findFirst({
      where: {
        userId: decodedToken.id,
        code: data.token,
      },
    });
    if (!emailInvitation) {
      throw new NotFoundException('Token not found!');
    }

    //find user in our database
    const user = await this.prisma.uSER.findFirst({
      where: {
        id: decodedToken.id,
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.organization_id) {
      const org = await this.prisma.organization.findUnique({
        where: { id: user.organization_id },
        select: { status: true },
      });
      if (org?.status === 'inactive') {
        throw new BadRequestException(
          'Cannot complete signup for an inactive organization',
        );
      }
    }

    const passwordCript = await bcrypt.hash(data.password, 10);
    //set password and update status to prospect
    const updateData: {
      password: string;
      verified: boolean;
      first_name?: string;
      last_name?: string;
      job_title?: string;
      status?: string;
      activatedAt?: Date;
    } = {
      password: passwordCript,
      verified: true, // Set verified to true after signup
      status: 'active',
      activatedAt: new Date(), // Set activatedAt to current date
    };

    // Only update fields that are provided
    if (data.firstName !== undefined) {
      updateData.first_name = data.firstName;
    }
    if (data.lastName !== undefined) {
      updateData.last_name = data.lastName;
    }
    if (data.jobTitle !== undefined) {
      updateData.job_title = data.jobTitle;
    }
    if (data.status !== undefined) {
      updateData.status = data.status;
    }

    const updatePass = await this.prisma.uSER.update({
      data: updateData,
      where: { id: decodedToken.id },
    });

    const existingAffiliate = await this.prisma.affiliateProfile.findUnique({
      where: {
        user_id: decodedToken.id,
      },
    });

    if (existingAffiliate) {
      //if the user already have an affiliate profile, I need to set the status to active, because the user just accepted the invite, so the affiliate profile need to be active for the user can receive the commission
      await this.prisma.affiliateProfile.update({
        where: { user_id: decodedToken.id },
        data: {
          status: 'active',
        },
      });

      if (existingAffiliate.hubspot_id) {
        await this.affiliateUpdateService.reactivate(
          existingAffiliate.hubspot_id,
          undefined,
          undefined,
          `Affiliate account reactivated after signup completion`,
        );
      }
    }

    if (!updatePass) {
      throw new BadRequestException('Error in set user password');
    }

    //Create a new JWT for keep the user logged in
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });

    //revoke previous sessions of this user before I create the new session
    await this.prisma.session.updateMany({
      where: { userId: user.id },
      data: { isRevoked: true },
    });

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        token: token,
        expiresAt: new Date(
          Date.now() + Number(process.env.TOKEN_TIME_EXPIRED) || 60 * 60 * 1000,
        ),
      },
    });

    if (!session) {
      throw new BadRequestException('Failed to create session');
    }
    return token;
  }

  async updatePassword(data: AuthUpdatePasswordDto, user): Promise<boolean> {
    const { oldPassword, password } = data;
    if (!oldPassword || !password) {
      throw new BadRequestException(
        'Old password and new password are required',
      );
    }

    const userDB = await this.prisma.uSER.findUnique({
      where: { id: user.id },
    });
    if (!userDB) throw new NotFoundException('User not found');

    const isMatch = await bcrypt.compare(oldPassword, userDB.password);
    if (!isMatch) throw new BadRequestException('Invalid old password');

    const hashedPassword = await bcrypt.hash(password, 10);
    const updatedUser = await this.prisma.uSER.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });
    return true;
  }
}
