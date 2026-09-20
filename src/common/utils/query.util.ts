/**
 * Normalizes a query param that Express/qs may deliver as a single string
 * (one occurrence, e.g. `?positions=A,B`) or as a string array (the key
 * repeated, e.g. `?positions=A&positions=B`) into a flat, trimmed string[].
 */
export function parseQueryList(value?: string | string[]): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];

  return values
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}
