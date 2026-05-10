import { getSupabaseAdmin } from '../../config/supabase.config';
import { resolveEffectiveSubscriptionTarget } from '../../common/subscription/effective-subscription';
import { SubscriptionService, buildSubscriptionMemberUsage } from './subscription.service';

jest.mock('../../config/supabase.config', () => ({
    getSupabaseAdmin: jest.fn(),
    getSupabaseClient: jest.fn(),
}));

jest.mock('../../common/subscription/effective-subscription', () => {
    const actual = jest.requireActual('../../common/subscription/effective-subscription');
    return {
        ...actual,
        resolveEffectiveSubscriptionTarget: jest.fn(),
    };
});

function createSyncMemberQuantitySupabaseMock(options?: {
    stripeMemberItemId?: string | null;
    extraMembersQuantity?: number;
    planId?: string | null;
    stripeMemberLookupKey?: string | null;
}) {
    let updatedPayload: Record<string, any> | null = null;
    const hasStripeMemberItemId =
        options && Object.prototype.hasOwnProperty.call(options, 'stripeMemberItemId');

    const subscriptionRow = {
        stripe_subscription_id: 'sub_123',
        stripe_member_item_id: hasStripeMemberItemId
            ? options?.stripeMemberItemId ?? null
            : 'si_member_123',
        plan_id: options?.planId ?? 'plan_123',
        extra_members_quantity: options?.extraMembersQuantity ?? 1,
    };

    return {
        supabase: {
            from: jest.fn((table: string) => {
                if (table === 'companies') {
                    return {
                        select: jest.fn(() => ({
                            eq: jest.fn().mockReturnValue({
                                single: jest.fn().mockResolvedValue({
                                    data: { owner_id: 'owner_123' },
                                }),
                                maybeSingle: jest.fn().mockResolvedValue({
                                    data: {
                                        rib_iban: 'Carte visa **** 4242',
                                        rib_bic: '12/2030',
                                        rib_bank_name: 'Carte bancaire',
                                    },
                                }),
                            }),
                        })),
                    };
                }

                if (table === 'subscriptions') {
                    return {
                        select: jest.fn(() => ({
                            eq: jest.fn().mockReturnValue({
                                maybeSingle: jest.fn().mockResolvedValue({
                                    data: subscriptionRow,
                                }),
                            }),
                        })),
                        update: jest.fn((payload: Record<string, any>) => {
                            updatedPayload = payload;

                            return {
                                eq: jest.fn().mockResolvedValue({ error: null }),
                            };
                        }),
                    };
                }

                if (table === 'subscription_plans') {
                    return {
                        select: jest.fn(() => ({
                            eq: jest.fn().mockReturnValue({
                                maybeSingle: jest.fn().mockResolvedValue({
                                    data: {
                                        stripe_member_lookup_key:
                                            options?.stripeMemberLookupKey ?? 'member_lookup_key',
                                    },
                                }),
                            }),
                        })),
                    };
                }

                throw new Error(`Unexpected table: ${table}`);
            }),
        },
        getUpdatedPayload: () => updatedPayload,
    };
}

function createStripeSubscriptionMock(options?: {
    memberItemId?: string | null;
    memberQuantity?: number;
    defaultPaymentMethod?: string | null;
    customer?: string;
}) {
    const memberItemId = options && Object.prototype.hasOwnProperty.call(options, 'memberItemId')
        ? options.memberItemId
        : 'si_member_123';
    const items = [
        { id: 'si_base_123', quantity: 1, price: { id: 'price_base_123' } },
    ];

    if (memberItemId) {
        items.push({
            id: memberItemId,
            quantity: options?.memberQuantity ?? 1,
            price: { id: 'price_member_123' },
        });
    }

    return {
        id: 'sub_123',
        customer: options?.customer ?? 'cus_123',
        default_payment_method: options?.defaultPaymentMethod ?? 'pm_card_123',
        status: 'active',
        latest_invoice: null,
        items: { data: items },
    };
}

