import { Controller, Post, Req, Headers, BadRequestException, Get, UseGuards, Body, Param, Put, Delete, Query } from '@nestjs/common';
import { Request } from 'express';
import { StripeService } from './stripe.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller()
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  @Get('stripe/customers')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  async listCustomers(
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Number(limit) : undefined;
    if (parsedLimit !== undefined && !Number.isFinite(parsedLimit)) {
      throw new BadRequestException('Limit must be a number');
    }
    // `cursor` is whatever nextCursor the previous response returned; it has to be
    // sent back alongside the same `search` value, since list and search cursors
    // are not interchangeable.
    return this.stripeService.listCustomers(search, cursor, parsedLimit);
  }

  @Post('stripe/customers')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  async createCustomer(@Body() body: { name: string; email?: string }) {
    if (!body.name) {
      throw new BadRequestException('Name is required');
    }
    return this.stripeService.createCustomer(body.name, body.email || '');
  }

  @Get('stripe/invoices/:id/url')
  @UseGuards(AuthGuard)
  async getInvoiceUrl(@Param('id') id: string) {
    if (!id) {
      throw new BadRequestException('Stripe invoice ID is required');
    }
    return this.stripeService.getInvoiceUrl(id);
  }

  @Post('stripe/invoices/:id/pay')
  @UseGuards(AuthGuard)
  async payInvoice(
    @Param('id') id: string,
    @Body('paymentMethodId') paymentMethodId?: string,
  ) {
    if (!id) {
      throw new BadRequestException('Stripe invoice ID is required');
    }
    await this.stripeService.payInvoice(id, paymentMethodId);
    return { success: true };
  }

  @Get('stripe/organizations/:organizationId/billing-contact')
  @UseGuards(AuthGuard)
  async getBillingContact(@Param('organizationId') organizationId: string) {
    if (!organizationId) {
      throw new BadRequestException('Organization ID is required');
    }
    return this.stripeService.getBillingContact(organizationId);
  }

  @Get('stripe/organizations/:organizationId/payment-methods')
  @UseGuards(AuthGuard)
  async getCustomerPaymentMethods(@Param('organizationId') organizationId: string) {
    if (!organizationId) {
      throw new BadRequestException('Organization ID is required');
    }
    return this.stripeService.getCustomerPaymentMethods(organizationId);
  }

  @Put('stripe/organizations/:organizationId/payment-methods/:paymentMethodId/default')
  @UseGuards(AuthGuard)
  async setDefaultPaymentMethod(
    @Param('organizationId') organizationId: string,
    @Param('paymentMethodId') paymentMethodId: string,
  ) {
    if (!organizationId || !paymentMethodId) {
      throw new BadRequestException('Organization ID and Payment Method ID are required');
    }
    return this.stripeService.setDefaultCustomerPaymentMethod(organizationId, paymentMethodId);
  }

  @Delete('stripe/organizations/:organizationId/payment-methods/:paymentMethodId')
  @UseGuards(AuthGuard)
  async deletePaymentMethod(
    @Param('organizationId') organizationId: string,
    @Param('paymentMethodId') paymentMethodId: string,
  ) {
    if (!organizationId || !paymentMethodId) {
      throw new BadRequestException('Organization ID and Payment Method ID are required');
    }
    return this.stripeService.deleteCustomerPaymentMethod(organizationId, paymentMethodId);
  }

  @Post('stripe/organizations/:organizationId/setup-intent')
  @UseGuards(AuthGuard)
  async createSetupIntent(
    @Param('organizationId') organizationId: string,
    @Body('method') method?: string,
  ) {
    if (!organizationId) {
      throw new BadRequestException('Organization ID is required');
    }
    return this.stripeService.createSetupIntent(organizationId, method);
  }

  @Post('webhooks/stripe')
  async handleWebhook(
    @Req() req: Request,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }
    const rawBody = (req as any).rawBody;
    if (!rawBody) {
      throw new BadRequestException('Raw body not available. Ensure rawBody is enabled in main.ts');
    }
    return this.stripeService.handleWebhook(rawBody, signature);
  }
}
