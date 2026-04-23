import {
    IsString,
    IsOptional,
    IsIn,
    IsEmail,
    IsISO8601,
    IsNotEmpty,
    Matches,
    Length,
    ValidateNested,
    IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateCompanyDto, CompanyWithRoleResponseDto } from '../../company/dto/company.dto';

export enum SubscriptionPlanSlug {
    ESSENTIEL = 'essentiel',
    BUSINESS = 'business',
    PREMIUM = 'premium',
}

/**
 * DTO pour les détails d'un plan d'abonnement
 */
export class SubscriptionPlanDto {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    price_monthly: number;
    price_yearly: number;
    max_companies: number | null;
    max_quotes_per_month: number | null;
    max_invoices_per_month: number | null;
    max_members: number | null;
    max_storage_mb: number;
    price_per_additional_member: number;
    features: string[];
    stripe_lookup_key_monthly: string | null;
    stripe_lookup_key_yearly: string | null;
    stripe_member_lookup_key: string | null;
}

/**
 * Réponse publique GET /subscription/plans : plans + indicateur Stripe.
 */
export interface AvailablePlansResponseDto {
    plans: SubscriptionPlanDto[];
    stripe_enabled: boolean;
}

export class CreateSubscriptionDto {
    @IsString()
    plan_slug: string;

    @IsIn(['monthly', 'yearly'])
    billing_period: 'monthly' | 'yearly';

    @IsOptional()
    @IsString()
    promotion_code?: string;
}

export class SubscribeResponseDto {
    subscription_id: string;
    client_secret: string | null;
    status: string;
}

export class CreateRegistrationSubscriptionDto {
    @IsEmail()
    email: string;

    @IsString()
    @IsNotEmpty()
    password: string;

    @IsString()
    @IsNotEmpty()
    first_name: string;

    @IsString()
    @IsNotEmpty()
    last_name: string;

    @IsOptional()
    @IsString()
    phone?: string;

    @IsOptional()
    @IsIn(['create', 'join_only'])
    company_creation_mode?: 'create' | 'join_only';

    @IsString()
    @IsNotEmpty()
    company_name: string;

    @IsString()
    @Length(9, 9, { message: 'Le SIREN doit contenir exactement 9 chiffres' })
    @Matches(/^\d{9}$/, { message: 'Le SIREN doit contenir uniquement des chiffres' })
    siren: string;

    @IsOptional()
    @IsString()
    siret?: string;

    @IsOptional()
    @IsString()
    address?: string;

    @IsOptional()
    @IsString()
    postal_code?: string;

    @IsOptional()
    @IsString()
    city?: string;

    @IsOptional()
    @IsString()
    country?: string;

    @IsOptional()
    @IsString()
    team_size?: string;

    @IsIn(['merchant_admin'])
    role: 'merchant_admin';

    @IsOptional()
    @IsString()
    accountant_siren?: string;

    @IsString()
    plan_slug: string;

    @IsIn(['monthly', 'yearly'])
    billing_period: 'monthly' | 'yearly';

    @IsOptional()
    @IsString()
    promotion_code?: string;

    @IsISO8601()
    platform_legal_accepted_at: string;
}

export class RegistrationPricingDto {
    original_amount_ht: number;
    discount_amount_ht: number;
    final_amount_ht: number;
    currency: string;
    promotion_code: string | null;
    coupon_name: string | null;
    coupon_percent_off: number | null;
    coupon_amount_off: number | null;
}

export class ValidateRegistrationPromotionCodeDto {
    @IsString()
    plan_slug: string;

    @IsIn(['monthly', 'yearly'])
    billing_period: 'monthly' | 'yearly';

    @IsString()
    @IsNotEmpty()
    promotion_code: string;
}

export class ValidateRegistrationPromotionCodeResponseDto {
    pricing: RegistrationPricingDto;
}

export class ValidateSubscriptionPromotionCodeDto {
    @IsString()
    plan_slug: string;

    @IsIn(['monthly', 'yearly'])
    billing_period: 'monthly' | 'yearly';

    @IsString()
    @IsNotEmpty()
    promotion_code: string;
}

export class ValidateSubscriptionPromotionCodeResponseDto {
    pricing: RegistrationPricingDto;
}

