import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import fs from 'fs';
import OpenAI, { toFile } from 'openai';
import insufficient_quota from '../common/utils/email-templates/insufficient_quota-openai';
import openrouter_fallback_failed from '../common/utils/email-templates/openrouter-fallback-failed';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { isOpenRouterEnabled } from '../openrouter/openrouter.config';
import {
  isInsufficientQuotaError,
  isRateLimitError,
} from '../openrouter/openrouter.errors';
import { OpenrouterService } from '../openrouter/openrouter.service';
import { parseJsonLoose } from '../openrouter/openrouter.service';
import {
  buildResumeExtractionPayload,
  buildTextSummaryPrompt,
  normalizeResumeExtraction,
  TEXT_SUMMARY_SYSTEM_PROMPT,
} from './openai.prompts';
import path from 'path';

import { File as NodeFile } from 'node:buffer';
if (!globalThis.File) {
  globalThis.File = NodeFile as unknown as typeof File;
}

@Injectable()
export class OpenaiService {
  private readonly logger = new Logger(OpenaiService.name);

  constructor(
    private readonly mailService: MailService,
    private readonly prisma: PrismaService,
    private readonly openrouter: OpenrouterService,
  ) {}

  /**
   * Sends the quota alert at most once per day. Failures here must never stop
   * the fallback from running, so everything is swallowed.
   */
  private async notifyInsufficientQuota(): Promise<void> {
    try {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);

      const existingMail = await this.prisma.mail_Settings.findFirst({
        where: {
          title: 'insufficient_quota',
          created_at: { gte: start, lt: end },
        },
      });
      if (existingMail) return;

      const mailSent = await this.mailService.sendMail({
        from: 'MedVirtual <noreply@medvirtual.ai>',
        to: 'shayan@regenta.ai',
        cc: 'paulo@regenta.ai',
        subject: 'Insufficient Quota from OpenAI',
        html: insufficient_quota(),
      });
      if (!mailSent) {
        this.logger.warn(
          'Failed to send insufficient quota email notification.',
        );
      }

      await this.prisma.mail_Settings.create({
        data: { title: 'insufficient_quota' },
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to record insufficient quota notification: ${error?.message}`,
      );
    }
  }

  /**
   * Alerts when OpenAI is out of credit AND the OpenRouter fallback failed too,
   * so nothing processed the request. Deduped per day like the quota alert, to
   * avoid a mail storm when a whole batch of candidates fails at once.
   */
  private async notifyFallbackFailed(
    operation: string,
    error: unknown,
  ): Promise<void> {
    try {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);

      const existingMail = await this.prisma.mail_Settings.findFirst({
        where: {
          title: 'openrouter_fallback_failed',
          created_at: { gte: start, lt: end },
        },
      });
      if (existingMail) return;

      const mailSent = await this.mailService.sendMail({
        from: 'MedVirtual <noreply@medvirtual.ai>',
        to: 'paulo@regenta.ai',
        subject: 'OpenRouter Fallback Failed - Both AI Providers Down',
        html: openrouter_fallback_failed(operation, error, new Date()),
      });
      if (!mailSent) {
        this.logger.warn('Failed to send OpenRouter fallback failure email.');
      }

      await this.prisma.mail_Settings.create({
        data: { title: 'openrouter_fallback_failed' },
      });
    } catch (notifyError: any) {
      this.logger.error(
        `Failed to record fallback failure notification: ${notifyError?.message}`,
      );
    }
  }

  /**
   * Axios only puts the generic "Request failed with status code N" on
   * `error.message` — the actual reason OpenRouter gives (e.g. which spend
   * limit was hit) lives in `error.response.data`. Without this, a 402 tells
   * us nothing beyond the status code.
   */
  private describeOpenRouterError(error: any): string {
    const body = error?.response?.data;
    if (body) {
      try {
        return typeof body === 'string' ? body : JSON.stringify(body);
      } catch {
        // Fall through to the generic message below.
      }
    }
    return error?.message ?? String(error);
  }

  /**
   * Runs `primary` against OpenAI and, only when the account is out of credit,
   * retries through OpenRouter. Rate limits and every other error keep their
   * existing behaviour — the fallback is deliberately narrow.
   */
  private async withQuotaFallback<T>(
    label: string,
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    try {
      return await primary();
    } catch (error: any) {
      if (isRateLimitError(error)) {
        this.logger.warn(`[OpenAI] rate limit on ${label}`);
        throw new BadRequestException(
          'Rate limit exceeded. Please try again later.',
        );
      }

      if (!isInsufficientQuotaError(error)) {
        this.logger.error(
          `[OpenAI] unexpected error on ${label}: ${error?.message}`,
        );
        throw new BadRequestException(
          `Unexpected error requesting OpenAI on ${label}.`,
        );
      }

      this.logger.error(
        `[OpenAI] insufficient_quota on ${label} — engaging OpenRouter fallback`,
      );
      await this.notifyInsufficientQuota();

      if (!isOpenRouterEnabled()) {
        throw new BadRequestException(
          'You dont have credits. Check your plan/billing.',
        );
      }

      try {
        const result = await fallback();
        this.logger.warn(`[OpenRouter] fallback succeeded for ${label}`);
        return result;
      } catch (fallbackError: any) {
        this.logger.error(
          `[OpenRouter] fallback failed for ${label}: ${this.describeOpenRouterError(fallbackError)}`,
        );
        await this.notifyFallbackFailed(label, fallbackError);
        throw new BadRequestException(
          'You dont have credits. Check your plan/billing.',
        );
      }
    }
  }

  /* istanbul ignore next */

  async organizeText(text: string, candidate: any): Promise<string> {
    const candidateJSON = JSON.stringify(candidate);

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new BadRequestException(
        'OPENAI_API_KEY is not defined in environment variables',
      );
    }
    const openai = new OpenAI({
      apiKey: apiKey,
    });

    const prompt = `
        You are a resume data extraction assistant.

        Your job is to read:
        1. Plain text extracted by Amazon Textract (resume content)
        2. A JSON object with candidate info

        and return a **single valid JSON object** with the exact structure below.

        ---

        ### OUTPUT SCHEMA (DO NOT CHANGE KEYS OR ORDER)
        {
        "bio": "",
        "experience": [
            {
            "company": "",
            "role": "",
            "start_date": null,
            "end_date": null,
            "description": ""
            }
        ],
        "education": [
            {
            "institution": "",
            "degree": "",
            "start_date": null,
            "end_date": null,
            "description": []
            }
        ]
        }

        ---

        ### CRITICAL RULES
        - Return ONLY valid JSON. No markdown, no explanations, no comments.
        - If a value is unknown, return "" or null (do not invent facts).
        - Never include personal names or identifiers in the "bio".
        - All dates must be ISO format (YYYY-MM-DD) or null.
        - Each "experience.description" must be:
            - Array of strings, each string a single sentence.
            - Each sentence between 100 and 120 characters.
            - If needed, use bullet points (•) to separate different responsibilities or achievements.
            - Each sentence need to have at least 100 characters.Don't return short than 100 characters.
            - If the description is too short, expand it with relevant details based on the role and industry.
        - Use the filler phrases only when needed to reach 100 characters:
            - "demonstrating strong attention to detail and adherence to quality standards"
            - "ensuring compliance with regulations and maintaining accurate documentation"
            - "coordinating with teams to optimize outcomes and workflow continuity"
            - "providing training and support to improve performance"
        - Do not create new companies, degrees, or dates. Use only information from the inputs.

        ---

        ### BIO
        - Do not include the person's name on the bio.
        - Write a brief description about the professional.
        - Write in a **client-oriented tone**, highlighting why the candidate is valuable to a potential employer.
        - Write 2–4 sentences (without the candidate’s name) summarizing professional background.
        - You may combine or paraphrase facts from Textract and HubSpot.
        - Use **keywords** from the 'specializations' array in the HubSpot JSON. 
        - If relevant details exist in both Textract and HubSpot, combine them.
        - Only include facts actually present in the inputs; do not invent achievements or roles.
        - Length: 2–4 sentences, concise, professional.


        ---

        ### ORDERING
        - Sort experience by most recent start_date.
        - Sort education by chronological order.

        ---

        ### INPUT DATA

        **Textract Resume Text:**
        ${text}

        **HubSpot Candidate JSON:**
        ${candidateJSON}

        ---

        ### FINAL INSTRUCTION
        Return only a **single valid JSON object** that passes strict JSON.parse().
        `;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You are a resume data extractor. return only the JSON request',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2,
      });
      const usage = response.usage;
      let cost = 0;
      if (usage) {
        const inputCost = (usage.prompt_tokens / 1000) * 0.002;
        const outputCost = (usage.completion_tokens / 1000) * 0.006;
        cost = inputCost + outputCost;
      }

      let message: any = response.choices?.[0]?.message?.content;
      if (!message) {
        throw new BadRequestException('OpenAI did not return a valid message.');
      }

      let parsedMessage;

      try {
        parsedMessage = JSON.parse(message);
      } catch (e) {
        console.error('Erro ao converter resposta JSON da OpenAI:', e);
        throw new BadRequestException('Invalid JSON returned from OpenAI');
      }
      parsedMessage.cost = `$${cost.toFixed(4)}`;
      message = JSON.stringify(parsedMessage, null, 2);

      return message;
    } catch (error: any) {
      if (error?.type === 'insufficient_quota') {
        console.error('[OpenAI] Insufficient Quota:');

        const today = new Date();
        const existingMail = await this.prisma.mail_Settings.findFirst({
          where: {
            title: 'insufficient_quota',
            created_at: {
              gte: new Date(today.setHours(0, 0, 0, 0)),
              lt: new Date(today.setHours(23, 59, 59, 999)),
            },
          },
        });
        if (!existingMail) {
          // Send insufficient quota via email
          const emailBody = insufficient_quota();
          const mailSent = await this.mailService.sendMail({
            from: 'MedVirtual <noreply@medvirtual.ai>',
            to: 'shayan@regenta.ai',
            cc: 'paulo@regenta.ai',
            subject: 'Insufficient Quota from OpenAI',
            html: emailBody,
          });
          if (!mailSent) {
            console.log(
              'Failed to send insufficient quota email notification.',
            );
          }
          //Here I save in the database that I sent the email
          await this.prisma.mail_Settings.create({
            data: {
              title: 'insufficient_quota',
            },
          });
        }

        throw new BadRequestException(
          'You dont have credits. Check your plan/billing.',
        );
      }

      if (error?.type === 'rate_limit_error') {
        console.log('[OpenAI] Rate Limit Exceeded:');
        throw new BadRequestException(
          'Rate limit exceeded. Please try again later.',
        );
      }

      console.log('[OpenAI] unexpected error:', error);
      throw new BadRequestException(
        'unexpected error to request OpenAI.',
        error,
      );
    }
  }

  async generateAvatarWithScreenshoot(
    candidate: any,
    imageDownloaded: any,
  ): Promise<{ imagePath: string; cost: number }> {
    const prompt = `
        Generate a realistic professional avatar inspired by the person in the reference image.
        Keep a similar lighting setup (soft studio light) and neutral background, but without accessories like headphone.
        Style: modern corporate headshot, natural facial expression, confident and friendly.
        Avoid copying the person — just use the image as reference for lighting and style.
        The avatar result need to be on format 1024x1024 pixels.
        `;

    return this.withQuotaFallback(
      'generateAvatarWithScreenshoot',
      async () => {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const image = fs.createReadStream(imageDownloaded);

        const result = await openai.images.edit({
          model: 'gpt-image-1',
          image: await toFile(image, null, {
            type: 'image/png',
          }),
          prompt,
        });

        // gpt-image-1 image edit pricing: $0.04 per 1024x1024 standard quality image
        const cost = 0.04;

        if (!result.data || !result.data[0] || !result.data[0].b64_json) {
          throw new Error(
            'The OpenAI API response did not contain the expected image data.',
          );
        }
        const imageBase64 = result.data[0].b64_json;
        const fileName = `${Date.now()}_avatarX.png`;
        const outputPath = path.resolve('/tmp', fileName);
        fs.writeFileSync(outputPath, Buffer.from(imageBase64, 'base64'));

        return { imagePath: outputPath, cost };
      },
      async () => {
        const result = await this.openrouter.editImage(imageDownloaded, prompt);
        this.logger.warn(
          `[OpenRouter] avatar served by ${result.model} at $${result.cost}`,
        );
        return { imagePath: result.imagePath, cost: result.cost };
      },
    );
  }

  async generateTextSummary(text: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new BadRequestException(
        'OPENAI_API_KEY is not defined in environment variables',
      );
    }

    const prompt = buildTextSummaryPrompt(text);

    return this.withQuotaFallback(
      'generateTextSummary',
      async () => {
        const openai = new OpenAI({ apiKey });
        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: TEXT_SUMMARY_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 300,
        });

        const content = response.choices?.[0]?.message?.content?.trim();
        if (!content) {
          throw new BadRequestException(
            'OpenAI did not return a valid summary.',
          );
        }
        return content;
      },
      async () => {
        const result = await this.openrouter.chatText(prompt, {
          temperature: 0.3,
          maxTokens: 300,
          systemPrompt: TEXT_SUMMARY_SYSTEM_PROMPT,
        });
        this.logger.warn(`[OpenRouter] text summary served by ${result.model}`);
        return result.data.trim();
      },
    );
  }

  async extractDataFromResumeImages(
    imagePaths: string[],
  ): Promise<{ data: any; cost: number }> {
    const apiKey =
      process.env.OPENAI_API_KEY_RESUME_EXTRACTION ||
      process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new BadRequestException(
        'OPENAI_API_KEY is not defined in environment variables',
      );
    }
    // Built once so both providers receive byte-identical input.
    const contentPayload = buildResumeExtractionPayload(imagePaths);

    return this.withQuotaFallback(
      'extractDataFromResumeImages',
      async () => {
        const openai = new OpenAI({ apiKey });
        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: contentPayload as any }],
          max_tokens: 4500,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        });

        const result = response.choices?.[0]?.message?.content;
        const usage = response.usage;
        let cost = 0;
        if (usage) {
          cost =
            (usage.prompt_tokens / 1000) * 0.00015 +
            (usage.completion_tokens / 1000) * 0.0006;
        }
        return {
          data: result ? normalizeResumeExtraction(parseJsonLoose(result)) : {},
          cost,
        };
      },
      async () => {
        const result = await this.openrouter.chatJson<any>(contentPayload, {
          temperature: 0.1,
          maxTokens: 4500,
          // Runs per model inside the cascade: free models often break the
          // schema (e.g. wrapping the payload in a "0" key), and an empty
          // result must be rejected rather than returned — updateFromJson
          // deletes the candidate's education/experience before reinserting,
          // so returning it wipes real data and still marks them `completed`.
          // Throwing here advances to the next free model; exhausting them all
          // leaves the candidate `failed` for the daily cron to retry.
          validate: (raw) => {
            const data = normalizeResumeExtraction(raw);
            if (
              imagePaths.length > 0 &&
              !data?.bio &&
              !data?.experience?.length
            ) {
              throw new BadRequestException(
                `OpenRouter returned an empty resume extraction for ${imagePaths.length} page(s).`,
              );
            }
            return data;
          },
        });
        this.logger.warn(
          `[OpenRouter] resume extraction served by ${result.model}`,
        );
        return { data: result.data, cost: result.cost };
      },
    );
  }
}
