import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, ArrayMinSize } from 'class-validator';

export class CreateFromInvoicesDto {
  @ApiProperty({
    type: [String],
    description:
      'HubspotLineItemSnapshot IDs to force-create commissions for — must already be ' +
      "match_status='matched' (i.e. already linked to a Staff/collaborator). Renamed " +
      'from invoice-level selection to per-collaborator line-item selection (per-collaborator ' +
      'commission plan §4.5) — one commission is created per collaborator payment, not per ' +
      'whole invoice.',
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  line_item_ids: string[];
}
