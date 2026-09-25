export const PAYOUT_REQUEST_SELECT = {
  id: true,
  affiliate_id: true,
  affiliate_profile_id: true,
  status: true,
  requested_amount: true,
  approved_amount: true,
  paid_amount: true,
  payment_method: true,
  payment_reference: true,
  transaction_reference: true,
  payment_proof_notes: true,
  approved_by: true,
  approved_at: true,
  reviewed_by: true,
  reviewed_at: true,
  paid_at: true,
  rejection_reason: true,
  cancellation_reason: true,
  cancelled_by: true,
  cancelled_at: true,
  bill_com_payment_id: true,
  bill_com_status: true,
  bill_com_error: true,
  bill_com_paymentStatus: true,
  bill_com_billId: true,
  createdAt: true,
  updatedAt: true,
  commissions: {
    select: {
      commission: {
        select: {
          id: true,
          commission_amount: true,
          base_amount_snapshot: true,
          commission_percent_snapshot: true,
          status: true,
          admin_decision_reason: true,
          createdAt: true,
          organization: { select: { id: true, name: true } },
          hubspotInvoiceSnapshot: {
            select: {
              id: true,
              invoice_amount: true,
              invoice_status: true,
              invoice_number: true,
              source: true,
              hubspot_id: true,
              internal_invoice_id: true,
              currency: true,
              paid_at: true,
              hubspot_pdf_link: true,
            },
          },
        },
      },
    },
  },
};

export const ADMIN_SELECT = {
  ...PAYOUT_REQUEST_SELECT,
  affiliate: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      email: true,
    },
  },
  affiliateProfile: {
    select: {
      id: true,
      payout_details: true,
      payout_preference_method: true,
      payout_preference_reference: true,
      payout_preference_notes: true,
      createdAt: true,
      contact: {
        select: { hubspot_billcom_vendor_id: true },
      },
      user: {
        select: {
          contact: {
            select: {
              hubspot_billcom_vendor_id: true,
            },
          },
        },
      },
    },
  },
  approvedBy: {
    select: { id: true, first_name: true, last_name: true },
  },
  reviewedBy: {
    select: { id: true, first_name: true, last_name: true },
  },
};

function mapCommissionStatus(status: string): string {
  switch (status) {
    case 'paid':
      return 'approved_for_payout';
    case 'requested':
      return 'pending_review';
    case 'eligible':
      return 'pending_review';
    case 'rejected':
      return 'rejected_for_payout';
    default:
      return 'pending_review';
  }
}

const AGING_DAYS = 14;

function computeRiskFlags(
  request: {
    createdAt: Date;
    affiliateProfile?: { banking_complete: boolean } | null;
    affiliate_id: string;
  },
  allRequestedIds: Set<string>,
): {
  has_duplicate_risk: boolean;
  has_missing_banking: boolean;
  is_aging: boolean;
} {
  const ageMs = Date.now() - new Date(request.createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  return {
    has_duplicate_risk: allRequestedIds.has(request.affiliate_id),
    has_missing_banking: !(request.affiliateProfile?.banking_complete ?? true),
    is_aging: ageDays > AGING_DAYS,
  };
}

export function shapeAdminRequest(raw: any, allRequestedIds?: Set<string>) {
  const flags = computeRiskFlags(raw, allRequestedIds ?? new Set());
  return {
    ...raw,
    affiliateProfile: raw.affiliateProfile
      ? {
          ...raw.affiliateProfile,
          payout_details: {
            ...raw.affiliateProfile.payout_details,
            vendorId:
              raw.affiliateProfile.contact?.hubspot_billcom_vendor_id ??
              raw.affiliateProfile.user?.contact?.hubspot_billcom_vendor_id ??
              undefined,
          },
        }
      : raw.affiliateProfile,
    affiliate_name: raw.affiliate
      ? `${raw.affiliate.first_name} ${raw.affiliate.last_name}`.trim()
      : undefined,
    affiliate_email: raw.affiliate?.email ?? undefined,
    commissions: (raw.commissions ?? []).map((c: any) => ({
      id: c.commission.id,
      organization_id: c.commission.organization?.id ?? null,
      organization_name: c.commission.organization?.name ?? null,
      base_amount: parseFloat(c.commission.base_amount_snapshot ?? '0'),
      commission_percentage: parseFloat(
        c.commission.commission_percent_snapshot ?? '0',
      ),
      commission_amount: parseFloat(c.commission.commission_amount ?? '0'),
      decision: mapCommissionStatus(c.commission.status),
      rejection_reason: c.commission.admin_decision_reason ?? null,
      invoice_status:
        c.commission.hubspotInvoiceSnapshot?.invoice_status ?? null,
      invoice_amount: parseFloat(
        String(c.commission.hubspotInvoiceSnapshot?.invoice_amount ?? '0'),
      ),
      invoice_number:
        c.commission.hubspotInvoiceSnapshot?.invoice_number ?? null,
      invoice_hubspot_id:
        c.commission.hubspotInvoiceSnapshot?.hubspot_id ?? null,
      invoice_source: c.commission.hubspotInvoiceSnapshot?.source ?? null,
      invoice_internal_id:
        c.commission.hubspotInvoiceSnapshot?.internal_invoice_id ?? null,
      invoice_currency: c.commission.hubspotInvoiceSnapshot?.currency ?? null,
      invoice_paid_at: c.commission.hubspotInvoiceSnapshot?.paid_at ?? null,
      invoice_pdf_link:
        c.commission.hubspotInvoiceSnapshot?.hubspot_pdf_link ?? null,
      created_at: c.commission.createdAt ?? null,
    })),
    requested_amount: parseFloat(raw.requested_amount ?? '0'),
    approved_amount: raw.approved_amount
      ? parseFloat(raw.approved_amount)
      : null,
    paid_amount: raw.paid_amount ? parseFloat(raw.paid_amount) : null,
    requested_at: raw.createdAt,
    updated_at: raw.updatedAt,
    ...flags,
  };
}
