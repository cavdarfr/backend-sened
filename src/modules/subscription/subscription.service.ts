import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { getSupabaseAdmin, getSupabaseClient } from '../../config/supabase.config';
import { LegalDocumentService } from '../legal-document/legal-document.service';
import { CompanyService } from '../company/company.service';
import { CreateCompanyDto, CompanyWithRoleResponseDto } from '../company/dto/company.dto';
import {
    hasUsableSubscription,
    hasUsableSubscriptionForCompanyOwnerRole,
    resolveEffectiveSubscriptionTarget,
} from '../../common/subscription/effective-subscription';
import {
    SubscriptionDto,
    SubscriptionPlanDto,
    SubscriptionWithPlansDto,
    SubscribeResponseDto,
    AvailablePlansResponseDto,
    CompanyCreationSummaryDto,
    CreatePendingCompanySubscriptionDto,
    CreateRegistrationSubscriptionDto,
    FinalizePendingCompanySubscriptionResponseDto,
    RegistrationSubscriptionResponseDto,
    FinalizeRegistrationSubscriptionResponseDto,
    RegistrationPricingDto,
    PendingCompanyPaymentSessionSummaryDto,
    PendingCompanySubscriptionResponseDto,
    ValidatePendingCompanyPromotionCodeDto,
    ValidatePendingCompanyPromotionCodeResponseDto,
    ValidateRegistrationPromotionCodeDto,
    ValidateRegistrationPromotionCodeResponseDto,
    ValidateSubscriptionPromotionCodeDto,
    ValidateSubscriptionPromotionCodeResponseDto,
    ChangeSubscriptionResponseDto,
} from './dto/subscription.dto';
import { decryptRegistrationSecret, encryptRegistrationSecret } from '../../common/utils/registration-payload';
import { normalizeBusinessIdentifiers } from '../../shared/utils/business-identifiers.util';

const REGISTRATION_SUPPORT_EMAIL = 'contact@sened.fr';
const INVALID_PROMO_CODE_MESSAGE = 'Le code promo est invalide.';

interface RegistrationPaymentSessionRecord {
    id: string;
    email: string;
    encrypted_password: string;
    registration_data: Record<string, any>;
    plan_id: string | null;
    plan_slug: string;
    billing_period: 'monthly' | 'yearly';
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    stripe_base_item_id: string | null;
    stripe_member_item_id: string | null;
    status: string;
    finalized_user_id: string | null;
    expires_at: string;
    created_at: string;
    updated_at: string;
}

interface PendingCompanyPaymentSessionRecord {
    id: string;
    user_id: string;
    company_data: CreateCompanyDto;
    plan_id: string | null;
    plan_slug: string | null;
    billing_period: 'monthly' | 'yearly' | null;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    stripe_base_item_id: string | null;
    stripe_member_item_id: string | null;
    status: string;
    finalized_company_id: string | null;
    expires_at: string;
    created_at: string;
    updated_at: string;
}

interface ResolvedRegistrationPricingContext {
    plan: any;
    basePriceId: string;
    basePrice: Stripe.Price;
    pricing: RegistrationPricingDto;
    stripePromotionCodeId: string | null;
}

interface SubscriptionMemberUsage {
    total_members: number;
    extra_members: number;
    pending_invitations: number;
    billable_members: number;
    billable_extra_members: number;
}

interface StripeCustomerBillingDetails {
    email?: string | null;
    name?: string | null;
    address?: {
        line1?: string | null;
        city?: string | null;
        postal_code?: string | null;
        country?: string | null;
    } | null;
}

export function buildSubscriptionMemberUsage(
    totalMembers: number,
    pendingInvitations: number,
    ownerRole: 'merchant_admin' | 'accountant',
    activeBillableMembers: number = totalMembers,
): SubscriptionMemberUsage {
    const normalizedTotalMembers = Math.max(totalMembers, 0);
    const normalizedPendingInvitations = Math.max(pendingInvitations, 0);
    const normalizedActiveBillableMembers = Math.max(activeBillableMembers, 0);
    const billableMembers = ownerRole === 'merchant_admin'
        ? normalizedActiveBillableMembers + normalizedPendingInvitations
        : normalizedActiveBillableMembers;

    return {
        total_members: normalizedTotalMembers,
        extra_members: Math.max(normalizedTotalMembers - 1, 0),
        pending_invitations: normalizedPendingInvitations,
        billable_members: billableMembers,
        billable_extra_members: ownerRole === 'merchant_admin'
            ? Math.max(billableMembers - 1, 0)
            : 0,
    };
}

@Injectable()
export class SubscriptionService {
    private stripe: Stripe | null = null;

    constructor(
        private configService: ConfigService,
        private readonly legalDocumentService: LegalDocumentService,
        @Inject(forwardRef(() => CompanyService))
        private readonly companyService: CompanyService,
    ) {
        const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY');
        if (stripeKey) {
            this.stripe = new Stripe(stripeKey);
        }
    }

    private isStripeEnabled(): boolean {
        return this.configService.get<string>('STRIPE_ENABLED', 'true') !== 'false';
    }

    private ensureStripe(): Stripe {
        if (!this.stripe) {
            throw new BadRequestException(
                'Le service de paiement n\'est pas configuré.',
            );
        }
        return this.stripe;
    }

    /**
     * Resolves a Stripe Price ID from a lookup key.
     */
    private async resolveStripePriceId(
        stripe: Stripe,
        lookupKey: string,
    ): Promise<string> {
        const price = await this.resolveStripePrice(stripe, lookupKey);
        return price.id;
    }

    private async resolveStripePrice(
        stripe: Stripe,
        lookupKey: string,
    ): Promise<Stripe.Price> {
        const prices = await stripe.prices.list({
            lookup_keys: [lookupKey],
            active: true,
            limit: 2,
        });

        if (prices.data.length === 0) {
            throw new BadRequestException(
                'Aucun tarif actif n’a été trouvé pour cet abonnement. Vérifiez la configuration de facturation.',
            );
        }

        if (prices.data.length > 1) {
            throw new BadRequestException(
                'Plusieurs tarifs actifs ont été trouvés pour cet abonnement. Vérifiez la configuration de facturation.',
            );
        }

        return prices.data[0];
    }

    /**
     * Resolves the lookup key for a plan based on billing period.
     */
    private resolveLookupKey(plan: any, billingPeriod: 'monthly' | 'yearly'): string {
        const lookupKey = billingPeriod === 'yearly'
            ? plan.stripe_lookup_key_yearly
            : plan.stripe_lookup_key_monthly;

        if (!lookupKey) {
            throw new BadRequestException(
                `Pas de prix ${billingPeriod === 'yearly' ? 'annuel' : 'mensuel'} configuré pour le plan "${plan.slug}".`,
            );
        }

        return lookupKey;
    }

    private normalizeEmail(email: string): string {
        return email.trim().toLowerCase();
    }

    private normalizePromotionCode(code?: string | null): string | null {
        const trimmed = code?.trim();
        return trimmed ? trimmed : null;
    }

    private convertStripeAmountToMajor(amount: number | null | undefined): number {
        return Number((((amount || 0) as number) / 100).toFixed(2));
    }

    private buildRegistrationPricing(
        amountMinor: number,
        discountMinor: number,
        currency: string,
        options?: {
            promotionCode?: string | null;
            couponName?: string | null;
            couponPercentOff?: number | null;
            couponAmountOff?: number | null;
        },
    ): RegistrationPricingDto {
        const normalizedDiscount = Math.max(0, Math.min(discountMinor, amountMinor));
        return {
            original_amount_ht: this.convertStripeAmountToMajor(amountMinor),
            discount_amount_ht: this.convertStripeAmountToMajor(normalizedDiscount),
            final_amount_ht: this.convertStripeAmountToMajor(amountMinor - normalizedDiscount),
            currency: currency.toUpperCase(),
            promotion_code: options?.promotionCode || null,
            coupon_name: options?.couponName || null,
            coupon_percent_off: options?.couponPercentOff ?? null,
            coupon_amount_off: options?.couponAmountOff != null
                ? this.convertStripeAmountToMajor(options.couponAmountOff)
                : null,
        };
    }

    private buildRegistrationPricingFromInvoice(
        invoice: Stripe.Invoice | null,
        fallbackPricing: RegistrationPricingDto,
    ): RegistrationPricingDto {
        if (!invoice) {
            return fallbackPricing;
        }

        const subtotal = typeof invoice.subtotal === 'number'
            ? invoice.subtotal
            : Math.round(fallbackPricing.original_amount_ht * 100);
        const discountAmount = Array.isArray(invoice.total_discount_amounts)
            ? invoice.total_discount_amounts.reduce(
                (sum, item) => sum + (item?.amount || 0),
                0,
            )
            : Math.round(fallbackPricing.discount_amount_ht * 100);

        return {
            ...fallbackPricing,
            original_amount_ht: this.convertStripeAmountToMajor(subtotal),
            discount_amount_ht: this.convertStripeAmountToMajor(discountAmount),
            final_amount_ht: this.convertStripeAmountToMajor(
                Math.max(subtotal - discountAmount, 0),
            ),
        };
    }

    private mapStripeStatus(status: string | null | undefined): string {
        if (status === 'active') return 'active';
        if (status === 'trialing') return 'active';
        if (status === 'past_due') return 'past_due';
        if (status === 'canceled') return 'cancelled';
        return status || 'incomplete';
    }

    private isStripePaymentSettled(
        subscription: Stripe.Subscription,
        latestInvoice: Stripe.Invoice | null,
    ): boolean {
        if (['active', 'trialing'].includes(subscription.status)) {
            return true;
        }

        const paymentIntent = (latestInvoice as any)?.payment_intent as Stripe.PaymentIntent | null;
        return paymentIntent?.status === 'succeeded';
    }

    private getBaseItem(
        subscription: Stripe.Subscription,
        expectedBaseItemId?: string | null,
    ): Stripe.SubscriptionItem | undefined {
        if (expectedBaseItemId) {
            const matched = subscription.items.data.find((item) => item.id === expectedBaseItemId);
            if (matched) {
                return matched;
            }
        }

        return subscription.items.data[0];
    }

    private getMemberItem(
        subscription: Stripe.Subscription,
        expectedBaseItemId?: string | null,
        expectedMemberItemId?: string | null,
    ): Stripe.SubscriptionItem | undefined {
        if (expectedMemberItemId) {
            const matched = subscription.items.data.find((item) => item.id === expectedMemberItemId);
            if (matched) {
                return matched;
            }
        }

        const baseItem = this.getBaseItem(subscription, expectedBaseItemId);
        return subscription.items.data.find((item) => item.id !== baseItem?.id);
    }

    private isStripeResourceMissing(error: unknown): boolean {
        const stripeError = error as { code?: string; statusCode?: number; type?: string } | null;
        return stripeError?.code === 'resource_missing' || stripeError?.statusCode === 404;
    }

    private getPeriodEndFromSubscription(
        subscription: Stripe.Subscription,
        expectedBaseItemId?: string | null,
    ): string | null {
        const baseItem = this.getBaseItem(subscription, expectedBaseItemId);
        return baseItem?.current_period_end
            ? new Date(baseItem.current_period_end * 1000).toISOString()
            : null;
    }

    private async getPaymentMethodType(
        stripe: Stripe,
        paymentMethod: string | Stripe.PaymentMethod | null | undefined,
    ): Promise<string | null> {
        if (!paymentMethod) {
            return null;
        }

        if (typeof paymentMethod !== 'string') {
            return paymentMethod.type || null;
        }

        const stripePaymentMethod = await stripe.paymentMethods.retrieve(paymentMethod);
        return stripePaymentMethod.type || null;
    }

    private async getSubscriptionPaymentMethod(
        stripe: Stripe,
        subscription: Stripe.Subscription,
        latestInvoice?: Stripe.Invoice | null,
    ): Promise<Stripe.PaymentMethod | null> {
        const paymentIntent = (latestInvoice as any)?.payment_intent as
            | Stripe.PaymentIntent
            | null
            | undefined;
        const paymentMethodRef =
            paymentIntent?.payment_method
            || subscription.default_payment_method
            || null;

        if (paymentMethodRef) {
            if (typeof paymentMethodRef !== 'string') {
                return paymentMethodRef as Stripe.PaymentMethod;
            }

            const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodRef);
            return 'deleted' in paymentMethod ? null : paymentMethod;
        }

        const customerId = typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer?.id;

        if (!customerId) {
            return null;
        }

        const stripeCustomer = await stripe.customers.retrieve(customerId);
        if ('deleted' in stripeCustomer && stripeCustomer.deleted) {
            return null;
        }

        const defaultPaymentMethod =
            stripeCustomer.invoice_settings?.default_payment_method || null;
        if (!defaultPaymentMethod) {
            return null;
        }

        if (typeof defaultPaymentMethod !== 'string') {
            return defaultPaymentMethod as Stripe.PaymentMethod;
        }

