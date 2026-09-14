import {
  INTERVIEW_MIN_LEAD_HOURS,
  isClientOriginatedRole,
  parseNaiveInterviewDate,
  violatesMinLeadTime,
} from './interview-schedule-window';

const HOUR_MS = 60 * 60 * 1000;

describe('interview-schedule-window', () => {
  describe('isClientOriginatedRole', () => {
    it('returns true for organization_admin', () => {
      expect(isClientOriginatedRole('organization_admin')).toBe(true);
    });

    it('returns true for organization_super_admin', () => {
      expect(isClientOriginatedRole('organization_super_admin')).toBe(true);
    });

    it('returns false for system_admin', () => {
      expect(isClientOriginatedRole('system_admin')).toBe(false);
    });

    it('returns false for system_super_admin', () => {
      expect(isClientOriginatedRole('system_super_admin')).toBe(false);
    });

    it('returns false for an empty string', () => {
      expect(isClientOriginatedRole('')).toBe(false);
    });

    it('returns false for null', () => {
      expect(isClientOriginatedRole(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isClientOriginatedRole(undefined)).toBe(false);
    });
  });

  describe('parseNaiveInterviewDate', () => {
    it('appends Z when no offset is present', () => {
      const result = parseNaiveInterviewDate('2026-09-10T12:00');
      expect(result).toEqual(new Date('2026-09-10T12:00Z'));
    });

    it('does not append Z when the string already ends in Z', () => {
      const result = parseNaiveInterviewDate('2026-09-10T12:00:00Z');
      expect(result).toEqual(new Date('2026-09-10T12:00:00Z'));
    });

    it('does not append Z when the string already has an offset', () => {
      const result = parseNaiveInterviewDate('2026-09-10T12:00:00+05:00');
      expect(result).toEqual(new Date('2026-09-10T12:00:00+05:00'));
    });

    it('returns null for a garbage string', () => {
      expect(parseNaiveInterviewDate('not-a-date')).toBeNull();
    });
  });

  describe('violatesMinLeadTime', () => {
    const now = new Date('2026-09-09T12:00:00Z');

    it('allows a date_time exactly at now + 24h', () => {
      const dateTime = new Date(
        now.getTime() + INTERVIEW_MIN_LEAD_HOURS * HOUR_MS,
      ).toISOString();
      expect(violatesMinLeadTime(dateTime, now)).toBe(false);
    });

    it('blocks a date_time at now + 24h minus 1 minute', () => {
      const dateTime = new Date(
        now.getTime() + INTERVIEW_MIN_LEAD_HOURS * HOUR_MS - 60 * 1000,
      ).toISOString();
      expect(violatesMinLeadTime(dateTime, now)).toBe(true);
    });

    it('allows a date_time at now + 24h plus 1 minute', () => {
      const dateTime = new Date(
        now.getTime() + INTERVIEW_MIN_LEAD_HOURS * HOUR_MS + 60 * 1000,
      ).toISOString();
      expect(violatesMinLeadTime(dateTime, now)).toBe(false);
    });

    it('blocks a date_time in the past', () => {
      const dateTime = new Date(now.getTime() - HOUR_MS).toISOString();
      expect(violatesMinLeadTime(dateTime, now)).toBe(true);
    });

    it('blocks a garbage string', () => {
      expect(violatesMinLeadTime('not-a-date', now)).toBe(true);
    });
  });
});