export class PendingCompanyDataDto extends CreateCompanyDto {
    @IsOptional()
    @IsIn(['merchant_admin'])
    owner_role?: 'merchant_admin';
}

export class CompanyCreationSummaryDto {
    name: string;
    legal_name: string | null;
    siren: string | null;
    address: string | null;
    postal_code: string | null;
    city: string | null;
    country: string | null;
    email: string | null;
    phone: string | null;
    source_accountant_company_id: string | null;
    accountant_company_name: string | null;
}

export class PendingCompanyPaymentSessionSummaryDto {
    session_id: string;
    status: string;
    plan_slug: string | null;
    billing_period: 'monthly' | 'yearly' | null;
    company_summary: CompanyCreationSummaryDto;
    finalized_company_id: string | null;
    company: CompanyWithRoleResponseDto | null;
}

export class CreatePendingCompanySubscriptionDto {
    @IsOptional()
    @IsUUID('4')
    session_id?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => PendingCompanyDataDto)
    company_data?: PendingCompanyDataDto;

    @IsOptional()
    @IsString()
    plan_slug?: string;

    @IsOptional()
    @IsIn(['monthly', 'yearly'])
    billing_period?: 'monthly' | 'yearly';

    @IsOptional()
    @IsString()
    promotion_code?: string;
}

export class ValidatePendingCompanyPromotionCodeDto {
    @IsUUID('4')
    session_id: string;

    @IsString()
    plan_slug: string;

    @IsIn(['monthly', 'yearly'])
    billing_period: 'monthly' | 'yearly';

    @IsString()
    @IsNotEmpty()
    promotion_code: string;
}

export class ValidatePendingCompanyPromotionCodeResponseDto {
    pricing: RegistrationPricingDto;
}

export class PendingCompanySubscriptionResponseDto {
    session_id: string;
    subscription_id: string | null;
    client_secret: string | null;
    status: string;
    pricing: RegistrationPricingDto | null;
    company_summary: CompanyCreationSummaryDto;
}

export class FinalizePendingCompanySubscriptionDto {
    @IsUUID('4')
    session_id: string;
}

export class FinalizePendingCompanySubscriptionResponseDto {
    status: 'completed' | 'processing';
    message: string;
    company: CompanyWithRoleResponseDto | null;
}

export class RegistrationSubscriptionResponseDto {
    registration_session_id: string;
    subscription_id: string;
    client_secret: string;
    status: string;
    pricing: RegistrationPricingDto;
}

export class FinalizeRegistrationSubscriptionDto {
    @IsString()
    registration_session_id: string;
}

export class FinalizeRegistrationSubscriptionResponseDto {
    status: 'completed' | 'processing';
    message: string;
}

/**
 * DTO pour un abonnement utilisateur
 */
export class SubscriptionDto {
    id: string;
    user_id: string;
    company_id: string | null;
    plan_id: string | null;
    status: string;
    billing_period: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    stripe_base_item_id: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    extra_members_quantity: number;
    created_at: string;
    updated_at: string;
    plan: SubscriptionPlanDto | null;
}

/**
 * DTO pour changer de plan
 */
export class ChangeSubscriptionDto {
    @IsString()
    plan_slug: string;

    @IsOptional()
    @IsIn(['monthly', 'yearly'])
    billing_period?: 'monthly' | 'yearly';
}

export class ChangeSubscriptionResponseDto {
    subscription: SubscriptionDto;
    client_secret: string | null;
    status: string;
}

/**
 * DTO réponse avec abonnement et plans disponibles
 */
export class SubscriptionWithPlansDto {
    subscription: SubscriptionDto | null;
    available_plans: SubscriptionPlanDto[];
    scope: 'self' | 'owner' | 'none';
    company_id: string | null;
    owner_user_id: string | null;
    company_owner_role: 'merchant_admin' | 'accountant' | null;
    /** Entreprise marchande liée à un cabinet (plan free autorisé comme pour le cabinet). */
    is_company_linked_to_accountant_cabinet: boolean;
    is_invited_merchant_admin: boolean;
    can_manage_billing: boolean;
    has_any_active_company_subscription: boolean;
    usage: {
        invoices_this_month: number;
        quotes_this_month: number;
        total_members: number;
        extra_members: number;
        pending_invitations: number;
        billable_members: number;
        billable_extra_members: number;
    };
}