function createChangePlanSupabaseMock() {
    let updatedPayload: Record<string, any> | null = null;
    const existingSubscription = {
        id: 'sub_row_123',
        user_id: 'owner_123',
        company_id: 'company_123',
        plan_id: 'old_plan_123',
        status: 'active',
        billing_period: 'monthly',
        stripe_customer_id: 'cus_123',
        stripe_subscription_id: 'sub_123',
        stripe_base_item_id: 'si_base_123',
        stripe_member_item_id: null,
        current_period_start: '2026-04-01T00:00:00.000Z',
        current_period_end: '2026-05-01T00:00:00.000Z',
        extra_members_quantity: 0,
        created_at: '2026-04-01T00:00:00.000Z',
        updated_at: '2026-04-01T00:00:00.000Z',
    };
    const oldPlan = {
        id: 'old_plan_123',
        slug: 'essentiel',
        name: 'Essentiel',
        stripe_lookup_key_monthly: 'essentiel_monthly',
        stripe_lookup_key_yearly: 'essentiel_yearly',
    };
    const newPlan = {
        id: 'new_plan_123',
        slug: 'business',
        name: 'Business',
        stripe_lookup_key_monthly: 'business_monthly',
        stripe_lookup_key_yearly: 'business_yearly',
    };

    return {
        supabase: {
            from: jest.fn((table: string) => {
                if (table === 'subscriptions') {
                    return {
                        select: jest.fn(() => ({
                            eq: jest.fn(() => ({
                                maybeSingle: jest.fn().mockResolvedValue({
                                    data: existingSubscription,
                                }),
                            })),
                        })),
                        update: jest.fn((payload: Record<string, any>) => {
                            updatedPayload = payload;
                            return {
                                eq: jest.fn().mockResolvedValue({ error: null }),
                            };
                        }),
                    };
                }

                if (table === 'subscription_plans') {
                    return {
                        select: jest.fn(() => {
                            let selectedById = false;
                            const chain: any = {
                                eq: jest.fn((column: string) => {
                                    if (column === 'id') selectedById = true;
                                    return chain;
                                }),
                                single: jest.fn().mockImplementation(() => Promise.resolve({
                                    data: selectedById ? oldPlan : newPlan,
                                    error: null,
                                })),
                            };
                            return chain;
                        }),
                    };
                }

                throw new Error(`Unexpected table: ${table}`);
            }),
        },
        existingSubscription,
        newPlan,
        getUpdatedPayload: () => updatedPayload,
    };
}

function createSubscriptionUpdatedWebhookSupabaseMock() {
    let updatedPayload: Record<string, any> | null = null;

    return {
        supabase: {
            from: jest.fn((table: string) => {
                if (table === 'subscriptions') {
                    return {
                        select: jest.fn(() => ({
                            eq: jest.fn(() => ({
                                maybeSingle: jest.fn().mockResolvedValue({
                                    data: {
                                        stripe_base_item_id: 'si_base_123',
                                        stripe_member_item_id: null,
                                    },
                                }),
                            })),
                        })),
                        update: jest.fn((payload: Record<string, any>) => {
                            updatedPayload = payload;
                            return {
                                eq: jest.fn().mockResolvedValue({ error: null }),
                            };
                        }),
                    };
                }

                if (table === 'subscription_plans') {
                    return {
                        select: jest.fn(() => ({
                            eq: jest.fn(() => ({
                                eq: jest.fn(() => ({
                                    maybeSingle: jest.fn().mockResolvedValue({
                                        data: { id: 'new_plan_123' },
                                    }),
                                })),
                            })),
                        })),
                    };
                }

                if (table === 'registration_payment_sessions') {
                    return {
                        select: jest.fn(() => ({
                            eq: jest.fn(() => ({
                                is: jest.fn(() => ({
                                    maybeSingle: jest.fn().mockResolvedValue({ data: null }),
                                })),
                            })),
                        })),
                    };
                }

                throw new Error(`Unexpected table: ${table}`);
            }),
        },
        getUpdatedPayload: () => updatedPayload,
    };
}

describe('buildSubscriptionMemberUsage', () => {
    it('includes pending merchant invitations in billable member counts', () => {
        expect(
            buildSubscriptionMemberUsage(1, 2, 'merchant_admin', 1),
        ).toEqual({
            total_members: 1,
            extra_members: 0,
            pending_invitations: 2,
            billable_members: 3,
            billable_extra_members: 2,
        });
    });

    it('keeps the same billable add-on count when a pending invitation becomes an active member', () => {
        const pendingInvitationUsage = buildSubscriptionMemberUsage(
            1,
            1,
            'merchant_admin',
            1,
        );
        const acceptedInvitationUsage = buildSubscriptionMemberUsage(
            2,
            0,
            'merchant_admin',
            2,
        );

        expect(pendingInvitationUsage.billable_extra_members).toBe(1);
        expect(acceptedInvitationUsage.billable_extra_members).toBe(1);
        expect(pendingInvitationUsage.billable_members).toBe(2);
        expect(acceptedInvitationUsage.billable_members).toBe(2);
    });

    it('does not bill cabinet invitations as merchant add-ons', () => {
        expect(
            buildSubscriptionMemberUsage(3, 2, 'accountant', 3),
        ).toEqual({
            total_members: 3,
            extra_members: 2,
            pending_invitations: 2,
            billable_members: 3,
            billable_extra_members: 0,
        });
    });
});

