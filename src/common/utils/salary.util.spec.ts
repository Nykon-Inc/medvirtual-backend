import {
  findPayRateMonthly,
  findBillRateHourly,
  findBillRateMonthly,
  buildConfigMap,
  computeCandidateRates,
  CandidateLike,
  PositionRateConfigLike,
} from './salary.util';

const FULL_TIME_HOURS = 176;
const PART_TIME_HOURS = 88;
const PART_TIME_CODE = '1087596819';

function makeConfig(
  position: string,
  overrides: Partial<PositionRateConfigLike> = {},
): PositionRateConfigLike & { position: string } {
  return {
    position,
    medical_floor_price_english: 15,
    non_medical_floor_price_english: 12,
    medical_floor_price_bilingual: 18,
    non_medical_floor_price_bilingual: 14,
    medical_margin_per_hour: 9,
    non_medical_margin_per_hour: 7,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<CandidateLike> = {}): CandidateLike {
  return {
    hourly_pay_rate: 20,
    approved_positions_pairing: ['Accountant'],
    languages: [{ name: 'English' }],
    employment_type: '',
    business_unit: 'MedVirtual',
    ...overrides,
  };
}

describe('salary.util', () => {
  describe('findPayRateMonthly', () => {
    it('uses full-time hours (176) when employment_type is not part-time code', () => {
      expect(findPayRateMonthly(10, 'some-other-code')).toBe(
        10 * FULL_TIME_HOURS,
      );
    });

    it('uses part-time hours (88) when employment_type is the part-time code', () => {
      expect(findPayRateMonthly(10, PART_TIME_CODE)).toBe(10 * PART_TIME_HOURS);
    });

    it('trims whitespace from employment_type before comparing', () => {
      expect(findPayRateMonthly(10, `  ${PART_TIME_CODE}  `)).toBe(
        10 * PART_TIME_HOURS,
      );
    });

    it('handles zero hourly rate', () => {
      expect(findPayRateMonthly(0, '')).toBe(0);
    });

    it('rounds to 2 decimal places', () => {
      const result = findPayRateMonthly(10.005, '');
      expect(result).toBe(Math.round(10.005 * FULL_TIME_HOURS * 100) / 100);
    });
  });

  describe('findBillRateHourly', () => {
    it('returns agreed_hourly + margin when agreed > minimum', () => {
      expect(findBillRateHourly(20, 15, 5)).toBe(25);
    });

    it('returns minimum_hourly + margin when minimum > agreed', () => {
      expect(findBillRateHourly(10, 15, 5)).toBe(20);
    });

    it('handles null minimum_hourly (treated as 0)', () => {
      expect(findBillRateHourly(20, null, 5)).toBe(25);
    });

    it('handles null margin_per_hour (treated as 0)', () => {
      expect(findBillRateHourly(20, 15, null)).toBe(20);
    });

    it('handles both null (returns agreed_hourly as-is)', () => {
      expect(findBillRateHourly(20, null, null)).toBe(20);
    });

    it('rounds to 2 decimal places', () => {
      const result = findBillRateHourly(10.005, null, 0.005);
      expect(result).toBe(Math.round((10.005 + 0.005) * 100) / 100);
    });
  });

  describe('findBillRateMonthly', () => {
    it('multiplies bill_hourly by full-time hours when not part-time', () => {
      expect(findBillRateMonthly(25, 'full-time')).toBe(25 * FULL_TIME_HOURS);
    });

    it('multiplies bill_hourly by part-time hours when part-time code', () => {
      expect(findBillRateMonthly(25, PART_TIME_CODE)).toBe(
        25 * PART_TIME_HOURS,
      );
    });

    it('handles zero bill_hourly', () => {
      expect(findBillRateMonthly(0, '')).toBe(0);
    });

    it('rounds to 2 decimal places', () => {
      const result = findBillRateMonthly(10.005, '');
      expect(result).toBe(Math.round(10.005 * FULL_TIME_HOURS * 100) / 100);
    });
  });

  describe('computeCandidateRates', () => {
    it('uses the medical floor price/margin when candidatePool is "medical"', () => {
      const configMap = buildConfigMap([makeConfig('Accountant')]);
      const candidate = makeCandidate({ hourly_pay_rate: 10 });

      const result = computeCandidateRates(candidate, configMap, 'medical');

      // effectiveBase = max(10, 15) = 15; bill_hourly = 15 + 9 = 24
      expect(result.bill_rate_hourly).toBe(24);
    });

    it('uses the non_medical floor price/margin when candidatePool is "non_medical"', () => {
      const configMap = buildConfigMap([makeConfig('Accountant')]);
      const candidate = makeCandidate({ hourly_pay_rate: 10 });

      const result = computeCandidateRates(candidate, configMap, 'non_medical');

      // effectiveBase = max(10, 12) = 12; bill_hourly = 12 + 7 = 19
      expect(result.bill_rate_hourly).toBe(19);
    });

    it('uses the bilingual floor price when the candidate has more than one language', () => {
      const configMap = buildConfigMap([makeConfig('Accountant')]);
      const candidate = makeCandidate({
        hourly_pay_rate: 10,
        languages: [{ name: 'English' }, { name: 'Spanish' }],
      });

      const result = computeCandidateRates(candidate, configMap, 'medical');

      // effectiveBase = max(10, 18) = 18; bill_hourly = 18 + 9 = 27
      expect(result.bill_rate_hourly).toBe(27);
    });

    it('does not read candidate.business_unit to decide the pool (caller-resolved)', () => {
      const configMap = buildConfigMap([makeConfig('Accountant')]);
      const candidate = makeCandidate({
        hourly_pay_rate: 10,
        business_unit: 'Berry Virtual',
      });

      const result = computeCandidateRates(candidate, configMap, 'medical');

      // Even though business_unit says "Berry Virtual", the explicit
      // candidatePool argument ('medical') must win: 15 + 9 = 24.
      expect(result.bill_rate_hourly).toBe(24);
    });

    it('falls back to the lowest-floor config for the pool when the position is unknown', () => {
      const configMap = buildConfigMap([
        makeConfig('Accountant', { medical_floor_price_english: 20 }),
        makeConfig('Nurse', { medical_floor_price_english: 15 }),
      ]);
      const candidate = makeCandidate({
        hourly_pay_rate: 10,
        approved_positions_pairing: ['Unknown Position'],
      });

      const result = computeCandidateRates(candidate, configMap, 'medical');

      // Falls back to the config with the lowest medical floor (Nurse, 15) + margin 9 = 24.
      expect(result.bill_rate_hourly).toBe(24);
    });

    it('uses the fallback config when the candidate has no approved positions', () => {
      const configMap = buildConfigMap([makeConfig('Accountant')]);
      const candidate = makeCandidate({
        hourly_pay_rate: 10,
        approved_positions_pairing: [],
      });

      const result = computeCandidateRates(candidate, configMap, 'medical');

      expect(result.bill_rate_hourly).toBe(24);
    });
  });
});
