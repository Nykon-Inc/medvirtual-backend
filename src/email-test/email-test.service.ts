import { Injectable } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import getVerificationCodeTemplate from '../common/utils/email-templates/verification-code';
import InviteSignup from '../common/utils/email-templates/invite-signup';
import getResetPasswordTemplate from '../common/utils/email-templates/reset-password';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailTheme } from '../common/utils/email-templates/theme';
import scheduleInterview from 'src/common/utils/email-templates/schedule-interview';
import { FRONTEND_ROUTES } from '../common/utils/frontend-routes';

@Injectable()
export class EmailTestService {
  constructor(
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getTheme(themeName: string): EmailTheme | undefined {
    switch (themeName.toLowerCase()) {
      case 'berry':
      case 'berry-virtual':
        return {
          primaryColor: '#FD7171',
          primaryColorHover: '#E55A5A',
          secondaryColor: '#F8F9FA',
          accentColor: '#FD7171',
          companyName: 'Berry Virtual',
        };
      case 'medvirtual':
      case 'med':
      default:
        return {
          primaryColor: '#01546B',
          primaryColorHover: '#013A4F',
          secondaryColor: '#F8F9FA',
          accentColor: '#00B2E2',
          companyName: 'MedVirtual',
        };
    }
  }

  async testVerificationCode(
    themeName: string,
    isBerryVirtual: boolean,
    email: string,
  ) {
    const theme = this.getTheme(themeName);
    const verificationCode = '123456';
    const verificationUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/signup/verification-code?t=${verificationCode}&berry=${isBerryVirtual ? 'true' : 'false'}`;

    const emailBody = getVerificationCodeTemplate(
      verificationCode,
      theme,
      isBerryVirtual,
      verificationUrl,
    );

    try {
      await this.mailService.sendMail({
        from: process.env.FROM_EMAIL || 'noreply@medvirtual.ai',
        to: email,
        subject: `Verify Your ${theme?.companyName || 'MedVirtual'} Account`,
        html: emailBody,
      });

      return {
        success: true,
        message: 'Verification code email sent successfully',
        theme: theme?.companyName,
        isBerryVirtual,
        verificationCode,
        verificationUrl,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to send verification code email',
        error: error.message,
      };
    }
  }

  async testInviteSignup(themeName: string, email: string) {
    const theme = this.getTheme(themeName);
    const inviteLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/signup?token=test-invite-token`;

    const emailBody = InviteSignup(inviteLink, theme);

    try {
      await this.mailService.sendMail({
        from: process.env.FROM_EMAIL || 'noreply@medvirtual.ai',
        to: email,
        subject: `${theme?.companyName || 'MedVirtual'} Platform Invitation`,
        html: emailBody,
      });

      return {
        success: true,
        message: 'Invite signup email sent successfully',
        theme: theme?.companyName,
        inviteLink,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to send invite signup email',
        error: error.message,
      };
    }
  }

  async testResetPassword(themeName: string, email: string) {
    const theme = this.getTheme(themeName);
    const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/set-password?t=test-reset-token`;

    const emailBody = getResetPasswordTemplate('Test User', resetLink, theme);

    try {
      await this.mailService.sendMail({
        from: process.env.FROM_EMAIL || 'noreply@medvirtual.ai',
        to: email,
        subject: `Password Reset - ${theme?.companyName || 'MedVirtual'} Platform`,
        html: emailBody,
      });

      return {
        success: true,
        message: 'Reset password email sent successfully',
        theme: theme?.companyName,
        resetLink,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to send reset password email',
        error: error.message,
      };
    }
  }

  async testNotification(themeName: string, email: string) {
    const theme = this.getTheme(themeName);

    const notificationContent = `
      <p>A new hire request has been completed and requires your attention.</p>
      <p><strong>Request Details:</strong></p>
      <ul>
        <li>Title: Senior Developer Position</li>
        <li>Salary: $80,000 - $100,000</li>
        <li>Status: Completed</li>
      </ul>
      <div style="text-align: left; margin: 30px 0;">
        <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}${FRONTEND_ROUTES.hireRequests}" 
           style="background-color: ${theme?.primaryColor || '#01546B'}; color: white; padding: 14px 28px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 16px;">
          View Details
        </a>
      </div>
    `;

    try {
      const emailBody = (this.notificationsService as any).buildEmail(
        notificationContent,
        theme,
      );

      await this.mailService.sendMail({
        from: process.env.FROM_EMAIL || 'noreply@medvirtual.ai',
        to: email,
        subject: `${theme?.companyName || 'MedVirtual'} - New Notification`,
        html: emailBody,
      });

      return {
        success: true,
        message: 'Notification email sent successfully',
        theme: theme?.companyName,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to send notification email',
        error: error.message,
      };
    }
  }

  async testAllTemplates(themeName: string, email: string) {
    // Send emails with delay to avoid rate limiting (Resend allows 2 requests per second)
    const verificationCode = await this.testVerificationCode(
      themeName,
      themeName === 'berry',
      email,
    );
    await this.delay(600); // Wait 600ms between emails

    const inviteSignup = await this.testInviteSignup(themeName, email);
    await this.delay(600); // Wait 600ms between emails

    const resetPassword = await this.testResetPassword(themeName, email);
    await this.delay(600); // Wait 600ms between emails

    const notification = await this.testNotification(themeName, email);

    const results = {
      verificationCode,
      inviteSignup,
      resetPassword,
      notification,
    };

    const allSuccessful = Object.values(results).every(
      (result) => result.success,
    );

    return {
      success: allSuccessful,
      message: allSuccessful
        ? 'All email templates sent successfully'
        : 'Some email templates failed',
      theme: this.getTheme(themeName)?.companyName,
      results,
    };
  }
}
