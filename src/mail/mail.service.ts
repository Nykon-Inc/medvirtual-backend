import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

interface MailOptions {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  cc?: string | string[];
  bcc?: string | string[];
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  // Matches {{token}}, [[token]], and PascalCase/UPPER_CASE [Token] placeholders
  // left unresolved by a template renderer. The [Token] branch requires an
  // uppercase-led, space-free identifier and rejects a following "(" so it
  // can't eat markdown links (`[our docs](url)`) or other bracketed prose.
  private static readonly PLACEHOLDER_PATTERN =
    /\{\{[^{}]+\}\}|\[\[[^[\]]+\]\]|\[[A-Z][A-Za-z0-9_]*\](?!\()/g;

  private applyDevPrefix(from: string): string {
    const isProduction = process.env.ENVIRONMENT === 'PROD';
    return isProduction ? from : `[DEV] ${from}`;
  }

  // Last-resort scrub: a template bug should never let raw {{tokens}} reach a
  // recipient. Strips leftover placeholders and cleans the punctuation/spacing
  // artifacts that removal leaves behind, and logs the token names (never the
  // recipient or full body) so the underlying template/data bug can be found.
  private scrubUnresolvedPlaceholders(text: string, field: string): string {
    const matches = text.match(MailService.PLACEHOLDER_PATTERN);
    if (!matches) return text;

    this.logger.warn(
      `Unresolved placeholder(s) in email ${field}: ${matches.join(', ')}`,
    );

    return matches
      .reduce((acc, token) => acc.split(token).join(''), text)
      .replace(/,\s*!/g, '!')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([!.,?])/g, '$1')
      .replace(/\s+(<\/?[a-zA-Z][^>]*>)/g, '$1')
      .trim();
  }

  async sendMail(options: MailOptions): Promise<boolean> {
    try {
      if (!process.env.RESEND_API_KEY) {
        throw new BadRequestException(
          'RESEND_API_KEY is not set in environment variables',
        );
      }

      if (
        !options ||
        !options.from ||
        !options.to ||
        !options.subject ||
        !options.html
      ) {
        throw new BadRequestException('Invalid email options provided');
      }

      const subject = this.scrubUnresolvedPlaceholders(
        options.subject,
        'subject',
      );
      const html = this.scrubUnresolvedPlaceholders(options.html, 'html body');

      const resend = new Resend(process.env.RESEND_API_KEY);

      const emailData = {
        from: this.applyDevPrefix(options.from),
        to: options.to,
        cc: options.cc,
        bcc: options.bcc,
        subject,
        html,
        headers: options.headers || {},
        tags: options.tags || [
          { name: 'type', value: 'general' },
          { name: 'source', value: 'medvirtual' },
        ],
      };

      const result = await resend.emails.send(emailData);

      if (!result || !result.data) {
        this.logger.error(
          `Failed to send email to ${options.to}: ${result?.error?.message || 'Unknown error'}`,
        );
        throw new BadRequestException('Failed to send email');
      }

      this.logger.log(
        `Email sent successfully to ${options.to} with ID: ${result.data.id}`,
      );
      return true;
    } catch (error) {
      this.logger.error(`Error sending email to ${options.to}:`, error);

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(`Failed to send email: ${error.message}`);
    }
  }

  async sendMailWithAttachments(options: {
    from: string;
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject: string;
    html: string;
    attachments: Array<{
      filename: string;
      content: Buffer;
    }>;
    headers?: any;
    tags?: any;
  }): Promise<boolean> {
    try {
      if (!process.env.RESEND_API_KEY) {
        throw new BadRequestException(
          'RESEND_API_KEY is not set in environment variables',
        );
      }

      if (
        !options ||
        !options.from ||
        !options.to ||
        !options.subject ||
        !options.html
      ) {
        throw new BadRequestException('Invalid email options provided');
      }

      const resend = new Resend(process.env.RESEND_API_KEY);

      const emailData = {
        from: options.from,
        to: options.to,
        cc: options.cc,
        bcc: options.bcc,
        subject: options.subject,
        html: options.html,
        attachments: options.attachments,
        headers: options.headers || {},
        tags: options.tags || [
          { name: 'type', value: 'general' },
          { name: 'source', value: 'medvirtual' },
        ],
      };

      const result = await resend.emails.send(emailData);

      if (!result || !result.data) {
        this.logger.error(
          `Failed to send email with attachments to ${options.to}: ${result?.error?.message || 'Unknown error'}`,
        );
        throw new BadRequestException('Failed to send email with attachments');
      }

      this.logger.log(
        `Email with attachments sent successfully to ${options.to} with ID: ${result.data.id}`,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Error sending email with attachments to ${options.to}:`,
        error,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(`Failed to send email: ${error.message}`);
    }
  }
}
