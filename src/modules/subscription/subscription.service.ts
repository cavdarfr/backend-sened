import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { getSupabaseAdmin, getSupabaseClient } from '../../config/supabase.config';
import { LegalDocumentService } from '../legal-document/legal-document.service';
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
    CreateRegistrationSubscriptionDto,
    RegistrationSubscriptionResponseDto,
    FinalizeRegistrationSubscriptionResponseDto,
} from './dto/subscription.dto';
import { decryptRegistrationSecret, encryptRegistrationSecret } from '../../common/utils/registration-payload';
import { normalizeBusinessIdentifiers } from '../../shared/utils/business-identifiers.util';

const REGISTRATION_SUPPORT_EMAIL = 'contact@sened.fr';

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

interface SubscriptionMemberUsage {
    total_members: number;
    extra_members: number;
    pending_invitations: number;
    billable_members: number;
    billable_extra_members: number;
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

        return prices.data[0].id;
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
                proration_behavior: 'create_prorations',
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
            platform_legal_accepted_at: dto.platform_legal_accepted_at,
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
        const baseItem = this.getBaseItem(subscription, session.stripe_base_item_id);
        const memberItem = subscription.items.data.find((item) => item.id !== baseItem?.id);
        const billingPeriod = baseItem?.price?.recurring?.interval === 'year' ? 'yearly' : session.billing_period;

        const { data: existingSubscription } = await supabase
            .from('subscriptions')
            .select('id')
            .eq('user_id', userId)
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
                .eq('user_id', userId);

            if (error) {
                throw new BadRequestException(error.message);
            }

