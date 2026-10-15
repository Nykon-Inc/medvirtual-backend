export const DEFAULT_OPENAI_TEXT_MODEL = 'gpt-4o-mini';

/** Single source for every OpenAI chat-completion call (text and resume vision). */
export function getOpenAiTextModel(): string {
  return process.env.OPENAI_MODEL_TO_TEXT || DEFAULT_OPENAI_TEXT_MODEL;
}
