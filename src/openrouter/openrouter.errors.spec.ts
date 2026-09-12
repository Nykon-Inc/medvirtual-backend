import {
  isInsufficientQuotaError,
  isRateLimitError,
} from './openrouter.errors';

describe('openrouter.errors', () => {
  describe('isInsufficientQuotaError', () => {
    it('should detect the OpenAI SDK v5 shape (status + code)', () => {
      expect(
        isInsufficientQuotaError({
          status: 429,
          code: 'insufficient_quota',
          error: { type: 'insufficient_quota' },
        }),
      ).toBe(true);
    });

    it('should detect the legacy shape with only a top-level type', () => {
      expect(isInsufficientQuotaError({ type: 'insufficient_quota' })).toBe(
        true,
      );
    });

    it('should detect quota nested under error.type', () => {
      expect(
        isInsufficientQuotaError({
          status: 429,
          error: { type: 'insufficient_quota' },
        }),
      ).toBe(true);
    });

    it('should detect a 401 with insufficient_quota', () => {
      expect(
        isInsufficientQuotaError({ status: 401, code: 'insufficient_quota' }),
      ).toBe(true);
    });

    it('should detect billing_hard_limit_reached', () => {
      expect(
        isInsufficientQuotaError({
          status: 429,
          code: 'billing_hard_limit_reached',
        }),
      ).toBe(true);
    });

    it('should detect the billing message when no code is present', () => {
      expect(
        isInsufficientQuotaError({
          status: 429,
          message:
            'You exceeded your current quota, please check your plan and billing details.',
        }),
      ).toBe(true);
    });

    it('should read an axios-shaped error', () => {
      expect(
        isInsufficientQuotaError({
          response: {
            status: 429,
            data: { error: { code: 'insufficient_quota' } },
          },
        }),
      ).toBe(true);
    });

    // Regression guard for the "quota only" decision: rate limits must never
    // engage the fallback, even though they also return 429.
    it('should NOT treat a rate limit as quota', () => {
      expect(
        isInsufficientQuotaError({
          status: 429,
          code: 'rate_limit_exceeded',
        }),
      ).toBe(false);
    });

    it('should NOT trigger on 5xx errors', () => {
      expect(isInsufficientQuotaError({ status: 500 })).toBe(false);
      expect(isInsufficientQuotaError({ status: 503 })).toBe(false);
    });

    it('should NOT trigger on a 400 validation error', () => {
      expect(
        isInsufficientQuotaError({
          status: 400,
          code: 'invalid_request_error',
        }),
      ).toBe(false);
    });

    it('should NOT trigger on an unrelated message mentioning billing with a bad status', () => {
      expect(
        isInsufficientQuotaError({
          status: 500,
          message: 'check your plan and billing details',
        }),
      ).toBe(false);
    });

    it('should handle null, undefined and plain errors', () => {
      expect(isInsufficientQuotaError(null)).toBe(false);
      expect(isInsufficientQuotaError(undefined)).toBe(false);
      expect(isInsufficientQuotaError(new Error('boom'))).toBe(false);
    });
  });

  describe('isRateLimitError', () => {
    it('should detect rate_limit_exceeded', () => {
      expect(
        isRateLimitError({ status: 429, code: 'rate_limit_exceeded' }),
      ).toBe(true);
    });

    it('should treat a bare 429 as a rate limit', () => {
      expect(isRateLimitError({ status: 429 })).toBe(true);
    });

    it('should NOT treat a quota-coded 429 as a rate limit', () => {
      expect(
        isRateLimitError({ status: 429, code: 'insufficient_quota' }),
      ).toBe(false);
    });

    it('should NOT trigger on 5xx or null', () => {
      expect(isRateLimitError({ status: 500 })).toBe(false);
      expect(isRateLimitError(null)).toBe(false);
    });
  });
});
