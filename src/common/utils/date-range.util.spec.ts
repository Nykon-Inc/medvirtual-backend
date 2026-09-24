import { buildInclusiveDateRange } from './date-range.util';

describe('buildInclusiveDateRange', () => {
  it('returns undefined when no bounds are given', () => {
    expect(buildInclusiveDateRange()).toBeUndefined();
    expect(buildInclusiveDateRange('', '')).toBeUndefined();
  });

  it('builds inclusive UTC day bounds', () => {
    expect(buildInclusiveDateRange('2026-09-01', '2026-09-30')).toEqual({
      gte: new Date('2026-09-01T00:00:00.000Z'),
      lte: new Date('2026-09-30T23:59:59.999Z'),
    });
  });

  it('supports a single open bound', () => {
    expect(buildInclusiveDateRange('2026-09-01')).toEqual({
      gte: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(buildInclusiveDateRange(undefined, '2026-09-30')).toEqual({
      lte: new Date('2026-09-30T23:59:59.999Z'),
    });
  });
});
