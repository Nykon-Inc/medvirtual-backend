import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import fs from 'fs';
import OpenAI from 'openai';
import path from 'path';
import { extractDriveFileId } from '../common/utils/hubspot.util';
import { GoogledriveService } from '../googledrive/googledrive.service';
import { getOpenAiTextModel } from '../openai/openai.config';
import {
  buildResumeExtractionPayload,
  buildTextSummaryPrompt,
  normalizeResumeExtraction,
  TEXT_SUMMARY_SYSTEM_PROMPT,
} from '../openai/openai.prompts';
import { parseJsonLoose } from '../openrouter/openrouter.service';
import { OpenrouterService } from '../openrouter/openrouter.service';
import { PrismaService } from '../prisma/prisma.service';
import { CompareResumeDto } from './dto/compare-resume.dto';
import { CompareTextDto } from './dto/compare-text.dto';
import {
  ProviderRunDto,
  ResumeComparisonResultDto,
  ResumeFromOpenRouterOnlyResultDto,
  TextSummaryComparisonResultDto,
} from './dto/comparison-result.dto';

const COMPARED_FIELDS = ['bio', 'experience', 'education', 'skills'];

@Injectable()
export class AiComparisonService {
  private readonly logger = new Logger(AiComparisonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogledriveService,
    private readonly openrouter: OpenrouterService,
  ) {}

  private compare(openai: number, openrouter: number) {
    return { openai, openrouter, delta: openai - openrouter };
  }

