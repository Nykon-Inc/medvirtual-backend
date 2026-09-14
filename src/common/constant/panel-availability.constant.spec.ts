import { HireRequestStatus, PanelCandidateStatus } from '@prisma/client';
import {
  CLIENT_OPEN_HIRE_REQUEST_STATUSES,
  isInClientOpenPanel,
  type PanelCandidateAvailabilityInput,
} from './panel-availability.constant';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';

function panelCandidate(
  hireRequestStatus: HireRequestStatus,
  options: {
    organizationId?: string;
    status?: PanelCandidateStatus | null;
  } = {},
): PanelCandidateAvailabilityInput {
  return {
    status: options.status,
    panel: {
      hireRequest: {
        status: hireRequestStatus,
        organization: { id: options.organizationId ?? ORG },
      },
    },
  };
}

describe('isInClientOpenPanel', () => {
  describe('organization scoping', () => {
    it('ignores panels belonging to another client', () => {
      // Regression: a candidate in someone else's panel must stay addable.
      const panels = [
        panelCandidate(HireRequestStatus.panel_ready, {
          organizationId: OTHER_ORG,
        }),
      ];

      expect(isInClientOpenPanel(panels, ORG)).toBe(false);
    });

    it('returns false when no organization is provided (system / public callers)', () => {
      const panels = [panelCandidate(HireRequestStatus.panel_ready)];

      expect(isInClientOpenPanel(panels, null)).toBe(false);
      expect(isInClientOpenPanel(panels, undefined)).toBe(false);
    });

    it('matches only the client-owned panel when both are present', () => {
      const panels = [
        panelCandidate(HireRequestStatus.panel_ready, {
          organizationId: OTHER_ORG,
        }),
        panelCandidate(HireRequestStatus.sourcing),
      ];

      expect(isInClientOpenPanel(panels, ORG)).toBe(true);
    });
  });

  describe('hire request status', () => {
    it.each(CLIENT_OPEN_HIRE_REQUEST_STATUSES)(
      'treats %s as an open panel',
      (status) => {
        expect(isInClientOpenPanel([panelCandidate(status)], ORG)).toBe(true);
      },
    );

    it.each([
      HireRequestStatus.awaiting_decision,
      HireRequestStatus.placement_completed,
      HireRequestStatus.cancelled,
      HireRequestStatus.deleted,
    ])('treats %s as a closed panel', (status) => {
      expect(isInClientOpenPanel([panelCandidate(status)], ORG)).toBe(false);
    });
  });

  describe('panel candidate status', () => {
    it('ignores candidates released back to the pool', () => {
      const panels = [
        panelCandidate(HireRequestStatus.panel_ready, {
          status: PanelCandidateStatus.returned_to_pool,
        }),
      ];

      expect(isInClientOpenPanel(panels, ORG)).toBe(false);
    });

    it.each([
      PanelCandidateStatus.selected,
      PanelCandidateStatus.interviewed,
      PanelCandidateStatus.selected_by_client,
      PanelCandidateStatus.blocked,
    ])('still occupies the panel when %s', (status) => {
      const panels = [
        panelCandidate(HireRequestStatus.panel_ready, { status }),
      ];

      expect(isInClientOpenPanel(panels, ORG)).toBe(true);
    });

    it('fails closed when the panel-candidate status was not selected', () => {
      // Some `panelCandidates` selects omit `status`; an unknown status must
      // not silently release the candidate.
      const panels = [
        panelCandidate(HireRequestStatus.panel_ready, { status: null }),
      ];

      expect(isInClientOpenPanel(panels, ORG)).toBe(true);
    });
  });

  describe('malformed input', () => {
    it('returns false for empty or missing collections', () => {
      expect(isInClientOpenPanel([], ORG)).toBe(false);
      expect(isInClientOpenPanel(null, ORG)).toBe(false);
      expect(isInClientOpenPanel(undefined, ORG)).toBe(false);
    });

    it('tolerates absent panel / hireRequest relations', () => {
      const panels: PanelCandidateAvailabilityInput[] = [
        {},
        { panel: null },
        { panel: { hireRequest: null } },
        { panel: { hireRequest: { status: null, organization: null } } },
      ];

      expect(isInClientOpenPanel(panels, ORG)).toBe(false);
    });
  });
});
