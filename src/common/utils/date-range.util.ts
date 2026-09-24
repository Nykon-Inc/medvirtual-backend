/**
 * Builds an inclusive date filter from `YYYY-MM-DD` bounds, as used by the
 * operational dashboard: `dateFrom` starts at 00:00:00.000 UTC and `dateTo`
 * ends at 23:59:59.999 UTC. Either bound may be omitted. Returns undefined
 * when neither is provided.
 */
export function buildInclusiveDateRange(
  dateFrom?: string,
  dateTo?: string,
): { gte?: Date; lte?: Date } | undefined {
  const range: { gte?: Date; lte?: Date } = {};
  if (dateFrom) range.gte = new Date(dateFrom);
  if (dateTo) range.lte = new Date(`${dateTo}T23:59:59.999Z`);
  return Object.keys(range).length > 0 ? range : undefined;
}