describe('SubscriptionService.syncMemberQuantity', () => {
    let service: SubscriptionService;
    let legalDocumentServiceMock: {
        ensurePlatformAcceptanceCurrent: jest.Mock;
        validateCurrentPlatformAcceptanceTimestamp: jest.Mock;
    };
    let companyServiceMock: {
        create: jest.Mock;
        findOne: jest.Mock;
    };
    let stripeMock: {
        paymentMethods: { retrieve: jest.Mock };
        subscriptionItems: {
            create: jest.Mock;
            del: jest.Mock;
            update: jest.Mock;
        };
        subscriptions: { retrieve: jest.Mock; create: jest.Mock; update: jest.Mock };
        customers: { retrieve: jest.Mock; create: jest.Mock };
        prices: { list: jest.Mock };
        promotionCodes: { list: jest.Mock };
        coupons: { retrieve: jest.Mock };
    };

    beforeEach(() => {
        process.env.REGISTRATION_ENCRYPTION_KEY = '12345678901234567890123456789012';

        legalDocumentServiceMock = {
            ensurePlatformAcceptanceCurrent: jest.fn(),
            validateCurrentPlatformAcceptanceTimestamp: jest.fn(),
        };
        companyServiceMock = {
            create: jest.fn(),
            findOne: jest.fn(),
        };

        service = new SubscriptionService(
            {
                get: jest.fn((key: string, defaultValue?: string) => {
                    if (key === 'STRIPE_ENABLED') {
                        return 'true';
                    }

                    return defaultValue;
                }),
            } as any,
            legalDocumentServiceMock as any,
            companyServiceMock as any,
        );

        stripeMock = {
            paymentMethods: {
                retrieve: jest.fn(),
            },
            subscriptionItems: {
                create: jest.fn(),
                del: jest.fn(),
                update: jest.fn(),
            },
            subscriptions: {
                retrieve: jest.fn(),
                create: jest.fn(),
                update: jest.fn(),
            },
            customers: {
                retrieve: jest.fn(),
                create: jest.fn(),
            },
            prices: {
                list: jest.fn(),
            },
            promotionCodes: {
                list: jest.fn(),
            },
            coupons: {
                retrieve: jest.fn(),
            },
        };

        (service as any).stripe = stripeMock;
    });

    afterEach(() => {
        delete process.env.REGISTRATION_ENCRYPTION_KEY;
        jest.restoreAllMocks();
    });

    it('keeps immediate billing when increasing extra members with a card default payment method', async () => {
        const supabaseMock = createSyncMemberQuantitySupabaseMock({
            stripeMemberItemId: 'si_member_123',
            extraMembersQuantity: 1,
        });

        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock.supabase as any);
        jest.spyOn(service as any, 'countExtraMembers').mockResolvedValue(2);

        stripeMock.subscriptions.retrieve.mockResolvedValue(
            createStripeSubscriptionMock({
                memberItemId: 'si_member_123',
                memberQuantity: 1,
                defaultPaymentMethod: 'pm_card_123',
            }),
        );
        stripeMock.paymentMethods.retrieve.mockResolvedValue({
            id: 'pm_card_123',
            type: 'card',
        });
        stripeMock.subscriptionItems.update.mockResolvedValue({ id: 'si_member_123' });

        await service.syncMemberQuantity('company_123');

        expect(stripeMock.subscriptionItems.update).toHaveBeenCalledWith(
            'si_member_123',
            expect.objectContaining({
                quantity: 2,
                proration_behavior: 'always_invoice',
                payment_behavior: 'pending_if_incomplete',
            }),
        );
        expect(supabaseMock.getUpdatedPayload()).toEqual(
            expect.objectContaining({
                stripe_member_item_id: 'si_member_123',
                extra_members_quantity: 2,
            }),
        );
    });

    it('creates a member add-on with an immediate invoice when the default payment method is SEPA', async () => {
        const supabaseMock = createSyncMemberQuantitySupabaseMock({
            stripeMemberItemId: null,
            extraMembersQuantity: 0,
            stripeMemberLookupKey: 'member_lookup_key',
        });

        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock.supabase as any);
        jest.spyOn(service as any, 'countExtraMembers').mockResolvedValue(2);

        stripeMock.subscriptions.retrieve
            .mockResolvedValueOnce(
                createStripeSubscriptionMock({
                    memberItemId: null,
                    defaultPaymentMethod: null,
                }),
            )
            .mockResolvedValueOnce(
                createStripeSubscriptionMock({
                    memberItemId: null,
                    defaultPaymentMethod: null,
                }),
            )
            .mockResolvedValueOnce(
                createStripeSubscriptionMock({
                    memberItemId: 'si_member_new_123',
                    memberQuantity: 2,
                    defaultPaymentMethod: null,
                }),
            );
        stripeMock.customers.retrieve.mockResolvedValue({
            id: 'cus_123',
            deleted: false,
            invoice_settings: {
                default_payment_method: 'pm_sepa_123',
            },
        });
        stripeMock.paymentMethods.retrieve.mockResolvedValue({
            id: 'pm_sepa_123',
            type: 'sepa_debit',
        });
        stripeMock.prices.list.mockResolvedValue({
            data: [{ id: 'price_member_123' }],
        });
        stripeMock.subscriptionItems.create.mockResolvedValue({ id: 'si_member_new_123' });

        await service.syncMemberQuantity('company_123');

        expect(stripeMock.subscriptionItems.create).toHaveBeenCalledWith(
            expect.objectContaining({
                subscription: 'sub_123',
                price: 'price_member_123',
                quantity: 2,
                proration_behavior: 'always_invoice',
            }),
        );
        expect(stripeMock.subscriptionItems.create.mock.calls[0][0]).not.toHaveProperty(
            'payment_behavior',
        );
        expect(supabaseMock.getUpdatedPayload()).toEqual(
            expect.objectContaining({
                stripe_member_item_id: 'si_member_new_123',
                extra_members_quantity: 2,
            }),
        );
    });

    it('updates member quantity with an immediate invoice when the default payment method is SEPA', async () => {
        const supabaseMock = createSyncMemberQuantitySupabaseMock({
            stripeMemberItemId: 'si_member_123',
            extraMembersQuantity: 1,
        });

        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock.supabase as any);
        jest.spyOn(service as any, 'countExtraMembers').mockResolvedValue(2);

        stripeMock.subscriptions.retrieve.mockResolvedValue(
            createStripeSubscriptionMock({
                memberItemId: 'si_member_123',
                memberQuantity: 1,
                defaultPaymentMethod: 'pm_sepa_123',
            }),
        );
        stripeMock.paymentMethods.retrieve.mockResolvedValue({
            id: 'pm_sepa_123',
            type: 'sepa_debit',
        });
        stripeMock.subscriptionItems.update.mockResolvedValue({ id: 'si_member_123' });

        await service.syncMemberQuantity('company_123');

        expect(stripeMock.subscriptionItems.update).toHaveBeenCalledWith(
            'si_member_123',
            expect.objectContaining({
                quantity: 2,
                proration_behavior: 'always_invoice',
            }),
        );
        expect(stripeMock.subscriptionItems.update.mock.calls[0][1]).not.toHaveProperty(
            'payment_behavior',
        );
    });

    it('clears a stale local member item when Stripe no longer has an add-on and no extra members remain', async () => {
        const supabaseMock = createSyncMemberQuantitySupabaseMock({
            stripeMemberItemId: 'si_stale_123',
            extraMembersQuantity: 1,
        });

        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock.supabase as any);
        jest.spyOn(service as any, 'countExtraMembers').mockResolvedValue(0);
        stripeMock.subscriptions.retrieve.mockResolvedValue(
            createStripeSubscriptionMock({
                memberItemId: null,
                defaultPaymentMethod: 'pm_card_123',
            }),
        );

        await service.syncMemberQuantity('company_123');

        expect(stripeMock.subscriptionItems.del).not.toHaveBeenCalled();
        expect(stripeMock.subscriptionItems.update).not.toHaveBeenCalled();
        expect(supabaseMock.getUpdatedPayload()).toEqual(
            expect.objectContaining({
                stripe_member_item_id: null,
                extra_members_quantity: 0,
            }),
        );
    });

    it('creates a new member add-on when the stored member item is stale and extra members are due', async () => {
        const supabaseMock = createSyncMemberQuantitySupabaseMock({
            stripeMemberItemId: 'si_stale_123',
            extraMembersQuantity: 0,
            stripeMemberLookupKey: 'member_lookup_key',
        });

        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock.supabase as any);
        jest.spyOn(service as any, 'countExtraMembers').mockResolvedValue(1);
        stripeMock.subscriptions.retrieve
            .mockResolvedValueOnce(
                createStripeSubscriptionMock({
                    memberItemId: null,
                    defaultPaymentMethod: 'pm_card_123',
                }),
            )
            .mockResolvedValueOnce(
                createStripeSubscriptionMock({
                    memberItemId: null,
                    defaultPaymentMethod: 'pm_card_123',
                }),
            )
            .mockResolvedValueOnce(
                createStripeSubscriptionMock({
                    memberItemId: 'si_member_new_123',
                    memberQuantity: 1,
                    defaultPaymentMethod: 'pm_card_123',
                }),
            );
        stripeMock.paymentMethods.retrieve.mockResolvedValue({
            id: 'pm_card_123',
            type: 'card',
        });
        stripeMock.prices.list.mockResolvedValue({
            data: [{ id: 'price_member_123' }],
        });
        stripeMock.subscriptionItems.create.mockResolvedValue({ id: 'si_member_new_123' });

        await service.syncMemberQuantity('company_123');

        expect(stripeMock.subscriptionItems.update).not.toHaveBeenCalledWith(
            'si_stale_123',
            expect.anything(),
        );
        expect(stripeMock.subscriptionItems.create).toHaveBeenCalledWith(
            expect.objectContaining({
                subscription: 'sub_123',
                quantity: 1,
            }),
        );
        expect(supabaseMock.getUpdatedPayload()).toEqual(
            expect.objectContaining({
                stripe_member_item_id: 'si_member_new_123',
                extra_members_quantity: 1,
            }),
        );
    });

    it('returns a client secret and keeps the local plan unchanged when a plan change requires payment confirmation', async () => {
        const supabaseMock = createChangePlanSupabaseMock();
        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock.supabase as any);
        jest.mocked(resolveEffectiveSubscriptionTarget).mockResolvedValue({
            can_manage_billing: true,
            subscription_company_id: 'company_123',
            owner_user_id: 'owner_123',
            company_owner_role: 'merchant_admin',
        } as any);
        stripeMock.prices.list.mockResolvedValue({ data: [{ id: 'price_business_monthly' }] });
        stripeMock.subscriptions.update.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            pending_update: { expires_at: 1770000000 },
            latest_invoice: {
                payment_intent: {
                    status: 'requires_action',
                    client_secret: 'pi_secret_123',
                },
            },
        });

        const result = await service.changePlan('owner_123', 'business', 'monthly', 'company_123');

        expect(stripeMock.subscriptions.update).toHaveBeenCalledWith(
            'sub_123',
            expect.objectContaining({
                payment_behavior: 'pending_if_incomplete',
                proration_behavior: 'always_invoice',
                expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payment_intent'],
            }),
        );
        expect(stripeMock.subscriptions.update.mock.calls[0][1]).not.toHaveProperty(
            'metadata',
        );
        expect(result.client_secret).toBe('pi_secret_123');
        expect(result.subscription.plan_id).toBe('old_plan_123');
        expect(supabaseMock.getUpdatedPayload()).toBeNull();
    });

    it('returns a confirmation secret when Stripe exposes it on the latest invoice', async () => {
        const supabaseMock = createChangePlanSupabaseMock();
        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock.supabase as any);
        jest.mocked(resolveEffectiveSubscriptionTarget).mockResolvedValue({
            can_manage_billing: true,
            subscription_company_id: 'company_123',
            owner_user_id: 'owner_123',
            company_owner_role: 'merchant_admin',
        } as any);
        stripeMock.prices.list.mockResolvedValue({ data: [{ id: 'price_business_monthly' }] });
        stripeMock.subscriptions.update.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            pending_update: { expires_at: 1770000000 },
            latest_invoice: {
                confirmation_secret: {
                    client_secret: 'cs_secret_123',
                },
            },
        });

        const result = await service.changePlan('owner_123', 'business', 'monthly', 'company_123');

        expect(result.client_secret).toBe('cs_secret_123');
        expect(result.status).toBe('requires_payment_confirmation');
        expect(result.subscription.plan_id).toBe('old_plan_123');
        expect(supabaseMock.getUpdatedPayload()).toBeNull();
    });

    it('updates the local subscription when a plan change is settled immediately', async () => {
        const supabaseMock = createChangePlanSupabaseMock();
        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock.supabase as any);
        jest.mocked(resolveEffectiveSubscriptionTarget).mockResolvedValue({
            can_manage_billing: true,
            subscription_company_id: 'company_123',
            owner_user_id: 'owner_123',
            company_owner_role: 'merchant_admin',
        } as any);
        stripeMock.prices.list.mockResolvedValue({ data: [{ id: 'price_business_monthly' }] });
        stripeMock.subscriptions.update.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            pending_update: null,
            latest_invoice: {
                payment_intent: {
                    status: 'succeeded',
                    client_secret: 'pi_secret_123',
                },
            },
        });

        const result = await service.changePlan('owner_123', 'business', 'monthly', 'company_123');

        expect(result.client_secret).toBeNull();
        expect(result.subscription.plan_id).toBe('new_plan_123');
        expect(supabaseMock.getUpdatedPayload()).toEqual(expect.objectContaining({
            plan_id: 'new_plan_123',
            billing_period: 'monthly',
        }));
    });

    it('resolves the applied plan from the Stripe price lookup key when subscription metadata is absent', async () => {
        const supabaseMock = createSubscriptionUpdatedWebhookSupabaseMock();
        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock.supabase as any);
        jest.spyOn(service as any, 'getPendingCompanySessionByStripeSubscriptionId')
            .mockResolvedValue(null);
        jest.spyOn(service as any, 'prefillCompanyBankingBySubscriptionId')
            .mockResolvedValue(undefined);

        await service.handleWebhook({
            type: 'customer.subscription.updated',
            data: {
                object: {
                    id: 'sub_123',
                    status: 'active',
                    cancel_at_period_end: false,
                    pending_update: null,
                    metadata: {},
                    items: {
                        data: [{
                            id: 'si_base_123',
                            quantity: 1,
                            current_period_end: 1770000000,
                            price: {
                                lookup_key: 'business_monthly',
                                recurring: { interval: 'month' },
                            },
                        }],
                    },
                },
            },
        } as any);

        expect(supabaseMock.getUpdatedPayload()).toEqual(expect.objectContaining({
            plan_id: 'new_plan_123',
            billing_period: 'monthly',
            stripe_base_item_id: 'si_base_123',
        }));
    });

    it('validates a percent-off promotion code for registration pricing', async () => {
        jest.mocked(getSupabaseAdmin).mockReturnValue({
            from: jest.fn(() => ({
                select: jest.fn(() => ({
                    eq: jest.fn().mockReturnValue({
                        eq: jest.fn().mockReturnValue({
                            single: jest.fn().mockResolvedValue({
                                data: {
                                    id: 'plan_123',
                                    slug: 'essentiel',
                                    is_active: true,
                                    price_monthly: 9.9,
                                    price_yearly: 99,
                                    stripe_lookup_key_monthly: 'essentiel_monthly',
                                    stripe_lookup_key_yearly: 'essentiel_yearly',
                                },
                            }),
                        }),
                    }),
                })),
            })),
        } as any);

        stripeMock.prices.list.mockResolvedValue({
            data: [
                {
                    id: 'price_123',
                    unit_amount: 990,
                    currency: 'eur',
                    product: 'prod_123',
                },
            ],
        });
        stripeMock.promotionCodes.list.mockResolvedValue({
            data: [
                {
                    id: 'promo_123',
                    code: 'BIENVENUE20',
                    active: true,
                    times_redeemed: 0,
                    max_redemptions: null,
                    restrictions: {},
                    coupon: {
                        id: 'coupon_123',
                        name: 'Bienvenue',
                        percent_off: 20,
                        amount_off: null,
                        valid: true,
                        applies_to: { products: ['prod_123'] },
                    },
                },
            ],
        });

        const result = await service.validateRegistrationPromotionCode({
            plan_slug: 'essentiel',
            billing_period: 'monthly',
            promotion_code: 'BIENVENUE20',
        });

        expect(result.pricing).toEqual(
            expect.objectContaining({
                original_amount_ht: 9.9,
                discount_amount_ht: 1.98,
                final_amount_ht: 7.92,
                promotion_code: 'BIENVENUE20',
                coupon_name: 'Bienvenue',
                coupon_percent_off: 20,
                coupon_amount_off: null,
            }),
        );
    });

    it('validates a fixed-amount promotion code for registration pricing', async () => {
        jest.mocked(getSupabaseAdmin).mockReturnValue({
            from: jest.fn(() => ({
                select: jest.fn(() => ({
                    eq: jest.fn().mockReturnValue({
                        eq: jest.fn().mockReturnValue({
                            single: jest.fn().mockResolvedValue({
                                data: {
                                    id: 'plan_123',
                                    slug: 'business',
                                    is_active: true,
                                    price_monthly: 12.9,
                                    price_yearly: 129,
                                    stripe_lookup_key_monthly: 'business_monthly',
                                    stripe_lookup_key_yearly: 'business_yearly',
                                },
                            }),
                        }),
                    }),
                })),
            })),
        } as any);

        stripeMock.prices.list.mockResolvedValue({
            data: [
                {
                    id: 'price_123',
                    unit_amount: 1290,
                    currency: 'eur',
                    product: 'prod_123',
                },
            ],
        });
        stripeMock.promotionCodes.list.mockResolvedValue({
            data: [
                {
                    id: 'promo_123',
                    code: 'WELCOME5',
                    active: true,
                    times_redeemed: 0,
                    max_redemptions: null,
                    restrictions: {},
                    coupon: {
                        id: 'coupon_123',
                        name: 'Welcome 5',
                        percent_off: null,
                        amount_off: 500,
                        currency: 'eur',
                        valid: true,
                        applies_to: { products: ['prod_123'] },
                    },
                },
            ],
        });

        const result = await service.validateRegistrationPromotionCode({
            plan_slug: 'business',
            billing_period: 'monthly',
            promotion_code: 'WELCOME5',
        });

        expect(result.pricing).toEqual(
            expect.objectContaining({
                original_amount_ht: 12.9,
                discount_amount_ht: 5,
                final_amount_ht: 7.9,
                promotion_code: 'WELCOME5',
                coupon_name: 'Welcome 5',
                coupon_percent_off: null,
                coupon_amount_off: 5,
            }),
        );
    });

    it('rejects an unknown promotion code for registration pricing', async () => {
        jest.mocked(getSupabaseAdmin).mockReturnValue({
            from: jest.fn(() => ({
                select: jest.fn(() => ({
                    eq: jest.fn().mockReturnValue({
                        eq: jest.fn().mockReturnValue({
                            single: jest.fn().mockResolvedValue({
                                data: {
                                    id: 'plan_123',
                                    slug: 'essentiel',
                                    is_active: true,
                                    price_monthly: 9.9,
                                    price_yearly: 99,
                                    stripe_lookup_key_monthly: 'essentiel_monthly',
                                    stripe_lookup_key_yearly: 'essentiel_yearly',
                                },
                            }),
                        }),
                    }),
                })),
            })),
        } as any);

        stripeMock.prices.list.mockResolvedValue({
            data: [
                {
                    id: 'price_123',
                    unit_amount: 990,
                    currency: 'eur',
                    product: 'prod_123',
                },
            ],
        });
        stripeMock.promotionCodes.list.mockResolvedValue({ data: [] });

        await expect(
            service.validateRegistrationPromotionCode({
                plan_slug: 'essentiel',
                billing_period: 'monthly',
                promotion_code: 'NOPE',
            }),
        ).rejects.toThrow(
            'Ce code promo est introuvable dans l’environnement Stripe configuré sur ce serveur. Vérifiez qu’il a été créé sur le même compte et dans le même mode (test/live).',
        );
    });

    it('rejects an inactive promotion code for registration pricing', async () => {
        jest.mocked(getSupabaseAdmin).mockReturnValue({
            from: jest.fn(() => ({
                select: jest.fn(() => ({
                    eq: jest.fn().mockReturnValue({
                        eq: jest.fn().mockReturnValue({
                            single: jest.fn().mockResolvedValue({
                                data: {
                                    id: 'plan_123',
                                    slug: 'essentiel',
                                    is_active: true,
                                    price_monthly: 9.9,
                                    price_yearly: 99,
                                    stripe_lookup_key_monthly: 'essentiel_monthly',
                                    stripe_lookup_key_yearly: 'essentiel_yearly',
                                },
                            }),
                        }),
                    }),
                })),
            })),
        } as any);

        stripeMock.prices.list.mockResolvedValue({
            data: [
                {
                    id: 'price_123',
                    unit_amount: 990,
                    currency: 'eur',
                    product: 'prod_123',
                },
            ],
        });
        stripeMock.promotionCodes.list.mockResolvedValue({
            data: [
                {
                    id: 'promo_123',
                    code: 'EXPIRE',
                    active: false,
                    times_redeemed: 0,
                    max_redemptions: null,
                    restrictions: {},
                    coupon: {
                        id: 'coupon_123',
                        percent_off: 10,
                        amount_off: null,
                        valid: true,
                        applies_to: { products: ['prod_123'] },
                    },
                },
            ],
        });

        await expect(
            service.validateRegistrationPromotionCode({
                plan_slug: 'essentiel',
                billing_period: 'monthly',
                promotion_code: 'EXPIRE',
            }),
        ).rejects.toThrow('Ce code promo est invalide ou expiré.');
    });

    it('creates a registration subscription with discounts when a promo code is valid', async () => {
        const supabaseMock = {
            from: jest.fn((table: string) => {
                if (table === 'registration_payment_sessions') {
                    return {
                        insert: jest.fn(() => ({
                            select: jest.fn(() => ({
                                single: jest.fn().mockResolvedValue({
                                    data: {
                                        id: 'reg_123',
                                    },
                                }),
                            })),
                        })),
                        update: jest.fn(() => ({
                            eq: jest.fn().mockResolvedValue({ error: null }),
                        })),
                    };
                }

                throw new Error(`Unexpected table: ${table}`);
            }),
        };

        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock as any);
        jest.spyOn(service as any, 'ensureRegistrationEmailAvailable').mockResolvedValue(undefined);
        jest.spyOn(service as any, 'ensureRegistrationCompanyAvailable').mockResolvedValue(undefined);
        jest.spyOn(service as any, 'cancelExistingRegistrationSessions').mockResolvedValue(undefined);
        jest.spyOn(service as any, 'resolveRegistrationPricingContext').mockResolvedValue({
            plan: { id: 'plan_123' },
            basePriceId: 'price_123',
            basePrice: { id: 'price_123', unit_amount: 990, currency: 'eur' },
            pricing: {
                original_amount_ht: 9.9,
                discount_amount_ht: 2,
                final_amount_ht: 7.9,
                currency: 'EUR',
                promotion_code: 'BIENVENUE20',
                coupon_name: 'Bienvenue',
                coupon_percent_off: 20,
                coupon_amount_off: null,
            },
            stripePromotionCodeId: 'promo_123',
        });

        stripeMock.customers.create.mockResolvedValue({ id: 'cus_123' });
        stripeMock.subscriptions.create.mockResolvedValue({
            id: 'sub_123',
            status: 'incomplete',
            items: { data: [{ id: 'si_123' }] },
            latest_invoice: {
                subtotal: 990,
                total_discount_amounts: [{ amount: 200 }],
                confirmation_secret: { client_secret: 'secret_123' },
                payment_intent: null,
            },
        });

        const result = await service.createRegistrationSubscription({
            email: 'test@example.com',
            password: 'Password123!',
            first_name: 'Jean',
            last_name: 'Dupont',
            company_creation_mode: 'create',
            company_name: 'Demo',
            siren: '123456789',
            address: '10 rue de Paris',
            postal_code: '75001',
            city: 'Paris',
            country: 'FR',
            role: 'merchant_admin',
            plan_slug: 'essentiel',
            billing_period: 'monthly',
            promotion_code: 'BIENVENUE20',
            platform_legal_accepted_at: new Date().toISOString(),
        });

        expect(legalDocumentServiceMock.validateCurrentPlatformAcceptanceTimestamp).toHaveBeenCalled();
        expect(stripeMock.customers.create).toHaveBeenCalledWith(
            expect.objectContaining({
                email: 'test@example.com',
                name: 'Demo',
                address: {
                    line1: '10 rue de Paris',
                    postal_code: '75001',
                    city: 'Paris',
                    country: 'FR',
                },
            }),
        );
        expect(stripeMock.subscriptions.create).toHaveBeenCalledWith(
            expect.objectContaining({
                automatic_tax: { enabled: true },
                discounts: [{ promotion_code: 'promo_123' }],
            }),
        );
        expect(result.pricing.discount_amount_ht).toBe(2);
    });

    it('creates a registration subscription without discounts when no promo code is provided', async () => {
        const supabaseMock = {
            from: jest.fn((table: string) => {
                if (table === 'registration_payment_sessions') {
                    return {
                        insert: jest.fn(() => ({
                            select: jest.fn(() => ({
                                single: jest.fn().mockResolvedValue({
                                    data: {
                                        id: 'reg_123',
                                    },
                                }),
                            })),
                        })),
                        update: jest.fn(() => ({
                            eq: jest.fn().mockResolvedValue({ error: null }),
                        })),
                    };
                }

                throw new Error(`Unexpected table: ${table}`);
            }),
        };

        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock as any);
        jest.spyOn(service as any, 'ensureRegistrationEmailAvailable').mockResolvedValue(undefined);
        jest.spyOn(service as any, 'ensureRegistrationCompanyAvailable').mockResolvedValue(undefined);
        jest.spyOn(service as any, 'cancelExistingRegistrationSessions').mockResolvedValue(undefined);
        jest.spyOn(service as any, 'resolveRegistrationPricingContext').mockResolvedValue({
            plan: { id: 'plan_123' },
            basePriceId: 'price_123',
            basePrice: { id: 'price_123', unit_amount: 990, currency: 'eur' },
            pricing: {
                original_amount_ht: 9.9,
                discount_amount_ht: 0,
                final_amount_ht: 9.9,
                currency: 'EUR',
                promotion_code: null,
                coupon_name: null,
                coupon_percent_off: null,
                coupon_amount_off: null,
            },
            stripePromotionCodeId: null,
        });

        stripeMock.customers.create.mockResolvedValue({ id: 'cus_123' });
        stripeMock.subscriptions.create.mockResolvedValue({
            id: 'sub_123',
            status: 'incomplete',
            items: { data: [{ id: 'si_123' }] },
            latest_invoice: {
                subtotal: 990,
                total_discount_amounts: [],
                confirmation_secret: { client_secret: 'secret_123' },
                payment_intent: null,
            },
        });

        await service.createRegistrationSubscription({
            email: 'test@example.com',
            password: 'Password123!',
            first_name: 'Jean',
            last_name: 'Dupont',
            company_creation_mode: 'create',
            company_name: 'Demo',
            siren: '123456789',
            role: 'merchant_admin',
            plan_slug: 'essentiel',
            billing_period: 'monthly',
            platform_legal_accepted_at: new Date().toISOString(),
        });

        expect(stripeMock.subscriptions.create).toHaveBeenCalledWith(
            expect.not.objectContaining({
                discounts: expect.anything(),
            }),
        );
        expect(stripeMock.subscriptions.create).toHaveBeenCalledWith(
            expect.objectContaining({
                automatic_tax: { enabled: true },
            }),
        );
    });
});
