import { redactAttributes, redactSensitive } from './redact-sensitive';

describe('redactSensitive', () => {
  it('should redact email addresses', () => {
    expect(
      redactSensitive('Owner updated: jane.doe+va@clinic.co.uk done'),
    ).toBe('Owner updated: [redacted-email] done');
  });

  it('should redact bearer tokens', () => {
    expect(redactSensitive('Authorization: Bearer abc.DEF-123_xyz=')).toBe(
      'Authorization: Bearer [redacted]',
    );
  });

  it('should redact bare JWTs', () => {
    expect(
      redactSensitive('token eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.s1gn4tur3 used'),
    ).toBe('token [redacted-jwt] used');
  });

  it('should leave ordinary text untouched', () => {
    expect(redactSensitive('Invoice 42 generated for org 7')).toBe(
      'Invoice 42 generated for org 7',
    );
  });
});

describe('redactAttributes', () => {
  it('should redact string values and keep other types', () => {
    expect(
      redactAttributes({ context: 'a@b.com', count: 3, ok: true }),
    ).toEqual({ context: '[redacted-email]', count: 3, ok: true });
  });

  it('should pass undefined through', () => {
    expect(redactAttributes(undefined)).toBeUndefined();
  });
});
