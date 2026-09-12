import {
  PANEL_CANDIDATE_MIN_LEAD_HOURS,
  PANEL_CANDIDATE_MIN_LEAD_ERROR,
  violatesPanelCandidateMinLead,
} from './panel-candidate-lead-time';

const HOUR_MS = 60 * 60 * 1000;

describe('panel-candidate-lead-time', () => {
  const now = new Date('2026-09-09T12:00:00Z');

  it('exposes a 48h constant', () => {
    expect(PANEL_CANDIDATE_MIN_LEAD_HOURS).toBe(48);
  });

  it('exposes a non-empty error message mentioning "48 hours"', () => {
    expect(PANEL_CANDIDATE_MIN_LEAD_ERROR.length).toBeGreaterThan(0);
    expect(PANEL_CANDIDATE_MIN_LEAD_ERROR).toMatch(/48 hours/);
  });

  describe('violatesPanelCandidateMinLead', () => {
    it('allows (false) when the date is null', () => {
      expect(violatesPanelCandidateMinLead(null, now)).toBe(false);
    });

    it('allows (false) when the date is undefined', () => {
      expect(violatesPanelCandidateMinLead(undefined, now)).toBe(false);
    });

    it('blocks a date 47h59m ahead', () => {
      const dateTime = new Date(
        now.getTime() + 47 * HOUR_MS + 59 * 60 * 1000,
      ).toISOString();
      expect(violatesPanelCandidateMinLead(dateTime, now)).toBe(true);
    });

    it('allows a date exactly at now + 48h (boundary is inclusive-allowed)', () => {
      const dateTime = new Date(
        now.getTime() + PANEL_CANDIDATE_MIN_LEAD_HOURS * HOUR_MS,
      ).toISOString();
      expect(violatesPanelCandidateMinLead(dateTime, now)).toBe(false);
    });

    it('allows a date 49h ahead', () => {
      const dateTime = new Date(now.getTime() + 49 * HOUR_MS).toISOString();
      expect(violatesPanelCandidateMinLead(dateTime, now)).toBe(false);
    });

    it('blocks a date in the past', () => {
      const dateTime = new Date(now.getTime() - HOUR_MS).toISOString();
      expect(violatesPanelCandidateMinLead(dateTime, now)).toBe(true);
    });

    it('blocks a garbage string (fail-closed)', () => {
      expect(violatesPanelCandidateMinLead('not-a-date', now)).toBe(true);
    });

    it('allows a real Date object 72h ahead (Prisma returns Date, not a string)', () => {
      const dateTime = new Date(now.getTime() + 72 * HOUR_MS);
      expect(violatesPanelCandidateMinLead(dateTime, now)).toBe(false);
    });
  });
});
