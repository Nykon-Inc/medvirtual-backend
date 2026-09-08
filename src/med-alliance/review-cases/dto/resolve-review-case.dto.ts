import { IsIn, IsOptional, IsString } from 'class-validator';

export class ResolveReviewCaseDto {
  @IsString()
  resolution: string;

  /**
   * For multiple_hubspot_matches: admin provides the correct HubSpot company ID
   * so the org can be synced and the pipeline can continue.
   */
  @IsOptional()
  @IsString()
  hubspot_company_id?: string;

  /**
   * For reconciliation_invoice_changed:
   * - void_and_recreate: void the existing commission and allow re-detection on next sync
   * - keep_existing: close the case, commission remains as-is
   * For unmatched_line_item / ambiguous_line_item:
   * - manual_link: admin picked the correct Staff (see staff_id below)
   * - not_applicable: this line item is not a collaborator payment (fee, discount, etc.)
   */
  @IsOptional()
  @IsIn(['void_and_recreate', 'keep_existing', 'manual_link', 'not_applicable'])
  action?: 'void_and_recreate' | 'keep_existing' | 'manual_link' | 'not_applicable';

  /**
   * For unmatched_line_item / ambiguous_line_item + action=manual_link:
   * the Staff id the admin picked, scoped to the case's organization.
   */
  @IsOptional()
  @IsString()
  staff_id?: string;
}
