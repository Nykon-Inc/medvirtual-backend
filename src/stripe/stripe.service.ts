import {
  Inject,
  Injectable,
  OnModuleInit,
  Logger,
  BadRequestException,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretsService } from '../secrets/secrets.service';
import Stripe = require('stripe');
import { PrismaService } from '../prisma/prisma.service';
import { Stripe as StripeCore } from 'stripe/cjs/stripe.core';
import * as redis from 'redis';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DateTime } from 'luxon';
import {
  isProduction,
  keyPrefix,
  queuesEnabled,
  webhookServerLabel,
} from '../common/app-config';
import { PusherService } from '../pusher/pusher.service';
import { InvoiceService } from '../invoice/invoice.service';

/**
 * All direct integration with the Stripe API for the invoicing feature. InvoiceService
 * calls into this class to push an approved invoice through Stripe's own invoice
 * lifecycle (create -> attach items -> finalize); this class also owns the inbound
 * webhook handler that syncs Stripe-side payment events back onto our Invoice rows,
 * and the self-service payment-method endpoints (setup intents, saved cards) used by
 * the client billing portal.
 *
 * Environment-aware key loading: pulls from AWS Secrets Manager in prod, plain env vars
 * elsewhere (see initializeStripe). Registers/rotates its own Stripe webhook endpoint on
 * boot (see initiateWebhookHandler) rather than requiring one to be configured manually
 * per environment.
 */
@Injectable()
export class StripeService implements OnModuleInit {
  private stripe: StripeCore;
  private secretKey: string;
  private publicKey: string;
  private readonly logger = new Logger(StripeService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly secretsService: SecretsService,
    @Inject('REDIS_CLIENT') private readonly redisClient: redis.RedisClientType,
    private readonly prisma: PrismaService,
    private readonly pusherService: PusherService,
    @Optional()
    @InjectQueue('invoice')
    private readonly invoiceQueue: Queue | null,
    @Optional()
    @InjectQueue('invoice-prebill-reconciliation')
    private readonly prebillReconQueue: Queue | null,
    // forwardRef because InvoiceService also depends on StripeService (publish flow) —
    // this breaks the circular DI dependency between the two modules.
    @Inject(forwardRef(() => InvoiceService))
    private readonly invoiceService: InvoiceService,
  ) {}

  async onModuleInit() {
    await this.initializeStripe();
    try {
      await this.initiateWebhookHandler();
    } catch (err) {
      // Don't crash app boot if webhook registration fails (e.g. missing WEBHOOK_URL in
      // a local/dev environment) — Stripe features just won't receive live events.
      this.logger.error(
        `Failed to initiate webhook handler on startup: ${err.message}`,
      );
    }
  }

  /**
   * Loads Stripe API keys appropriate to the running environment: AWS Secrets Manager
   * when APP_ENV is 'production', plain env vars everywhere else. Leaves `this.stripe`
   * unset if no key is found, rather than throwing — callers check for that via
   * getStripeInstance()/the various "Stripe is not initialized" guards.
   */
  private async initializeStripe(): Promise<void> {
    let secretKey = '';
    let publicKey = '';

    if (isProduction(this.configService)) {
      this.logger.log('Fetching Stripe keys from AWS Secrets Manager...');
      const stripeKeys =
        await this.secretsService.getSecret('prod/stripe/key01');
      if (stripeKeys) {
        secretKey = stripeKeys.stripe_secret_key || stripeKeys.secret_key || '';
        publicKey = stripeKeys.stripe_public_key || stripeKeys.public_key || '';
      }
    } else {
      this.logger.log('Fetching Stripe keys from Environment config...');
      secretKey = this.configService.get<string>('STRIPE_SECRET_KEY') || '';
      publicKey = this.configService.get<string>('STRIPE_PUBLIC_KEY') || '';
    }

    this.secretKey = secretKey;
    this.publicKey = publicKey;

    if (!this.secretKey) {
      this.logger.error(
        'Stripe Secret Key is missing or empty. Stripe initialization aborted.',
      );
      return;
    }

    // Initialize Stripe client
    this.stripe = new Stripe(this.secretKey);
    this.logger.log('Stripe client initialized successfully.');
  }

  public getStripeInstance(): StripeCore {
    return this.stripe;
  }

  public getPublicKey(): string {
    return this.publicKey;
  }

  /**
   * Self-registers (or re-registers) this environment's Stripe webhook endpoint on
   * every boot, rather than requiring a human to configure it once in the Stripe
   * dashboard. Idempotent: if a correctly-configured endpoint for this exact URL and
   * event set already exists (and its signing secret is cached in Redis), it's left
   * alone; otherwise it's deleted and recreated to get a fresh signing secret. Also
   * cleans up stale endpoints left behind by this same environment pointing at an old
   * URL (e.g. after an ngrok/staging URL changes).
   */
  public async initiateWebhookHandler() {
    if (!this.stripe) {
      this.logger.warn('Stripe is not initialized. Skipping webhook setup.');
      return;
    }

    // Signing secret is cached in Redis (not env vars) since it's generated dynamically
    // by Stripe each time the webhook endpoint is (re)created below.
    const secretKey = `${keyPrefix(this.configService)}stripe_webhook_secret`;
    const server = webhookServerLabel(this.configService);

    const webhookBaseUrl = this.configService.get<string>('WEBHOOK_URL') || '';
    if (!webhookBaseUrl) {
      this.logger.warn(
        'WEBHOOK_URL is not configured. Skipping webhook setup.',
      );
      return;
    }
    const webhookUrl = `${webhookBaseUrl}/webhooks/stripe`;

    this.logger.log(
      `initiateWebhookHandler: Target URL=${webhookUrl}, Server=${server}`,
    );

    // The full set of Stripe event types this environment's endpoint subscribes to —
    // see webhookHandler's switch statement below for what each one does. Kept as an
    // explicit allowlist (rather than "all events") to keep the webhook payload volume
    // and the surface area of webhookHandler's switch statement bounded.
    const REQUIRED_EVENTS: StripeCore.WebhookEndpointCreateParams.EnabledEvent[] =
      [
        'customer.created',
        'invoice.paid',
        'invoice.overdue',
        'invoice.voided',
        'invoice.finalized',
        'payment_intent.succeeded',
        'invoice.payment_failed',
        'payment_method.attached',
        'checkout.session.completed',
      ];

    try {
      const list = await this.stripe.webhookEndpoints.list({ limit: 100 });
      let existingWebhook: any = null;

      // Clean up endpoints for the same server with different URLs, and check if target already exists
      for (const item of list.data) {
        const itemServer = item.metadata?.server;
        if (itemServer === server) {
          if (item.url === webhookUrl) {
            existingWebhook = item;
          } else {
            // Delete old/different webhook URL for the same environment
            this.logger.log(
              `Deleting obsolete webhook endpoint for server ${server}: ${item.url}`,
            );
            await this.stripe.webhookEndpoints.del(item.id);
          }
        }
      }

      if (existingWebhook) {
        // Check if status is enabled, events match exactly, and we have the secret in Redis
        const redisSecret = await this.redisClient.get(secretKey);

        const enabledEvents = existingWebhook.enabled_events || [];
        const eventsMatch =
          enabledEvents.length === REQUIRED_EVENTS.length &&
          enabledEvents.every((e: string) =>
            (REQUIRED_EVENTS as string[]).includes(e),
          );

        if (
          existingWebhook.status === 'enabled' &&
          eventsMatch &&
          redisSecret
        ) {
          this.logger.log(
            `Stripe webhook for URL ${webhookUrl} already exists and is correctly configured. Skipping creation.`,
          );
          return existingWebhook;
        }

        // Otherwise, delete the existing one and recreate it to get a new secret and correct config
        this.logger.log(
          `Existing webhook for ${webhookUrl} is misconfigured or lacks Redis secret. Re-creating...`,
        );
        await this.stripe.webhookEndpoints.del(existingWebhook.id);
      }

      // Create new webhook
      this.logger.log(
        `Creating new Stripe webhook endpoint for URL: ${webhookUrl}`,
      );
      const newWebhook = await this.stripe.webhookEndpoints.create({
        url: webhookUrl,
        enabled_events: REQUIRED_EVENTS,
        metadata: {
          server,
        },
      });

      if (newWebhook && newWebhook.secret) {
        await this.redisClient.set(secretKey, newWebhook.secret);
        this.logger.log(
          `Stored Stripe webhook signing secret in Redis under key: ${secretKey}`,
        );
      }

      return newWebhook;
    } catch (err) {
      this.logger.error(
        `Failed to handle Stripe webhook setup: ${err.message}`,
      );
      throw err;
    }
  }

