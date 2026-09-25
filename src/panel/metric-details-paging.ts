import { MetricDetailsQueryDto } from './dto/metric-details-query.dto';
import { MetricDetailsResponse } from './dto/metric-detail-rows.dto';

/**
 * Shared paging for the Operational Dashboard card drill-downs: DB-level
 * `skip`/`take` plus a `count` over the same `where`, or the full set when
 * `export=true` (no `meta`, same as the other `/panel/*` list endpoints).
 */
export async function paginateMetricDetails<TRecord, TRow>(
  query: MetricDetailsQueryDto,
  count: () => Promise<number>,
  findMany: (paging: { skip?: number; take?: number }) => Promise<TRecord[]>,
  toRow: (record: TRecord) => TRow,
): Promise<MetricDetailsResponse<TRow>> {
  if (query.export) {
    const records = await findMany({});
    return { data: records.map(toRow) };
  }

  const page = query.page ?? 1;
  const perPage = query.perPage ?? 10;
  const [total, records] = await Promise.all([
    count(),
    findMany({ skip: (page - 1) * perPage, take: perPage }),
  ]);

  return {
    data: records.map(toRow),
    meta: {
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      page,
      perPage,
    },
  };
}

/** Same as `paginateMetricDetails`, for rows that must be built in memory. */
export function paginateInMemory<TRow>(
  query: MetricDetailsQueryDto,
  rows: TRow[],
): { page: TRow[]; meta?: MetricDetailsResponse<TRow>['meta'] } {
  if (query.export) return { page: rows };
  const page = query.page ?? 1;
  const perPage = query.perPage ?? 10;
  const total = rows.length;
  return {
    page: rows.slice((page - 1) * perPage, page * perPage),
    meta: {
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      page,
      perPage,
    },
  };
}

export function toIso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export function displayName(
  first: string | null | undefined,
  last: string | null | undefined,
  fallback?: string | null,
): string {
  const joined = [first, last].filter(Boolean).join(' ').trim();
  return joined || fallback || '—';
}
