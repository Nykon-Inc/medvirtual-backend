import { DEFAULT_OPENAI_TEXT_MODEL, getOpenAiTextModel } from './openai.config';

describe('getOpenAiTextModel', () => {
  const original = process.env.OPENAI_MODEL_TO_TEXT;

  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_MODEL_TO_TEXT;
    else process.env.OPENAI_MODEL_TO_TEXT = original;
  });

  it('should return OPENAI_MODEL_TO_TEXT when set', () => {
    process.env.OPENAI_MODEL_TO_TEXT = 'custom-model';
    expect(getOpenAiTextModel()).toBe('custom-model');
  });

  it('should return the default when the variable is unset or empty', () => {
    delete process.env.OPENAI_MODEL_TO_TEXT;
    expect(getOpenAiTextModel()).toBe(DEFAULT_OPENAI_TEXT_MODEL);
    process.env.OPENAI_MODEL_TO_TEXT = '';
    expect(getOpenAiTextModel()).toBe(DEFAULT_OPENAI_TEXT_MODEL);
  });
});
