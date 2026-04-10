import { getSupabaseAdmin } from '../../config/supabase.config';
import { SubscriptionService, buildSubscriptionMemberUsage } from './subscription.service';

jest.mock('../../config/supabase.config', () => ({
    getSupabaseAdmin: jest.fn(),
    getSupabaseClient: jest.fn(),
}));

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
    let stripeMock: {
        paymentMethods: { retrieve: jest.Mock };
        subscriptionItems: {
            create: jest.Mock;
            del: jest.Mock;
            update: jest.Mock;
        };
        subscriptions: { retrieve: jest.Mock };
        customers: { retrieve: jest.Mock };
        prices: { list: jest.Mock };
    };

    beforeEach(() => {
        service = new SubscriptionService(
            {
                get: jest.fn((key: string, defaultValue?: string) => {
                    if (key === 'STRIPE_ENABLED') {
                        return 'true';
                    }

                    return defaultValue;
                }),
            } as any,
            { ensurePlatformAcceptanceCurrent: jest.fn() } as any,
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
            },
            customers: {
                retrieve: jest.fn(),
            },
            prices: {
                list: jest.fn(),
            },
        };

        (service as any).stripe = stripeMock;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('keeps immediate billing when increasing extra members with a card default payment method', async () => {
        const supabaseMock = createSyncMemberQuantitySupabaseMock({
            stripeMemberItemId: 'si_member_123',
            extraMembersQuantity: 1,
        });

        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock.supabase as any);
        jest.spyOn(service as any, 'countExtraMembers').mockResolvedValue(2);

        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            customer: 'cus_123',
            default_payment_method: 'pm_card_123',
        });
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

    it('creates a member add-on without immediate payment when the default payment method is SEPA', async () => {
        const supabaseMock = createSyncMemberQuantitySupabaseMock({
            stripeMemberItemId: null,
            extraMembersQuantity: 0,
            stripeMemberLookupKey: 'member_lookup_key',
        });

        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock.supabase as any);
        jest.spyOn(service as any, 'countExtraMembers').mockResolvedValue(2);

        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            customer: 'cus_123',
            default_payment_method: null,
        });
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
                proration_behavior: 'create_prorations',
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

    it('updates member quantity without immediate payment when the default payment method is SEPA', async () => {
        const supabaseMock = createSyncMemberQuantitySupabaseMock({
            stripeMemberItemId: 'si_member_123',
            extraMembersQuantity: 1,
        });

        jest.mocked(getSupabaseAdmin).mockReturnValue(supabaseMock.supabase as any);
        jest.spyOn(service as any, 'countExtraMembers').mockResolvedValue(2);

        stripeMock.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            customer: 'cus_123',
            default_payment_method: 'pm_sepa_123',
        });
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
                proration_behavior: 'create_prorations',
            }),
        );
        expect(stripeMock.subscriptionItems.update.mock.calls[0][1]).not.toHaveProperty(
            'payment_behavior',
        );
    });
});
