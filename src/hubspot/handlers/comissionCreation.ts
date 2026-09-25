import { BadRequestException, Injectable } from '@nestjs/common';
import { InvoicePaidCommissionService } from '../../med-alliance/sync/invoice-paid-commission.service';

@Injectable()
export class HandlerComissionCreation {
  constructor(private readonly invoicePaid: InvoicePaidCommissionService) {}

  /**
   * Called by HandlerInvoicePropertyChange when hs_invoice_status transitions to 'paid'.
   * This is the live, real-time commission-creation path — invoices normally reach "paid"
   * via this webhook, so it may fire more often in practice than the periodic sync
   * (CommissionDetectionService). The per-collaborator logic itself lives in
   * InvoicePaidCommissionService, shared with internal (Stripe/Hubstaff) invoices.
   */
  async execute(event) {
    try {
      return await this.invoicePaid.createCommissionsForPaidSnapshot(
        { hubspot_id: String(event.objectId) },
        String(event.objectId),
      );
    } catch (error) {
      console.error(`❌ Error creating comission ${event.objectId}`);
      console.error('Status:', error.response?.status);
      console.error('Data:', error.response?.data);
      console.error('Message:', error.message);
      throw new BadRequestException(
        `Error creating comission: ${error.message}`,
      );
    }
  }
}
