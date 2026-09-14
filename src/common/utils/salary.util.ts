import { getApprovedPositionLabel } from '../dictionaries/approved-positions-pairing-dictionary';

/** Minimal shape needed to resolve a candidate pool via BusinessUnitContext.poolFor. */
export interface PoolResolver {
  poolFor(hubspotValueOrSlug: string): Promise<CandidatePool | null>;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const FULL_TIME_HOURS_PER_MONTH = 176;
const PART_TIME_HOURS_PER_MONTH = 88;
const PART_TIME_EMPLOYMENT_TYPE_CODE = '1087596819';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Candidate visibility pool a business unit draws floor prices from. */
export type CandidatePool = 'medical' | 'non_medical';

/** Minimal shape needed from a PositionRateConfig record. */
export interface PositionRateConfigLike {
  medical_floor_price_english: { toNumber(): number } | number | null;
  non_medical_floor_price_english: { toNumber(): number } | number | null;
  medical_floor_price_bilingual: { toNumber(): number } | number | null;
  non_medical_floor_price_bilingual: { toNumber(): number } | number | null;
  medical_margin_per_hour: { toNumber(): number } | number | null;
  non_medical_margin_per_hour: { toNumber(): number } | number | null;
}

/** Minimal candidate shape required by computeCandidateRates. */
export interface CandidateLike {
  hourly_pay_rate: { toNumber(): number } | number | null;
  approved_positions_pairing: string[] | null;
  languages: { name: string }[];
  employment_type: string | null;
  business_unit: string | null;
}

/** Output of computeCandidateRates. */
export interface CandidateRates {
  bill_rate_hourly: number;
  bill_rate_monthly: number;
  /** @alias bill_rate_monthly — backward-compat field for existing frontend consumers. */
  salary: number;
  /** @alias bill_rate_hourly — backward-compat field for existing frontend consumers. */
  hourlySalary: number;
}

// ─── Private helpers ───────────────────────────────────────────────────────────

/** Converts a Prisma Decimal, plain number, or null → number | null. */
function toNum(
  v: { toNumber(): number } | number | null | undefined,
): number | null {
  if (v == null) return null;
  return typeof v === 'number' ? v : v.toNumber();
}

/** Returns the correct floor price field key based on candidate pool and language tier. */
function floorPriceKey(
  isBilingual: boolean,
  candidatePool: CandidatePool,
): keyof PositionRateConfigLike {
  if (isBilingual) {
    return candidatePool === 'non_medical'
      ? 'non_medical_floor_price_bilingual'
      : 'medical_floor_price_bilingual';
  }
  return candidatePool === 'non_medical'
    ? 'non_medical_floor_price_english'
    : 'medical_floor_price_english';
}

/**
 * Fallback: returns the config record with the lowest floor price for the given
 * language tier and candidate pool, scanning the entire map.
 * Used when a candidate's position is not found in the config table.
 */
function findMinFloorConfig(
  configMap: Map<string, PositionRateConfigLike>,
  isBilingual: boolean,
  candidatePool: CandidatePool,
): PositionRateConfigLike | undefined {
  const key = floorPriceKey(isBilingual, candidatePool);
  let minFloor: number | null = null;
  let minConfig: PositionRateConfigLike | undefined;

  for (const cfg of configMap.values()) {
    const floor = toNum(cfg[key] as { toNumber(): number } | number | null);
    if (floor !== null && (minFloor === null || floor < minFloor)) {
      minFloor = floor;
      minConfig = cfg;
    }
  }

  return minConfig;
}

// ─── High-level helpers ────────────────────────────────────────────────────────

/**
 * Builds an O(1) lookup map from position name → PositionRateConfig row.
 * Use this once per request/method before a .map() call.
 */
export function buildConfigMap<
  T extends PositionRateConfigLike & { position: string },
>(configs: T[]): Map<string, T> {
  return new Map(configs.map((c) => [c.position, c]));
}

/**
 * Resolves the `candidate_pool` for every distinct `business_unit` present in
 * `candidates`, in one batch — so a subsequent synchronous `.map()` calling
 * `computeCandidateRates` can look pools up without ever `await`-ing inside
 * the loop. Unknown/missing business units fall back to `'medical'`.
 */
export async function buildCandidatePoolMap(
  candidates: { business_unit: string | null }[],
  poolResolver: PoolResolver,
): Promise<Map<string, CandidatePool>> {
  const distinctBUs = Array.from(
    new Set(
      candidates.map((c) => c.business_unit).filter((bu): bu is string => !!bu),
    ),
  );
  const entries = await Promise.all(
    distinctBUs.map(
      async (bu) =>
        [bu, (await poolResolver.poolFor(bu)) ?? 'medical'] as [
          string,
          CandidatePool,
        ],
    ),
  );
  return new Map(entries);
}

export function computeCandidateRates(
  candidate: CandidateLike,
  configMap: Map<string, PositionRateConfigLike>,
  candidatePool: CandidatePool,
): CandidateRates {
  const positions = candidate.approved_positions_pairing ?? [];
  const isBilingual = (candidate.languages?.length ?? 0) > 1;
  const agreed = toNum(candidate.hourly_pay_rate) ?? 0;
  const key = floorPriceKey(isBilingual, candidatePool);
  const marginKey =
    candidatePool === 'non_medical'
      ? 'non_medical_margin_per_hour'
      : 'medical_margin_per_hour';

  let bestBillH = 0;

  if (positions.length > 0) {
    for (const rawPosition of positions) {
      const label = getApprovedPositionLabel(rawPosition);
      const config =
        configMap.get(label) ??
        findMinFloorConfig(configMap, isBilingual, candidatePool);
      const minH = toNum(
        config?.[key] as { toNumber(): number } | number | null,
      );
      const margin =
        toNum(config?.[marginKey] as { toNumber(): number } | number | null) ||
        Number(process.env.CANDIDATE_COST_PER_HOUR);
      const billH = findBillRateHourly(agreed, minH, margin);
      if (billH > bestBillH) {
        bestBillH = billH;
      }
    }
  } else {
    // No positions — use fallback config
    const config = findMinFloorConfig(configMap, isBilingual, candidatePool);
    const minH = toNum(config?.[key] as { toNumber(): number } | number | null);
    const margin =
      toNum(config?.[marginKey] as { toNumber(): number } | number | null) ||
      Number(process.env.CANDIDATE_COST_PER_HOUR);
    bestBillH = findBillRateHourly(agreed, minH, margin);
  }

  const billM = findBillRateMonthly(bestBillH, candidate.employment_type ?? '');
  const SalaryM = findPayRateMonthly(agreed, candidate.employment_type ?? '');

  return {
    bill_rate_hourly: bestBillH,
    bill_rate_monthly: billM,
    salary: SalaryM,
    hourlySalary: agreed,
  };
}

// ─── Primitive rate functions ──────────────────────────────────────────────────

/**
 * Pay Rate (monthly) — visible to admins only.
 * agreed_hourly × hours/month depending on employment type.
 */
export function findPayRateMonthly(
  agreed_hourly: number,
  employment_type: string,
): number {
  const hours =
    employment_type?.trim() === PART_TIME_EMPLOYMENT_TYPE_CODE
      ? PART_TIME_HOURS_PER_MONTH
      : FULL_TIME_HOURS_PER_MONTH;
  return Math.round(agreed_hourly * hours * 100) / 100;
}

/**
 * Bill Rate (hourly) — visible to admins and clients.
 * effective_base = max(agreed_hourly, minimum_hourly ?? 0)
 * bill_hourly = effective_base + (margin_per_hour ?? 0)
 */
export function findBillRateHourly(
  agreed_hourly: number,
  minimum_hourly: number | null,
  margin_per_hour: number | null,
): number {
  const effectiveBase = Math.max(agreed_hourly, minimum_hourly ?? 0);
  return Math.round((effectiveBase + (margin_per_hour ?? 0)) * 100) / 100;
}

/**
 * Bill Rate (monthly) — visible to admins and clients.
 * bill_hourly × hours/month depending on employment type.
 */
export function findBillRateMonthly(
  bill_hourly: number,
  employment_type: string,
): number {
  const hours =
    employment_type?.trim() === PART_TIME_EMPLOYMENT_TYPE_CODE
      ? PART_TIME_HOURS_PER_MONTH
      : FULL_TIME_HOURS_PER_MONTH;
  return Math.round(bill_hourly * hours * 100) / 100;
}

// ─── Legacy functions (still in use, kept for compatibility) ──────────────────

export function findHourlyPerRate(salary: number): number {
  return (
    salary / Number(process.env.CANDIDATE_HOUR_PER_MONTH) -
    Number(process.env.CANDIDATE_COST_PER_HOUR)
  );
}