        const paymentMethod = await stripe.paymentMethods.retrieve(defaultPaymentMethod);
        return 'deleted' in paymentMethod ? null : paymentMethod;
    }

    private buildBankingPrefillFromPaymentMethod(
        paymentMethod: Stripe.PaymentMethod | null,
    ): { rib_iban: string; rib_bic: string; rib_bank_name: string } | null {
        if (!paymentMethod) {
            return null;
        }

        if (paymentMethod.type === 'card' && paymentMethod.card) {
            const brand = paymentMethod.card.brand || 'carte';
            const last4 = paymentMethod.card.last4 || '';
            const expMonth = String(paymentMethod.card.exp_month || '').padStart(2, '0');
            const expYear = paymentMethod.card.exp_year || '';
            return {
                rib_iban: `Carte ${brand} **** ${last4}`.slice(0, 34),
                rib_bic: `${expMonth}/${expYear}`.slice(0, 11),
                rib_bank_name: 'Carte bancaire',
            };
        }

        if (paymentMethod.type === 'sepa_debit' && paymentMethod.sepa_debit) {
            const sepa = paymentMethod.sepa_debit;
            return {
                rib_iban: `IBAN **** ${sepa.last4 || ''}`.slice(0, 34),
                rib_bic: (sepa.bank_code || sepa.country || 'SEPA').slice(0, 11),
                rib_bank_name: `Prélèvement SEPA${sepa.country ? ` ${sepa.country}` : ''}`.slice(0, 100),
            };
        }

        return null;
    }

    private async prefillCompanyBankingOnce(
        companyId: string | null,
        subscription: Stripe.Subscription,
        latestInvoice?: Stripe.Invoice | null,
    ): Promise<void> {
        if (!companyId) {
            return;
        }

        const supabase = getSupabaseAdmin();
        const { data: company } = await supabase
            .from('companies')
            .select('rib_iban, rib_bic, rib_bank_name')
            .eq('id', companyId)
            .maybeSingle();

        if (
            !company
            || company.rib_iban
            || company.rib_bic
            || company.rib_bank_name
        ) {
            return;
        }

        const paymentMethod = await this.getSubscriptionPaymentMethod(
            this.ensureStripe(),
            subscription,
            latestInvoice,
        );
        const bankingPrefill = this.buildBankingPrefillFromPaymentMethod(paymentMethod);
        if (!bankingPrefill) {
            return;
        }

        await supabase
            .from('companies')
            .update(bankingPrefill)
            .eq('id', companyId);
    }

    private async prefillCompanyBankingBySubscriptionId(
        stripeSubscriptionId: string,
    ): Promise<void> {
        const stripe = this.ensureStripe();
        const supabase = getSupabaseAdmin();
        const { data: localSubscription } = await supabase
            .from('subscriptions')
            .select('company_id')
            .eq('stripe_subscription_id', stripeSubscriptionId)
            .maybeSingle();

        if (!localSubscription?.company_id) {
            return;
        }

        const stripeSubscription = await stripe.subscriptions.retrieve(
            stripeSubscriptionId,
            { expand: ['latest_invoice.payment_intent'] },
        );
        await this.prefillCompanyBankingOnce(
            localSubscription.company_id,
            stripeSubscription,
            stripeSubscription.latest_invoice as Stripe.Invoice | null,
        );
    }

    private getLatestInvoiceClientSecret(
        latestInvoice: Stripe.Invoice | null,
    ): string | null {
        const confirmationSecret = (latestInvoice as any)?.confirmation_secret as
            | { client_secret?: string | null }
            | null
            | undefined;
        if (confirmationSecret?.client_secret) {
            return confirmationSecret.client_secret;
        }

        const paymentIntent = (latestInvoice as any)?.payment_intent as
            | Stripe.PaymentIntent
            | null
            | undefined;
        if (
            paymentIntent?.client_secret
            && ['requires_action', 'requires_confirmation', 'requires_payment_method'].includes(paymentIntent.status)
        ) {
            return paymentIntent.client_secret;
        }

        return null;
    }

    private async resolvePlanIdFromStripeBasePrice(
        supabase: ReturnType<typeof getSupabaseAdmin>,
        baseItem: Stripe.SubscriptionItem | undefined,
        billingPeriod: 'monthly' | 'yearly',
    ): Promise<string | null> {
        const lookupKey = baseItem?.price?.lookup_key;
        if (!lookupKey) {
            return null;
        }

        const lookupColumn = billingPeriod === 'yearly'
            ? 'stripe_lookup_key_yearly'
            : 'stripe_lookup_key_monthly';
        const { data: plan } = await supabase
            .from('subscription_plans')
            .select('id')
            .eq(lookupColumn, lookupKey)
            .eq('is_active', true)
            .maybeSingle();

        return plan?.id || null;
    }

    private async getDefaultSubscriptionPaymentMethodType(
        stripe: Stripe,
        stripeSubscriptionId: string,
    ): Promise<string | null> {
        const stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);

        const subscriptionPaymentMethodType = await this.getPaymentMethodType(
            stripe,
            stripeSubscription.default_payment_method as string | Stripe.PaymentMethod | null | undefined,
        );

        if (subscriptionPaymentMethodType) {
            return subscriptionPaymentMethodType;
        }

        const customerId = typeof stripeSubscription.customer === 'string'
            ? stripeSubscription.customer
            : stripeSubscription.customer?.id;

        if (!customerId) {
            return null;
        }

        const stripeCustomer = await stripe.customers.retrieve(customerId);
        if ('deleted' in stripeCustomer && stripeCustomer.deleted) {
            return null;
        }

        return this.getPaymentMethodType(
            stripe,
            stripeCustomer.invoice_settings?.default_payment_method as
                | string
                | Stripe.PaymentMethod
                | null
                | undefined,
        );
    }

    private getMemberItemBillingParams(
        paymentMethodType: string | null,
        isIncreasingQuantity: boolean,
    ): {
        proration_behavior: 'always_invoice' | 'create_prorations';
        payment_behavior?: 'pending_if_incomplete';
    } {
        if (!isIncreasingQuantity) {
            return {
                proration_behavior: 'create_prorations',
            };
        }

        if (paymentMethodType === 'sepa_debit') {
            return {
                proration_behavior: 'always_invoice',
            };
        }

        return {
            proration_behavior: 'always_invoice',
            payment_behavior: 'pending_if_incomplete',
        };
    }

    private async ensureRegistrationEmailAvailable(
        supabase: any,
        email: string,
    ): Promise<void> {
        const normalizedEmail = this.normalizeEmail(email);
        const { data: existingProfile, error } = await supabase
            .from('profiles')
            .select('id')
            .ilike('email', normalizedEmail)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') {
            throw new BadRequestException(error.message);
        }

        if (existingProfile) {
            throw new BadRequestException(
                'Un compte existe déjà avec cet email. Connectez-vous ou réinitialisez votre mot de passe.',
            );
        }
    }

    private async ensureRegistrationCompanyAvailable(
        supabase: any,
        siren?: string,
        siret?: string,
        country?: string,
    ): Promise<void> {
        const normalized = normalizeBusinessIdentifiers({
            siren,
            siret,
            country,
        });

        if (!normalized.siren) {
            throw new BadRequestException(
                'Le SIREN doit contenir 9 chiffres ou le SIRET 14 chiffres',
            );
        }

        const { data: existingCompany, error } = await supabase
            .from('companies')
            .select('id')
            .eq('siren', normalized.siren)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') {
            throw new BadRequestException(error.message);
        }

        if (existingCompany) {
            throw new BadRequestException(
                `Cette entreprise est déjà associée à un compte SENED. Si vous pensez devoir y accéder, contactez ${REGISTRATION_SUPPORT_EMAIL}.`,
            );
        }
    }

    private async cancelExistingRegistrationSessions(
        supabase: any,
        email: string,
    ): Promise<void> {
        const normalizedEmail = this.normalizeEmail(email);
        const { data: sessions, error } = await supabase
            .from('registration_payment_sessions')
            .select('id, stripe_subscription_id, finalized_user_id, status')
            .ilike('email', normalizedEmail)
            .is('finalized_user_id', null);

        if (error) {
            throw new BadRequestException(error.message);
        }

        if (!sessions || sessions.length === 0) {
            return;
        }

        const stripe = this.ensureStripe();

        for (const session of sessions) {
            if (session.stripe_subscription_id) {
                const stripeSubscription = await stripe.subscriptions.retrieve(
                    session.stripe_subscription_id,
                    { expand: ['latest_invoice.payment_intent'] },
                );

                if (['active', 'trialing'].includes(stripeSubscription.status)) {
                    const { data: fullSession } = await supabase
                        .from('registration_payment_sessions')
                        .select('*')
                        .eq('id', session.id)
                        .maybeSingle();

                    if (fullSession) {
                        const outcome = await this.finalizeRegistrationSessionRecord(
                            fullSession as RegistrationPaymentSessionRecord,
                        );

                        if (outcome === 'completed') {
                            throw new BadRequestException(
                                'Votre paiement a déjà été confirmé. Vérifiez votre email pour activer votre compte.',
                            );
                        }

                        throw new BadRequestException(
                            'Un paiement est déjà en cours de confirmation pour cette adresse email.',
                        );
                    }
                }

                try {
                    await stripe.subscriptions.cancel(session.stripe_subscription_id);
                } catch (stripeError: any) {
                    if (stripeError?.code !== 'resource_missing') {
                        console.error('Erreur annulation session inscription Stripe:', stripeError);
                    }
                }
            }

            await supabase
                .from('registration_payment_sessions')
                .update({
                    status: session.status === 'completed' ? 'completed' : 'cancelled',
                    stripe_subscription_id: null,
                    stripe_base_item_id: null,
                    stripe_member_item_id: null,
                })
                .eq('id', session.id);
        }
    }

    private buildRegistrationMetadata(
        dto: CreateRegistrationSubscriptionDto,
    ): Record<string, any> {
        return {
            full_name: `${dto.first_name} ${dto.last_name}`.trim(),
            first_name: dto.first_name,
            last_name: dto.last_name,
            phone: dto.phone || null,
            company_creation_mode: dto.company_creation_mode || 'create',
            company_name: dto.company_name,
            siren: dto.siren,
            address: dto.address || null,
            postal_code: dto.postal_code || null,
            city: dto.city || null,
            country: dto.country || 'FR',
            team_size: dto.role === 'merchant_admin' ? dto.team_size || null : null,
            role: dto.role,
            accountant_siren: dto.accountant_siren || null,
            plan_slug: dto.plan_slug,
            promotion_code: this.normalizePromotionCode(dto.promotion_code),
            platform_legal_accepted_at: dto.platform_legal_accepted_at,
        };
    }

    private normalizePendingCompanyData(
        companyData?: CreateCompanyDto | null,
    ): CreateCompanyDto {
        const normalized = {
            ...(companyData || {}),
            owner_role: 'merchant_admin' as const,
        };

        if (!normalized.country) {
            normalized.country = 'FR';
        }

        return normalized as CreateCompanyDto;
    }

    private cleanStripeCustomerValue(value?: string | null): string | undefined {
        const trimmed = value?.trim();
        return trimmed || undefined;
    }

    private buildStripeCustomerAddress(
        details?: StripeCustomerBillingDetails | null,
    ): NonNullable<Stripe.CustomerCreateParams['address']> | undefined {
        const address = details?.address;
        if (!address) {
            return undefined;
        }

        const country = this.cleanStripeCustomerValue(address.country)?.toUpperCase();
        const stripeAddress = {
            line1: this.cleanStripeCustomerValue(address.line1),
            city: this.cleanStripeCustomerValue(address.city),
            postal_code: this.cleanStripeCustomerValue(address.postal_code),
            country: country || undefined,
        };

        return Object.values(stripeAddress).some(Boolean)
            ? stripeAddress
            : undefined;
    }

    private buildStripeCustomerParams(
        details?: StripeCustomerBillingDetails | null,
    ): Pick<Stripe.CustomerCreateParams, 'email' | 'name' | 'address'> {
        return {
            email: this.cleanStripeCustomerValue(details?.email),
            name: this.cleanStripeCustomerValue(details?.name),
            address: this.buildStripeCustomerAddress(details),
        };
    }

    private async updateStripeCustomerBillingDetails(
        stripe: Stripe,
        customerId: string,
        details?: StripeCustomerBillingDetails | null,
    ): Promise<void> {
        const params = this.buildStripeCustomerParams(details);
        const updateParams: Stripe.CustomerUpdateParams = {};

        if (params.email) {
            updateParams.email = params.email;
        }
        if (params.name) {
            updateParams.name = params.name;
        }
        if (params.address) {
            updateParams.address = params.address;
        }

        if (Object.keys(updateParams).length > 0) {
            await stripe.customers.update(customerId, updateParams);
        }
    }

    private async getPendingCompanyAccountantName(
        accountantCompanyId?: string | null,
    ): Promise<string | null> {
        if (!accountantCompanyId) {
            return null;
        }

        const supabase = getSupabaseAdmin();
        const { data } = await supabase
            .from('companies')
            .select('name')
            .eq('id', accountantCompanyId)
            .maybeSingle();

        return data?.name || null;
    }

    private async buildPendingCompanySummary(
        companyData: CreateCompanyDto,
    ): Promise<CompanyCreationSummaryDto> {
        const normalized = this.normalizePendingCompanyData(companyData);
        const accountantCompanyName = await this.getPendingCompanyAccountantName(
            normalized.source_accountant_company_id,
        );

        return {
            name: normalized.name,
            legal_name: normalized.legal_name || null,
            siren: normalized.siren || null,
            address: normalized.address || null,
            postal_code: normalized.postal_code || null,
            city: normalized.city || null,
            country: normalized.country || 'FR',
            email: normalized.email || null,
            phone: normalized.phone || null,
            source_accountant_company_id:
                normalized.source_accountant_company_id || null,
            accountant_company_name: accountantCompanyName,
        };
    }

    private async getPendingCompanySessionForUser(
        userId: string,
        sessionId: string,
    ): Promise<PendingCompanyPaymentSessionRecord> {
        const supabase = getSupabaseAdmin();
        const { data: session, error } = await supabase
            .from('pending_company_payment_sessions')
            .select('*')
            .eq('id', sessionId)
            .eq('user_id', userId)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') {
            throw new BadRequestException(error.message);
        }

        if (!session) {
            throw new NotFoundException('Session de création d’entreprise introuvable.');
        }

        return session as PendingCompanyPaymentSessionRecord;
    }

    private async getPendingCompanySessionByStripeSubscriptionId(
        subscriptionId: string,
    ): Promise<PendingCompanyPaymentSessionRecord | null> {
        const supabase = getSupabaseAdmin();
        const { data: session, error } = await supabase
            .from('pending_company_payment_sessions')
            .select('*')
            .eq('stripe_subscription_id', subscriptionId)
            .is('finalized_company_id', null)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') {
            throw new BadRequestException(error.message);
        }

        return (session as PendingCompanyPaymentSessionRecord | null) || null;
    }

    private async getPendingCompanySessionSummary(
        session: PendingCompanyPaymentSessionRecord,
    ): Promise<PendingCompanyPaymentSessionSummaryDto> {
        let company: CompanyWithRoleResponseDto | null = null;
        if (session.finalized_company_id) {
            try {
                company = await this.companyService.findOne(
                    session.user_id,
                    session.finalized_company_id,
                );
            } catch {
                company = null;
            }
        }

        return {
            session_id: session.id,
            status: session.status,
            plan_slug: session.plan_slug,
            billing_period: session.billing_period,
            company_summary: await this.buildPendingCompanySummary(
                session.company_data || {},
            ),
            finalized_company_id: session.finalized_company_id,
            company,
        };
    }

    private async cancelPendingCompanyStripeSubscription(
        session: PendingCompanyPaymentSessionRecord,
    ): Promise<void> {
        if (!this.isStripeEnabled() || !session.stripe_subscription_id) {
            return;
        }

        const stripe = this.ensureStripe();
        try {
            await stripe.subscriptions.cancel(session.stripe_subscription_id);
        } catch (error: any) {
            if (error?.code !== 'resource_missing') {
                console.error(
                    'Erreur annulation abonnement société en attente:',
                    error,
                );
            }
        }
    }

    private async getOrCreateStripeCustomerForUser(
        stripe: Stripe,
        supabase: any,
        userId: string,
        options?: {
            existingCustomerId?: string | null;
            companyName?: string | null;
            billingDetails?: StripeCustomerBillingDetails | null;
        },
    ): Promise<string> {
        if (options?.existingCustomerId) {
            await this.updateStripeCustomerBillingDetails(
                stripe,
                options.existingCustomerId,
                options.billingDetails,
            );
            return options.existingCustomerId;
        }

        const { data: existingSubscription } = await supabase
            .from('subscriptions')
            .select('stripe_customer_id')
            .eq('user_id', userId)
            .not('stripe_customer_id', 'is', null)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (existingSubscription?.stripe_customer_id) {
            await this.updateStripeCustomerBillingDetails(
                stripe,
                existingSubscription.stripe_customer_id,
                options?.billingDetails,
            );
            return existingSubscription.stripe_customer_id;
        }

        const { data: existingPendingSession } = await supabase
            .from('pending_company_payment_sessions')
            .select('stripe_customer_id')
            .eq('user_id', userId)
            .not('stripe_customer_id', 'is', null)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (existingPendingSession?.stripe_customer_id) {
            await this.updateStripeCustomerBillingDetails(
                stripe,
                existingPendingSession.stripe_customer_id,
                options?.billingDetails,
            );
            return existingPendingSession.stripe_customer_id;
        }

        const { data: profile } = await supabase
            .from('profiles')
            .select('email, first_name, last_name')
            .eq('id', userId)
            .single();

        const customerParams = this.buildStripeCustomerParams({
            email: profile?.email,
            name:
                options?.companyName
                || [profile?.first_name, profile?.last_name].filter(Boolean).join(' ')
                || undefined,
            address: options?.billingDetails?.address,
        });

        const customer = await stripe.customers.create({
            ...customerParams,
            metadata: { user_id: userId },
        });

        return customer.id;
    }

    private buildSimplePlanPricing(
        plan: SubscriptionPlanDto,
        billingPeriod: 'monthly' | 'yearly',
    ): RegistrationPricingDto {
        const amount = billingPeriod === 'yearly'
            ? Number(plan.price_yearly || 0)
            : Number(plan.price_monthly || 0);

        return {
            original_amount_ht: Number(amount.toFixed(2)),
            discount_amount_ht: 0,
            final_amount_ht: Number(amount.toFixed(2)),
            currency: 'EUR',
            promotion_code: null,
            coupon_name: null,
            coupon_percent_off: null,
            coupon_amount_off: null,
        };
    }

    private async upsertPendingCompanyLocalSubscription(
        companyId: string,
        userId: string,
        session: PendingCompanyPaymentSessionRecord,
        stripeSubscription: Stripe.Subscription | null,
    ): Promise<void> {
        const supabase = getSupabaseAdmin();
        const baseItem = stripeSubscription
            ? this.getBaseItem(stripeSubscription, session.stripe_base_item_id)
            : undefined;
        const memberItem = stripeSubscription
            ? stripeSubscription.items.data.find((item) => item.id !== baseItem?.id)
            : undefined;
        const payload = {
            user_id: userId,
            company_id: companyId,
            plan_id: session.plan_id,
            stripe_customer_id:
                session.stripe_customer_id
                || (typeof stripeSubscription?.customer === 'string'
                    ? stripeSubscription.customer
                    : stripeSubscription?.customer?.id || null),
            stripe_subscription_id: session.stripe_subscription_id,
            stripe_base_item_id: baseItem?.id || session.stripe_base_item_id,
            stripe_member_item_id: memberItem?.id || null,
            extra_members_quantity: memberItem?.quantity || 0,
            billing_period:
                (baseItem?.price?.recurring?.interval === 'year'
                    ? 'yearly'
                    : session.billing_period || 'monthly') as 'monthly' | 'yearly',
            status: stripeSubscription
                ? this.mapStripeStatus(stripeSubscription.status)
                : 'active',
            current_period_start: new Date().toISOString(),
            current_period_end: stripeSubscription
                ? this.getPeriodEndFromSubscription(
                    stripeSubscription,
                    session.stripe_base_item_id,
                )
                : null,
            updated_at: new Date().toISOString(),
        };

        const { data: existingSubscription } = await supabase
            .from('subscriptions')
            .select('id')
            .eq('company_id', companyId)
            .maybeSingle();

        if (existingSubscription?.id) {
            const { error } = await supabase
                .from('subscriptions')
                .update(payload)
                .eq('company_id', companyId);

            if (error) {
                throw new BadRequestException(error.message);
            }

            return;
        }

        const { error } = await supabase
            .from('subscriptions')
            .insert({
                ...payload,
                created_at: new Date().toISOString(),
            });

        if (error) {
            throw new BadRequestException(error.message);
        }
    }

    private normalizePendingCompanyPromotionError(error: any): never {
        throw new BadRequestException(
            error instanceof BadRequestException
                ? INVALID_PROMO_CODE_MESSAGE
                : INVALID_PROMO_CODE_MESSAGE,
        );
    }

    private async loadPromotionCoupon(
        stripe: Stripe,
        promotionCode: any,
    ): Promise<any> {
        const couponRef = promotionCode?.coupon ?? promotionCode?.promotion?.coupon;
        if (!couponRef) {
            throw new BadRequestException('Ce code promo ne peut pas être appliqué.');
        }

        if (typeof couponRef !== 'string') {
            return couponRef;
        }

        return stripe.coupons.retrieve(couponRef);
    }

    private ensurePromotionCodeStillValid(
        promotionCode: any,
        coupon: any,
        amountMinor: number,
        currency: string,
        productId: string | null,
    ): void {
        if (!promotionCode?.active) {
            throw new BadRequestException('Ce code promo est invalide ou expiré.');
        }

        if (promotionCode?.expires_at && promotionCode.expires_at * 1000 < Date.now()) {
            throw new BadRequestException('Ce code promo a expiré.');
        }

        if (
            promotionCode?.max_redemptions != null
            && promotionCode?.times_redeemed != null
            && promotionCode.times_redeemed >= promotionCode.max_redemptions
        ) {
            throw new BadRequestException('Ce code promo a déjà atteint sa limite d’utilisation.');
        }

        if (promotionCode?.customer) {
            throw new BadRequestException('Ce code promo ne peut pas être utilisé pour cette inscription.');
        }

        if (coupon?.valid === false) {
            throw new BadRequestException('Ce code promo est invalide ou expiré.');
        }

        if (coupon?.redeem_by && coupon.redeem_by * 1000 < Date.now()) {
            throw new BadRequestException('Ce code promo a expiré.');
        }

        const minimumAmount = promotionCode?.restrictions?.minimum_amount;
        const minimumAmountCurrency = promotionCode?.restrictions?.minimum_amount_currency;
        if (
            typeof minimumAmount === 'number'
            && amountMinor < minimumAmount
            && (!minimumAmountCurrency || minimumAmountCurrency.toLowerCase() === currency.toLowerCase())
        ) {
            throw new BadRequestException('Ce code promo ne s’applique pas à ce plan.');
        }

        const couponCurrency = coupon?.currency;
        if (
            typeof coupon?.amount_off === 'number'
            && couponCurrency
            && couponCurrency.toLowerCase() !== currency.toLowerCase()
        ) {
            throw new BadRequestException('Ce code promo ne s’applique pas à ce plan.');
        }

        const allowedProducts = coupon?.applies_to?.products;
        if (
            Array.isArray(allowedProducts)
            && allowedProducts.length > 0
            && productId
            && !allowedProducts.includes(productId)
        ) {
            throw new BadRequestException('Ce code promo ne s’applique pas à ce plan.');
        }
    }

    private computeDiscountAmountMinor(
        coupon: any,
        originalAmountMinor: number,
    ): number {
        if (typeof coupon?.amount_off === 'number') {
            return Math.max(0, Math.min(originalAmountMinor, coupon.amount_off));
        }

        if (typeof coupon?.percent_off === 'number') {
            return Math.max(
                0,
                Math.min(
                    originalAmountMinor,
                    Math.round((originalAmountMinor * coupon.percent_off) / 100),
                ),
            );
        }

        return 0;
    }

    private async resolveRegistrationPricingContext(
        planSlug: string,
        billingPeriod: 'monthly' | 'yearly',
        promotionCodeInput?: string | null,
    ): Promise<ResolvedRegistrationPricingContext> {
        const supabase = getSupabaseAdmin();
        const stripe = this.ensureStripe();

        const { data: plan, error: planError } = await supabase
            .from('subscription_plans')
            .select('*')
            .eq('slug', planSlug)
            .eq('is_active', true)
            .single();

        if (planError || !plan) {
            throw new NotFoundException(`Plan "${planSlug}" non trouvé`);
        }

        if (Number(plan.price_monthly || 0) === 0 && Number(plan.price_yearly || 0) === 0) {
            throw new BadRequestException('Ce plan ne nécessite pas de paiement.');
        }

        const baseLookupKey = this.resolveLookupKey(plan, billingPeriod);
        const basePrice = await this.resolveStripePrice(stripe, baseLookupKey);

        if (typeof basePrice.unit_amount !== 'number') {
            throw new BadRequestException(
                'Le tarif Stripe de cet abonnement est incomplet. Vérifiez la configuration de facturation.',
            );
        }

        const normalizedPromotionCode = this.normalizePromotionCode(promotionCodeInput);
        if (!normalizedPromotionCode) {
            return {
                plan,
                basePriceId: basePrice.id,
                basePrice,
                pricing: this.buildRegistrationPricing(
                    basePrice.unit_amount,
                    0,
                    basePrice.currency,
                ),
                stripePromotionCodeId: null,
            };
        }

        const promotionCodes = await stripe.promotionCodes.list({
            code: normalizedPromotionCode,
            active: true,
            limit: 10,
        });

        const matchedPromotionCode = promotionCodes.data.find(
            (promotionCode) =>
                promotionCode.code?.trim().toLowerCase()
                === normalizedPromotionCode.toLowerCase(),
        );

        if (!matchedPromotionCode) {
            throw new BadRequestException(
                'Ce code promo est introuvable dans l’environnement Stripe configuré sur ce serveur. Vérifiez qu’il a été créé sur le même compte et dans le même mode (test/live).',
            );
        }

        const coupon = await this.loadPromotionCoupon(stripe, matchedPromotionCode);
        const productId = typeof basePrice.product === 'string'
            ? basePrice.product
            : basePrice.product?.id || null;

        this.ensurePromotionCodeStillValid(
            matchedPromotionCode,
            coupon,
            basePrice.unit_amount,
            basePrice.currency,
            productId,
        );

        const discountAmountMinor = this.computeDiscountAmountMinor(
            coupon,
            basePrice.unit_amount,
        );

        return {
            plan,
            basePriceId: basePrice.id,
            basePrice,
            pricing: this.buildRegistrationPricing(
                basePrice.unit_amount,
                discountAmountMinor,
                basePrice.currency,
                {
                    promotionCode: matchedPromotionCode.code || normalizedPromotionCode,
                    couponName: coupon?.name || null,
                    couponPercentOff: coupon?.percent_off ?? null,
                    couponAmountOff: coupon?.amount_off ?? null,
                },
            ),
            stripePromotionCodeId: matchedPromotionCode.id,
        };
    }

    private async createSupabaseUserForPaidRegistration(
        session: RegistrationPaymentSessionRecord,
    ): Promise<{ id: string; email: string }> {
        const normalizedEmail = this.normalizeEmail(session.email);
        const supabase = getSupabaseAdmin();

        const { data: existingProfile } = await supabase
            .from('profiles')
            .select('id, email')
            .ilike('email', normalizedEmail)
            .maybeSingle();

        if (existingProfile?.id) {
            return { id: existingProfile.id, email: existingProfile.email };
        }

        const signupClient = getSupabaseClient();
        const metadata = session.registration_data || {};
        const password = decryptRegistrationSecret(session.encrypted_password);
        const frontendUrl =
            (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173').replace(/\/+$/, '');

        const { data, error } = await signupClient.auth.signUp({
            email: normalizedEmail,
            password,
            options: {
                data: metadata,
                emailRedirectTo: `${frontendUrl}/auth/login`,
            },
        });

        if (error) {
            if (/already registered/i.test(error.message)) {
                const { data: profileAfterConflict } = await supabase
                    .from('profiles')
                    .select('id, email')
                    .ilike('email', normalizedEmail)
                    .maybeSingle();

                if (profileAfterConflict?.id) {
                    return {
                        id: profileAfterConflict.id,
                        email: profileAfterConflict.email,
                    };
                }
            }

            throw new BadRequestException(error.message);
        }

        const userId = data.user?.id;
        if (!userId) {
            throw new BadRequestException(
                'Impossible de créer le compte après le paiement. Contactez le support.',
            );
        }

        await this.legalDocumentService.recordPlatformAcceptanceForUser(
            userId,
            metadata.platform_legal_accepted_at,
        );

        return {
            id: userId,
            email: normalizedEmail,
        };
    }

    private async attachStripeSubscriptionToUser(
        session: RegistrationPaymentSessionRecord,
        userId: string,
        subscription: Stripe.Subscription,
    ): Promise<void> {
        const supabase = getSupabaseAdmin();
        const { data: createdCompanies } = await supabase
            .from('companies')
            .select('id')
            .eq('owner_id', userId)
            .order('created_at', { ascending: false })
            .limit(1);
        const targetCompanyId = createdCompanies?.[0]?.id || null;
        if (!targetCompanyId) {
            throw new BadRequestException(
                'Impossible de rattacher l’abonnement à une entreprise après l’inscription.',
            );
        }

        const baseItem = this.getBaseItem(subscription, session.stripe_base_item_id);
        const memberItem = subscription.items.data.find((item) => item.id !== baseItem?.id);
        const billingPeriod = baseItem?.price?.recurring?.interval === 'year' ? 'yearly' : session.billing_period;

        const { data: existingSubscription } = await supabase
            .from('subscriptions')
            .select('id')
            .eq('company_id', targetCompanyId)
            .maybeSingle();

        const payload = {
            plan_id: session.plan_id,
            stripe_customer_id: session.stripe_customer_id,
            stripe_subscription_id: session.stripe_subscription_id,
            stripe_base_item_id: baseItem?.id || session.stripe_base_item_id,
            stripe_member_item_id: memberItem?.id || null,
            extra_members_quantity: memberItem?.quantity || 0,
            billing_period: billingPeriod,
            status: this.mapStripeStatus(subscription.status),
            current_period_start: new Date().toISOString(),
            current_period_end: this.getPeriodEndFromSubscription(subscription, session.stripe_base_item_id),
            updated_at: new Date().toISOString(),
        };

        if (existingSubscription?.id) {
            const { error } = await supabase
                .from('subscriptions')
                .update(payload)
                .eq('company_id', targetCompanyId);

            if (error) {
                throw new BadRequestException(error.message);
            }

            return;
        }

        const { error } = await supabase
            .from('subscriptions')
            .insert({
                user_id: userId,
                company_id: targetCompanyId,
                ...payload,
                created_at: new Date().toISOString(),
            });

        if (error) {
            throw new BadRequestException(error.message);
        }
    }

    private async finalizeRegistrationSessionRecord(
        session: RegistrationPaymentSessionRecord,
    ): Promise<'completed' | 'processing'> {
        const stripe = this.ensureStripe();
        const supabase = getSupabaseAdmin();

        if (!session.stripe_subscription_id) {
            throw new BadRequestException('Session de paiement invalide.');
        }

        if (session.finalized_user_id) {
            return 'completed';
        }

        const stripeSubscription = await stripe.subscriptions.retrieve(
            session.stripe_subscription_id,
            { expand: ['latest_invoice.payment_intent'] },
        );
        const latestInvoice = stripeSubscription.latest_invoice as Stripe.Invoice | null;

        if (!this.isStripePaymentSettled(stripeSubscription, latestInvoice)) {
            await supabase
                .from('registration_payment_sessions')
                .update({
                    status: this.mapStripeStatus(stripeSubscription.status),
                })
                .eq('id', session.id);

            return 'processing';
        }

        const user = await this.createSupabaseUserForPaidRegistration(session);
        await this.attachStripeSubscriptionToUser(session, user.id, stripeSubscription);
        const { data: createdCompany } = await supabase
            .from('companies')
            .select('id')
            .eq('owner_id', user.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        await this.prefillCompanyBankingOnce(
            createdCompany?.id || null,
            stripeSubscription,
            latestInvoice,
        );

        await supabase
            .from('registration_payment_sessions')
            .update({
                finalized_user_id: user.id,
                status: 'completed',
            })
            .eq('id', session.id);

        return 'completed';
    }

    private async finalizePendingCompanySessionRecord(
        session: PendingCompanyPaymentSessionRecord,
    ): Promise<{ status: 'completed' | 'processing'; company_id: string | null }> {
        const supabase = getSupabaseAdmin();

        if (session.finalized_company_id) {
            return {
                status: 'completed',
                company_id: session.finalized_company_id,
            };
        }

        const companyData = this.normalizePendingCompanyData(session.company_data);
        if (!companyData.name?.trim()) {
            throw new BadRequestException(
                'Les informations de l’entreprise à créer sont incomplètes.',
            );
        }

        if (!session.plan_id) {
            throw new BadRequestException(
                'Aucun forfait n’a encore été sélectionné pour cette entreprise.',
            );
        }

        if (!this.isStripeEnabled() || !session.stripe_subscription_id) {
            const company = await this.companyService.create(
                session.user_id,
                companyData,
            );

            await this.upsertPendingCompanyLocalSubscription(
                company.id,
                session.user_id,
                session,
                null,
            );

            await supabase
                .from('pending_company_payment_sessions')
                .update({
                    finalized_company_id: company.id,
                    status: 'completed',
                })
                .eq('id', session.id);

            return {
                status: 'completed',
                company_id: company.id,
            };
        }

        const stripe = this.ensureStripe();
        const stripeSubscription = await stripe.subscriptions.retrieve(
            session.stripe_subscription_id,
            { expand: ['latest_invoice.payment_intent'] },
        );
        const latestInvoice = stripeSubscription.latest_invoice as Stripe.Invoice | null;

        if (!this.isStripePaymentSettled(stripeSubscription, latestInvoice)) {
            await supabase
                .from('pending_company_payment_sessions')
                .update({
                    status: this.mapStripeStatus(stripeSubscription.status),
                })
                .eq('id', session.id);

            return {
                status: 'processing',
                company_id: null,
            };
        }

        const company = await this.companyService.create(
            session.user_id,
            companyData,
        );

        await this.upsertPendingCompanyLocalSubscription(
            company.id,
            session.user_id,
            session,
            stripeSubscription,
        );
        await this.prefillCompanyBankingOnce(
            company.id,
            stripeSubscription,
            latestInvoice,
        );

        await supabase
            .from('pending_company_payment_sessions')
            .update({
                finalized_company_id: company.id,
                status: 'completed',
            })
            .eq('id', session.id);

        return {
            status: 'completed',
            company_id: company.id,
        };
    }

    private async getAvailablePlansFromDb(supabase: any): Promise<SubscriptionPlanDto[]> {
        const { data, error } = await supabase
            .from('subscription_plans')
            .select('*')
            .eq('is_active', true)
            .order('price_monthly', { ascending: true });

        if (error) {
            throw new Error(`Erreur: ${error.message}`);
        }

        return data as SubscriptionPlanDto[];
    }

    private pickDefaultBypassPlan(plans: SubscriptionPlanDto[]): SubscriptionPlanDto | null {
        return plans.find((plan) => plan.slug === 'essentiel') || plans[0] || null;
    }

    private async getRawSubscriptionForCompany(
        supabase: any,
        companyId: string | null,
    ): Promise<any | null> {
        if (!companyId) {
            return null;
        }

        const { data: subscription, error } = await supabase
            .from('subscriptions')
            .select('*')
            .eq('company_id', companyId)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') {
            throw new Error(`Erreur lors de la récupération de l'abonnement: ${error.message}`);
        }

        return subscription;
    }

    private async getRawSubscriptionForUser(supabase: any, userId: string): Promise<any | null> {
        const { data: subscriptions, error } = await supabase
            .from('subscriptions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(1);

        if (error && error.code !== 'PGRST116') {
            throw new Error(`Erreur lors de la récupération de l'abonnement: ${error.message}`);
        }

        return subscriptions?.[0] || null;
    }

    private async ensureBypassSubscriptionForCompany(
        supabase: any,
        ownerUserId: string | null,
        companyId: string | null,
        userId: string | null,
        plans: SubscriptionPlanDto[],
        existingSubscription?: any | null,
    ): Promise<any | null> {
        if (!userId) {
            return existingSubscription || null;
        }

        const subscription = existingSubscription ?? await this.getRawSubscriptionForCompany(supabase, companyId);
        if (this.isStripeEnabled()) {
            return subscription;
        }

        const shouldRepair = !subscription || !hasUsableSubscription(subscription);
        if (!shouldRepair) {
            return subscription;
        }

        const defaultPlan = this.pickDefaultBypassPlan(plans);
        if (!defaultPlan) {
            return subscription;
        }

        const payload = {
            plan_id: defaultPlan.id,
            status: 'active',
            updated_at: new Date().toISOString(),
        };

        if (subscription?.id) {
            await supabase
                .from('subscriptions')
                .update(payload)
                .eq('id', subscription.id);

            return {
                ...subscription,
                ...payload,
            };
        }

        const insertedSubscription = {
            user_id: ownerUserId || userId,
            company_id: companyId,
            plan_id: defaultPlan.id,
            status: 'active',
            extra_members_quantity: 0,
            billing_period: 'monthly',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        const { data: createdSubscription, error } = await supabase
            .from('subscriptions')
            .insert(insertedSubscription)
            .select('*')
            .single();

        if (error) {
            throw new Error(`Erreur lors de la création de l'abonnement bypass: ${error.message}`);
        }

        return createdSubscription;
    }

    private async hydrateSubscription(
        supabase: any,
        subscription: any | null,
    ): Promise<SubscriptionDto | null> {
        if (!subscription) {
            return null;
        }

        let plan: SubscriptionPlanDto | null = null;
        if (subscription.plan_id) {
            const { data: planData } = await supabase
                .from('subscription_plans')
                .select('*')
                .eq('id', subscription.plan_id)
                .single();
            plan = planData;
        }

        return {
            ...subscription,
            billing_period: subscription.billing_period || 'monthly',
            extra_members_quantity: subscription.extra_members_quantity || 0,
            plan: plan as SubscriptionPlanDto,
        };
    }

    private async getUsageForOwner(supabase: any, ownerUserId: string | null) {
        return this.getUsageForOwnerRole(supabase, ownerUserId, 'merchant_admin');
    }

    private async getOwnedCompanyIdsByOwnerRole(
        supabase: any,
        ownerUserId: string | null,
        ownerRole: 'merchant_admin' | 'accountant',
    ): Promise<string[]> {
        if (!ownerUserId) {
            return [];
        }

        const { data: ownerRelations } = await supabase
            .from('user_companies')
            .select('company_id, company:companies(owner_id)')
            .eq('user_id', ownerUserId)
            .eq('role', ownerRole);

        return (ownerRelations || [])
            .filter((relation: any) => relation.company?.owner_id === ownerUserId)
            .map((relation: any) => relation.company_id);
    }

    private async getUsageForOwnerRole(
        supabase: any,
        ownerUserId: string | null,
        ownerRole: 'merchant_admin' | 'accountant',
    ) {
        if (!ownerUserId) {
            return {
                invoices_this_month: 0,
                quotes_this_month: 0,
                ...buildSubscriptionMemberUsage(0, 0, ownerRole),
            };
        }

        const companyIds = await this.getOwnedCompanyIdsByOwnerRole(
            supabase,
            ownerUserId,
            ownerRole,
        );
        if (companyIds.length === 0) {
            return {
                invoices_this_month: 0,
                quotes_this_month: 0,
                ...buildSubscriptionMemberUsage(0, 0, ownerRole),
            };
        }

        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const { count: invoiceCount } = await supabase
            .from('invoices')
            .select('*', { count: 'exact', head: true })
            .in('company_id', companyIds)
            .gte('created_at', startOfMonth.toISOString());

        const { count: quoteCount } = await supabase
            .from('quotes')
            .select('*', { count: 'exact', head: true })
            .in('company_id', companyIds)
            .gte('created_at', startOfMonth.toISOString());

        const { count: memberCount } = await supabase
            .from('user_companies')
            .select('*', { count: 'exact', head: true })
            .in('company_id', companyIds);

        const { count: billableMemberCount } = await supabase
            .from('user_companies')
            .select('*', { count: 'exact', head: true })
            .in('company_id', companyIds)
            .in('role', ['merchant_admin', 'merchant_consultant']);

        const { count: pendingInvitationCount } = await supabase
            .from('company_invitations')
            .select('*', { count: 'exact', head: true })
            .in('company_id', companyIds)
            .eq('invitation_type', 'member')
            .in('role', ['merchant_admin', 'merchant_consultant'])
            .is('accepted_at', null)
            .gt('expires_at', new Date().toISOString());

        const memberUsage = buildSubscriptionMemberUsage(
            memberCount || 0,
            pendingInvitationCount || 0,
            ownerRole,
            billableMemberCount || 0,
        );

        return {
            invoices_this_month: invoiceCount || 0,
            quotes_this_month: quoteCount || 0,
            ...memberUsage,
        };
    }

    private async getUsageForCompanyRole(
        supabase: any,
        companyId: string | null,
        ownerRole: 'merchant_admin' | 'accountant',
    ) {
        if (!companyId) {
            return {
                invoices_this_month: 0,
                quotes_this_month: 0,
                ...buildSubscriptionMemberUsage(0, 0, ownerRole),
            };
        }

        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const { count: invoiceCount } = await supabase
            .from('invoices')
            .select('*', { count: 'exact', head: true })
            .eq('company_id', companyId)
            .gte('created_at', startOfMonth.toISOString());

        const { count: quoteCount } = await supabase
            .from('quotes')
            .select('*', { count: 'exact', head: true })
            .eq('company_id', companyId)
            .gte('created_at', startOfMonth.toISOString());

        const { count: memberCount } = await supabase
            .from('user_companies')
            .select('*', { count: 'exact', head: true })
            .eq('company_id', companyId);

        const { count: billableMemberCount } = await supabase
            .from('user_companies')
            .select('*', { count: 'exact', head: true })
            .eq('company_id', companyId)
            .in('role', ['merchant_admin', 'merchant_consultant']);

        const { count: pendingInvitationCount } = await supabase
            .from('company_invitations')
            .select('*', { count: 'exact', head: true })
            .eq('company_id', companyId)
            .eq('invitation_type', 'member')
            .in('role', ['merchant_admin', 'merchant_consultant'])
            .is('accepted_at', null)
            .gt('expires_at', new Date().toISOString());

        return {
            invoices_this_month: invoiceCount || 0,
            quotes_this_month: quoteCount || 0,
            ...buildSubscriptionMemberUsage(
                memberCount || 0,
                pendingInvitationCount || 0,
                ownerRole,
                billableMemberCount || 0,
            ),
        };
    }

    async getSubscriptionWithPlans(userId: string, companyId?: string): Promise<SubscriptionWithPlansDto> {
        const supabase = getSupabaseAdmin();
        const allPlans = await this.getAvailablePlansFromDb(supabase);
        const effectiveTarget = await resolveEffectiveSubscriptionTarget(userId, companyId);

        let subscription = effectiveTarget.subscription_company_id
            ? await this.getRawSubscriptionForCompany(supabase, effectiveTarget.subscription_company_id)
            : null;

        subscription = await this.ensureBypassSubscriptionForCompany(
            supabase,
            effectiveTarget.owner_user_id,
            effectiveTarget.subscription_company_id,
            effectiveTarget.owner_user_id || userId,
            allPlans,
            subscription,
        );

        const usage = await this.getUsageForCompanyRole(
            supabase,
            effectiveTarget.subscription_company_id,
            effectiveTarget.company_owner_role || 'merchant_admin',
        );

        return {
            subscription: await this.hydrateSubscription(supabase, subscription),
            available_plans: allPlans,
            scope: effectiveTarget.scope,
            company_id: effectiveTarget.company_id,
            owner_user_id: effectiveTarget.owner_user_id,
            company_owner_role: effectiveTarget.company_owner_role,
            is_company_linked_to_accountant_cabinet:
                effectiveTarget.is_selected_company_linked_to_accountant_cabinet,
            is_invited_merchant_admin: effectiveTarget.is_invited_merchant_admin,
            can_manage_billing: effectiveTarget.can_manage_billing,
            has_any_active_company_subscription: effectiveTarget.has_any_active_company_subscription,
            usage,
        };
    }

    async getUserSubscription(userId: string): Promise<SubscriptionDto | null> {
        const supabase = getSupabaseAdmin();
        const subscription = await this.getRawSubscriptionForUser(supabase, userId);
        return this.hydrateSubscription(supabase, subscription || null);
    }

    async getAvailablePlans(): Promise<AvailablePlansResponseDto> {
        const supabase = getSupabaseAdmin();
        const plans = await this.getAvailablePlansFromDb(supabase);
        return {
            plans,
            stripe_enabled: this.isStripeEnabled(),
        };
    }

    async getPendingCompanyPaymentSessionSummary(
        userId: string,
        sessionId: string,
    ): Promise<PendingCompanyPaymentSessionSummaryDto> {
        const session = await this.getPendingCompanySessionForUser(userId, sessionId);
        return this.getPendingCompanySessionSummary(session);
    }

    async createPendingCompanySubscription(
        userId: string,
        dto: CreatePendingCompanySubscriptionDto,
    ): Promise<PendingCompanySubscriptionResponseDto> {
        const supabase = getSupabaseAdmin();

        let session: PendingCompanyPaymentSessionRecord | null = null;
        if (dto.session_id) {
            session = await this.getPendingCompanySessionForUser(userId, dto.session_id);
        }

        const companyData = dto.company_data
            ? this.normalizePendingCompanyData(dto.company_data)
            : this.normalizePendingCompanyData(session?.company_data);

        if (!companyData.name?.trim()) {
            throw new BadRequestException(
                'Les informations de l’entreprise à créer sont incomplètes.',
            );
        }

        const normalizedCompanyData = this.normalizePendingCompanyData(companyData);

        if (session?.finalized_company_id) {
            return {
                session_id: session.id,
                subscription_id: session.stripe_subscription_id,
                client_secret: null,
                status: 'completed',
                pricing: null,
                company_summary: await this.buildPendingCompanySummary(
                    normalizedCompanyData,
                ),
            };
        }

        if (!session) {
            const { data: createdSession, error } = await supabase
                .from('pending_company_payment_sessions')
                .insert({
                    user_id: userId,
                    company_data: normalizedCompanyData,
                    status: 'draft',
                })
                .select('*')
                .single();

            if (error || !createdSession) {
                throw new BadRequestException(
                    error?.message
                        || 'Impossible de préparer la création de l’entreprise.',
                );
            }

            session = createdSession as PendingCompanyPaymentSessionRecord;
        } else {
            const { data: updatedSession, error } = await supabase
                .from('pending_company_payment_sessions')
                .update({
                    company_data: normalizedCompanyData,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', session.id)
                .select('*')
                .single();

            if (error || !updatedSession) {
                throw new BadRequestException(
                    error?.message
                        || 'Impossible de mettre à jour la session de création.',
                );
            }

            session = updatedSession as PendingCompanyPaymentSessionRecord;
        }

        const companySummary = await this.buildPendingCompanySummary(
            normalizedCompanyData,
        );

        if (!dto.plan_slug || !dto.billing_period) {
            return {
                session_id: session.id,
                subscription_id: session.stripe_subscription_id,
                client_secret: null,
                status: session.status || 'draft',
                pricing: null,
                company_summary: companySummary,
            };
        }

        if (!this.isStripeEnabled()) {
            const plans = await this.getAvailablePlansFromDb(supabase);
            const plan = plans.find((entry) => entry.slug === dto.plan_slug);
            if (!plan) {
                throw new NotFoundException(`Plan "${dto.plan_slug}" non trouvé`);
            }

            const pricing = this.buildSimplePlanPricing(plan, dto.billing_period);
            const { data: updatedSession, error } = await supabase
                .from('pending_company_payment_sessions')
                .update({
                    company_data: normalizedCompanyData,
                    plan_id: plan.id,
                    plan_slug: dto.plan_slug,
                    billing_period: dto.billing_period,
                    status: 'active',
                    stripe_subscription_id: null,
                    stripe_base_item_id: null,
                    stripe_member_item_id: null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', session.id)
                .select('*')
                .single();

            if (error || !updatedSession) {
                throw new BadRequestException(
                    error?.message || 'Impossible de préparer la souscription.',
                );
            }

            return {
                session_id: session.id,
                subscription_id: null,
                client_secret: null,
                status: 'active',
                pricing,
                company_summary: companySummary,
            };
        }

        const stripe = this.ensureStripe();
        const pricingContext = await this.resolveRegistrationPricingContext(
            dto.plan_slug,
            dto.billing_period,
            dto.promotion_code,
        );

        if (
            session.status
            && ['active', 'trialing'].includes(session.status)
            && session.stripe_subscription_id
        ) {
            throw new BadRequestException(
                'Cette session de paiement a déjà été validée.',
            );
        }

        await this.cancelPendingCompanyStripeSubscription(session);

        const customerId = await this.getOrCreateStripeCustomerForUser(
            stripe,
            supabase,
            userId,
            {
                existingCustomerId: session.stripe_customer_id,
                companyName: companySummary.legal_name || companySummary.name,
                billingDetails: {
                    email: companySummary.email,
                    name: companySummary.legal_name || companySummary.name,
                    address: {
                        line1: companySummary.address,
                        postal_code: companySummary.postal_code,
                        city: companySummary.city,
                        country: companySummary.country || 'FR',
                    },
                },
            },
        );

        const stripeSubscription = await stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: pricingContext.basePriceId, quantity: 1 }],
            billing_mode: { type: 'flexible' },
            automatic_tax: { enabled: true },
            payment_behavior: 'default_incomplete',
            payment_settings: {
                save_default_payment_method: 'on_subscription',
                payment_method_types: ['card', 'sepa_debit'],
            },
            discounts: pricingContext.stripePromotionCodeId
                ? [{ promotion_code: pricingContext.stripePromotionCodeId }]
                : undefined,
            metadata: {
                pending_company_session_id: session.id,
                pending_company_flow: 'true',
                user_id: userId,
                plan_id: pricingContext.plan.id,
                billing_period: dto.billing_period,
            },
            expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payment_intent'],
        });

        const latestInvoice = stripeSubscription.latest_invoice as Stripe.Invoice | null;
        const confirmationSecret = (latestInvoice as any)?.confirmation_secret as
            | { client_secret?: string | null }
            | null;
        const paymentIntent = (latestInvoice as any)?.payment_intent as Stripe.PaymentIntent | null;
        const clientSecret = confirmationSecret?.client_secret || paymentIntent?.client_secret || null;
        const appliedPricing = this.buildRegistrationPricingFromInvoice(
            latestInvoice,
            pricingContext.pricing,
        );
        const mappedStripeStatus = this.mapStripeStatus(stripeSubscription.status);

        const { error: updateError } = await supabase
            .from('pending_company_payment_sessions')
            .update({
                company_data: normalizedCompanyData,
                plan_id: pricingContext.plan.id,
                plan_slug: dto.plan_slug,
                billing_period: dto.billing_period,
                stripe_customer_id: customerId,
                stripe_subscription_id: stripeSubscription.id,
                stripe_base_item_id: stripeSubscription.items.data[0]?.id || null,
                stripe_member_item_id: null,
                status: mappedStripeStatus,
                updated_at: new Date().toISOString(),
            })
            .eq('id', session.id);

        if (updateError) {
            throw new BadRequestException(updateError.message);
        }

        if (!clientSecret && ['active', 'trialing'].includes(stripeSubscription.status)) {
            return {
                session_id: session.id,
                subscription_id: stripeSubscription.id,
                client_secret: null,
                status: mappedStripeStatus,
                pricing: appliedPricing,
                company_summary: companySummary,
            };
        }

        if (!clientSecret) {
            const pendingSetupIntent = (stripeSubscription as any).pending_setup_intent;
            console.error('Pending company Stripe init without client secret', {
                sessionId: session.id,
                subscriptionId: stripeSubscription.id,
                subscriptionStatus: stripeSubscription.status,
                latestInvoiceStatus: latestInvoice?.status || null,
                paymentIntentStatus: paymentIntent?.status || null,
                pendingSetupIntent: typeof pendingSetupIntent === 'string'
                    ? pendingSetupIntent
                    : pendingSetupIntent?.id || null,
            });
            throw new BadRequestException(
                'Le service de paiement n’a pas pu initialiser le paiement. Réessayez dans quelques instants.',
            );
        }

        return {
            session_id: session.id,
            subscription_id: stripeSubscription.id,
            client_secret: clientSecret,
            status: stripeSubscription.status,
            pricing: appliedPricing,
            company_summary: companySummary,
        };
    }

    async validatePendingCompanyPromotionCode(
        userId: string,
        dto: ValidatePendingCompanyPromotionCodeDto,
    ): Promise<ValidatePendingCompanyPromotionCodeResponseDto> {
        await this.getPendingCompanySessionForUser(userId, dto.session_id);

        if (!this.isStripeEnabled()) {
            throw new BadRequestException(
                'Le paiement est temporairement indisponible. Réessayez dans quelques instants.',
            );
        }

        try {
            const pricingContext = await this.resolveRegistrationPricingContext(
                dto.plan_slug,
                dto.billing_period,
                dto.promotion_code,
            );

            return {
                pricing: pricingContext.pricing,
            };
        } catch (error: any) {
            this.normalizePendingCompanyPromotionError(error);
        }
    }

    async finalizePendingCompanySubscription(
        userId: string,
        sessionId: string,
    ): Promise<FinalizePendingCompanySubscriptionResponseDto> {
        const session = await this.getPendingCompanySessionForUser(userId, sessionId);
        const result = await this.finalizePendingCompanySessionRecord(session);

        if (result.status === 'processing') {
            return {
                status: 'processing',
                message:
                    'Le paiement est en cours de confirmation. L’entreprise sera créée automatiquement dès validation.',
                company: null,
            };
        }

        const company = result.company_id
            ? await this.companyService.findOne(userId, result.company_id)
            : null;

        return {
            status: 'completed',
            message: 'L’entreprise a été créée et l’abonnement est actif.',
            company,
        };
    }

    /**
     * Get or create a Stripe customer for this user.
     */
    private async getOrCreateStripeCustomer(
        stripe: Stripe,
        supabase: any,
        userId: string,
        companyId: string,
        billingDetails?: StripeCustomerBillingDetails | null,
    ): Promise<string> {
        const { data: company } = await supabase
            .from('companies')
            .select('name, legal_name, email, address, postal_code, city, country')
            .eq('id', companyId)
            .maybeSingle();
        const resolvedBillingDetails: StripeCustomerBillingDetails | null = billingDetails || (
            company
                ? {
                    email: company.email,
                    name: company.legal_name || company.name,
                    address: {
                        line1: company.address,
                        postal_code: company.postal_code,
                        city: company.city,
                        country: company.country || 'FR',
                    },
                }
                : null
        );

        const { data: companySubscription } = await supabase
            .from('subscriptions')
            .select('stripe_customer_id')
            .eq('company_id', companyId)
            .maybeSingle();

        if (companySubscription?.stripe_customer_id) {
            await this.updateStripeCustomerBillingDetails(
                stripe,
                companySubscription.stripe_customer_id,
                resolvedBillingDetails,
            );
            return companySubscription.stripe_customer_id;
        }

        const { data: existingCustomerSubscription } = await supabase
            .from('subscriptions')
            .select('stripe_customer_id')
            .eq('user_id', userId)
            .not('stripe_customer_id', 'is', null)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (existingCustomerSubscription?.stripe_customer_id) {
            await this.updateStripeCustomerBillingDetails(
                stripe,
                existingCustomerSubscription.stripe_customer_id,
                resolvedBillingDetails,
            );
            await supabase
                .from('subscriptions')
                .update({ stripe_customer_id: existingCustomerSubscription.stripe_customer_id })
                .eq('company_id', companyId);
            return existingCustomerSubscription.stripe_customer_id;
        }

        const { data: profile } = await supabase
            .from('profiles')
            .select('email, first_name, last_name')
            .eq('id', userId)
            .single();

        const customer = await stripe.customers.create({
            ...this.buildStripeCustomerParams({
                email: resolvedBillingDetails?.email || profile?.email,
                name:
                    resolvedBillingDetails?.name
                    || [profile?.first_name, profile?.last_name].filter(Boolean).join(' ')
                    || undefined,
                address: resolvedBillingDetails?.address,
            }),
            metadata: { user_id: userId },
        });

        // Ensure subscription row exists, then set customer id
        const existingSub = await this.getRawSubscriptionForCompany(supabase, companyId);
        if (existingSub) {
            await supabase
                .from('subscriptions')
                .update({ stripe_customer_id: customer.id })
                .eq('company_id', companyId);
        } else {
            await supabase
                .from('subscriptions')
                .insert({
                    user_id: userId,
                    company_id: companyId,
                    stripe_customer_id: customer.id,
                    status: 'incomplete',
                    extra_members_quantity: 0,
                    billing_period: 'monthly',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                });
        }

        return customer.id;
    }

    async createRegistrationSubscription(
        dto: CreateRegistrationSubscriptionDto,
    ): Promise<RegistrationSubscriptionResponseDto> {
        if (dto.role !== 'merchant_admin') {
            throw new ForbiddenException(
                'Seul l\'administrateur marchand peut initier un abonnement à l\'inscription.',
            );
        }

        if ((dto.company_creation_mode || 'create') !== 'create') {
            throw new BadRequestException(
                'Le paiement à l’inscription est réservé à la création d’une entreprise.',
            );
        }

        if (!this.isStripeEnabled()) {
            throw new BadRequestException(
                'Le paiement est temporairement indisponible. Réessayez dans quelques instants.',
            );
        }

        await this.legalDocumentService.validateCurrentPlatformAcceptanceTimestamp(
            dto.platform_legal_accepted_at,
        );

        const supabase = getSupabaseAdmin();
        const stripe = this.ensureStripe();
        const normalizedEmail = this.normalizeEmail(dto.email);

        await this.ensureRegistrationEmailAvailable(supabase, normalizedEmail);
        await this.ensureRegistrationCompanyAvailable(
            supabase,
            dto.siren,
            dto.siret,
            dto.country,
        );
        await this.cancelExistingRegistrationSessions(supabase, normalizedEmail);

        const pricingContext = await this.resolveRegistrationPricingContext(
            dto.plan_slug,
            dto.billing_period,
            dto.promotion_code,
        );
        const plan = pricingContext.plan;

        const registrationData = this.buildRegistrationMetadata({
            ...dto,
            email: normalizedEmail,
            promotion_code: pricingContext.pricing.promotion_code || undefined,
        });

        const { data: createdSession, error: sessionError } = await supabase
            .from('registration_payment_sessions')
            .insert({
                email: normalizedEmail,
                encrypted_password: encryptRegistrationSecret(dto.password),
                registration_data: registrationData,
                plan_id: plan.id,
                plan_slug: dto.plan_slug,
                billing_period: dto.billing_period,
                status: 'pending',
            })
            .select('*')
            .single();

        if (sessionError || !createdSession) {
            throw new BadRequestException(sessionError?.message || 'Impossible de préparer le paiement.');
        }

        const customer = await stripe.customers.create({
            ...this.buildStripeCustomerParams({
                email: normalizedEmail,
                name: registrationData.company_name || `${dto.first_name} ${dto.last_name}`.trim(),
                address: {
                    line1: registrationData.address,
                    postal_code: registrationData.postal_code,
                    city: registrationData.city,
                    country: registrationData.country || 'FR',
                },
            }),
            metadata: {
                registration_session_id: createdSession.id,
                registration_flow: 'true',
                role: dto.role,
            },
        });

        const stripeSubscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price: pricingContext.basePriceId, quantity: 1 }],
            billing_mode: { type: 'flexible' },
            automatic_tax: { enabled: true },
            payment_behavior: 'default_incomplete',
            payment_settings: {
                save_default_payment_method: 'on_subscription',
                payment_method_types: ['card', 'sepa_debit'],
            },
            discounts: pricingContext.stripePromotionCodeId
                ? [{ promotion_code: pricingContext.stripePromotionCodeId }]
                : undefined,
            metadata: {
                registration_session_id: createdSession.id,
                registration_flow: 'true',
                email: normalizedEmail,
                plan_id: plan.id,
                billing_period: dto.billing_period,
            },
            expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payment_intent'],
        });

        const latestInvoice = stripeSubscription.latest_invoice as Stripe.Invoice | null;
        const confirmationSecret = (latestInvoice as any)?.confirmation_secret as
            | { client_secret?: string | null }
            | null;
        const paymentIntent = (latestInvoice as any)?.payment_intent as Stripe.PaymentIntent | null;
        const clientSecret = confirmationSecret?.client_secret || paymentIntent?.client_secret || null;
        const appliedPricing = this.buildRegistrationPricingFromInvoice(
            latestInvoice,
            pricingContext.pricing,
        );

        if (!clientSecret) {
            throw new BadRequestException(
                'Le service de paiement n’a pas pu initialiser le paiement. Réessayez dans quelques instants.',
            );
        }

        const { error: updateError } = await supabase
            .from('registration_payment_sessions')
            .update({
                stripe_customer_id: customer.id,
                stripe_subscription_id: stripeSubscription.id,
                stripe_base_item_id: stripeSubscription.items.data[0]?.id || null,
                stripe_member_item_id: null,
                status: this.mapStripeStatus(stripeSubscription.status),
            })
            .eq('id', createdSession.id);

        if (updateError) {
            throw new BadRequestException(updateError.message);
        }

        return {
            registration_session_id: createdSession.id,
            subscription_id: stripeSubscription.id,
            client_secret: clientSecret,
            status: stripeSubscription.status,
            pricing: appliedPricing,
        };
    }

    async validateRegistrationPromotionCode(
        dto: ValidateRegistrationPromotionCodeDto,
    ): Promise<ValidateRegistrationPromotionCodeResponseDto> {
        if (!this.isStripeEnabled()) {
            throw new BadRequestException(
                'Le paiement est temporairement indisponible. Réessayez dans quelques instants.',
            );
        }

        const pricingContext = await this.resolveRegistrationPricingContext(
            dto.plan_slug,
            dto.billing_period,
            dto.promotion_code,
        );

        return {
            pricing: pricingContext.pricing,
        };
    }

    async validateSubscriptionPromotionCode(
        userId: string,
        dto: ValidateSubscriptionPromotionCodeDto,
        explicitCompanyId?: string | null,
    ): Promise<ValidateSubscriptionPromotionCodeResponseDto> {
        if (!this.isStripeEnabled()) {
            throw new BadRequestException(
                'Le paiement est temporairement indisponible. Réessayez dans quelques instants.',
            );
        }

        const effectiveTarget = await resolveEffectiveSubscriptionTarget(userId, explicitCompanyId);
        if (!effectiveTarget.can_manage_billing) {
            throw new ForbiddenException(
                'La facturation est gérée par le propriétaire de l\'entreprise.',
            );
        }

        const pricingContext = await this.resolveRegistrationPricingContext(
            dto.plan_slug,
            dto.billing_period,
            dto.promotion_code,
        );

        return {
            pricing: pricingContext.pricing,
        };
    }

    async finalizeRegistrationSubscription(
        registrationSessionId: string,
    ): Promise<FinalizeRegistrationSubscriptionResponseDto> {
        const supabase = getSupabaseAdmin();
        const { data: session, error } = await supabase
            .from('registration_payment_sessions')
            .select('*')
            .eq('id', registrationSessionId)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') {
            throw new BadRequestException(error.message);
        }

        if (!session) {
            throw new NotFoundException('Session de paiement introuvable.');
        }

        const outcome = await this.finalizeRegistrationSessionRecord(
            session as RegistrationPaymentSessionRecord,
        );

        if (outcome === 'processing') {
            return {
                status: 'processing',
                message:
                    'Le paiement est en cours de confirmation. Votre compte sera créé automatiquement dès validation.',
            };
        }

        return {
            status: 'completed',
            message:
                'Votre compte a été créé. Vérifiez votre email pour confirmer votre compte.',
        };
    }

    /**
     * Count extra members for a specific company.
     */
    private async countExtraMembers(
        supabase: any,
        companyId: string | null,
        ownerRole: 'merchant_admin' | 'accountant',
    ): Promise<number> {
        const usage = await this.getUsageForCompanyRole(
            supabase,
            companyId,
            ownerRole,
        );

        return usage.billable_extra_members;
    }

    /**
     * Creates a Stripe Subscription with billing_mode flexible.
     * Returns client_secret for Payment Element confirmation.
     *
     * Items:
     *  1. Base plan price (monthly or yearly)
     *  2. Member addon (monthly, per-unit, quantity = extra members)
     */
    async createSubscription(
        userId: string,
        planSlug: string,
        billingPeriod: 'monthly' | 'yearly',
        promotionCodeInput?: string | null,
        explicitCompanyId?: string | null,
    ): Promise<SubscribeResponseDto> {
        await this.legalDocumentService.ensurePlatformAcceptanceCurrent(userId);
        const supabase = getSupabaseAdmin();
        const effectiveTarget = await resolveEffectiveSubscriptionTarget(userId, explicitCompanyId);
        const subscriptionCompanyId = effectiveTarget.subscription_company_id;
        const ownerUserId = effectiveTarget.owner_user_id || userId;
        const ownerRole = effectiveTarget.company_owner_role || 'merchant_admin';

        if (!effectiveTarget.can_manage_billing) {
            throw new ForbiddenException(
                'La facturation est gérée par le propriétaire de l\'entreprise.',
            );
        }
        if (!subscriptionCompanyId) {
            throw new BadRequestException(
                'Impossible de déterminer l’entreprise à facturer pour cet abonnement.',
            );
        }

        let pricingContext: ResolvedRegistrationPricingContext | null = null;
        let plan: any = null;

        // Bypass Stripe si désactivé
        if (!this.isStripeEnabled()) {
            const { data: selectedPlan, error: planError } = await supabase
                .from('subscription_plans')
                .select('*')
                .eq('slug', planSlug)
                .eq('is_active', true)
                .single();

            if (planError || !selectedPlan) {
                throw new NotFoundException(`Plan "${planSlug}" non trouvé`);
            }

            plan = selectedPlan;
            const existingSub = await this.getRawSubscriptionForCompany(
                supabase,
                subscriptionCompanyId,
            );
            if (existingSub) {
                await supabase
                    .from('subscriptions')
                    .update({
                        user_id: ownerUserId,
                        plan_id: plan.id,
                        status: 'active',
                        billing_period: billingPeriod,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('company_id', subscriptionCompanyId);
            } else {
                await supabase
                    .from('subscriptions')
                    .insert({
                        user_id: ownerUserId,
                        company_id: subscriptionCompanyId,
                        plan_id: plan.id,
                        status: 'active',
                        billing_period: billingPeriod,
                        extra_members_quantity: 0,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    });
            }

            return {
                subscription_id: 'bypass_no_stripe',
                client_secret: null,
                status: 'active',
            };
        }

        const stripe = this.ensureStripe();
        pricingContext = await this.resolveRegistrationPricingContext(
            planSlug,
            billingPeriod,
            promotionCodeInput,
        );
        plan = pricingContext.plan;
        const activePricingContext = pricingContext as ResolvedRegistrationPricingContext;

        // Guard against duplicate subscriptions (per company)
        const existingSub = await this.getRawSubscriptionForCompany(
            supabase,
            subscriptionCompanyId,
        );
        if (existingSub) {
            // Cas 1: vrai abonnement Stripe actif → refuser
            if (['active', 'trialing'].includes(existingSub.status) && existingSub.stripe_subscription_id) {
                throw new BadRequestException(
                    'Cette entreprise a déjà un abonnement actif. Utilisez le changement de plan.',
                );
            }
            // Cas 1b: subscription 'active' sans Stripe (créée par le trigger DB) → réinitialiser
            if (['active', 'trialing'].includes(existingSub.status) && !existingSub.stripe_subscription_id) {
                await supabase
                    .from('subscriptions')
                    .update({ status: 'incomplete', updated_at: new Date().toISOString() })
                    .eq('company_id', subscriptionCompanyId);
            }
            // Cas 2: abonnement incomplete/past_due avec stripe_subscription_id → annuler l'ancien
            if (['incomplete', 'past_due'].includes(existingSub.status) && existingSub.stripe_subscription_id) {
                try {
                    await stripe.subscriptions.cancel(existingSub.stripe_subscription_id);
                } catch (e: any) {
                    // Ignorer si l'abonnement Stripe n'existe plus
                    if (e.code !== 'resource_missing') {
                        console.error('Erreur annulation abonnement incomplet:', e.message);
                    }
                }
                await supabase
                    .from('subscriptions')
                    .update({
                        stripe_subscription_id: null,
                        stripe_base_item_id: null,
                        stripe_member_item_id: null,
                        status: 'incomplete',
                        updated_at: new Date().toISOString(),
                    })
                    .eq('company_id', subscriptionCompanyId);
            }
            // Cas 3: ligne locale sans stripe_subscription_id → on la réutilise (mise à jour plus loin)
        }

        // Resolve base price
        const basePriceId = activePricingContext.basePriceId;

        // Count extra members
        const extraMembers = await this.countExtraMembers(
            supabase,
            subscriptionCompanyId,
            ownerRole,
        );

        // Resolve member addon price if needed
        let memberPriceId: string | null = null;
        if (extraMembers > 0) {
            if (!plan.stripe_member_lookup_key) {
                throw new BadRequestException(
                    `Aucun tarif de membre supplémentaire n'est configuré pour le plan "${planSlug}".`,
                );
            }
            memberPriceId = await this.resolveStripePriceId(stripe, plan.stripe_member_lookup_key);
        }

        // Get or create Stripe customer
        const stripeCustomerId = await this.getOrCreateStripeCustomer(
            stripe,
            supabase,
            ownerUserId,
            subscriptionCompanyId,
        );

        // Build subscription items
        const items: Stripe.SubscriptionCreateParams.Item[] = [
            { price: basePriceId, quantity: 1 },
        ];

        if (memberPriceId && extraMembers > 0) {
            items.push({ price: memberPriceId, quantity: extraMembers });
        }

        // Create subscription with payment_behavior: default_incomplete
        // to get a client_secret for Stripe Elements.
        const subscriptionParams: Stripe.SubscriptionCreateParams = {
            customer: stripeCustomerId,
            items,
            billing_mode: { type: 'flexible' },
            automatic_tax: { enabled: true },
            payment_behavior: 'default_incomplete',
            payment_settings: {
                save_default_payment_method: 'on_subscription',
                payment_method_types: ['card', 'sepa_debit'],
            },
            metadata: {
                user_id: ownerUserId,
                company_id: subscriptionCompanyId,
                plan_id: plan.id,
                billing_period: billingPeriod,
                promotion_code: activePricingContext.pricing.promotion_code || '',
            },
            expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payment_intent'],
        };
        if (activePricingContext.stripePromotionCodeId) {
            subscriptionParams.discounts = [{
                promotion_code: activePricingContext.stripePromotionCodeId,
            }];
        }
        const stripeSub = await stripe.subscriptions.create(subscriptionParams);

        // Extract item IDs
        const baseItemId = stripeSub.items.data[0]?.id || null;
        const memberItemId = stripeSub.items.data.length >= 2
            ? stripeSub.items.data[1]?.id
            : null;

        // Update local DB
        await supabase
            .from('subscriptions')
            .update({
                user_id: ownerUserId,
                plan_id: plan.id,
                stripe_customer_id: stripeCustomerId,
                stripe_subscription_id: stripeSub.id,
                stripe_base_item_id: baseItemId,
                stripe_member_item_id: memberItemId,
                extra_members_quantity: extraMembers,
                billing_period: billingPeriod,
                status: stripeSub.status as string,
                current_period_start: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('company_id', subscriptionCompanyId);

        // Stripe's flexible billing flow may expose the client secret on either
        // latest_invoice.confirmation_secret or latest_invoice.payment_intent.
        const latestInvoice = stripeSub.latest_invoice as Stripe.Invoice | null;
        const confirmationSecret = (latestInvoice as any)?.confirmation_secret as
            | { client_secret?: string | null }
            | null;
        const paymentIntent = (latestInvoice as any)?.payment_intent as Stripe.PaymentIntent | null;
        const clientSecret = confirmationSecret?.client_secret || paymentIntent?.client_secret || null;

        if (!clientSecret) {
            console.error('Stripe subscription created without client secret', {
                subscriptionId: stripeSub.id,
                latestInvoiceId: latestInvoice?.id || null,
                status: stripeSub.status,
                userId,
                billingPeriod,
                planId: plan.id,
            });
            throw new BadRequestException(
                'Le service de paiement n’a pas pu initialiser le paiement. Réessayez dans quelques instants.',
            );
        }

        return {
            subscription_id: stripeSub.id,
            client_secret: clientSecret,
            status: stripeSub.status,
        };
    }

    /**
     * Handles Stripe subscription webhooks.
     */
    async handleWebhook(event: Stripe.Event): Promise<void> {
        const supabase = getSupabaseAdmin();

        switch (event.type) {
            case 'invoice.paid': {
                const invoice = event.data.object as Stripe.Invoice;
                const subscription = invoice.parent?.subscription_details?.subscription;
                const subscriptionId = typeof subscription === 'string'
                    ? subscription
                    : subscription?.id;
                if (!subscriptionId) return;

                // Get stored subscription to find base item ID
                const { data: localSub } = await supabase
                    .from('subscriptions')
                    .select('stripe_base_item_id')
                    .eq('stripe_subscription_id', subscriptionId)
                    .maybeSingle();

                // Find the period end from the base plan item, not the member addon
                let periodEnd: string | null = null;
                if (localSub?.stripe_base_item_id) {
                    // Look for the invoice line matching the base item
                    const baseLine = invoice.lines.data.find(
                        (line: any) => line.subscription_item === localSub.stripe_base_item_id,
                    );
                    if (baseLine?.period?.end) {
                        periodEnd = new Date(baseLine.period.end * 1000).toISOString();
                    }
                }

                // Fallback: use first line if base item not matched
                if (!periodEnd && invoice.lines.data[0]?.period?.end) {
                    periodEnd = new Date(invoice.lines.data[0].period.end * 1000).toISOString();
                }

                await supabase
                    .from('subscriptions')
                    .update({
                        status: 'active',
                        current_period_end: periodEnd,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('stripe_subscription_id', subscriptionId);

                const { data: pendingSession } = await supabase
                    .from('registration_payment_sessions')
                    .select('*')
                    .eq('stripe_subscription_id', subscriptionId)
                    .is('finalized_user_id', null)
                    .maybeSingle();

                if (pendingSession) {
                    await this.finalizeRegistrationSessionRecord(
                        pendingSession as RegistrationPaymentSessionRecord,
                    );
                }

                const pendingCompanySession =
                    await this.getPendingCompanySessionByStripeSubscriptionId(
                        subscriptionId,
                    );
                if (pendingCompanySession) {
                    await this.finalizePendingCompanySessionRecord(
                        pendingCompanySession,
                    );
                }
                await this.prefillCompanyBankingBySubscriptionId(subscriptionId);
                break;
            }

            case 'customer.subscription.updated': {
                const sub = event.data.object as Stripe.Subscription;
                const status = sub.status === 'active' ? 'active' :
                    sub.status === 'past_due' ? 'past_due' :
                        sub.status === 'canceled' ? 'cancelled' : sub.status;

                // Get stored subscription to identify items by stored IDs
                const { data: localSub } = await supabase
                    .from('subscriptions')
                    .select('stripe_base_item_id, stripe_member_item_id')
                    .eq('stripe_subscription_id', sub.id)
                    .maybeSingle();

                // Find base item by stored ID, fallback to first item
                let baseItem: Stripe.SubscriptionItem | undefined;
                if (localSub?.stripe_base_item_id) {
                    baseItem = sub.items.data.find(
                        (item) => item.id === localSub.stripe_base_item_id,
                    );
                }
                baseItem = baseItem || sub.items.data[0];

                const periodEnd = baseItem?.current_period_end;

                // Sync billing_period from the base item's price interval
                const interval = baseItem?.price?.recurring?.interval;
                const billingPeriod = interval === 'year' ? 'yearly' : 'monthly';

                // Sync plan_id from metadata when available. Pending updates
                // cannot include metadata, so resolve the applied plan from the
                // base Stripe Price lookup key after the update is settled.
                const planId = sub.metadata?.plan_id
                    || (!sub.pending_update
                        ? await this.resolvePlanIdFromStripeBasePrice(
                            supabase,
                            baseItem,
                            billingPeriod,
                        )
                        : null);

                const updateData: Record<string, any> = {
                    status,
                    cancel_at_period_end: sub.cancel_at_period_end,
                    billing_period: billingPeriod,
                    current_period_end: periodEnd
                        ? new Date(periodEnd * 1000).toISOString()
                        : null,
                    updated_at: new Date().toISOString(),
                };

                if (planId && !sub.pending_update) {
                    updateData.plan_id = planId;
                }

                // Update base/member item IDs if they changed
                if (sub.items.data.length > 0) {
                    // Base item is the one we know, or first
                    updateData.stripe_base_item_id = baseItem?.id || null;

                    // Member item is the other one (if any)
                    const memberItem = sub.items.data.find(
                        (item) => item.id !== baseItem?.id,
                    );
                    updateData.stripe_member_item_id = memberItem?.id || null;
                    updateData.extra_members_quantity = memberItem?.quantity || 0;
                }

                await supabase
                    .from('subscriptions')
                    .update(updateData)
                    .eq('stripe_subscription_id', sub.id);

                if (['active', 'trialing'].includes(sub.status)) {
                    const { data: pendingSession } = await supabase
                        .from('registration_payment_sessions')
                        .select('*')
                        .eq('stripe_subscription_id', sub.id)
                        .is('finalized_user_id', null)
                        .maybeSingle();

                    if (pendingSession) {
                        await this.finalizeRegistrationSessionRecord(
                            pendingSession as RegistrationPaymentSessionRecord,
                        );
                    }
                }

                if (['active', 'trialing'].includes(sub.status)) {
                    const pendingCompanySession =
                        await this.getPendingCompanySessionByStripeSubscriptionId(
                            sub.id,
                        );
                    if (pendingCompanySession) {
                        await this.finalizePendingCompanySessionRecord(
                            pendingCompanySession,
                        );
                    }
                    await this.prefillCompanyBankingBySubscriptionId(sub.id);
                }
                break;
            }

            case 'invoice.payment_failed': {
                const invoice = event.data.object as Stripe.Invoice;
                const subscription = invoice.parent?.subscription_details?.subscription;
                const subscriptionId = typeof subscription === 'string'
                    ? subscription
                    : subscription?.id;
                if (!subscriptionId) return;

                await supabase
                    .from('subscriptions')
                    .update({
                        status: 'past_due',
                        updated_at: new Date().toISOString(),
                    })
                    .eq('stripe_subscription_id', subscriptionId);

                await supabase
                    .from('registration_payment_sessions')
                    .update({
                        status: 'past_due',
                    })
                    .eq('stripe_subscription_id', subscriptionId)
                    .is('finalized_user_id', null);

                await supabase
                    .from('pending_company_payment_sessions')
                    .update({
                        status: 'past_due',
                    })
                    .eq('stripe_subscription_id', subscriptionId)
                    .is('finalized_company_id', null);
                break;
            }

            case 'customer.subscription.deleted': {
                const sub = event.data.object as Stripe.Subscription;

                await supabase
                    .from('subscriptions')
                    .update({
                        plan_id: null,
                        status: 'cancelled',
                        stripe_subscription_id: null,
                        stripe_base_item_id: null,
                        stripe_member_item_id: null,
                        extra_members_quantity: 0,
                        cancel_at_period_end: false,
                        current_period_end: null,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('stripe_subscription_id', sub.id);

                await supabase
                    .from('registration_payment_sessions')
                    .update({
                        status: 'cancelled',
                    })
                    .eq('stripe_subscription_id', sub.id)
                    .is('finalized_user_id', null);

                await supabase
                    .from('pending_company_payment_sessions')
                    .update({
                        status: 'cancelled',
                    })
                    .eq('stripe_subscription_id', sub.id)
                    .is('finalized_company_id', null);
                break;
            }
        }
    }

    /**
     * Creates a Stripe Billing Portal session for managing payment methods.
     */
    async createBillingPortalSession(
        userId: string,
        explicitCompanyId?: string | null,
    ): Promise<{ url: string }> {
        const effectiveTarget = await resolveEffectiveSubscriptionTarget(userId, explicitCompanyId);
        if (!effectiveTarget.can_manage_billing) {
            throw new ForbiddenException(
                'La facturation est gérée par le propriétaire de l\'entreprise.',
            );
        }
        if (!effectiveTarget.subscription_company_id) {
            throw new BadRequestException(
                'Impossible de déterminer l’entreprise à facturer.',
            );
        }

        const stripe = this.ensureStripe();
        const supabase = getSupabaseAdmin();
        const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';

        const { data: subscription } = await supabase
            .from('subscriptions')
            .select('stripe_customer_id')
            .eq('company_id', effectiveTarget.subscription_company_id)
            .maybeSingle();

        if (!subscription?.stripe_customer_id) {
            throw new BadRequestException(
                'Aucun profil de facturation n’est associé à ce compte. Souscrivez d’abord à un plan payant.',
            );
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: subscription.stripe_customer_id,
            return_url: `${frontendUrl}/settings`,
        });

        return { url: session.url };
    }

    /**
     * Sync member quantity on Stripe subscription when members are added/removed.
     */
    async syncMemberQuantity(
        companyId: string,
    ): Promise<{ client_secret: string | null; status: string } | null> {
        if (!this.isStripeEnabled()) return null;

        const stripe = this.ensureStripe();
        const supabase = getSupabaseAdmin();

        // Get company subscription
        const { data: subscription } = await supabase
            .from('subscriptions')
            .select('stripe_subscription_id, stripe_base_item_id, stripe_member_item_id, plan_id, extra_members_quantity')
            .eq('company_id', companyId)
            .maybeSingle();

        if (!subscription?.stripe_subscription_id) return null;

        // Count extra members
        const extraMembers = await this.countExtraMembers(
            supabase,
            companyId,
            'merchant_admin',
        );
        let stripeSubscription = await stripe.subscriptions.retrieve(
            subscription.stripe_subscription_id,
            { expand: ['latest_invoice.payment_intent'] },
        );
        let memberItem = this.getMemberItem(
            stripeSubscription,
            subscription.stripe_base_item_id,
            subscription.stripe_member_item_id,
        );
        let nextMemberItemId = memberItem?.id || null;
        const stripeMemberQuantity = memberItem?.quantity || 0;

        if (
            extraMembers === (subscription.extra_members_quantity || 0)
            && stripeMemberQuantity === extraMembers
            && (subscription.stripe_member_item_id || null) === nextMemberItemId
        ) {
            return null;
        }

        let stripeMutationPerformed = false;

        if (extraMembers <= 0) {
            if (memberItem) {
                try {
                    await stripe.subscriptionItems.del(memberItem.id, {
                        proration_behavior: 'create_prorations',
                    });
                    stripeMutationPerformed = true;
                } catch (error) {
                    if (!this.isStripeResourceMissing(error)) {
                        throw error;
                    }
                }
                nextMemberItemId = null;
            }
        } else if (memberItem) {
            const isIncreasingQuantity = extraMembers > stripeMemberQuantity;
            const defaultPaymentMethodType = await this.getDefaultSubscriptionPaymentMethodType(
                stripe,
                subscription.stripe_subscription_id,
            );
            const billingParams = this.getMemberItemBillingParams(
                defaultPaymentMethodType,
                isIncreasingQuantity,
            );

            if (stripeMemberQuantity !== extraMembers) {
                try {
                    await stripe.subscriptionItems.update(memberItem.id, {
                        quantity: extraMembers,
                        ...billingParams,
                    });
                    stripeMutationPerformed = true;
                } catch (error) {
                    if (!this.isStripeResourceMissing(error)) {
                        throw error;
                    }
                    memberItem = undefined;
                    nextMemberItemId = null;
                }
            }
        } else {
            if (!subscription.plan_id) {
                return null;
            }

            const { data: plan } = await supabase
                .from('subscription_plans')
                .select('stripe_member_lookup_key')
                .eq('id', subscription.plan_id)
                .maybeSingle();

            if (!plan?.stripe_member_lookup_key) {
                return null;
            }

            const memberPriceId = await this.resolveStripePriceId(stripe, plan.stripe_member_lookup_key);
            const defaultPaymentMethodType = await this.getDefaultSubscriptionPaymentMethodType(
                stripe,
                subscription.stripe_subscription_id,
            );
            const billingParams = this.getMemberItemBillingParams(
                defaultPaymentMethodType,
                true,
            );
            const createdItem = await stripe.subscriptionItems.create({
                subscription: subscription.stripe_subscription_id,
                price: memberPriceId,
                quantity: extraMembers,
                ...billingParams,
            });
            nextMemberItemId = createdItem.id;
            stripeMutationPerformed = true;
        }

        if (stripeMutationPerformed) {
            stripeSubscription = await stripe.subscriptions.retrieve(
                subscription.stripe_subscription_id,
                { expand: ['latest_invoice.payment_intent'] },
            );
            memberItem = this.getMemberItem(
                stripeSubscription,
                subscription.stripe_base_item_id,
                nextMemberItemId,
            );
            nextMemberItemId = memberItem?.id || null;
        }

        const latestInvoice = stripeSubscription.latest_invoice as Stripe.Invoice | null;
        const clientSecret = this.getLatestInvoiceClientSecret(latestInvoice);

        if (!clientSecret) {
            await supabase
                .from('subscriptions')
                .update({
                    stripe_member_item_id: nextMemberItemId,
                    extra_members_quantity: extraMembers,
                    updated_at: new Date().toISOString(),
                })
                .eq('company_id', companyId);
        }

        if (!clientSecret && ['active', 'trialing'].includes(stripeSubscription.status)) {
            await this.prefillCompanyBankingOnce(
                companyId,
                stripeSubscription,
                latestInvoice,
            );
        }

        return {
            client_secret: clientSecret,
            status: stripeSubscription.status,
        };
    }

    async isMemberQuantityBillingSettled(companyId: string): Promise<boolean> {
        if (!this.isStripeEnabled()) return true;

        const stripe = this.ensureStripe();
        const supabase = getSupabaseAdmin();

        const { data: subscription } = await supabase
            .from('subscriptions')
            .select('stripe_subscription_id, stripe_base_item_id, stripe_member_item_id, extra_members_quantity')
            .eq('company_id', companyId)
            .maybeSingle();

        if (!subscription?.stripe_subscription_id) return true;

        const extraMembers = await this.countExtraMembers(
            supabase,
            companyId,
            'merchant_admin',
        );

        const stripeSubscription = await stripe.subscriptions.retrieve(
            subscription.stripe_subscription_id,
            { expand: ['latest_invoice.payment_intent'] },
        );
        const latestInvoice = stripeSubscription.latest_invoice as Stripe.Invoice | null;
        const paymentIntent = (latestInvoice as any)?.payment_intent as
            | Stripe.PaymentIntent
            | null
            | undefined;

        if ([
            'requires_action',
            'requires_confirmation',
            'requires_payment_method',
        ].includes(paymentIntent?.status || '')) {
            return false;
        }

        const memberItem = this.getMemberItem(
            stripeSubscription,
            subscription.stripe_base_item_id,
            subscription.stripe_member_item_id,
        ) || null;
        const stripeMemberQuantity = memberItem?.quantity || 0;

        if (stripeMemberQuantity < extraMembers) {
            return false;
        }

        if (
            (subscription.extra_members_quantity || 0) !== extraMembers
            || (memberItem?.id || null) !== (subscription.stripe_member_item_id || null)
        ) {
            await supabase
                .from('subscriptions')
                .update({
                    stripe_member_item_id: memberItem?.id || null,
                    extra_members_quantity: extraMembers,
                    updated_at: new Date().toISOString(),
                })
                .eq('company_id', companyId);
        }

        return true;
    }

    /**
     * Changes the subscription plan and/or billing period via Stripe swap (proration).
     */
    async changePlan(
        userId: string,
        planSlug: string,
        billingPeriod?: 'monthly' | 'yearly',
        explicitCompanyId?: string | null,
    ): Promise<ChangeSubscriptionResponseDto> {
        await this.legalDocumentService.ensurePlatformAcceptanceCurrent(userId);
        const supabase = getSupabaseAdmin();
        const effectiveTarget = await resolveEffectiveSubscriptionTarget(userId, explicitCompanyId);
        const subscriptionCompanyId = effectiveTarget.subscription_company_id;
        const ownerUserId = effectiveTarget.owner_user_id || userId;

        if (!effectiveTarget.can_manage_billing) {
            throw new ForbiddenException(
                'La facturation est gérée par le propriétaire de l\'entreprise.',
            );
        }
        if (!subscriptionCompanyId) {
            throw new BadRequestException(
                'Impossible de déterminer l’entreprise à facturer pour ce changement de plan.',
            );
        }

        const { data: newPlan, error: planError } = await supabase
            .from('subscription_plans')
            .select('*')
            .eq('slug', planSlug)
            .eq('is_active', true)
            .single();

        if (planError || !newPlan) {
            throw new NotFoundException(`Plan "${planSlug}" non trouvé`);
        }

        const { data: existingSubscription } = await supabase
            .from('subscriptions')
            .select('*')
            .eq('company_id', subscriptionCompanyId)
            .maybeSingle();

        // Use existing billing_period if not provided
        const effectiveBillingPeriod = billingPeriod
            || existingSubscription?.billing_period
            || 'monthly';

        // Bypass Stripe si désactivé
        if (!this.isStripeEnabled()) {
            if (existingSubscription) {
                await supabase
                    .from('subscriptions')
                    .update({
                        user_id: ownerUserId,
                        plan_id: newPlan.id,
                        status: 'active',
                        billing_period: effectiveBillingPeriod,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('company_id', subscriptionCompanyId);
            } else {
                await supabase
                    .from('subscriptions')
                    .insert({
                        user_id: ownerUserId,
                        company_id: subscriptionCompanyId,
                        plan_id: newPlan.id,
                        status: 'active',
                        billing_period: effectiveBillingPeriod,
                        extra_members_quantity: 0,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    });
            }

            return {
                subscription: {
                    ...(existingSubscription || {}),
                    plan_id: newPlan.id,
                    status: 'active',
                    billing_period: effectiveBillingPeriod,
                    extra_members_quantity: existingSubscription?.extra_members_quantity || 0,
                    plan: newPlan as SubscriptionPlanDto,
                } as SubscriptionDto,
                client_secret: null,
                status: 'active',
            };
        }

        const stripe = this.ensureStripe();

        if (!existingSubscription?.stripe_subscription_id) {
            throw new BadRequestException(
                'Aucun abonnement actif n’est associé à ce compte. Souscrivez d’abord à un plan payant.',
            );
        }

        // Use stored stripe_base_item_id to identify the base item
        let baseItemId = existingSubscription.stripe_base_item_id;

        if (!baseItemId) {
            // Fallback: retrieve from Stripe and use first item
            const stripeSub = await stripe.subscriptions.retrieve(
                existingSubscription.stripe_subscription_id,
                { expand: ['items'] },
            );
            baseItemId = stripeSub.items.data[0]?.id;
        }

        if (!baseItemId) {
            throw new BadRequestException(
                'Impossible de retrouver l’abonnement de base pour ce compte.',
            );
        }

        // Resolve the new price based on billing period
        const lookupKey = this.resolveLookupKey(newPlan, effectiveBillingPeriod);
        const newPriceId = await this.resolveStripePriceId(stripe, lookupKey);

        // Swap the base plan item. pending_if_incomplete prevents Stripe from
        // applying updates that require payment authentication before payment is settled.
        const updatedStripeSubscription = await stripe.subscriptions.update(existingSubscription.stripe_subscription_id, {
            items: [{
                id: baseItemId,
                price: newPriceId,
            }],
            proration_behavior: 'always_invoice',
            payment_behavior: 'pending_if_incomplete',
            expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payment_intent'],
        });

        const latestInvoice = updatedStripeSubscription.latest_invoice as Stripe.Invoice | null;
        const clientSecret = this.getLatestInvoiceClientSecret(latestInvoice);
        if (clientSecret || updatedStripeSubscription.pending_update) {
            return {
                subscription: await this.hydrateSubscription(supabase, existingSubscription) as SubscriptionDto,
                client_secret: clientSecret,
                status: clientSecret ? 'requires_payment_confirmation' : 'pending',
            };
        }

        // Update DB immediately (webhook will also sync)
        await supabase
            .from('subscriptions')
            .update({
                user_id: ownerUserId,
                plan_id: newPlan.id,
                billing_period: effectiveBillingPeriod,
                updated_at: new Date().toISOString(),
            })
            .eq('company_id', subscriptionCompanyId);

        return {
            subscription: {
                ...existingSubscription,
                plan_id: newPlan.id,
                billing_period: effectiveBillingPeriod,
                extra_members_quantity: existingSubscription.extra_members_quantity || 0,
                plan: newPlan as SubscriptionPlanDto,
            } as SubscriptionDto,
            client_secret: null,
            status: updatedStripeSubscription.status,
        };
    }
}
