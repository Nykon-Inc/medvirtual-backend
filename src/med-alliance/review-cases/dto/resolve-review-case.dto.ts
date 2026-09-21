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
   * For invoice_reassociated_in_hubspot:
   * - reassociate_and_void: reassign the snapshot to the new organization and void the
   *   commission still attached to the old organization
   * - reassociate_keep_commission: reassign the snapshot to the new organization but leave
   *   the existing commission untouched
   * - keep_existing: close the case, snapshot stays on the old organization
   */
  @IsOptional()
  @IsIn([
    'void_and_recreate',
    'keep_existing',
    'manual_link',
    'not_applicable',
    'reassociate_and_void',
    'reassociate_keep_commission',
  ])
  action?:
    | 'void_and_recreate'
    | 'keep_existing'
    | 'manual_link'
    | 'not_applicable'
    | 'reassociate_and_void'
    | 'reassociate_keep_commission';

  /**
   * For unmatched_line_item / ambiguous_line_item + action=manual_link:
   * the Staff id the admin picked, scoped to the case's organization.
   */
  @IsOptional()
  @IsString()
  staff_id?: string;
}
