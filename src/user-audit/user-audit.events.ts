/**
 * USER lifecycle events. Kept as a const union rather than a Prisma enum so new events do not
 * require a migration — see the UserAuditLog model comment in schema.prisma.
 */
export const USER_AUDIT_EVENTS = {
  CREATED: 'created',
  INVITED: 'invited',
  INVITE_RESENT: 'invite_resent',
  INVITE_ACCEPTED: 'invite_accepted',
  EMAIL_VERIFIED: 'email_verified',
  VERIFICATION_CODE_RESENT: 'verification_code_resent',
  LOGIN_SUCCEEDED: 'login_succeeded',
  LOGIN_FAILED: 'login_failed',
  LOGOUT: 'logout',
  PASSWORD_RESET_REQUESTED: 'password_reset_requested',
  PASSWORD_RESET_COMPLETED: 'password_reset_completed',
  PASSWORD_CHANGED: 'password_changed',
  PROFILE_UPDATED: 'profile_updated',
  EMAIL_CHANGED: 'email_changed',
  ROLE_CHANGED: 'role_changed',
  STATUS_CHANGED: 'status_changed',
  ORGANIZATION_CHANGED: 'organization_changed',
  AFFILIATE_PROFILE_CHANGED: 'affiliate_profile_changed',
  HUBSPOT_LINK_CHANGED: 'hubspot_link_changed',
  DEACTIVATED: 'deactivated',
  REACTIVATED: 'reactivated',
  DELETED: 'deleted',
  INVITE_EXPIRED_DELETED: 'invite_expired_deleted',
} as const;

export type UserAuditEvent =
  (typeof USER_AUDIT_EVENTS)[keyof typeof USER_AUDIT_EVENTS];