  /**
   * Entry point for the /webhooks/stripe controller route. Verifies the request really
   * came from Stripe (constructEvent validates the signature against our stored
   * secret — this is the only thing standing between this endpoint and anyone on the
   * internet POSTing fake "invoice paid" events), then dispatches to webhookHandler.
   */
  public async handleWebhook(rawBody: string | Buffer, signature: string) {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not initialized');
    }

    const redisSecretKey = `${keyPrefix(this.configService)}stripe_webhook_secret`;

    let webhookSecret = await this.redisClient.get(redisSecretKey);
    if (!webhookSecret) {
      this.logger.warn(
        `Webhook secret not found in Redis for key "${redisSecretKey}". Checking environment config.`,
      );
      webhookSecret =
        this.configService.get<string>('STRIPE_SIGNING_SECRET') || '';
    }

    if (!webhookSecret) {
      throw new BadRequestException(
        'Webhook signing secret is not configured.',
      );
    }

    let event: StripeCore.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch (err) {
      this.logger.error(
        `Webhook signature verification failed: ${err.message}`,
      );
      throw new BadRequestException(`Webhook Error: ${err.message}`);
    }

    await this.webhookHandler(event);
    return { received: true };
  }

  /**
   * Dispatches a verified Stripe event to the appropriate handling logic. This is
   * where Stripe's state (an invoice got paid, a card was attached, a checkout
   * completed) gets mirrored back onto our own Invoice/USER/InvoiceAuditLog rows —
   * webhooks are the *only* path by which async, client-side-initiated Stripe actions
   * (like the client paying an invoice on their own) become visible to our system.
   */
  public async webhookHandler(event: StripeCore.Event) {
    this.logger.log(`Received Stripe event of type: ${event.type}`);
    if (event) {
      switch (event.type) {
        case 'customer.created':
          // leave blank for now
          break;
        case 'payment_intent.succeeded': {
          // Special case: a $1 PaymentIntent tagged with metadata.refund is a card
          // verification charge (used when saving a new payment method / setup flow,
          // not a real payment) — auto-refund it immediately rather than actually
          // charging the client a dollar for adding a card.
          const paymentIntent = event.data.object as any;
          if (
            paymentIntent.metadata?.refund === 'true' &&
            paymentIntent.amount === 100
          ) {
            try {
              this.logger.log(
                `Refunding $1 setup fee for PaymentIntent: ${paymentIntent.id}`,
              );
              await this.safeStripeCall(() =>
                this.stripe.refunds.create({
                  payment_intent: paymentIntent.id,
                }),
              );
            } catch (err) {
              this.logger.error(
                `Failed to refund setup fee for PaymentIntent ${paymentIntent.id}: ${err.message}`,
              );
            }
          }
          break;
        }
        case 'invoice.paid': {
          // The primary event this whole webhook system exists for: a client paid
          // their Stripe invoice (via the hosted payment page or portal), and we need
          // to mark our own Invoice as paid, log it, record the InvoicePayment, and
          // kick off prebill reconciliation if applicable — none of which our own API
          // would otherwise know to do, since the payment happened entirely on Stripe's
          // side.
          this.logger.log(`Handling invoice.paid for Stripe ID: ${event.id}`);
          const paidInvoice = event.data.object as any;
          const internalInvoice = await this.prisma.invoice.findUnique({
            where: { stripe_invoice_id: paidInvoice.id },
          });

          if (internalInvoice) {
            await this.prisma.invoice.update({
              where: { id: internalInvoice.id },
              data: {
                status: 'paid',
                stripe_status: 'paid',
                ...(paidInvoice.number
                  ? { stripe_invoice_number: paidInvoice.number }
                  : {}),
              },
            });

            const authorId =
              (paidInvoice.metadata?.authorId as string) || 'system';
            let actorId: string | null = null;
            if (authorId && authorId !== 'system') {
              const userExists = await this.prisma.uSER.findUnique({
                where: { id: authorId },
              });
              if (userExists) {
                actorId = authorId;
              }
            }

            await this.prisma.invoiceAuditLog.create({
              data: {
                invoice_id: internalInvoice.id,
                actor_id: actorId,
                event: `Invoice ${internalInvoice.reference || internalInvoice.id} has been marked as paid`,
              },
            });

            const providerRef =
              (typeof paidInvoice.payment_intent === 'string'
                ? paidInvoice.payment_intent
                : paidInvoice.id) || '';

            // Stripe amounts are always integer cents — convert to dollars for storage.
            const amountDecimal =
              (paidInvoice.amount_paid ?? paidInvoice.total ?? 0) / 100;
            const paidAt = paidInvoice.status_transitions?.paid_at
              ? new Date(paidInvoice.status_transitions.paid_at * 1000)
              : new Date();

            // Webhooks can be delivered more than once for the same event (Stripe's own
            // at-least-once delivery guarantee) — upsert on provider_reference instead
            // of always inserting, so a redelivered event updates the existing
            // InvoicePayment row rather than creating a duplicate.
            const existingPayment = providerRef
              ? await this.prisma.invoicePayment.findFirst({
                  where: {
                    invoice_id: internalInvoice.id,
                    provider_reference: providerRef,
                  },
                })
              : null;

            if (existingPayment) {
              await this.prisma.invoicePayment.update({
                where: { id: existingPayment.id },
                data: {
                  status: 'paid',
                  amount: amountDecimal,
                  paid_at: paidAt,
                },
              });
            } else {
              await this.prisma.invoicePayment.create({
                data: {
                  invoice_id: internalInvoice.id,
                  provider: 'stripe',
                  provider_reference: providerRef,
                  amount: amountDecimal,
                  status: 'paid',
                  paid_at: paidAt,
                },
              });
            }

            // Schedule prebill reconciliation if this was a pre-billed invoice
            await this.schedulePrebillReconciliationIfNeeded(
              internalInvoice.id,
            );

            // Send invoice email to organization superadmin
            try {
              await this.invoiceService.sendInvoiceToSuperadmin(
                internalInvoice.id,
              );
            } catch (err) {
              this.logger.error(
                `Failed to send invoice email to superadmin: ${err.message}`,
                err.stack,
              );
            }
          }
          break;
        }
        case 'invoice.overdue':
          // leave blank for now
          break;
        case 'invoice.payment_failed': {
          // Mirrors the invoice.paid handler's shape, but records a failed InvoicePayment
          // and does NOT flip our Invoice.status — a failed payment attempt leaves the
          // invoice exactly where it was (still owed), it just gives visibility into the
          // attempt and re-notifies the client to try again.
          this.logger.log(
            `Handling invoice.payment_failed for Stripe ID: ${event.id}`,
          );
          const failedInvoice = event.data.object as any;
          const internalInvoice = await this.prisma.invoice.findUnique({
            where: { stripe_invoice_id: failedInvoice.id },
          });

          if (internalInvoice) {
            await this.prisma.invoice.update({
              where: { id: internalInvoice.id },
              data: {
                stripe_status: 'payment_failed',
              },
            });

            const authorId =
              (failedInvoice.metadata?.authorId as string) || 'system';
            let actorId: string | null = null;
            if (authorId && authorId !== 'system') {
              const userExists = await this.prisma.uSER.findUnique({
                where: { id: authorId },
              });
              if (userExists) {
                actorId = authorId;
              }
            }

            await this.prisma.invoiceAuditLog.create({
              data: {
                invoice_id: internalInvoice.id,
                actor_id: actorId,
                event: `Failed to pay for Invoice ${internalInvoice.reference || internalInvoice.id}`,
              },
            });

            const providerRef =
              (typeof failedInvoice.payment_intent === 'string'
                ? failedInvoice.payment_intent
                : failedInvoice.id) || '';

            const amountDecimal =
              (failedInvoice.amount_due ?? failedInvoice.total ?? 0) / 100;

            const existingPayment = providerRef
              ? await this.prisma.invoicePayment.findFirst({
                  where: {
                    invoice_id: internalInvoice.id,
                    provider_reference: providerRef,
                  },
                })
              : null;

            if (existingPayment) {
              await this.prisma.invoicePayment.update({
                where: { id: existingPayment.id },
                data: {
                  status: 'failed',
                  amount: amountDecimal,
                },
              });
            } else {
              await this.prisma.invoicePayment.create({
                data: {
                  invoice_id: internalInvoice.id,
                  provider: 'stripe',
                  provider_reference: providerRef,
                  amount: amountDecimal,
                  status: 'failed',
                },
              });
            }

            // Send invoice email to organization superadmin
            try {
              await this.invoiceService.sendInvoiceToSuperadmin(
                internalInvoice.id,
              );
            } catch (err) {
              this.logger.error(
                `Failed to send invoice email to superadmin: ${err.message}`,
                err.stack,
              );
            }
          }
          break;
        }
        case 'payment_method.attached':
          // leave blank for now
          break;
        case 'invoice.voided':
          break;
        case 'invoice.finalized': {
          // Stripe finalizing an invoice is the trigger for OUR invoice to become
          // `published` — note this is the async confirmation of the same finalize
          // step that InvoiceService.updateStatus already triggered synchronously via
          // finalizeStripeInvoice; this handler is what actually flips our status once
          // Stripe confirms it (rather than assuming success from the API call alone).
          this.logger.log(
            `Handling invoice.finalized for Stripe ID: ${event.id}`,
          );
          const finalizedInvoice = event.data.object as StripeCore.Invoice;
          const internalInvoice = await this.prisma.invoice.findUnique({
            where: { stripe_invoice_id: finalizedInvoice.id },
          });

          if (internalInvoice) {
            // 1. Update status to published in internal DB
            await this.prisma.invoice.update({
              where: { id: internalInvoice.id },
              data: {
                status: 'published',
                stripe_status: 'finalized',
                ...(finalizedInvoice.number
                  ? { stripe_invoice_number: finalizedInvoice.number }
                  : {}),
              },
            });

            // 2. Create Audit Log
            const authorId =
              (finalizedInvoice.metadata?.authorId as string) || 'system';
            let actorId: string | null = null;
            if (authorId && authorId !== 'system') {
              const userExists = await this.prisma.uSER.findUnique({
                where: { id: authorId },
              });
              if (userExists) {
                actorId = authorId;
              }
            }

            await this.prisma.invoiceAuditLog.create({
              data: {
                invoice_id: internalInvoice.id,
                actor_id: actorId,
                event: `Invoice ${internalInvoice.reference} has been marked as published`,
              },
            });

            // Send invoice to organization superadmin
            try {
              await this.invoiceService.sendInvoiceToSuperadmin(
                internalInvoice.id,
              );
            } catch (err) {
              this.logger.error(
                `Failed to send invoice email to superadmin: ${err.message}`,
                err.stack,
              );
            }

            // 3. Collection attempt: Stripe doesn't auto-charge saved payment methods on
            // its own schedule for these invoices, so we schedule (or immediately fire)
            // our own `payInvoice` call for the due date. If the due date is still in
            // the future, delay a BullMQ job until exactly then (in the org's billing
            // timezone, America/Los_Angeles); if it's already due (e.g. a same-day
            // invoice), attempt collection immediately instead of scheduling.
            const now = Date.now();
            const dueDateMs = finalizedInvoice.due_date
              ? DateTime.fromSeconds(finalizedInvoice.due_date)
                  .setZone('America/Los_Angeles')
                  .startOf('day')
                  .toMillis()
              : DateTime.fromMillis(now)
                  .setZone('America/Los_Angeles')
                  .startOf('day')
                  .toMillis();

            if (dueDateMs > now) {
              const delayMs = dueDateMs - now;
              const jobId = `attempt-collection-${internalInvoice.id}`;
              if (
                !queuesEnabled(this.configService)
              ) {
                this.logger.warn(
                  'LOCAL mode — attempt-collection job NOT scheduled.',
                );
              } else {
                // Remove any previously-scheduled collection attempt for this invoice
                // before scheduling a new one — e.g. if finalized fires twice, or the
                // due date changed — so we never end up with two competing charge
                // attempts for the same invoice.
                const existingJob = await this.invoiceQueue!.getJob(jobId);
                if (existingJob) {
                  try {
                    await existingJob.remove();
                  } catch (err) {
                    this.logger.warn(
                      `Failed to remove existing delayed job ${jobId}: ${err.message}`,
                    );
                  }
                }
                await this.invoiceQueue!.add(
                  'attempt-collection',
                  {
                    invoiceId: internalInvoice.id,
                    stripeInvoiceId: finalizedInvoice.id,
                  },
                  {
                    delay: delayMs,
                    jobId,
                    removeOnComplete: true,
                    removeOnFail: false,
                  },
                );
                this.logger.log(
                  `Scheduled collection job for invoice ${internalInvoice.id} in ${delayMs}ms`,
                );
              }
            } else {
              this.logger.log(
                `Due date is today or in the past. Attempting immediate collection for invoice ${internalInvoice.id}`,
              );
              await this.payInvoice(finalizedInvoice.id);
            }
          }
          break;
        }
        case 'checkout.session.completed':
          break;
        default:
          break;
      }

      // For any invoice.* event (paid, finalized, payment_failed, etc.), push a
      // real-time update over Pusher so a client with the invoice detail page open sees
      // the new status immediately, without needing to poll or refresh.
      if (event.type.startsWith('invoice.')) {
        try {
          const stripeInvoice = event.data.object as any;
          if (stripeInvoice.id) {
            const internalInvoice = await this.prisma.invoice.findUnique({
              where: { stripe_invoice_id: stripeInvoice.id },
            });
            if (internalInvoice) {
              await this.pusherService.trigger(
                `${internalInvoice.id}`,
                'invoice.status.update',
                {
                  invoiceId: internalInvoice.id,
                  status: internalInvoice.status,
                  stripe_status: internalInvoice.stripe_status,
                  event: event.type,
                },
              );
              this.logger.log(
                `Triggered Pusher event 'invoice.status.update' for invoice ${internalInvoice.id}`,
              );
            }
          }
        } catch (err) {
          this.logger.error(
            `Failed to trigger pusher event for ${event.type}: ${err.message}`,
          );
        }
      }
    }
  }

  /** Attempts to charge a Stripe invoice against a payment method (or the customer's
   * default one if none is specified) — used both for the due-date collection attempt
   * scheduled in the invoice.finalized handler and any manual "charge now" action. */
  public async payInvoice(
    stripeInvoiceId: string,
    paymentMethodId?: string,
  ): Promise<void> {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not initialized');
    }
    await this.safeStripeCall(() =>
      this.stripe.invoices.pay(
        stripeInvoiceId,
        paymentMethodId ? { payment_method: paymentMethodId } : undefined,
      ),
    );
  }

  /** Lists Stripe customers for the admin UI's "link existing customer" picker.
   * Without `search`, pages through customers newest-first. With `search`, uses
   * Stripe's Search API instead of List so customers outside the first page can
   * still be found by name/email.
   *
   * `cursor` is opaque to the caller but means different things per branch —
   * a customer id (`starting_after`) when listing, a search page token when
   * searching — so a cursor must be sent back with the same `search` value it
   * was issued under. Pass `nextCursor` straight through from the previous
   * response and that holds automatically. */
  public async listCustomers(search?: string, cursor?: string, limit = 100) {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not initialized');
    }
    const trimmed = search?.trim();
    // Stripe rejects anything outside 1..100 outright.
    const pageSize = Math.min(Math.max(Math.trunc(limit) || 100, 1), 100);

    if (trimmed) {
      const response = await this.safeStripeCall(() =>
        this.stripe.customers.search({
          query: this.buildCustomerSearchQuery(trimmed),
          limit: pageSize,
          ...(cursor ? { page: cursor } : {}),
        }),
      );
      return {
        data: response.data.map((c) => this.toCustomerSummary(c)),
        hasMore: response.has_more,
        // Search hands back its own page token; unlike List there's nothing to derive.
        nextCursor: response.next_page ?? null,
      };
    }

    const response = await this.safeStripeCall(() =>
      this.stripe.customers.list({
        limit: pageSize,
        ...(cursor ? { starting_after: cursor } : {}),
      }),
    );
    return {
      data: response.data.map((c) => this.toCustomerSummary(c)),
      hasMore: response.has_more,
      // List is cursor-by-object-id: the next page starts after the last row here.
      nextCursor: response.has_more
        ? (response.data[response.data.length - 1]?.id ?? null)
        : null,
    };
  }

  private toCustomerSummary(c: StripeCore.Customer) {
    return {
      id: c.id,
      name: c.name || (c as any).description || c.email || 'Unnamed Customer',
      email: c.email || '',
    };
  }

  /** Escapes single quotes so the search term can't break out of the Stripe
   * Search Query Language string literal it's interpolated into. */
  private buildCustomerSearchQuery(term: string): string {
    const escaped = term.replace(/'/g, "\\'");
    return `name~'${escaped}' OR email~'${escaped}'`;
  }

  /** Creates a new Stripe customer — used when linking an org to Stripe for the first
   * time (see InvoiceConfiguration.stripe_customer_id) rather than picking an existing one. */
  public async createCustomer(name: string, email: string) {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not initialized');
    }
    try {
      const customer = await this.stripe.customers.create({
        name,
        email: email || undefined,
      });
      return {
        id: customer.id,
        name:
          customer.name ||
          (customer as any).description ||
          customer.email ||
          'Unnamed Customer',
        email: customer.email || '',
      };
    } catch (err) {
      throw new BadRequestException(
        `Failed to create Stripe customer: ${err.message}`,
      );
    }
  }

  // Stripe's live-mode API rate limit is ~100 req/s; this stays well under that (25) to
  // leave headroom for other services sharing the same Stripe account/key. Implemented
  // as a fixed-window counter in Redis (not in-process memory) so the limit is shared
  // correctly across multiple running instances of this service, not just per-process.
  private BUCKET_KEY = 'stripe_rate_limit';
  private MAX_REQUESTS_PER_SECOND = 25;

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fixed-window rate limiter: buckets requests by wall-clock second (via a Redis key
   * per second, auto-expiring after 2s) and blocks until the next second if the current
   * window is full. Recurses (rather than looping) to retry once the wait is over.
   */
  private async acquireToken(): Promise<void> {
    const now = Date.now();
    const currentSecond = Math.floor(now / 1000);

    const key = `${this.BUCKET_KEY}:${currentSecond}`;

    // Increment count for this second
    const requests = await this.redisClient.incr(key);

    if (requests === 1) {
      // First request for this second → set expiry so Redis clears it automatically
      await this.redisClient.expire(key, 2); // 2 sec buffer
    }

    if (requests > this.MAX_REQUESTS_PER_SECOND) {
      // Too many requests this second → wait until next second starts
      const msUntilNextSecond = 1000 - (now % 1000);
      await this.delay(msUntilNextSecond);
      return this.acquireToken(); // retry after waiting
    }
    return;
  }

  /**
   * Wraps every outbound Stripe API call in this service — acquires a rate-limit token
   * first (see acquireToken), and if Stripe itself still returns a 429 (e.g. a burst
   * from another process sharing the same key), retries with a fixed 500ms backoff up
   * to `retries` times before giving up. This is the reason nearly every Stripe SDK call
   * in this file is wrapped in `safeStripeCall(() => ...)` rather than called directly.
   */
  public async safeStripeCall<T>(
    fn: () => Promise<T>,
    retries = 10,
  ): Promise<T> {
    await this.acquireToken();
    try {
      return await fn();
    } catch (err: any) {
      if (
        retries > 0 &&
        (err.statusCode === 429 ||
          err.type === 'StripeRateLimitError' ||
          err.message?.includes('rate limit'))
      ) {
        this.logger.warn(
          `Stripe rate limit hit, retrying in 500ms... (${retries} retries left)`,
        );
        await this.delay(500);
        return this.safeStripeCall(fn, retries - 1);
      }
      throw err;
    }
  }

  /** Creates a one-time, single-use percentage-off Stripe coupon/promo code scoped to
   * an organization's Stripe customer. Used for ad-hoc percentage discounts outside the
   * per-invoice discount flow (see createStripeInvoiceOnly's own discount handling). */
  public async createInvoiceDiscount(
    discount: number,
    clientId: string,
    name?: string,
  ) {
    const invoiceConfig = await this.prisma.invoiceConfiguration.findUnique({
      where: { organization_id: clientId },
    });
    if (invoiceConfig?.stripe_customer_id) {
      const coupon = await this.safeStripeCall(() =>
        this.stripe.coupons.create({
          name,
          percent_off: discount,
          duration: 'once',
        }),
      );
      return await this.safeStripeCall(() =>
        this.stripe.promotionCodes.create({
          coupon: coupon.id,
          max_redemptions: 1,
        } as any),
      );
    }
    return null;
  }

  /** Same as createInvoiceDiscount but for a flat dollar-amount-off coupon. */
  public async createInvoiceDiscountDollar(
    discount: number,
    clientId: string,
    name?: string,
  ) {
    const invoiceConfig = await this.prisma.invoiceConfiguration.findUnique({
      where: { organization_id: clientId },
    });
    if (invoiceConfig?.stripe_customer_id) {
      const coupon = await this.safeStripeCall(() =>
        this.stripe.coupons.create({
          name,
          amount_off: Math.round(discount * 100),
          currency: 'usd',
          duration: 'once',
        }),
      );
      return await this.safeStripeCall(() =>
        this.stripe.promotionCodes.create({
          coupon: coupon.id,
          max_redemptions: 1,
        } as any),
      );
    }
    return null;
  }

  /**
   * Step 1 of the publish-to-Stripe flow (see InvoiceService.updateStatus): creates an
   * empty Stripe invoice shell — customer, due date, discounts, and metadata only, no
   * line items yet (those are attached separately in attachStripeInvoiceItems). Deliberately
   * sets `auto_advance: false` so Stripe never auto-finalizes this invoice on its own;
   * finalization only happens when finalizeStripeInvoice explicitly calls for it, once
   * we're sure all line items were attached successfully.
   */
  public async createStripeInvoiceOnly(params: {
    clientId: string;
    reference: string;
    dueDate: Date;
    isPrebill: boolean;
    periodStart?: string;
    periodEnd?: string;
    invoice?: any;
  }) {
    const {
      clientId,
      reference,
      dueDate,
      isPrebill,
      periodStart,
      periodEnd,
      invoice,
    } = params;

    const invoiceConfig = await this.prisma.invoiceConfiguration.findUnique({
      where: { organization_id: clientId },
    });

    if (!invoiceConfig || !invoiceConfig.stripe_customer_id) {
      throw new BadRequestException(
        'Stripe customer ID not found for this organization',
      );
    }

    const stripeCustomerId = invoiceConfig.stripe_customer_id;

    // Fetch customer + payment methods
    const [methods, customer] = await Promise.all([
      this.safeStripeCall(() =>
        this.stripe.paymentMethods.list({ customer: stripeCustomerId }),
      ),
      this.safeStripeCall(() =>
        this.stripe.customers.retrieve(stripeCustomerId),
      ),
    ]);

    let default_payment_method: any = null;

    // Opportunistically backfill missing customer data on Stripe's side (email, default
    // payment method) rather than requiring it to have been set up perfectly when the
    // customer was first linked — self-healing so invoice creation doesn't hard-fail on
    // a customer record that's slightly incomplete.
    if (!customer.deleted) {
      const updatePayload: any = {};

      if (!customer.email) {
        const org = await this.prisma.organization.findUnique({
          where: { id: clientId },
        });
        updatePayload.email = org?.email || 'test.email@mailinator.com';
      }

      const invoiceSettings = customer.invoice_settings || {};
      if (!invoiceSettings.default_payment_method) {
        if (methods.data.length > 0) {
          updatePayload.invoice_settings = {
            default_payment_method: methods.data[0].id,
          };
          default_payment_method = methods.data[0];
        }
      } else if (methods.data.length > 0) {
        default_payment_method = methods.data.find(
          (e) => e.id === (invoiceSettings.default_payment_method as string),
        );
      }

      if (Object.keys(updatePayload).length > 0) {
        await this.safeStripeCall(() =>
          this.stripe.customers.update(stripeCustomerId, updatePayload),
        );
      }
    }

    // Stripe rejects a due_date in the past — if our own due date has already elapsed
    // (e.g. invoice was approved/published late), push it forward 2 hours so Stripe
    // accepts the invoice rather than failing the whole publish flow.
    let effectiveDueDate = new Date(dueDate);
    const diffNowMinutes =
      (effectiveDueDate.getTime() - Date.now()) / (1000 * 60);
    if (diffNowMinutes < 0) {
      effectiveDueDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
    }

    // Each discount type our invoice supports (version-level discount, med-alliance
    // referral credit, flat dollar discount) becomes its own single-use Stripe coupon —
    // Stripe invoices accept a list of discounts, so these stack rather than requiring
    // one combined coupon.
    const discounts: any[] = [];
    if (invoice) {
      const version = invoice.currentVersion;
      if (version) {
        const discountType = version.discountType;
        const discountValue = Number(version.discountValue);

        if (discountValue > 0) {
          if (discountType === 'percent') {
            const coupon = await this.stripe.coupons.create({
              percent_off: discountValue,
              duration: 'once',
              name: `Discount - ${reference}`,
            });
            discounts.push({ coupon: coupon.id });
          } else if (discountType === 'dollar') {
            const coupon = await this.stripe.coupons.create({
              amount_off: Math.round(discountValue * 100),
              currency: 'usd',
              duration: 'once',
              name: `Discount - ${reference}`,
            });
            discounts.push({ coupon: coupon.id });
          }
        }
      }

      const allianceCreditVal =
        invoice.allianceCredit || invoice.currentVersion?.allianceCredit;
      if (
        allianceCreditVal &&
        !Number.isNaN(Number(allianceCreditVal)) &&
        Number(allianceCreditVal) > 0
      ) {
        const coupon = await this.stripe.coupons.create({
          amount_off: Math.round(Number(allianceCreditVal) * 100),
          currency: 'usd',
          duration: 'once',
          name: `Alliance credit - ${reference}`,
        });
        discounts.push({ coupon: coupon.id });
      }

      const discountDollarVal =
        invoice.discountDollar || invoice.currentVersion?.discountDollar;
      if (discountDollarVal && Number(discountDollarVal) > 0) {
        const coupon = await this.stripe.coupons.create({
          amount_off: Math.round(Number(discountDollarVal) * 100),
          currency: 'usd',
          duration: 'once',
          name: `Discount - ${reference}`,
        });
        discounts.push({ coupon: coupon.id });
      }
    }

    const invoiceCreateParams: any = {
      customer: stripeCustomerId,
      collection_method: 'send_invoice',
      auto_advance: false, // critical: do NOT finalize
      due_date: Math.ceil(effectiveDueDate.getTime() / 1000),
      description: 'Invoice for services rendered',
      metadata: {
        reference: reference || '',
        clientId,
        prebilled: isPrebill ? 'true' : 'false',
        periodStart: periodStart || '',
        periodEnd: periodEnd || '',
      },
    };

    if (discounts.length > 0) {
      invoiceCreateParams.discounts = discounts;
    }

    // idempotencyKey ties this creation to our own invoice reference — if this method
    // is somehow called twice for the same invoice (e.g. a retried request), Stripe
    // returns the *same* invoice object instead of creating a duplicate.
    const stripeInvoice = await this.safeStripeCall(() =>
      this.stripe.invoices.create(invoiceCreateParams, {
        idempotencyKey: `creates-invoice-${reference}-${stripeCustomerId}`,
      }),
    );

    // Persist Stripe linkage ONLY — no other Invoice fields are touched here, since this
    // is just step 1 of the multi-step publish flow (see class-level method comment).
    await this.prisma.invoice.update({
      where: { reference },
      data: {
        stripe_invoice_id: stripeInvoice.id,
        stripe_invoice_number: stripeInvoice.number,
        stripe_status: 'invoice_created',
      },
    });

    return {
      invoice: stripeInvoice,
      default_payment_method,
      stripe_customer_id: stripeCustomerId,
    };
  }

  /** Stripe invoice item descriptions are plain text — strip any HTML that made it into
   * a line item's description (e.g. from a rich-text notes field) before sending it. */
  private stripHtml(html: string): string {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, '');
  }

  /**
   * Converts our InvoiceLineItem rows into the flat list of Stripe invoice items to
   * create. "Deterministic" refers to internalItemId being derived purely from
   * `${reference}:${lineItemId}` rather than randomly generated — this is what lets
   * attachStripeInvoiceItems below tell "already attached" items apart from new ones
   * on a retry, without needing to track attachment state separately. Zero-amount lines
   * are skipped since Stripe doesn't accept $0 invoice items.
   */
  private async buildDeterministicInvoiceItems(invoice: any): Promise<
    Array<{
      internalItemId: string;
      amountCents: number;
      description: string;
      type: 'LINE_ITEM';
      discountCents?: number;
    }>
  > {
    const result: Array<{
      internalItemId: string;
      amountCents: number;
      description: string;
      type: 'LINE_ITEM';
      discountCents?: number;
    }> = [];

    const lineItems = invoice.currentVersion?.line_items || [];

    for (const item of lineItems) {
      const finalTotal = Number(item.final_total || 0);
      const adjustmentAmount = Number(item.adjustment_amount || 0);
      const isDiscount = adjustmentAmount < 0;

      // When the line carries a real discount, Stripe must see the GROSS amount and
      // apply the discount itself via a coupon — otherwise the discount would be
      // subtracted twice (once in our own final_total, again by Stripe).
      const grossAmount = isDiscount ? finalTotal - adjustmentAmount : finalTotal;

      if (Math.round(grossAmount * 100) === 0) {
        continue;
      }

      result.push({
        internalItemId: `${invoice.reference}:${item.id}`,
        amountCents: Math.round(grossAmount * 100),
        description: this.stripHtml(item.description || 'Line Item'),
        type: 'LINE_ITEM',
        ...(isDiscount && {
          discountCents: Math.round(Math.abs(adjustmentAmount) * 100),
        }),
      });
    }

    return result;
  }

  /**
   * Step 2 of the publish flow: pushes each of our line items onto the Stripe invoice
   * created in createStripeInvoiceOnly, as individual Stripe InvoiceItems. Safe to call
   * more than once for the same invoice (e.g. after a partial failure) — see the
   * idempotency comment inline below.
   */
  public async attachStripeInvoiceItems(
    invoice: any,
    stripeCustomerId: string,
  ): Promise<void> {
    if (!invoice.stripe_invoice_id || !stripeCustomerId) {
      throw new Error('Stripe invoice not initialized');
    }

    const stripeInvoiceId = invoice.stripe_invoice_id;

    // 1. Fetch existing Stripe invoice items
    const existingLines = await this.safeStripeCall(() =>
      this.stripe.invoiceItems.list({
        invoice: stripeInvoiceId,
        limit: 100,
      }),
    );

    // 2. Build deterministic list of items
    const itemsToAttach = await this.buildDeterministicInvoiceItems(invoice);

    if (itemsToAttach.length === 0) {
      return;
    }

    // The actual idempotency mechanism: read back what's already on the Stripe invoice
    // (by our own internal_item_id metadata, not Stripe's own item id) and skip
    // re-creating anything already present. Combined with buildDeterministicInvoiceItems'
    // stable IDs, this means re-running attach after a partial failure only creates the
    // items that are still missing.
    const existingItemIds = new Set(
      existingLines.data
        .map((line) => line.metadata?.internal_item_id)
        .filter(Boolean),
    );

    // 3. Attach only missing items
    for (const item of itemsToAttach) {
      if (existingItemIds.has(item.internalItemId)) {
        continue;
      }

      // A negative per-line adjustment becomes its own single-use Stripe coupon,
      // attached directly to this invoice item — Stripe then renders it as a
      // discount sub-line under this specific item (applied before any
      // whole-invoice discount, which is handled separately in
      // createStripeInvoiceOnly). idempotencyKey is tied to our own
      // internalItemId so a retry reuses the same coupon instead of minting a
      // new (orphaned) one each time.
      const discounts: Array<{ coupon: string }> = [];
      if (item.discountCents && item.discountCents > 0) {
        const coupon = await this.safeStripeCall(() =>
          this.stripe.coupons.create(
            {
              amount_off: item.discountCents,
              currency: 'usd',
              duration: 'once',
              name: `Line discount - ${item.description}`,
            },
            {
              idempotencyKey: `line-discount-coupon-${invoice.reference}-${item.internalItemId}`,
            },
          ),
        );
        discounts.push({ coupon: coupon.id });
      }

      await this.safeStripeCall(() =>
        this.stripe.invoiceItems.create(
          {
            customer: stripeCustomerId,
            invoice: stripeInvoiceId,
            currency: 'usd',
            amount: item.amountCents,
            description: item.description,
            ...(discounts.length > 0 && { discounts }),
            metadata: {
              internal_item_id: item.internalItemId,
              type: item.type,
            },
          },
          {
            idempotencyKey: `invoice-items-${invoice.reference}-${item.internalItemId}`,
          },
        ),
      );
    }

    // Update state in DB
    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        stripe_status: 'all_line_items_added',
      },
    });
  }

  /**
   * Step 3 of the publish flow: locks the Stripe invoice (no further line items can be
   * added/changed after this) and assigns it Stripe's own invoice number. Guards on
   * Stripe's own status being `draft` — if it's already been finalized (e.g. a retry
   * after the DB update below failed but the Stripe call succeeded), this is a safe
   * no-op rather than erroring or double-finalizing.
   */
  public async finalizeStripeInvoice(invoice: any): Promise<void> {
    if (!invoice.stripe_invoice_id) {
      throw new Error('Stripe invoice not initialized');
    }

    const stripeInvoiceId = invoice.stripe_invoice_id;

    // 1. Guard: fetch Stripe invoice state
    const stripeInvoice = await this.safeStripeCall(() =>
      this.stripe.invoices.retrieve(stripeInvoiceId),
    );

    if (stripeInvoice.status !== 'draft') {
      return;
    }

    // 2. Finalize invoice (idempotent)
    await this.safeStripeCall(() =>
      this.stripe.invoices.finalizeInvoice(
        stripeInvoiceId,
        {},
        {
          idempotencyKey: `finalize-invoices-${invoice.reference}`,
        },
      ),
    );

    // Update state in DB
    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        stripe_status: 'finalized',
      },
    });
  }

  /**
   * Step 4 (final) of the publish flow: re-fetches the Stripe invoice and sanity-checks
   * it actually finalized into a coherent, billable state — not just that the finalize
   * API call didn't throw. InvoiceService.updateStatus only lets our own status advance
   * to `published` if this method returns without throwing.
   */
  public async verifyFinalizedStripeInvoice(invoice: any): Promise<void> {
    if (!invoice.stripe_invoice_id) {
      throw new Error('Stripe invoice not initialized');
    }

    const stripeInvoiceId = invoice.stripe_invoice_id;

    // 1. Fetch Stripe invoice
    const stripeInvoice = await this.safeStripeCall(() =>
      this.stripe.invoices.retrieve(stripeInvoiceId),
    );

    // 2. Terminal Stripe states
    if (stripeInvoice.status === 'void') {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          stripe_status: 'voided',
        },
      });
      return;
    }

    if (stripeInvoice.status === 'uncollectible') {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          stripe_status: 'uncollectible',
        },
      });
      return;
    }

    // 3. Not finalized yet
    if (stripeInvoice.status === 'draft') {
      throw new Error('Stripe invoice still in draft');
    }

    // 4. Structural verification — catches the case where finalize "succeeded" but the
    // invoice is nonsensical (e.g. attachStripeInvoiceItems silently attached nothing),
    // which we'd rather fail loudly on than publish a $0 or empty invoice to a client.
    const lineCount = stripeInvoice.lines?.data?.length ?? 0;
    const total = stripeInvoice.total ?? 0;

    if (lineCount === 0) {
      throw new Error('Finalized invoice has no line items');
    }

    if (total <= 0) {
      throw new Error('Finalized invoice has invalid total');
    }
  }

  /** Returns Stripe's hosted payment page URL for an invoice — what "View on Stripe" /
   * the client-facing payment link in the invoice email points at. */
  public async getInvoiceUrl(
    stripeInvoiceId: string,
  ): Promise<{ url: string | null }> {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not initialized');
    }
    const invoice = await this.safeStripeCall(() =>
      this.stripe.invoices.retrieve(stripeInvoiceId),
    );
    return { url: invoice.hosted_invoice_url || null };
  }

  /** Name + email of the org's Stripe customer record, for display on the invoice's
   * "Billed to" card (the account Stripe actually bills/emails, which can differ from
   * the organization's own contact info).
   *
   * Throws on every failure mode, deliberately: the frontend's "Billed to" card and
   * the PDF renderer's waitForResponse both key off the 400 (see generatePdf), so a
   * silent null here would change that contract. Use findCustomerForOrganization below
   * when a missing customer should not be an error. */
  public async getBillingContact(organizationId: string) {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not initialized');
    }

    const invoiceConfig = await this.prisma.invoiceConfiguration.findUnique({
      where: { organization_id: organizationId },
    });

    if (!invoiceConfig || !invoiceConfig.stripe_customer_id) {
      throw new BadRequestException(
        'Stripe customer ID not found for this organization',
      );
    }

    const customer = await this.safeStripeCall(() =>
      this.stripe.customers.retrieve(invoiceConfig.stripe_customer_id as string),
    );

    if (customer.deleted) {
      throw new BadRequestException('Stripe customer has been deleted');
    }

    return {
      name: customer.name || null,
      email: customer.email || null,
    };
  }

  /**
   * Retrieves the full Stripe customer linked to an organization, or null.
   *
   * The non-throwing counterpart to getBillingContact above: this one decorates a
   * response that must still succeed when Stripe cannot answer. It returns null —
   * rather than raising — when Stripe is unconfigured, when the org has no invoice
   * configuration, when no stripe_customer_id is assigned yet, when the customer was
   * deleted on Stripe's side, or when the API call itself fails.
   */
  public async findCustomerForOrganization(organizationId: string) {
    if (!this.stripe) return null;

    const invoiceConfig = await this.prisma.invoiceConfiguration.findUnique({
      where: { organization_id: organizationId },
      select: { stripe_customer_id: true },
    });

    const stripeCustomerId = invoiceConfig?.stripe_customer_id;
    if (!stripeCustomerId) return null;

    try {
      const customer = await this.safeStripeCall(() =>
        this.stripe.customers.retrieve(stripeCustomerId),
      );
      // A customer deleted in Stripe still resolves, as a stub with deleted:true
      // and none of the fields a caller would want.
      return customer.deleted ? null : customer;
    } catch (err) {
      this.logger.warn(
        `Could not retrieve Stripe customer ${stripeCustomerId} for org ${organizationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Lists an org's saved Stripe payment methods for the billing portal, flagging which
   * one is the customer's default (used for automatic collection — see payInvoice). */
  public async getCustomerPaymentMethods(organizationId: string) {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not initialized');
    }

    const invoiceConfig = await this.prisma.invoiceConfiguration.findUnique({
      where: { organization_id: organizationId },
    });

    if (!invoiceConfig || !invoiceConfig.stripe_customer_id) {
      throw new BadRequestException(
        'Stripe customer ID not found for this organization',
      );
    }

    const stripeCustomerId = invoiceConfig.stripe_customer_id;

    const [methods, customer] = await Promise.all([
      this.safeStripeCall(() =>
        this.stripe.paymentMethods.list({ customer: stripeCustomerId }),
      ),
      this.safeStripeCall(() =>
        this.stripe.customers.retrieve(stripeCustomerId),
      ),
    ]);

    let defaultPaymentMethodId: string | null = null;
    if (!customer.deleted) {
      const invoiceSettings = (customer as any).invoice_settings || {};
      defaultPaymentMethodId = invoiceSettings.default_payment_method as
        | string
        | null;
    }

    return methods.data.map((method) => ({
      ...method,
      is_default: method.id === defaultPaymentMethodId,
    }));
  }

  /** Sets which saved payment method Stripe should charge automatically (e.g. on the
   * due-date collection attempt scheduled from the invoice.finalized webhook). */
  public async setDefaultCustomerPaymentMethod(
    organizationId: string,
    paymentMethodId: string,
  ) {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not initialized');
    }

    const invoiceConfig = await this.prisma.invoiceConfiguration.findUnique({
      where: { organization_id: organizationId },
    });

    if (!invoiceConfig || !invoiceConfig.stripe_customer_id) {
      throw new BadRequestException(
        'Stripe customer ID not found for this organization',
      );
    }

    return await this.safeStripeCall(() =>
      this.stripe.customers.update(invoiceConfig.stripe_customer_id as string, {
        invoice_settings: { default_payment_method: paymentMethodId },
      }),
    );
  }

  /** Detaches (removes) a saved payment method from an org's Stripe customer. */
  public async deleteCustomerPaymentMethod(
    organizationId: string,
    paymentMethodId: string,
  ) {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not initialized');
    }

    // Verify the payment method actually belongs to THIS org's Stripe customer before
    // detaching — without this check, any org could pass another org's paymentMethodId
    // and delete a stranger's saved card.
    const invoiceConfig = await this.prisma.invoiceConfiguration.findUnique({
      where: { organization_id: organizationId },
    });

    if (!invoiceConfig || !invoiceConfig.stripe_customer_id) {
      throw new BadRequestException(
        'Stripe customer ID not found for this organization',
      );
    }

    const pm = await this.safeStripeCall(() =>
      this.stripe.paymentMethods.retrieve(paymentMethodId),
    );
    if (pm.customer !== invoiceConfig.stripe_customer_id) {
      throw new BadRequestException(
        'Payment method does not belong to this customer',
      );
    }

    await this.safeStripeCall(() =>
      this.stripe.paymentMethods.detach(paymentMethodId),
    );
  }

  /**
   * Starts the "add a payment method" flow for the client billing portal. Rather than
   * using Stripe's dedicated (free) SetupIntent API, this deliberately creates a real
   * $1.00 PaymentIntent with setup_future_usage — charging a trivial real amount is a
   * stronger verification that the card/bank account actually works than a $0 setup
   * would be, and the metadata.refund flag here is what the payment_intent.succeeded
   * webhook handler (above) matches on to auto-refund this $1 once it clears.
   */
  public async createSetupIntent(
    organizationId: string,
    method: string = 'card',
  ) {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not initialized');
    }

    const invoiceConfig = await this.prisma.invoiceConfiguration.findUnique({
      where: { organization_id: organizationId },
    });

    if (!invoiceConfig || !invoiceConfig.stripe_customer_id) {
      throw new BadRequestException(
        'Stripe customer ID not found for this organization',
      );
    }

    const paymentIntent = await this.safeStripeCall(() =>
      this.stripe.paymentIntents.create({
        amount: 100, // $1.00 fee to verify and save the card/bank
        currency: 'usd',
        customer: invoiceConfig.stripe_customer_id as string,
        setup_future_usage: 'on_session',
        payment_method_types: method === 'ach' ? ['us_bank_account'] : ['card'],
        metadata: {
          organizationId,
          refund: 'true',
        },
      }),
    );

    return { clientSecret: paymentIntent.client_secret };
  }

  /**
   * Checks if the paid invoice was pre-billed.
   * If so, schedules a delayed BullMQ job to fire on the day after billing_end_date
   * so real Hubstaff data can be reconciled against the prebill amounts.
   */
  private async schedulePrebillReconciliationIfNeeded(
    invoiceId: string,
  ): Promise<void> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        currentVersion: {
          select: { is_prebill: true, billing_end_date: true },
        },
      },
    });

    if (!invoice?.currentVersion?.is_prebill) {
      return; // Not a prebill — nothing to reconcile
    }

    const billingEndDate =
      invoice.currentVersion.billing_end_date ?? invoice.billing_end_date;
    if (!billingEndDate) {
      this.logger.warn(
        `Invoice ${invoiceId} is prebill but has no billing_end_date — skipping prebill reconciliation scheduling`,
      );
      return;
    }

    // Fire at the very start of the day after billing_end_date
    const runAt = DateTime.fromJSDate(billingEndDate, { zone: 'utc' })
      .plus({ days: 1 })
      .startOf('day')
      .toMillis();

    const delayMs = Math.max(runAt - Date.now(), 0);
    const jobId = `prebill-recon-${invoiceId}`;

    if (!queuesEnabled(this.configService)) {
      this.logger.warn(
        `LOCAL mode — prebill reconciliation job for invoice ${invoiceId} NOT scheduled.`,
      );
      return;
    }

    // Remove any pre-existing job for this invoice to avoid duplicates
    const existing = await this.prebillReconQueue!.getJob(jobId);
    if (existing) {
      try {
        await existing.remove();
      } catch {
        /* already processed */
      }
    }

    await this.prebillReconQueue!.add(
      'reconcile-prebill-invoice',
      {
        invoiceId,
        organizationId: invoice.organization_id,
        billingStartDate: invoice.billing_start_date.toISOString(),
        billingEndDate: billingEndDate.toISOString(),
      },
      {
        delay: delayMs,
        jobId,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(
      `Scheduled prebill reconciliation for invoice ${invoiceId} ` +
        `in ${Math.round(delayMs / 1000 / 60 / 60)}h (after billing_end_date ${billingEndDate.toISOString()})`,
    );
  }
}
