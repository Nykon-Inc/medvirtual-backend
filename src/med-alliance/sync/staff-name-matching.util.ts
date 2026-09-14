/**
 * Name normalization and matching helpers for StaffMatchingService.
 *
 * Real-world data shapes observed (see plan spec for full catalogue):
 *   - Staff/Deal name is never bare — it's "{Company}{separator}{Name}{optional suffix}"
 *     with a "|" or " - " separator, a "(n)" VA-counter suffix, or a duplicated surname.
 *   - Line item name is comparatively clean but can carry stray whitespace/newlines.
 * Exact string comparison never matches this data — both sides must be normalized
 * and compared by token overlap, not literal equality.
 */

/** Strips a leading "{Company} | " or "{Company} - " prefix from a HubSpot deal name. */
export function stripCompanyPrefix(dealName: string): string {
  const separators = [' | ', ' - '];
  let result = dealName;
  for (const sep of separators) {
    const lastIndex = result.lastIndexOf(sep);
    if (lastIndex !== -1) {
      result = result.slice(lastIndex + sep.length);
    }
  }
  return result;
}

/** Strips a trailing "(n)" VA-counter suffix, e.g. "Maria Cielo Danao (2)" → "Maria Cielo Danao". */
export function stripCounterSuffix(name: string): string {
  return name.replace(/\s*\(\d+\)\s*$/, '');
}

/** Strips middle-initial punctuation, e.g. "Dharyll Mae C. Vicente" → "Dharyll Mae Vicente". */
export function stripMiddleInitials(name: string): string {
  return name.replace(/\b[A-Z]\.\s*/g, '');
}

/** Collapses an immediately-repeated surname token, e.g. "Maglasang Maglasang" → "Maglasang". */
export function collapseDuplicateTokens(name: string): string {
  const tokens = name.split(/\s+/).filter(Boolean);
  const result: string[] = [];
  for (const token of tokens) {
    const prev = result[result.length - 1];
    if (prev && prev.toLowerCase() === token.toLowerCase()) continue;
    result.push(token);
  }
  return result.join(' ');
}

/** Full normalization pipeline for a Deal/Staff-side name (no structured Candidate name available). */
export function extractNameFromDealName(dealName: string): string {
  let name = stripCompanyPrefix(dealName);
  name = stripCounterSuffix(name);
  name = stripMiddleInitials(name);
  name = collapseDuplicateTokens(name);
  return normalizeForComparison(name);
}

/** Normalizes any name for comparison: trim, collapse whitespace, lowercase, strip accents. */
export function normalizeForComparison(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function tokenize(normalizedName: string): string[] {
  return normalizedName.split(' ').filter(Boolean);
}

/**
 * Levenshtein distance, used as a string-similarity tie-breaker alongside token overlap.
 * Not the sole match criterion — real data has too much prefix/suffix noise for edit
 * distance alone to be reliable.
 */
function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[a.length][b.length];
}

function similarityScore(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

export interface NameMatchScore {
  /** Ratio of the smaller token set contained in the larger one (0-1). */
  tokenOverlap: number;
  /** Levenshtein-based string similarity on the normalized full strings (0-1). */
  stringSimilarity: number;
  /** Combined score used to rank candidates — weighted average, token overlap dominant. */
  combined: number;
}

/**
 * Scores how well a (normalized) line-item name matches a (normalized) staff name.
 * Token overlap is computed with a 1-token tolerance to absorb a middle initial or
 * counter suffix that normalization didn't fully strip.
 */
export function scoreNameMatch(
  lineItemNormalized: string,
  staffNormalized: string,
): NameMatchScore {
  const lineTokens = new Set(tokenize(lineItemNormalized));
  const staffTokens = new Set(tokenize(staffNormalized));

  const intersection = [...lineTokens].filter((t) => staffTokens.has(t)).length;
  const smallerSize = Math.min(lineTokens.size, staffTokens.size) || 1;
  const tokenOverlap = intersection / smallerSize;

  const stringSimilarity = similarityScore(lineItemNormalized, staffNormalized);

  return {
    tokenOverlap,
    stringSimilarity,
    combined: tokenOverlap * 0.7 + stringSimilarity * 0.3,
  };
}

/** A match is considered "strong" (safe to auto-approve) above this combined score. */
export const STRONG_MATCH_THRESHOLD = 0.75;
/** Below this combined score, a candidate is not considered a match at all. */
export const MIN_MATCH_THRESHOLD = 0.5;
