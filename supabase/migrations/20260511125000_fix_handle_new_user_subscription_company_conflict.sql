-- Fix signup trigger subscription upsert against the partial unique index on subscriptions(company_id).
-- Keep the current trigger logic unchanged; only guard null company_id and target the partial index predicate.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_company_id UUID;
    v_siret text;
    v_siren text;
    v_company_name text;
    v_address text;
    v_postal_code text;
    v_city text;
    v_country text;
    v_company_creation_mode text;
    v_accountant_siren text;
    v_accountant_company_id uuid;
    v_plan_slug text;
    v_plan_id UUID;
    v_price_monthly numeric;
    v_price_yearly numeric;
    v_first_name text;
    v_last_name text;
    v_phone text;
    v_role_text text;
    v_role public.company_role;
    v_has_accountant_firm_invite boolean := false;
    v_invited_firm_name text;
    v_invited_firm_siren text;
    v_has_merchant_signup_invite boolean := false;
    v_signup_company_name text;
    v_signup_siren text;
    v_signup_siret text;
    v_signup_address text;
    v_signup_postal_code text;
    v_signup_city text;
    v_signup_country text;
BEGIN
    v_first_name := NEW.raw_user_meta_data->>'first_name';
    v_last_name := NEW.raw_user_meta_data->>'last_name';
    v_phone := NEW.raw_user_meta_data->>'phone';

    INSERT INTO public.profiles (id, email, first_name, last_name, phone)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(v_first_name, ''),
        COALESCE(v_last_name, ''),
        v_phone
    )
    ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        first_name = COALESCE(EXCLUDED.first_name, profiles.first_name),
        last_name = COALESCE(EXCLUDED.last_name, profiles.last_name);

    v_siret := NEW.raw_user_meta_data->>'siret';
    v_siren := NEW.raw_user_meta_data->>'siren';
    v_company_name := NEW.raw_user_meta_data->>'company_name';
    v_address := NEW.raw_user_meta_data->>'address';
    v_postal_code := NEW.raw_user_meta_data->>'postal_code';
    v_city := NEW.raw_user_meta_data->>'city';
    v_country := COALESCE(NEW.raw_user_meta_data->>'country', 'FR');
    v_company_creation_mode := COALESCE(
        NULLIF(NEW.raw_user_meta_data->>'company_creation_mode', ''),
        'create'
    );
    v_accountant_siren := NULLIF(
        regexp_replace(COALESCE(NEW.raw_user_meta_data->>'accountant_siren', ''), '\D', '', 'g'),
        ''
    );
    v_plan_slug := NEW.raw_user_meta_data->>'plan_slug';
    v_role_text := COALESCE(NEW.raw_user_meta_data->>'role', 'merchant_admin');

    IF v_company_creation_mode NOT IN ('create', 'join_only') THEN
        v_company_creation_mode := 'create';
    END IF;

    IF v_role_text NOT IN ('merchant_admin', 'merchant_consultant', 'accountant', 'accountant_consultant', 'superadmin') THEN
        v_role_text := 'merchant_admin';
    END IF;
    v_role := v_role_text::public.company_role;

    IF v_role = 'merchant_admin' THEN
        SELECT
            signup_company_name,
            signup_siren,
            signup_siret,
            signup_address,
            signup_postal_code,
            signup_city,
            signup_country
        INTO
            v_signup_company_name,
            v_signup_siren,
            v_signup_siret,
            v_signup_address,
            v_signup_postal_code,
            v_signup_city,
            v_signup_country
        FROM public.company_invitations
        WHERE lower(email) = lower(trim(NEW.email))
          AND accepted_at IS NULL
          AND expires_at > now()
          AND role = 'merchant_admin'
          AND COALESCE(invitation_type, 'member') = 'merchant_signup'
        LIMIT 1;

        v_has_merchant_signup_invite := FOUND;

        IF v_has_merchant_signup_invite THEN
            v_role_text := 'merchant_admin';
            v_role := 'merchant_admin'::public.company_role;
            v_company_creation_mode := 'create';
            v_company_name := COALESCE(NULLIF(v_company_name, ''), v_signup_company_name);
            v_siren := COALESCE(NULLIF(v_siren, ''), v_signup_siren);
            v_siret := COALESCE(NULLIF(v_siret, ''), v_signup_siret);
            v_address := COALESCE(NULLIF(v_address, ''), v_signup_address);
            v_postal_code := COALESCE(NULLIF(v_postal_code, ''), v_signup_postal_code);
            v_city := COALESCE(NULLIF(v_city, ''), v_signup_city);
            v_country := COALESCE(NULLIF(v_country, ''), v_signup_country, 'FR');
        END IF;
    END IF;

    IF v_role = 'accountant' THEN
        SELECT invited_firm_name, invited_firm_siren
        INTO v_invited_firm_name, v_invited_firm_siren
        FROM public.company_invitations
        WHERE lower(email) = lower(trim(NEW.email))
          AND accepted_at IS NULL
          AND expires_at > now()
          AND role = 'accountant'
          AND COALESCE(invitation_type, 'member') = 'accountant_firm'
        LIMIT 1;

        v_has_accountant_firm_invite := FOUND;

        IF v_has_accountant_firm_invite THEN
            v_company_creation_mode := 'create';
            v_company_name := COALESCE(v_invited_firm_name, v_company_name);
            v_siren := COALESCE(v_invited_firm_siren, v_siren);
        END IF;
    END IF;

    IF v_company_creation_mode = 'create'
       AND v_role IN ('merchant_admin', 'accountant')
       AND v_company_name IS NOT NULL
       AND v_company_name != '' THEN
        INSERT INTO public.companies (name, siren, address, postal_code, city, country, owner_id)
        VALUES (v_company_name, COALESCE(v_siren, LEFT(v_siret, 9)), v_address, v_postal_code, v_city, v_country, NEW.id)
        RETURNING id INTO v_company_id;

        INSERT INTO public.user_companies (user_id, company_id, role, is_default)
        VALUES (NEW.id, v_company_id, v_role, true);

        INSERT INTO public.units (company_id, name, abbreviation)
        VALUES
            (v_company_id, 'Heure', 'h'),
            (v_company_id, 'Jour', 'j'),
            (v_company_id, 'Unité', 'u'),
            (v_company_id, 'Forfait', 'forf.'),
            (v_company_id, 'Mètre', 'm'),
            (v_company_id, 'Mètre carré', 'm²'),
            (v_company_id, 'Kilogramme', 'kg'),
            (v_company_id, 'Litre', 'L');

        INSERT INTO public.document_settings (company_id)
        VALUES (v_company_id)
        ON CONFLICT (company_id) DO NOTHING;

        IF v_role = 'merchant_admin'
           AND v_accountant_siren IS NOT NULL
           AND char_length(v_accountant_siren) = 9 THEN
            SELECT c.id
            INTO v_accountant_company_id
            FROM public.companies c
            WHERE c.siren = v_accountant_siren
              AND EXISTS (
                  SELECT 1
                  FROM public.user_companies uc
                  WHERE uc.company_id = c.id
                    AND uc.role = 'accountant'
              )
            ORDER BY c.created_at ASC, c.id ASC
            LIMIT 1;

            IF v_accountant_company_id IS NOT NULL THEN
                UPDATE public.companies
                SET accountant_company_id = v_accountant_company_id
                WHERE id = v_company_id;
            END IF;
        END IF;
    END IF;

    IF v_company_creation_mode = 'create' AND v_company_id IS NOT NULL THEN
        v_plan_id := NULL;
        v_price_monthly := NULL;
        v_price_yearly := NULL;

        IF v_role = 'accountant' THEN
            SELECT id, price_monthly, price_yearly
            INTO v_plan_id, v_price_monthly, v_price_yearly
            FROM public.subscription_plans
            WHERE slug = 'free'
            LIMIT 1;
        ELSIF v_plan_slug IS NOT NULL AND v_plan_slug != '' THEN
            SELECT id, price_monthly, price_yearly
            INTO v_plan_id, v_price_monthly, v_price_yearly
            FROM public.subscription_plans
            WHERE slug = v_plan_slug
            LIMIT 1;
        END IF;

        INSERT INTO public.subscriptions (user_id, company_id, plan_id, status)
        VALUES (
            NEW.id,
            v_company_id,
            v_plan_id,
            (CASE
                WHEN v_role = 'accountant' THEN 'active'
                WHEN v_plan_id IS NOT NULL AND COALESCE(v_price_monthly, 0) = 0 AND COALESCE(v_price_yearly, 0) = 0 THEN 'active'
                ELSE 'incomplete'
            END)::public.subscription_status
        )
        ON CONFLICT (company_id) WHERE company_id IS NOT NULL DO UPDATE SET
            user_id = EXCLUDED.user_id,
            plan_id = EXCLUDED.plan_id,
            status = EXCLUDED.status;
    END IF;

    IF to_regprocedure('public.accept_pending_invitations(uuid,text)') IS NOT NULL THEN
        PERFORM public.accept_pending_invitations(NEW.id, NEW.email);
    END IF;

    RETURN NEW;
END;
$$;
