import { USER } from '@prisma/client';

/**
 * Builds the denormalized actor label stored on audit rows. USER has no `name` column, so the
 * display name is composed from first/last name with the email as fallback.
 */
export function buildActorLabel(
  user?: Pick<USER, 'first_name' | 'last_name' | 'email'> | null,
): string | null {
  if (!user) return null;
  const full = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim();
  return full || user.email || null;
}
