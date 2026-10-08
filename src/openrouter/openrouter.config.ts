import { BadRequestException } from '@nestjs/common';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Free models verified to accept image input AND support `response_format`.
 * `nvidia/nemotron-nano-12b-v2-vl:free` is deliberately excluded — it accepts
 * images but does not support `response_format`, so it cannot return JSON
 * reliably.
 */
export const DEFAULT_VISION_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'openrouter/free',
];

export const DEFAULT_TEXT_MODELS = [...DEFAULT_VISION_MODELS];

/**
 * No image-output model on OpenRouter is free — every free-tier model is
 * text-output only, even the ones that accept an image as input.
 * `openai/gpt-5-image-mini` is cheaper (~$0.01/image) but was tried and
 * produced unsatisfactory avatar quality — reverted to this one, ~$0.04/image
 * (image_output is billed per token, not per image: OpenRouter's own
 * /models pricing lists $0.00003/token, and a 1024x1024 edit runs ~1300
 * output tokens), about 3x the OpenAI primary (gpt-image-2.5-flare, ~$0.013/image at medium).
 */
export const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
export const IMAGE_MODEL_COST = 0.0392;

/** Free models are slow and queued; cap the wait so one cannot eat the Lambda budget. */
export const OPENROUTER_TIMEOUT_MS = 90_000;

export function getOpenRouterApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new BadRequestException(
      'OPENROUTER_API_KEY is not defined in environment variables',
    );
  }
  return apiKey;
}

/** Parses a CSV env override, falling back to the built-in cascade. */
export function parseModelList(
  raw: string | undefined,
  fallback: string[],
): string[] {
  const parsed = (raw ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

/**
 * Kill switch. Without an API key the fallback is a no-op and the original
 * OpenAI error is rethrown, so this can ship before the key is provisioned.
 */
export function isOpenRouterEnabled(): boolean {
  return (
    process.env.OPENROUTER_FALLBACK_ENABLED !== 'false' &&
    !!process.env.OPENROUTER_API_KEY
  );
}

export function getVisionModels(): string[] {
  return parseModelList(
    process.env.OPENROUTER_VISION_MODELS,
    DEFAULT_VISION_MODELS,
  );
}

export function getTextModels(): string[] {
  return parseModelList(
    process.env.OPENROUTER_TEXT_MODELS,
    DEFAULT_TEXT_MODELS,
  );
}

export function getImageModel(): string {
  return process.env.OPENROUTER_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
}

export function getOpenRouterHeaders(): Record<string, string> {
  return {
    'HTTP-Referer':
      process.env.OPENROUTER_HTTP_REFERER || 'https://medvirtual.ai',
    'X-Title': process.env.OPENROUTER_X_TITLE || 'MedVirtual',
  };
}
