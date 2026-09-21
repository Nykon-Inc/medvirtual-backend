import axios from 'axios';
import {
  computeLineItemCommissionEligibility,
  resolveCommissionAnchorDate,
  resolveStaffCommissionStartDate,
} from './commission-eligibility.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('computeLineItemCommissionEligibility', () => {
  it('is not eligible when the staff has no start_date yet', () => {
    const result = computeLineItemCommissionEligibility({
      lineItemAmount: 1000,
      staffStartDate: null,
      commissionPercent: 7,
      now: new Date('2026-06-01'),
    });

    expect(result).toEqual({
      eligible: false,
      skipReason: 'staff_not_deployed',
    });
  });

  it('is eligible when now is within 365 days of staff.start_date', () => {
    const result = computeLineItemCommissionEligibility({
      lineItemAmount: 1000,
      staffStartDate: new Date('2026-01-01'),
      commissionPercent: 7,
      now: new Date('2026-06-01'),
    });

    expect(result.eligible).toBe(true);
    expect(result.commissionAmount?.toString()).toBe('70');
  });

  it('is not eligible when now is more than 365 days past staff.start_date', () => {
    const result = computeLineItemCommissionEligibility({
      lineItemAmount: 1000,
      staffStartDate: new Date('2025-01-01'),
      commissionPercent: 7,
      now: new Date('2026-06-01'),
    });

    expect(result.eligible).toBe(false);
    expect(result.skipReason).toBe('staff_window_expired');
  });

  it('rounds commissionAmount to 2 decimal places', () => {
    const result = computeLineItemCommissionEligibility({
      lineItemAmount: 100,
      staffStartDate: new Date('2026-01-01'),
      commissionPercent: 7.333,
      now: new Date('2026-01-15'),
    });

    expect(result.eligible).toBe(true);
    expect(result.commissionAmount?.toString()).toBe('7.33');
  });
});

describe('resolveCommissionAnchorDate', () => {
  it('prefers due_date when present', () => {
    const dueDate = new Date('2026-03-01');
    const paidAt = new Date('2026-02-15');

    expect(
      resolveCommissionAnchorDate({ due_date: dueDate, paid_at: paidAt }),
    ).toBe(dueDate);
  });

  it('falls back to paid_at when due_date is null', () => {
    const paidAt = new Date('2026-02-15');

    expect(
      resolveCommissionAnchorDate({ due_date: null, paid_at: paidAt }),
    ).toBe(paidAt);
  });

  it('falls back to the current time when both due_date and paid_at are null', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-01T00:00:00.000Z'));

    const result = resolveCommissionAnchorDate({
      due_date: null,
      paid_at: null,
    });

    expect(result).toEqual(new Date('2026-05-01T00:00:00.000Z'));

    jest.useRealTimers();
  });
});

describe('resolveStaffCommissionStartDate', () => {
  const mockPrisma = {
    staff: { update: jest.fn() },
  } as any;

  afterEach(() => jest.clearAllMocks());

  it('returns null without calling axios when staff is null/undefined', async () => {
    expect(await resolveStaffCommissionStartDate(mockPrisma, null)).toBeNull();
    expect(
      await resolveStaffCommissionStartDate(mockPrisma, undefined),
    ).toBeNull();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('returns the local value without calling axios when already set', async () => {
    const localDate = new Date('2026-01-01');

    const result = await resolveStaffCommissionStartDate(mockPrisma, {
      id: 'staff-1',
      hubspot_id: 'deal-1',
      hubspot_commission_start_date: localDate,
    });

    expect(result).toBe(localDate);
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(mockPrisma.staff.update).not.toHaveBeenCalled();
  });

  it('returns null without calling axios when hubspot_id is missing', async () => {
    const result = await resolveStaffCommissionStartDate(mockPrisma, {
      id: 'staff-1',
      hubspot_id: null,
      hubspot_commission_start_date: null,
    });

    expect(result).toBeNull();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('fetches from HubSpot, persists, and returns the parsed date when local value is null', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { properties: { alliance_commission_start_date: '1735689600000' } },
    });
    mockPrisma.staff.update.mockResolvedValue({});

    const result = await resolveStaffCommissionStartDate(mockPrisma, {
      id: 'staff-1',
      hubspot_id: 'deal-1',
      hubspot_commission_start_date: null,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.hubapi.com/crm/v3/objects/deals/deal-1?properties=alliance_commission_start_date',
      expect.any(Object),
    );
    expect(mockPrisma.staff.update).toHaveBeenCalledWith({
      where: { id: 'staff-1' },
      data: { hubspot_commission_start_date: new Date(1735689600000) },
    });
    expect(result).toEqual(new Date(1735689600000));
  });

  it('parses HubSpot\'s "YYYY-MM-DD" date-property format (the actual format the read/search API returns, not epoch-millis)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { properties: { alliance_commission_start_date: '2025-11-16' } },
    });
    mockPrisma.staff.update.mockResolvedValue({});

    const result = await resolveStaffCommissionStartDate(mockPrisma, {
      id: 'staff-1',
      hubspot_id: 'deal-1',
      hubspot_commission_start_date: null,
    });

    expect(mockPrisma.staff.update).toHaveBeenCalledWith({
      where: { id: 'staff-1' },
      data: { hubspot_commission_start_date: new Date('2025-11-16') },
    });
    expect(result).toEqual(new Date('2025-11-16'));
  });

  it('returns null and does not persist when HubSpot also has no value', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { properties: {} } });

    const result = await resolveStaffCommissionStartDate(mockPrisma, {
      id: 'staff-1',
      hubspot_id: 'deal-1',
      hubspot_commission_start_date: null,
    });

    expect(result).toBeNull();
    expect(mockPrisma.staff.update).not.toHaveBeenCalled();
  });

  it('returns null without throwing when the HubSpot call fails', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('Network error'));

    const result = await resolveStaffCommissionStartDate(mockPrisma, {
      id: 'staff-1',
      hubspot_id: 'deal-1',
      hubspot_commission_start_date: null,
    });

    expect(result).toBeNull();
    expect(mockPrisma.staff.update).not.toHaveBeenCalled();
  });
});
