import {
  hasActiveStaff,
  resolvePairingRequestType,
  isPairingTypeDowngraded,
  ACTIVE_STAFF_STATUS_FILTER,
} from './organizationActiveStaff.util';

describe('organizationActiveStaff.util', () => {
  describe('hasActiveStaff', () => {
    const mockPrisma = {
      staff: { count: jest.fn() },
    } as any;

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('returns false without querying prisma when organizationId is null', async () => {
      const result = await hasActiveStaff(mockPrisma, null);
      expect(result).toBe(false);
      expect(mockPrisma.staff.count).not.toHaveBeenCalled();
    });

    it('returns false without querying prisma when organizationId is undefined', async () => {
      const result = await hasActiveStaff(mockPrisma, undefined);
      expect(result).toBe(false);
      expect(mockPrisma.staff.count).not.toHaveBeenCalled();
    });

    it('returns false when staff.count resolves to 0', async () => {
      mockPrisma.staff.count.mockResolvedValueOnce(0);
      const result = await hasActiveStaff(mockPrisma, 'org-1');
      expect(result).toBe(false);
    });

    it('returns true when staff.count resolves to a positive number', async () => {
      mockPrisma.staff.count.mockResolvedValueOnce(3);
      const result = await hasActiveStaff(mockPrisma, 'org-1');
      expect(result).toBe(true);
    });

    it('queries with the exact active-staff filter for the given organization', async () => {
      mockPrisma.staff.count.mockResolvedValueOnce(1);
      await hasActiveStaff(mockPrisma, 'org-1');
      expect(mockPrisma.staff.count).toHaveBeenCalledWith({
        where: {
          organization_id: 'org-1',
          ...ACTIVE_STAFF_STATUS_FILTER,
        },
      });
    });
  });

  describe('resolvePairingRequestType', () => {
    it('downgrades Upsell Agent to null when org has no active staff', () => {
      expect(resolvePairingRequestType('Upsell Agent', false)).toBeNull();
    });

    it('keeps Upsell Agent when org has active staff', () => {
      expect(resolvePairingRequestType('Upsell Agent', true)).toBe(
        'Upsell Agent',
      );
    });

    it('does not touch Agent Replacement regardless of active staff', () => {
      expect(resolvePairingRequestType('Agent Replacement', false)).toBe(
        'Agent Replacement',
      );
      expect(resolvePairingRequestType('Agent Replacement', true)).toBe(
        'Agent Replacement',
      );
    });

    it('passes through other values unchanged', () => {
      expect(resolvePairingRequestType('New Client', false)).toBe('New Client');
    });

    it('normalizes null/undefined to null', () => {
      expect(resolvePairingRequestType(null, false)).toBeNull();
      expect(resolvePairingRequestType(undefined, true)).toBeNull();
    });
  });

  describe('isPairingTypeDowngraded', () => {
    it('is true only when requested was Upsell Agent and resolved is null', () => {
      expect(isPairingTypeDowngraded('Upsell Agent', null)).toBe(true);
    });

    it('is false when requested was Upsell Agent and resolved stayed Upsell Agent', () => {
      expect(isPairingTypeDowngraded('Upsell Agent', 'Upsell Agent')).toBe(
        false,
      );
    });

    it('is false for other requested types even if resolved is null', () => {
      expect(isPairingTypeDowngraded('Agent Replacement', null)).toBe(false);
      expect(isPairingTypeDowngraded(null, null)).toBe(false);
    });
  });
});
