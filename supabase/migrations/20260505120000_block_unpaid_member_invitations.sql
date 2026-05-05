ALTER TABLE public.company_invitations
ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'settled'
CHECK (billing_status IN ('settled', 'payment_required'));

CREATE INDEX IF NOT EXISTS idx_company_invitations_billing_status_pending
ON public.company_invitations (billing_status)
WHERE accepted_at IS NULL;

CREATE OR REPLACE FUNCTION public.accept_pending_invitations(p_user_id uuid, p_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_invitation RECORD;
    v_email_normalized text;
    v_accountant_company_id uuid;
    v_has_companies boolean;
    v_merchant_company_id uuid;
    v_responded_at timestamptz;
BEGIN
    v_email_normalized := lower(trim(p_email));

    FOR v_invitation IN
        SELECT
            id,
            company_id,
            role,
            invited_by,
            COALESCE(invitation_type, 'member') AS invitation_type,
            invited_firm_name,
            invited_firm_siren
        FROM public.company_invitations
        WHERE lower(email) = v_email_normalized
          AND accepted_at IS NULL
          AND expires_at > now()
          AND billing_status = 'settled'
    LOOP
        IF v_invitation.invitation_type = 'accountant_firm' THEN
            SELECT c.id
            INTO v_accountant_company_id
            FROM public.user_companies uc
            JOIN public.companies c ON c.id = uc.company_id
            WHERE uc.user_id = p_user_id
              AND uc.role = 'accountant'
            ORDER BY uc.created_at ASC
            LIMIT 1;

            IF v_accountant_company_id IS NULL AND v_invitation.invited_firm_siren IS NOT NULL THEN
                SELECT c.id
                INTO v_accountant_company_id
                FROM public.companies c
                JOIN public.user_companies uc ON uc.company_id = c.id
                WHERE c.siren = v_invitation.invited_firm_siren
                  AND uc.role = 'accountant'
                ORDER BY uc.created_at ASC
                LIMIT 1;
            END IF;

            IF v_accountant_company_id IS NULL THEN
                SELECT EXISTS(
                    SELECT 1
                    FROM public.user_companies
                    WHERE user_id = p_user_id
                ) INTO v_has_companies;

                INSERT INTO public.companies (name, siren, owner_id)
                VALUES (
                    COALESCE(v_invitation.invited_firm_name, 'Cabinet comptable'),
                    v_invitation.invited_firm_siren,
                    p_user_id
                )
                RETURNING id INTO v_accountant_company_id;

                INSERT INTO public.user_companies (user_id, company_id, role, is_default)
                VALUES (p_user_id, v_accountant_company_id, 'accountant', NOT v_has_companies)
                ON CONFLICT (user_id, company_id) DO NOTHING;

                INSERT INTO public.units (company_id, name, abbreviation)
                VALUES
                    (v_accountant_company_id, 'Heure', 'h'),
                    (v_accountant_company_id, 'Jour', 'j'),
                    (v_accountant_company_id, 'Unite', 'u'),
                    (v_accountant_company_id, 'Forfait', 'forf.'),
                    (v_accountant_company_id, 'Metre', 'm'),
                    (v_accountant_company_id, 'Metre carre', 'm2'),
                    (v_accountant_company_id, 'Kilogramme', 'kg'),
                    (v_accountant_company_id, 'Litre', 'L');

                INSERT INTO public.document_settings (company_id)
                VALUES (v_accountant_company_id)
                ON CONFLICT (company_id) DO NOTHING;
            ELSE
                INSERT INTO public.user_companies (user_id, company_id, role, is_default)
                VALUES (p_user_id, v_accountant_company_id, 'accountant', false)
                ON CONFLICT (user_id, company_id) DO NOTHING;
            END IF;

            UPDATE public.companies
            SET accountant_company_id = v_accountant_company_id
            WHERE id = v_invitation.company_id;

            DELETE FROM public.user_companies
            WHERE user_id = p_user_id
              AND company_id = v_invitation.company_id
              AND role = 'accountant';
        ELSIF v_invitation.invitation_type = 'merchant_signup' THEN
            SELECT c.id
            INTO v_merchant_company_id
            FROM public.user_companies uc
            JOIN public.companies c ON c.id = uc.company_id
            WHERE uc.user_id = p_user_id
              AND uc.role = 'merchant_admin'
              AND c.owner_id = p_user_id
            ORDER BY uc.is_default DESC, uc.created_at ASC
            LIMIT 1;

            IF v_merchant_company_id IS NULL THEN
                RAISE EXCEPTION 'Aucune entreprise marchande n''a ete creee pour cette invitation';
            END IF;

            UPDATE public.companies
            SET accountant_company_id = v_invitation.company_id
            WHERE id = v_merchant_company_id
              AND accountant_company_id IS DISTINCT FROM v_invitation.company_id;

            INSERT INTO public.accountant_link_requests (
                accountant_company_id,
                merchant_company_id,
                request_origin,
                requested_by,
                status
            )
            VALUES (
                v_invitation.company_id,
                v_merchant_company_id,
                'new_client_invitation',
                v_invitation.invited_by,
                'pending'
            )
            ON CONFLICT (accountant_company_id, merchant_company_id)
            WHERE status = 'pending'
            DO NOTHING;

            v_responded_at := now();

            UPDATE public.accountant_link_requests
            SET status = 'accepted',
                responded_at = v_responded_at,
                responded_by = p_user_id
            WHERE accountant_company_id = v_invitation.company_id
              AND merchant_company_id = v_merchant_company_id
              AND status = 'pending';

            UPDATE public.accountant_link_requests
            SET status = 'cancelled',
                responded_at = v_responded_at,
                responded_by = p_user_id
            WHERE merchant_company_id = v_merchant_company_id
              AND accountant_company_id <> v_invitation.company_id
              AND status = 'pending';
        ELSE
            INSERT INTO public.user_companies (user_id, company_id, role, is_default)
            VALUES (p_user_id, v_invitation.company_id, v_invitation.role, false)
            ON CONFLICT (user_id, company_id) DO UPDATE SET role = EXCLUDED.role;

            IF v_invitation.role = 'accountant' THEN
                SELECT c.id
                INTO v_accountant_company_id
                FROM public.user_companies uc
                JOIN public.companies c ON c.id = uc.company_id
                WHERE uc.user_id = p_user_id
                  AND uc.role = 'accountant'
                  AND c.owner_id = p_user_id
                ORDER BY uc.is_default DESC, uc.created_at ASC
                LIMIT 1;

                IF v_accountant_company_id IS NOT NULL THEN
                    UPDATE public.companies
                    SET accountant_company_id = v_accountant_company_id
                    WHERE id = v_invitation.company_id
                      AND accountant_company_id IS NULL;
                END IF;
            END IF;
        END IF;

        UPDATE public.company_invitations
        SET accepted_at = now()
        WHERE id = v_invitation.id;
    END LOOP;
END;
$$;