            return;
        }

        const { error } = await supabase
            .from('subscriptions')
            .insert({
                user_id: userId,
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

        await supabase
            .from('registration_payment_sessions')
            .update({
                finalized_user_id: user.id,
                status: 'completed',
            })
            .eq('id', session.id);

        return 'completed';
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

    private async getRawSubscriptionForUser(supabase: any, userId: string): Promise<any | null> {
        const { data: subscription, error } = await supabase
            .from('subscriptions')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') {
            throw new Error(`Erreur lors de la récupération de l'abonnement: ${error.message}`);
        }

        return subscription;
    }

    private async ensureBypassSubscriptionForUser(
        supabase: any,
        userId: string | null,
        plans: SubscriptionPlanDto[],
        existingSubscription?: any | null,
    ): Promise<any | null> {
        if (!userId) {
            return existingSubscription || null;
        }

        const subscription = existingSubscription ?? await this.getRawSubscriptionForUser(supabase, userId);
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
            user_id: userId,
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

    async getSubscriptionWithPlans(userId: string, companyId?: string): Promise<SubscriptionWithPlansDto> {
        const supabase = getSupabaseAdmin();
        const allPlans = await this.getAvailablePlansFromDb(supabase);
        const effectiveTarget = await resolveEffectiveSubscriptionTarget(userId, companyId);

        let subscription = effectiveTarget.subscription_user_id
            ? await this.getRawSubscriptionForUser(supabase, effectiveTarget.subscription_user_id)
            : null;

        subscription = await this.ensureBypassSubscriptionForUser(
            supabase,
            effectiveTarget.subscription_user_id,
            allPlans,
            subscription,
        );

        const usage = await this.getUsageForOwner(
            supabase,
            effectiveTarget.owner_user_id || effectiveTarget.subscription_user_id,
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
            can_manage_billing: effectiveTarget.can_manage_billing,
            has_any_active_company_subscription: effectiveTarget.has_any_active_company_subscription,
            usage,
        };
    }

    async getUserSubscription(userId: string): Promise<SubscriptionDto | null> {
        const supabase = getSupabaseAdmin();
        const allPlans = await this.getAvailablePlansFromDb(supabase);
        const subscription = await this.ensureBypassSubscriptionForUser(
            supabase,
            userId,
            allPlans,
        );

        return this.hydrateSubscription(supabase, subscription);
    }

    async getAvailablePlans(): Promise<AvailablePlansResponseDto> {
        const supabase = getSupabaseAdmin();
        const plans = await this.getAvailablePlansFromDb(supabase);
        return {
            plans,
            stripe_enabled: this.isStripeEnabled(),
        };
    }

    /**
     * Get or create a Stripe customer for this user.
     */
    private async getOrCreateStripeCustomer(
        stripe: Stripe,
        supabase: any,
        userId: string,
    ): Promise<string> {
        const { data: subscription } = await supabase
            .from('subscriptions')
            .select('stripe_customer_id')
            .eq('user_id', userId)
            .maybeSingle();

        if (subscription?.stripe_customer_id) {
            return subscription.stripe_customer_id;
        }

        const { data: profile } = await supabase
            .from('profiles')
            .select('email, first_name, last_name')
            .eq('id', userId)
            .single();

        const customer = await stripe.customers.create({
            email: profile?.email,
            name: [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || undefined,
            metadata: { user_id: userId },
        });

        // Ensure subscription row exists, then set customer id
        const existingSub = await this.getRawSubscriptionForUser(supabase, userId);
        if (existingSub) {
            await supabase
                .from('subscriptions')
                .update({ stripe_customer_id: customer.id })
                .eq('user_id', userId);
        } else {
            await supabase
                .from('subscriptions')
                .insert({
                    user_id: userId,
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

        const { data: plan, error: planError } = await supabase
            .from('subscription_plans')
            .select('*')
            .eq('slug', dto.plan_slug)
            .eq('is_active', true)
            .single();

        if (planError || !plan) {
            throw new NotFoundException(`Plan "${dto.plan_slug}" non trouvé`);
        }

        if (Number(plan.price_monthly || 0) === 0 && Number(plan.price_yearly || 0) === 0) {
            throw new BadRequestException('Ce plan ne nécessite pas de paiement.');
        }

        const baseLookupKey = this.resolveLookupKey(plan, dto.billing_period);
        const basePriceId = await this.resolveStripePriceId(stripe, baseLookupKey);

        const registrationData = this.buildRegistrationMetadata({
            ...dto,
            email: normalizedEmail,
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
            email: normalizedEmail,
            name: registrationData.company_name || `${dto.first_name} ${dto.last_name}`.trim(),
            metadata: {
                registration_session_id: createdSession.id,
                registration_flow: 'true',
                role: dto.role,
            },
        });

        const stripeSubscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price: basePriceId, quantity: 1 }],
            billing_mode: { type: 'flexible' },
            payment_behavior: 'default_incomplete',
            payment_settings: {
                save_default_payment_method: 'on_subscription',
                payment_method_types: ['card', 'sepa_debit'],
            },
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
     * Count extra members (total active members across owner's companies - 1 for owner).
     */
    private async countExtraMembers(supabase: any, userId: string): Promise<number> {
        const usage = await this.getUsageForOwnerRole(
            supabase,
            userId,
            'merchant_admin',
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
    ): Promise<SubscribeResponseDto> {
        await this.legalDocumentService.ensurePlatformAcceptanceCurrent(userId);
        const supabase = getSupabaseAdmin();
        const effectiveTarget = await resolveEffectiveSubscriptionTarget(userId);

        if (!effectiveTarget.can_manage_billing) {
            throw new ForbiddenException(
                'La facturation est gérée par le propriétaire de l\'entreprise.',
            );
        }

        const { data: plan, error: planError } = await supabase
            .from('subscription_plans')
            .select('*')
            .eq('slug', planSlug)
            .eq('is_active', true)
            .single();

        if (planError || !plan) {
            throw new NotFoundException(`Plan "${planSlug}" non trouvé`);
        }

        // Bypass Stripe si désactivé
        if (!this.isStripeEnabled()) {
            const existingSub = await this.getRawSubscriptionForUser(supabase, userId);
            if (existingSub) {
                await supabase
                    .from('subscriptions')
                    .update({
                        plan_id: plan.id,
                        status: 'active',
                        billing_period: billingPeriod,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('user_id', userId);
            } else {
                await supabase
                    .from('subscriptions')
                    .insert({
                        user_id: userId,
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

        // Guard against duplicate subscriptions
        const existingSub = await this.getRawSubscriptionForUser(supabase, userId);
        if (existingSub) {
            // Cas 1: vrai abonnement Stripe actif → refuser
            if (['active', 'trialing'].includes(existingSub.status) && existingSub.stripe_subscription_id) {
                throw new BadRequestException(
                    'Vous avez déjà un abonnement actif. Utilisez le changement de plan.',
                );
            }
            // Cas 1b: subscription 'active' sans Stripe (créée par le trigger DB) → réinitialiser
            if (['active', 'trialing'].includes(existingSub.status) && !existingSub.stripe_subscription_id) {
                await supabase
                    .from('subscriptions')
                    .update({ status: 'incomplete', updated_at: new Date().toISOString() })
                    .eq('user_id', userId);
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
                    .eq('user_id', userId);
            }
            // Cas 3: ligne locale sans stripe_subscription_id → on la réutilise (mise à jour plus loin)
        }

        // Resolve base price
        const baseLookupKey = this.resolveLookupKey(plan, billingPeriod);
        const basePriceId = await this.resolveStripePriceId(stripe, baseLookupKey);

        // Count extra members
        const extraMembers = await this.countExtraMembers(supabase, userId);

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
        const stripeCustomerId = await this.getOrCreateStripeCustomer(stripe, supabase, userId);

        // Build subscription items
        const items: Stripe.SubscriptionCreateParams.Item[] = [
            { price: basePriceId, quantity: 1 },
        ];

        if (memberPriceId && extraMembers > 0) {
            items.push({ price: memberPriceId, quantity: extraMembers });
        }

        // Create subscription with payment_behavior: default_incomplete
        // to get a client_secret for Stripe Elements.
        const stripeSub = await stripe.subscriptions.create({
            customer: stripeCustomerId,
            items,
            billing_mode: { type: 'flexible' },
            payment_behavior: 'default_incomplete',
            payment_settings: {
                save_default_payment_method: 'on_subscription',
                payment_method_types: ['card', 'sepa_debit'],
            },
            metadata: {
                user_id: userId,
                plan_id: plan.id,
                billing_period: billingPeriod,
            },
            expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payment_intent'],
        });

        // Extract item IDs
        const baseItemId = stripeSub.items.data[0]?.id || null;
        const memberItemId = stripeSub.items.data.length >= 2
            ? stripeSub.items.data[1]?.id
            : null;

        // Update local DB
        await supabase
            .from('subscriptions')
            .update({
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
            .eq('user_id', userId);

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

                // Sync plan_id from metadata if available
                const planId = sub.metadata?.plan_id;

                const updateData: Record<string, any> = {
                    status,
                    cancel_at_period_end: sub.cancel_at_period_end,
                    billing_period: billingPeriod,
                    current_period_end: periodEnd
                        ? new Date(periodEnd * 1000).toISOString()
                        : null,
                    updated_at: new Date().toISOString(),
                };

                if (planId) {
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
                    if (memberItem) {
                        updateData.stripe_member_item_id = memberItem.id;
                        updateData.extra_members_quantity = memberItem.quantity || 0;
                    }
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
                break;
            }
        }
    }

    /**
     * Creates a Stripe Billing Portal session for managing payment methods.
     */
    async createBillingPortalSession(userId: string): Promise<{ url: string }> {
        const effectiveTarget = await resolveEffectiveSubscriptionTarget(userId);
        if (!effectiveTarget.can_manage_billing) {
            throw new ForbiddenException(
                'La facturation est gérée par le propriétaire de l\'entreprise.',
            );
        }

        const stripe = this.ensureStripe();
        const supabase = getSupabaseAdmin();
        const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';

        const { data: subscription } = await supabase
            .from('subscriptions')
            .select('stripe_customer_id')
            .eq('user_id', userId)
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
    async syncMemberQuantity(companyId: string): Promise<void> {
        if (!this.isStripeEnabled()) return;

        const stripe = this.ensureStripe();
        const supabase = getSupabaseAdmin();

        // Find the company owner
        const { data: company } = await supabase
            .from('companies')
            .select('owner_id')
            .eq('id', companyId)
            .single();

        if (!company?.owner_id) return;

        // Get owner's subscription
        const { data: subscription } = await supabase
            .from('subscriptions')
            .select('stripe_subscription_id, stripe_member_item_id, plan_id, extra_members_quantity')
            .eq('user_id', company.owner_id)
            .maybeSingle();

        if (!subscription?.stripe_subscription_id) return;

        // Count extra members
        const extraMembers = await this.countExtraMembers(supabase, company.owner_id);
        const defaultPaymentMethodType = await this.getDefaultSubscriptionPaymentMethodType(
            stripe,
            subscription.stripe_subscription_id,
        );

        let nextMemberItemId = subscription.stripe_member_item_id || null;

        if (extraMembers === (subscription.extra_members_quantity || 0)) {
            return;
        }

        if (extraMembers <= 0) {
            if (subscription.stripe_member_item_id) {
                await stripe.subscriptionItems.del(subscription.stripe_member_item_id, {
                    proration_behavior: 'create_prorations',
                });
                nextMemberItemId = null;
            }
        } else if (subscription.stripe_member_item_id) {
            const isIncreasingQuantity = extraMembers > (subscription.extra_members_quantity || 0);
            const billingParams = this.getMemberItemBillingParams(
                defaultPaymentMethodType,
                isIncreasingQuantity,
            );

            await stripe.subscriptionItems.update(subscription.stripe_member_item_id, {
                quantity: extraMembers,
                ...billingParams,
            });
        } else {
            if (!subscription.plan_id) {
                return;
            }

            const { data: plan } = await supabase
                .from('subscription_plans')
                .select('stripe_member_lookup_key')
                .eq('id', subscription.plan_id)
                .maybeSingle();

            if (!plan?.stripe_member_lookup_key) {
                return;
            }

            const memberPriceId = await this.resolveStripePriceId(stripe, plan.stripe_member_lookup_key);
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
        }

        // Update DB
        await supabase
            .from('subscriptions')
            .update({
                stripe_member_item_id: nextMemberItemId,
                extra_members_quantity: extraMembers,
                updated_at: new Date().toISOString(),
            })
            .eq('user_id', company.owner_id);
    }

    /**
     * Changes the subscription plan and/or billing period via Stripe swap (proration).
     */
    async changePlan(
        userId: string,
        planSlug: string,
        billingPeriod?: 'monthly' | 'yearly',
    ): Promise<SubscriptionDto> {
        await this.legalDocumentService.ensurePlatformAcceptanceCurrent(userId);
        const supabase = getSupabaseAdmin();
        const effectiveTarget = await resolveEffectiveSubscriptionTarget(userId);

        if (!effectiveTarget.can_manage_billing) {
            throw new ForbiddenException(
                'La facturation est gérée par le propriétaire de l\'entreprise.',
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
            .eq('user_id', userId)
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
                        plan_id: newPlan.id,
                        status: 'active',
                        billing_period: effectiveBillingPeriod,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('user_id', userId);
            } else {
                await supabase
                    .from('subscriptions')
                    .insert({
                        user_id: userId,
                        plan_id: newPlan.id,
                        status: 'active',
                        billing_period: effectiveBillingPeriod,
                        extra_members_quantity: 0,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    });
            }

            return {
                ...(existingSubscription || {}),
                plan_id: newPlan.id,
                status: 'active',
                billing_period: effectiveBillingPeriod,
                extra_members_quantity: existingSubscription?.extra_members_quantity || 0,
                plan: newPlan as SubscriptionPlanDto,
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

        // Swap the base plan item
        await stripe.subscriptions.update(existingSubscription.stripe_subscription_id, {
            items: [{
                id: baseItemId,
                price: newPriceId,
            }],
            proration_behavior: 'create_prorations',
            metadata: {
                user_id: userId,
                plan_id: newPlan.id,
                billing_period: effectiveBillingPeriod,
            },
        });

        // Update DB immediately (webhook will also sync)
        await supabase
            .from('subscriptions')
            .update({
                plan_id: newPlan.id,
                billing_period: effectiveBillingPeriod,
                updated_at: new Date().toISOString(),
            })
            .eq('user_id', userId);

        return {
            ...existingSubscription,
            plan_id: newPlan.id,
            billing_period: effectiveBillingPeriod,
            extra_members_quantity: existingSubscription.extra_members_quantity || 0,
            plan: newPlan as SubscriptionPlanDto,
        };
    }
}
