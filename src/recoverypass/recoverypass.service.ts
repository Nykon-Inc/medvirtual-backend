import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

import { PrismaService } from '../prisma/prisma.service';
import { UserService } from '../user/user.service';
import { MailService } from '../mail/mail.service';
import { RecoveryForgotPasswordDto } from './dto/recoveryForgotPassword.dto';
import getResetPasswordTemplate from '../common/utils/email-templates/reset-password';
import { getUserEmailTheme } from '../common/utils/email-templates/theme-helper';
import { RecoveryResetPasswordDto } from './dto/recoveryResetPassword.dto';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { UserAuditSource } from '@prisma/client';
import {
  USER_AUDIT_EVENTS,
  UserAuditService,
  auditActor,
} from '../user-audit/user-audit.service';

@Injectable()
export class RecoverypassService {
  private readonly RESET_TOKEN_EXPIRATION_MINUTES = 10;

  constructor(
    private readonly user: UserService,
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly emailTemplates: EmailTemplatesService,
    private readonly userAudit: UserAuditService,
  ) {}

  async forgotPassword(data: RecoveryForgotPasswordDto): Promise<boolean> {
    //check if the user exists with this email
    if (!data || !data.email) {
      throw new BadRequestException('Email is required');
    }
    const user = await this.user.findByEmail(data.email);
    if (!user) {
      throw new NotFoundException(
        'User not found! Please check the email provided.',
      );
    }

    if (user.status === 'invited') {
      throw new BadRequestException(
        'User account is not active. Please accept the invitation before resetting password.',
      );
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(rawToken, 10);

    const expiresAt = new Date(
      Date.now() + this.RESET_TOKEN_EXPIRATION_MINUTES * 60 * 1000,
    );

    // Invalidate previous tokens
    await this.prisma.passwordResetToken.updateMany({
      where: {
        userId: user.id,
        usedAt: null,
      },
      data: {
        usedAt: new Date(),
      },
    });

    // Store new token (hashed)
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    const emailTheme = await getUserEmailTheme(this.prisma, user.id);
    const resetLink = `${process.env.FRONTEND_URL}/set-password?t=${rawToken}`;

    const fallbackSubject = `Reset Your MedVirtual Password - Action Required`;
    const fallbackHtml = getResetPasswordTemplate(
      user.first_name,
      resetLink,
      emailTheme || undefined,
    );
    const tplContent = await this.emailTemplates.getTemplateContent(
      'reset-password',
      {
        '{{userName}}': user.first_name,
        '{{resetLink}}': resetLink,
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
    const mailSent = await this.mail.sendMail({
      from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: user.email,
      subject: tplContent?.subject ?? fallbackSubject,
      html: tplContent?.html ?? fallbackHtml,
      headers: {
        'X-Mailer': 'MedVirtual Platform',
        'X-Priority': '3',
        'List-Unsubscribe': '<mailto:unsubscribe@medvirtual.ai>',
        'X-Entity-Ref-ID': `reset-${user.id}`,
      },
      tags: [
        { name: 'type', value: 'password_reset' },
        { name: 'source', value: 'medvirtual' },
      ],
    });

    if (!mailSent)
      throw new BadRequestException('Error sending recovery email');

    await this.userAudit.log({
      subject: user,
      event: USER_AUDIT_EVENTS.PASSWORD_RESET_REQUESTED,
      source: UserAuditSource.user,
      ...auditActor(user),
      metadata: { token_expires_at: expiresAt.toISOString() },
    });

    return true;
  }

  async setPassword(data: RecoveryResetPasswordDto): Promise<boolean> {
    const { token, password } = data;
    if (!token) throw new BadRequestException('Reset token is required');
    if (!password) throw new BadRequestException('New password is required');

    const resetToken = await this.prisma.passwordResetToken.findFirst({
      where: {
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        user: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!resetToken) {
      throw new BadRequestException('Invalid or expired token');
    }

    const isValidToken = await bcrypt.compare(token, resetToken.tokenHash);

    if (!isValidToken) {
      throw new BadRequestException('Invalid or expired token');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Atomic operation
    await this.prisma.$transaction([
      this.prisma.uSER.update({
        where: { id: resetToken.userId },
        data: {
          password: hashedPassword,
        },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: {
          usedAt: new Date(),
        },
      }),
    ]);

    await this.userAudit.log({
      subject: resetToken.user,
      event: USER_AUDIT_EVENTS.PASSWORD_RESET_COMPLETED,
      source: UserAuditSource.user,
      ...auditActor(resetToken.user),
    });

    return true;
  }
}
