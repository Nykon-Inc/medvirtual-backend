import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { InvoiceStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { ConfigService } from '@nestjs/config';
import { queuesEnabled } from '../common/app-config';

/**
 * Stripe → Internal invoice reconciliation.
 *
 * Runs every hour via BullMQ repeatable job.
 *
 * For every invoice that:
 *   - has a stripe_invoice_id
 *   - was created within the last 30 days
 *
 * We retrieve the corresponding Stripe invoice and apply these rules:
 *
 * | Stripe status  | Internal action                                           |
 * |----------------|-----------------------------------------------------------|
 * | void           | Mark invoice as `voided` (if not already)                 |
 * | paid           | Mark invoice as `paid`, ensure InvoicePayment record      |
 * | uncollectible  | Update stripe_status only                                 |
 * | open (overdue) | Update stripe_status to `overdue` if past due date        |
 * | draft          | Sync stripe_status only (shouldn't normally happen here)  |
 */
@Processor('invoice-reconciliation')
@Injectable()
export class InvoiceReconciliationWorker
  extends WorkerHost
  implements OnModuleInit
{
  private readonly logger = new Logger(InvoiceReconciliationWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly configService: ConfigService,
    @InjectQueue('invoice-reconciliation')
    private readonly reconciliationQueue: Queue,
  ) {
    super();
  }

  async onModuleInit() {
    if (!queuesEnabled(this.configService)) {
      this.logger.warn(
        'LOCAL mode — Stripe reconciliation recurring job NOT scheduled.',
      );
      return;
    }
    // Recurring hourly job
    await this.reconciliationQueue.add(
      'reconcile-stripe-invoices',
      {},
      {
        repeat: {
          pattern: '0 * * * *', // Top of every hour
        },
        jobId: 'reconcile-stripe-invoices-repeat',
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    // Immediate run on server start — don't wait for the first cron tick
    await this.reconciliationQueue.add(
      'reconcile-stripe-invoices',
      {},
      {
        jobId: 'reconcile-stripe-invoices-startup',
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(
      'Scheduled Stripe invoice reconciliation every hour (immediate run queued)',
    );
  }

  async process(job: Job<any, any, string>): Promise<any> {
    if (!queuesEnabled(this.configService)) {
      this.logger.warn('LOCAL mode — Stripe reconciliation job skipped.');
      return;
    }
    this.logger.log('Starting Stripe invoice reconciliation...');

    const oneMonthAgo = DateTime.now().minus({ months: 1 }).toJSDate();

    // Fetch all invoices that have a stripe_invoice_id and were created in the last month
    const invoices = await this.prisma.invoice.findMany({
      where: {
        stripe_invoice_id: { not: null },
        createdAt: { gte: oneMonthAgo },
        // Skip already-terminal statuses that will never change
        status: {
          notIn: [InvoiceStatus.voided, InvoiceStatus.cancelled],
        },
      },
      select: {
        id: true,
        reference: true,
        status: true,
        stripe_invoice_id: true,
        stripe_status: true,
      },
    });

    this.logger.log(`Found ${invoices.length} invoice(s) to reconcile`);

    let reconciled = 0;
    let errored = 0;

    for (const invoice of invoices) {
      try {
        await this.reconcileInvoice(invoice);
        reconciled++;
      } catch (err) {
        this.logger.error(
          `Failed to reconcile invoice ${invoice.id} (Stripe: ${invoice.stripe_invoice_id}): ${err.message}`,
        );
        errored++;
      }
    }

    const summary = { total: invoices.length, reconciled, errored };
    this.logger.log(`Reconciliation complete: ${JSON.stringify(summary)}`);
    return summary;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async reconcileInvoice(invoice: {
    id: string;
    reference: string | null;
    status: InvoiceStatus;
    stripe_invoice_id: string | null;
    stripe_status: string | null;
  }): Promise<void> {
    const stripeInvoiceId = invoice.stripe_invoice_id!;

    const stripeInvoice = await this.stripeService.safeStripeCall(() =>
      this.stripeService.getStripeInstance().invoices.retrieve(stripeInvoiceId),
    );

    const stripeStatus = stripeInvoice.status; // 'draft' | 'open' | 'paid' | 'uncollectible' | 'void'

    this.logger.log(
      `Invoice ${invoice.id} — internal: ${invoice.status}, stripe: ${stripeStatus}`,
    );

    switch (stripeStatus) {
      case 'void':
        await this.handleVoided(invoice, stripeInvoice);
        break;

      case 'paid':
        await this.handlePaid(invoice, stripeInvoice);
        break;

      case 'uncollectible':
        await this.handleUncollectible(invoice);
        break;

      case 'open':
        await this.handleOpen(invoice, stripeInvoice);
        break;

      default:
        // 'draft' or unknown — just keep stripe_status in sync
        if (invoice.stripe_status !== stripeStatus) {
          await this.prisma.invoice.update({
            where: { id: invoice.id },
            data: { stripe_status: stripeStatus ?? null },
          });
        }
        break;
    }
  }

  /**
   * Stripe invoice has been voided — mirror that on our side.
   */
  private async handleVoided(
    invoice: { id: string; reference: string | null; status: InvoiceStatus },
    _stripeInvoice: any,
  ): Promise<void> {
    if (invoice.status === InvoiceStatus.voided) {
      // Already voided — just ensure stripe_status is in sync
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { stripe_status: 'voided' },
      });
      return;
    }

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: InvoiceStatus.voided,
        stripe_status: 'voided',
        voidedAt: new Date(),
      },
    });

    await this.prisma.invoiceAuditLog.create({
      data: {
        invoice_id: invoice.id,
        actor_id: null,
        event: `[Reconciliation] Invoice ${invoice.reference || invoice.id} voided on Stripe — mirrored internally`,
      },
    });

    this.logger.log(`Invoice ${invoice.id} voided via reconciliation`);
  }

  /**
   * Stripe invoice is paid — mark our invoice as paid and ensure payment record exists.
   */
  private async handlePaid(
    invoice: { id: string; reference: string | null; status: InvoiceStatus },
    stripeInvoice: any,
  ): Promise<void> {
    const dataToUpdate: any = {
      stripe_status: 'paid',
      ...(stripeInvoice.number
        ? { stripe_invoice_number: stripeInvoice.number }
        : {}),
    };

    if (invoice.status !== InvoiceStatus.paid) {
      dataToUpdate.status = InvoiceStatus.paid;
    }

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: dataToUpdate,
    });

    // Upsert InvoicePayment record, keyed on provider_reference so re-running
    // reconciliation is idempotent. Prefer the payment_intent id (it's expanded
    // as an object on some API versions/webhook payloads, hence the typeof
    // check); fall back to the Stripe invoice id itself if no payment intent
    // is present (e.g. invoices paid out-of-band).
    const providerRef =
      (typeof stripeInvoice.payment_intent === 'string'
        ? stripeInvoice.payment_intent
        : stripeInvoice.id) || '';

    // Stripe amounts are in cents; convert to a decimal currency amount.
    const amountDecimal =
      (stripeInvoice.amount_paid ?? stripeInvoice.total ?? 0) / 100;

    const paidAt = stripeInvoice.status_transitions?.paid_at
      ? new Date(stripeInvoice.status_transitions.paid_at * 1000)
      : new Date();

    if (providerRef) {
      const existing = await this.prisma.invoicePayment.findFirst({
        where: { invoice_id: invoice.id, provider_reference: providerRef },
      });

      if (existing) {
        await this.prisma.invoicePayment.update({
          where: { id: existing.id },
          data: { status: 'paid', amount: amountDecimal, paid_at: paidAt },
        });
      } else {
        await this.prisma.invoicePayment.create({
          data: {
            invoice_id: invoice.id,
            provider: 'stripe',
            provider_reference: providerRef,
            amount: amountDecimal,
            status: 'paid',
            paid_at: paidAt,
          },
        });
      }
    }

    if (invoice.status !== InvoiceStatus.paid) {
      await this.prisma.invoiceAuditLog.create({
        data: {
          invoice_id: invoice.id,
          actor_id: null,
          event: `[Reconciliation] Invoice ${invoice.reference || invoice.id} marked as paid (Stripe confirmed)`,
        },
      });
      this.logger.log(
        `Invoice ${invoice.id} marked as paid via reconciliation`,
      );
    }
  }

  /**
   * Stripe marked the invoice as uncollectible — sync the stripe_status field.
   */
  private async handleUncollectible(invoice: { id: string }): Promise<void> {
    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { stripe_status: 'uncollectible' },
    });
    this.logger.log(
      `Invoice ${invoice.id} marked uncollectible via reconciliation`,
    );
  }

  /**
   * Stripe invoice is still open.
   * If it's past the due date, flag it as overdue in stripe_status.
   */
  private async handleOpen(
    invoice: { id: string; stripe_status: string | null },
    stripeInvoice: any,
  ): Promise<void> {
    const now = Date.now();
    const dueDateSeconds = stripeInvoice.due_date;

    const isOverdue = dueDateSeconds ? dueDateSeconds * 1000 < now : false;
    const newStripeStatus = isOverdue ? 'overdue' : 'open';

    if (invoice.stripe_status !== newStripeStatus) {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { stripe_status: newStripeStatus },
      });
      this.logger.log(
        `Invoice ${invoice.id} stripe_status updated to "${newStripeStatus}"`,
      );
    }
  }
}
