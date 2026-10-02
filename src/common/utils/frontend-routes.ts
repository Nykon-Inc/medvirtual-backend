/**
 * Frontend pages the backend links to from emails and notifications.
 *
 * The frontend UI lives under `/modules/**`; the legacy pages (`/hire-requests`,
 * `/tickets`, `/med-alliance/...`) were removed. Every link sent to a user must be
 * built from this map so a route change is made in one place. Append the path to
 * `process.env.FRONTEND_URL`.
 *
 * Deep-link query params the frontend reads: `hireRequests?request={id}`,
 * `adminTickets?ticket={id}`, `profile?ticket={id}`, `adminOfferPanels?panel={id}`,
 * `allianceAdminPayoutRequests?payout={id}`, `allianceAdminPipeline?company={organizationId}`.
 */
export const FRONTEND_ROUTES = {
  /** Role-aware resolver: forwards admins and clients to their own hire-requests view. */
  hireRequests: '/modules/talent/hire-requests',
  /** System roles only. */
  adminTickets: '/modules/talent/admin/tickets',
  /** Any logged-in user; organization users manage their tickets here. */
  profile: '/modules/profile',
  /** Organization roles only. */
  clientInterviewPanels: '/modules/talent/client/interview-panels',
  /** System roles only. */
  adminOfferPanels: '/modules/talent/admin/offer-panels',
  /** Hub: sends affiliates to the partner shell and super admins to the admin shell. */
  alliance: '/modules/alliance',
  /** Alliance admin shell (super admin only). */
  allianceAdminPipeline: '/modules/alliance/admin/pipeline',
  allianceAdminCommissions: '/modules/alliance/admin/commissions',
  allianceAdminPayoutRequests: '/modules/alliance/admin/payout-requests',
  allianceAdminPartners: '/modules/alliance/admin/partners',
} as const;
