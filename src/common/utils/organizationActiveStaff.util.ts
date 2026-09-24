import { PrismaService } from '../../prisma/prisma.service';

/**
 * Status values that count as "active" staff for pairing-type classification.
 * Mirrors the criteria already used by offer-panels.service.ts::acceptByClientUser
 * (the only call site that computed this correctly before this util existed).
 */
export const ACTIVE_STAFF_STATUS_FILTER = {
  status: { notIn: ['terminated', 'inactive'] as string[] },
  terminated_date: null,
};

/**
 * Returns true if the organization has at least one Staff row that is not
 * terminated/inactive. Uses Staff.organization_id directly — does NOT follow
 * the indirect Staff.hirerequest_id -> HireRequest.org_id path, to keep a
 * single consistent definition of "org has active staff" system-wide.
 */
export async function hasActiveStaff(
  prisma: PrismaService,
  organizationId: string | null | undefined,
): Promise<boolean> {
  if (!organizationId) return false;
  const count = await prisma.staff.count({
    where: {
      organization_id: organizationId,
      ...ACTIVE_STAFF_STATUS_FILTER,
    },
  });
  return count > 0;
}

/**
 * Given the requested/persisted pairing type and whether the org has active
 * staff, returns the pairing type that should actually be used/persisted.
 * 'Upsell Agent' is only valid when the org has at least one active staff;
 * otherwise it is downgraded to null (treated as a regular hire request).
 * 'Agent Replacement' and any other value pass through unchanged — this
 * safeguard is specific to the Upsell/"UPS" misclassification bug.
 */
export function resolvePairingRequestType(
  requestedType: string | null | undefined,
  orgHasActiveStaff: boolean,
): string | null {
  if (requestedType === 'Upsell Agent' && !orgHasActiveStaff) {
    return null;
  }
  return requestedType ?? null;
}

/** True when applying resolvePairingRequestType actually downgraded 'Upsell Agent' to null. */
export function isPairingTypeDowngraded(
  requestedType: string | null | undefined,
  resolvedType: string | null,
): boolean {
  return requestedType === 'Upsell Agent' && resolvedType === null;
}