  private isEmptyValue(value: any): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    return false;
  }

  private missingFields(present: any, other: any): string[] {
    if (!present || !other) return [];
    return COMPARED_FIELDS.filter(
      (field) =>
        !this.isEmptyValue(present[field]) && this.isEmptyValue(other[field]),
    );
  }

  private settled<T>(
    result: PromiseSettledResult<
      T & { model: string; cost: number; latencyMs: number }
    >,
    dataKey: 'data',
  ): ProviderRunDto {
    if (result.status === 'fulfilled') {
      return {
        model: result.value.model,
        ok: true,
        latencyMs: result.value.latencyMs,
        cost: result.value.cost,
        data: (result.value as any)[dataKey],
      };
    }
    return {
      model: 'n/a',
      ok: false,
      latencyMs: 0,
      cost: 0,
      error: result.reason?.message ?? String(result.reason),
    };
  }

  /**
   * Resolves a candidate's resume into page images ready to send to a provider.
   * The caller owns cleanup and must call `this.cleanup(tempDir, pdfPath)` in a
   * `finally` block.
   */
  private async prepareResumePages(dto: CompareResumeDto): Promise<{
    candidateId: string;
    imagePaths: string[];
    tempDir: string;
    pdfPath: string;
  }> {
    const candidate = await this.prisma.candidate.findUnique({
      where: { id: dto.candidateId },
      select: { id: true, resume_url: true },
    });

    if (!candidate) throw new NotFoundException('Candidate not found');
    if (!candidate.resume_url || !candidate.resume_url.includes('http')) {
      throw new BadRequestException('Candidate has no usable resume URL');
    }

    const fileId = extractDriveFileId(candidate.resume_url);
    if (!fileId) {
      throw new BadRequestException(
        'Could not extract the Google Drive file ID from the resume URL',
      );
    }

    // The `_cmp_` prefix keeps this run from colliding with a concurrent
    // processData, whose cleanup would otherwise delete our PDF.
    const pdfName = `${candidate.id}_cmp_resume.pdf`;
    const downloadDir = '/tmp';
    const pdfPath = path.join(downloadDir, pdfName);
    const tempDir = path.join(downloadDir, `cmp_pages_${candidate.id}`);

    const downloaded = await this.google.downloadFile(
      fileId,
      pdfName,
      downloadDir,
    );
    if (downloaded !== 'Download successful') {
      throw new BadRequestException(`Failed to download resume: ${downloaded}`);
    }

    try {
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const imagePaths = await this.convertPdfToImages(
        pdfPath,
        tempDir,
        dto.maxPages,
      );

      return { candidateId: candidate.id, imagePaths, tempDir, pdfPath };
    } catch (error) {
      // The caller never gets a chance to clean up if preparation itself fails.
      this.cleanup(tempDir, pdfPath);
      throw error;
    }
  }

  /**
   * Runs the resume extraction through both providers and reports a diff.
   * Deliberately read-only: it never calls processData/updateStatus and never
   * writes to the candidate record.
   */
  async compareResume(
    dto: CompareResumeDto,
  ): Promise<ResumeComparisonResultDto> {
    const { candidateId, imagePaths, tempDir, pdfPath } =
      await this.prepareResumePages(dto);

    try {
      const contentPayload = buildResumeExtractionPayload(imagePaths);

      const [openaiResult, openrouterResult] = await Promise.allSettled([
        this.runOpenaiExtraction(contentPayload),
        this.openrouter.chatJson<any>(contentPayload, {
          models: dto.models,
          temperature: 0.1,
          maxTokens: 4500,
        }),
      ]);

      const openai = this.settled(openaiResult as any, 'data');
      const openrouter = this.settled(openrouterResult as any, 'data');

      // Normalized so the diff compares content, not schema drift. Unlike the
      // production path this never rejects an empty result — seeing the bad
      // output is the point of a diagnostic dry run.
      openai.data = normalizeResumeExtraction(openai.data);
      openrouter.data = normalizeResumeExtraction(openrouter.data);

      const a = openai.data ?? {};
      const b = openrouter.data ?? {};

      return {
        candidateId,
        pageCount: imagePaths.length,
        openai,
        openrouter,
        diff: {
          experienceCount: this.compare(
            a.experience?.length ?? 0,
            b.experience?.length ?? 0,
          ),
          educationCount: this.compare(
            a.education?.length ?? 0,
            b.education?.length ?? 0,
          ),
          skillsCount: this.compare(
            a.skills?.length ?? 0,
            b.skills?.length ?? 0,
          ),
          bioLength: this.compare(a.bio?.length ?? 0, b.bio?.length ?? 0),
          missingInOpenrouter: this.missingFields(a, b),
          missingInOpenai: this.missingFields(b, a),
          costDelta: openai.cost - openrouter.cost,
          latencyDeltaMs: openai.latencyMs - openrouter.latencyMs,
        },
      };
    } finally {
      this.cleanup(tempDir, pdfPath);
    }
  }

  async compareTextSummary(
    dto: CompareTextDto,
  ): Promise<TextSummaryComparisonResultDto> {
    const prompt = buildTextSummaryPrompt(dto.text);

    const [openaiResult, openrouterResult] = await Promise.allSettled([
      this.runOpenaiSummary(prompt),
      this.openrouter.chatText(prompt, {
        models: dto.models,
        temperature: 0.3,
        maxTokens: 300,
        systemPrompt: TEXT_SUMMARY_SYSTEM_PROMPT,
      }),
    ]);

    const openai = this.settled(openaiResult as any, 'data');
    const openrouter = this.settled(openrouterResult as any, 'data');

    const textA = typeof openai.data === 'string' ? openai.data : '';
    const textB = typeof openrouter.data === 'string' ? openrouter.data : '';

    return {
      openai,
      openrouter,
      diff: {
        length: this.compare(textA.length, textB.length),
        sentenceCount: this.compare(
          this.countSentences(textA),
          this.countSentences(textB),
        ),
        latencyDeltaMs: openai.latencyMs - openrouter.latencyMs,
        costDelta: openai.cost - openrouter.cost,
      },
    };
  }

  /**
   * Extracts a resume through OpenRouter alone. Unlike compareResume this never
   * touches OpenAI, so it costs nothing and can be used while credits are out.
   * Read-only: it never writes to the candidate record.
   */
  async resumeFromOpenRouterOnly(
    dto: CompareResumeDto,
  ): Promise<ResumeFromOpenRouterOnlyResultDto> {
    const { candidateId, imagePaths, tempDir, pdfPath } =
      await this.prepareResumePages(dto);

    try {
      const contentPayload = buildResumeExtractionPayload(imagePaths);

      const result = await this.openrouter.chatJson<any>(contentPayload, {
        models: dto.models,
        temperature: 0.1,
        maxTokens: 4500,
      });

      // Built directly rather than via `settled`, which only understands the
      // envelope shape produced by Promise.allSettled.
      const openrouter: ProviderRunDto = {
        model: result.model,
        ok: true,
        latencyMs: result.latencyMs,
        cost: result.cost,
        data: normalizeResumeExtraction(result.data),
      };

      return {
        candidateId,
        pageCount: imagePaths.length,
        openrouter,
      };
    } finally {
      this.cleanup(tempDir, pdfPath);
    }
  }

  private countSentences(text: string): number {
    return text.split(/[.!?]+\s|[.!?]+$/).filter((s) => s.trim().length > 0)
      .length;
  }

  /**
   * Calls OpenAI directly rather than through OpenaiService on purpose: going
   * through the service would silently fall back to OpenRouter on a quota
   * error, and we would end up comparing OpenRouter against itself.
   */
  private async runOpenaiExtraction(contentPayload: any[]) {
    const apiKey =
      process.env.OPENAI_API_KEY_RESUME_EXTRACTION ||
      process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new BadRequestException(
        'OPENAI_API_KEY is not defined in environment variables',
      );
    }

    const model = getOpenAiTextModel();
    const startedAt = Date.now();
    const openai = new OpenAI({ apiKey });

    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: contentPayload as any }],
      max_tokens: 4500,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    const usage = response.usage;
    const cost = usage
      ? (usage.prompt_tokens / 1000) * 0.00015 +
        (usage.completion_tokens / 1000) * 0.0006
      : 0;

    const content = response.choices?.[0]?.message?.content;
    return {
      data: content ? parseJsonLoose(content) : {},
      cost,
      model,
      latencyMs: Date.now() - startedAt,
    };
  }

  /** Direct call for the same reason as runOpenaiExtraction. */
  private async runOpenaiSummary(prompt: string) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new BadRequestException(
        'OPENAI_API_KEY is not defined in environment variables',
      );
    }

    const model = getOpenAiTextModel();
    const startedAt = Date.now();
    const openai = new OpenAI({ apiKey });

    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: TEXT_SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 300,
    });

    const usage = response.usage;
    const cost = usage
      ? (usage.prompt_tokens / 1000) * 0.00015 +
        (usage.completion_tokens / 1000) * 0.0006
      : 0;

    return {
      data: response.choices?.[0]?.message?.content?.trim() ?? '',
      cost,
      model,
      latencyMs: Date.now() - startedAt,
    };
  }

  /** Mirrors the poppler conversion in CandidatesService.processData. */
  private async convertPdfToImages(
    pdfPath: string,
    tempDir: string,
    maxPages?: number,
  ): Promise<string[]> {
    const { Poppler } = require('node-poppler');
    const popplerPath =
      process.env.POPPLER_BIN_PATH ||
      (fs.existsSync('/opt/bin/pdftocairo') ? '/opt/bin' : undefined);
    const poppler = new Poppler(popplerPath);

    await poppler.pdfToCairo(pdfPath, path.join(tempDir, 'page'), {
      firstPageToConvert: 1,
      pngFile: true,
    });

    const imagePaths = fs
      .readdirSync(tempDir)
      .filter((file) => file.startsWith('page') && file.endsWith('.png'))
      .map((file) => path.join(tempDir, file))
      .sort((a, b) => {
        const numA = parseInt(a.match(/page-(\d+)\.png/)?.[1] || '0');
        const numB = parseInt(b.match(/page-(\d+)\.png/)?.[1] || '0');
        return numA - numB;
      });

    if (imagePaths.length === 0) {
      throw new BadRequestException(
        'No images could be converted from the PDF.',
      );
    }

    return maxPages ? imagePaths.slice(0, maxPages) : imagePaths;
  }

  private cleanup(tempDir: string, pdfPath: string): void {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
      }
    } catch (error: any) {
      this.logger.warn(
        `Failed to clean up comparison artifacts: ${error?.message}`,
      );
    }
  }
}
