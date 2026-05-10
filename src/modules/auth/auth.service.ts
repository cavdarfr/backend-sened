import { Injectable, UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';
import { getSupabaseClient, getSupabaseAdmin, SupabaseUser } from '../../config/supabase.config';
import { CompleteRegistrationDto } from './dto/complete-registration.dto';
import { normalizeBusinessIdentifiers } from '../../shared/utils/business-identifiers.util';
import { SubscriptionService } from '../subscription/subscription.service';
import { CompanyService } from '../company/company.service';

const REGISTRATION_SUPPORT_EMAIL = 'contact@sened.fr';

@Injectable()
export class AuthService {
    constructor(
        private readonly subscriptionService: SubscriptionService,
        private readonly companyService: CompanyService,
    ) {}

    async checkRegistrationAvailability(params: {
        siren?: string;
        siret?: string;
        role?: 'merchant_admin' | 'merchant_consultant' | 'accountant' | 'accountant_consultant' | 'superadmin';
        country?: string;
    }): Promise<{ available: boolean; message?: string; supportEmail?: string }> {
        const adminRoles = new Set(['merchant_admin', 'accountant']);
        if (!params.role || !adminRoles.has(params.role)) {
            return { available: true };
        }

        const normalized = normalizeBusinessIdentifiers({
            siren: params.siren,
            siret: params.siret,
            country: params.country,
        });

        if (!normalized.siren) {
            throw new BadRequestException(
                'Le SIREN doit contenir 9 chiffres ou le SIRET 14 chiffres',
            );
        }

        const supabase = getSupabaseAdmin();
        const { data: existingCompany, error } = await supabase
            .from('companies')
            .select('id')
            .eq('siren', normalized.siren)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') {
            throw new BadRequestException(error.message);
        }

        if (existingCompany) {
            const isAccountant = params.role === 'accountant';
            return {
                available: false,
                message:
                    `${isAccountant ? 'Ce cabinet' : 'Cette entreprise'} est déjà associé à un compte SENED. Si vous pensez devoir y accéder, contactez ${REGISTRATION_SUPPORT_EMAIL}.`,
                supportEmail: REGISTRATION_SUPPORT_EMAIL,
            };
        }

        return { available: true };
    }

    /**
     * Vérifie un token JWT et retourne l'utilisateur associé
     * @param token - Token JWT à vérifier
     * @returns L'utilisateur Supabase
     * @throws UnauthorizedException si le token est invalide
     */
    async verifyToken(token: string): Promise<SupabaseUser> {
        if (!token) {
            throw new UnauthorizedException('Token manquant');
        }

        try {
            const supabase = getSupabaseClient(token);
            const { data: { user }, error } = await supabase.auth.getUser();

            if (error) {
                throw new UnauthorizedException(`Erreur de vérification: ${error.message}`);
            }

            if (!user) {
                throw new UnauthorizedException('Utilisateur non trouvé');
            }

            return user as SupabaseUser;
        } catch (error) {
            if (error instanceof UnauthorizedException) {
                throw error;
            }
            throw new UnauthorizedException('Token invalide ou expiré');
        }
    }

    /**
     * Vérifie si un token est valide (sans lever d'exception)
     * @param token - Token JWT à vérifier
     * @returns true si le token est valide, false sinon
     */
    async isValidToken(token: string): Promise<boolean> {
        try {
            await this.verifyToken(token);
            return true;
        } catch {
            return false;
        }
    }

    async completeRegistration(email: string, dto: CompleteRegistrationDto): Promise<{ success: boolean }> {
        const supabase = getSupabaseAdmin();

        const { data: user, error: userError } = await supabase
            .from('profiles')
            .select('id')
            .eq('email', email)
            .single();

        if (userError || !user) {
            throw new NotFoundException('Utilisateur non trouvé');
        }

        // Vérifier si l'utilisateur a été invité et forcer le rôle de l'invitation
        const { data: invitation } = await supabase
            .from('company_invitations')
            .select('role, company_id, invited_by, invitation_type')
            .eq('email', email.toLowerCase())
            .not('accepted_at', 'is', null)
            .order('accepted_at', { ascending: false })
            .limit(1)
            .single();

        if (invitation) {
            // Forcer le rôle de l'invitation — ignorer le rôle du DTO
            dto.role = invitation.role;

            // Corriger user_companies si le trigger a mis un mauvais rôle
            await supabase
                .from('user_companies')
                .update({ role: invitation.role })
                .eq('user_id', user.id)
                .eq('company_id', invitation.company_id);
        }

        const { error: profileError } = await supabase
            .from('profiles')
            .update({
                first_name: dto.first_name,
                last_name: dto.last_name,
                phone: dto.phone || null,
            })
            .eq('id', user.id);

        if (profileError) {
            console.error('Error updating profile:', profileError);
            throw new BadRequestException('Erreur lors de la mise à jour du profil');
        }

        const shouldCreateCompany =
            dto.company_creation_mode !== 'join_only'
            && (dto.role === 'merchant_admin' || dto.role === 'accountant' || !dto.role);
        let userCompanyId: string | null = null;

        if (shouldCreateCompany) {
            const { data: userCompany, error: ucError } = await supabase
                .from('user_companies')
                .select('company_id')
                .eq('user_id', user.id)
                .eq('is_default', true)
                .single();

            if (ucError || !userCompany) {
                throw new NotFoundException('Entreprise par défaut non trouvée');
            }

            userCompanyId = userCompany.company_id;

            // Normaliser les identifiants métier
            const normalized = normalizeBusinessIdentifiers({
                siren: dto.siren,
                country: dto.country,
            });

            const { error: companyError } = await supabase
                .from('companies')
                .update({
                    name: dto.company_name,
                    siren: normalized.siren,
                    vat_number: normalized.vat_number,
                    address: dto.address || null,
                    postal_code: dto.postal_code || null,
                    city: dto.city || null,
                    country: normalized.country,
                })
                .eq('id', userCompanyId);

            if (companyError) {
                console.error('Error updating company:', companyError);
                throw new BadRequestException('Erreur lors de la mise à jour de l\'entreprise');
            }

            // Filet de sécurité : assigner owner_id si le trigger ne l'a pas fait
            await supabase
                .from('companies')
                .update({ owner_id: user.id })
                .eq('id', userCompanyId)
                .is('owner_id', null);
        }

        const canOwnSubscription = shouldCreateCompany && (dto.role === 'merchant_admin' || !dto.role);

        if (canOwnSubscription && dto.plan_slug && dto.plan_slug !== 'free') {
            const { data: plan } = await supabase
                .from('subscription_plans')
                .select('id')
                .eq('slug', dto.plan_slug)
                .single();

            if (plan) {
                await supabase
                    .from('subscriptions')
                    .update({ plan_id: plan.id })
                    .eq('user_id', user.id);
            }
        }

        // Association comptable optionnelle
        if (dto.accountant_siren && userCompanyId) {
            const cleanSiren = dto.accountant_siren.replace(/\s/g, '');
            // Chercher une company avec ce SIREN et un owner ayant le rôle accountant
            const { data: accountantCompany } = await supabase
                .from('companies')
                .select('id')
                .eq('siren', cleanSiren)
                .single();

            if (accountantCompany) {
                // Vérifier que c'est bien un cabinet comptable (rôle accountant)
                const { data: accountantUc } = await supabase
                    .from('user_companies')
                    .select('role')
                    .eq('company_id', accountantCompany.id)
                    .eq('role', 'accountant')
                    .limit(1)
                    .single();

                if (accountantUc) {
                    await supabase
                        .from('companies')
                        .update({ accountant_company_id: accountantCompany.id })
                        .eq('id', userCompanyId);
                }
            }
            // Si non trouvé, on ignore silencieusement
        }

        if (
            invitation?.company_id
            && invitation?.invited_by
            && invitation?.invitation_type !== 'merchant_signup'
        ) {
            await this.companyService.acceptNewClientInvitationLinkRequest(
                invitation.company_id,
                invitation.invited_by,
                user.id,
            );
        }

        // Sync Stripe member quantity for companies joined via invitation
        // The DB trigger accept_pending_invitations may have added the user
        // to companies, but Stripe billing was not updated
        const { data: userCompanies } = await supabase
            .from('user_companies')
            .select('company_id')
            .eq('user_id', user.id);

        if (userCompanies && userCompanies.length > 0) {
            for (const uc of userCompanies) {
                try {
                    await this.subscriptionService.syncMemberQuantity(uc.company_id);
                } catch (e) {
                    // Don't fail registration if Stripe sync fails
                }
            }
        }

        return { success: true };
    }
}
