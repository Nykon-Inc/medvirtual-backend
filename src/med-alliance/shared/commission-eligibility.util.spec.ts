import {
  computeLineItemCommissionEligibility,
  resolveCommissionAnchorDate,
} from './commission-eligibility.util';

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
