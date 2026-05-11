-- ============================================
-- SCHÉMA SUPABASE COMPLET - Application Devis/Factures
-- ============================================
-- Version: 1.0.0
-- Date: 2024-12-12
-- Description: Schéma complet pour la gestion de devis,
-- factures, signatures électroniques et multi-entreprises
-- ============================================

-- ============================================
-- TYPES ENUM
-- ============================================

-- Statuts d'abonnement
CREATE TYPE subscription_status AS ENUM ('active', 'canceled', 'past_due', 'trialing', 'incomplete');

-- Rôles utilisateur dans une entreprise
CREATE TYPE company_role AS ENUM (
    'merchant_admin',
    'merchant_consultant',
    'accountant',
    'accountant_consultant',
    'superadmin'
);

-- Types de client
CREATE TYPE client_type AS ENUM ('individual', 'professional');

-- Types de document pour numérotation
CREATE TYPE document_type AS ENUM ('quote', 'invoice');

-- Statuts de devis
CREATE TYPE quote_status AS ENUM ('draft', 'sent', 'viewed', 'accepted', 'signed', 'refused', 'expired', 'converted');

-- Statuts de facture
CREATE TYPE invoice_status AS ENUM ('draft', 'sent', 'paid', 'overdue', 'cancelled');

-- Types de remise
CREATE TYPE discount_type AS ENUM ('percentage', 'fixed');

-- Types de documents stockés
CREATE TYPE storage_document_type AS ENUM ('quote_pdf', 'invoice_pdf', 'signature', 'logo', 'attachment', 'avatar');

-- ============================================
-- FUNCTION: Mise à jour automatique du timestamp
-- ============================================
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = TIMEZONE('utc', NOW());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- TABLE: profiles
-- Extension de auth.users de Supabase
-- ============================================
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL UNIQUE,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    phone VARCHAR(20),
    address TEXT,
    avatar_url TEXT,
    signature_url TEXT,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS profiles_email_idx ON public.profiles(email);

-- Trigger updated_at
DROP TRIGGER IF EXISTS on_profiles_updated ON public.profiles;
CREATE TRIGGER on_profiles_updated
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- ============================================
-- TABLE: subscription_plans
-- Plans d'abonnement (Free, Pro, Enterprise)
-- ============================================
CREATE TABLE IF NOT EXISTS public.subscription_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL,
    slug VARCHAR(50) NOT NULL UNIQUE,
    price_monthly DECIMAL(10,2) NOT NULL DEFAULT 0,
    price_yearly DECIMAL(10,2) NOT NULL DEFAULT 0,
    max_companies INTEGER,
    max_quotes_per_month INTEGER,
    max_invoices_per_month INTEGER,
    max_members INTEGER,
    max_storage_mb INTEGER NOT NULL DEFAULT 100,
    features JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    stripe_price_id TEXT,
    stripe_lookup_key_monthly TEXT,
    stripe_lookup_key_yearly TEXT,
    price_per_additional_member DECIMAL(10,2) DEFAULT 0,
    stripe_member_lookup_key TEXT,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- Insertion des plans par défaut
INSERT INTO public.subscription_plans (name, slug, price_monthly, price_yearly, max_companies, max_quotes_per_month, max_storage_mb, features) VALUES
    ('Free', 'free', 0, 0, 1, 10, 100, '{"pdf_export": true, "email_support": false}'),
    ('Pro', 'pro', 19.99, 199.99, 3, 100, 1000, '{"pdf_export": true, "email_support": true, "priority_support": false}'),
    ('Enterprise', 'enterprise', 49.99, 499.99, 10, NULL, 10000, '{"pdf_export": true, "email_support": true, "priority_support": true, "api_access": true}')
ON CONFLICT (slug) DO NOTHING;

-- ============================================
-- TABLE: subscriptions
-- Abonnements par entreprise
-- ============================================
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    plan_id UUID REFERENCES public.subscription_plans(id),
    stripe_customer_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    status subscription_status NOT NULL DEFAULT 'active',
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN DEFAULT false,
    extra_members_quantity INTEGER DEFAULT 0,
    stripe_member_item_id TEXT,
    stripe_base_item_id TEXT,
    billing_period TEXT DEFAULT 'monthly' CHECK (billing_period IN ('monthly', 'yearly')),
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx ON public.subscriptions(user_id);
CREATE INDEX IF NOT EXISTS subscriptions_company_id_idx ON public.subscriptions(company_id);
CREATE INDEX IF NOT EXISTS subscriptions_stripe_customer_id_idx ON public.subscriptions(stripe_customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_company_id_unique_idx
    ON public.subscriptions(company_id)
    WHERE company_id IS NOT NULL;

DROP TRIGGER IF EXISTS on_subscriptions_updated ON public.subscriptions;
CREATE TRIGGER on_subscriptions_updated
    BEFORE UPDATE ON public.subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- ============================================
-- TABLE: companies
-- Entreprises des utilisateurs
-- ============================================
CREATE TABLE IF NOT EXISTS public.companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    legal_name VARCHAR(255),
    siren VARCHAR(9),
    vat_number VARCHAR(20),
    address TEXT,
    city VARCHAR(100),
    postal_code VARCHAR(10),
    country VARCHAR(2) DEFAULT 'FR',
    phone VARCHAR(20),
    email VARCHAR(255),
    website VARCHAR(255),
    logo_url TEXT,
    rib_iban VARCHAR(34),
    rib_bic VARCHAR(11),
    rib_bank_name VARCHAR(100),
    default_vat_rate DECIMAL(5,2) DEFAULT 20.00,
    default_payment_terms INTEGER DEFAULT 30,
    terms_and_conditions TEXT,
    quote_validity_days INTEGER DEFAULT 30,
    quote_footer TEXT,
    invoice_footer TEXT,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS companies_siren_idx ON public.companies(siren);
CREATE INDEX IF NOT EXISTS companies_owner_id_idx ON public.companies(owner_id);

DROP TRIGGER IF EXISTS on_companies_updated ON public.companies;
CREATE TRIGGER on_companies_updated
    BEFORE UPDATE ON public.companies
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- ============================================
-- TABLE: user_companies
-- Relation utilisateurs <-> entreprises avec rôles
-- ============================================
CREATE TABLE IF NOT EXISTS public.user_companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    role company_role NOT NULL DEFAULT 'merchant_consultant',
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    UNIQUE(user_id, company_id)
);

CREATE INDEX IF NOT EXISTS user_companies_user_id_idx ON public.user_companies(user_id);
CREATE INDEX IF NOT EXISTS user_companies_company_id_idx ON public.user_companies(company_id);

-- ============================================
-- TABLE: units
-- Unités de mesure par entreprise
-- ============================================
CREATE TABLE IF NOT EXISTS public.units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    abbreviation VARCHAR(10) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    UNIQUE(company_id, abbreviation)
);

CREATE INDEX IF NOT EXISTS units_company_id_idx ON public.units(company_id);

-- ============================================
-- TABLE: products
-- Produits/Services par entreprise
-- ============================================
CREATE TABLE IF NOT EXISTS public.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    reference VARCHAR(50),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL,
    unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
    vat_rate DECIMAL(5,2) DEFAULT 20.00,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS products_company_id_idx ON public.products(company_id);
CREATE INDEX IF NOT EXISTS products_reference_idx ON public.products(company_id, reference);

DROP TRIGGER IF EXISTS on_products_updated ON public.products;
CREATE TRIGGER on_products_updated
    BEFORE UPDATE ON public.products
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- ============================================
-- TABLE: clients
-- Clients par entreprise (particuliers ou pros)
-- ============================================
CREATE TABLE IF NOT EXISTS public.clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    type client_type NOT NULL DEFAULT 'individual',
    client_sector VARCHAR(10) CHECK (client_sector IN ('private', 'public')),
    -- Particulier
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    -- Professionnel
    company_name VARCHAR(255),
    siret VARCHAR(14),
    siren VARCHAR(9),
    vat_number VARCHAR(20),
    -- Contact commun
    email VARCHAR(255),
    phone VARCHAR(20),
    signature_contact_first_name VARCHAR(100),
    signature_contact_last_name VARCHAR(100),
    signature_contact_email VARCHAR(255),
    signature_contact_phone VARCHAR(20),
    address TEXT,
    city VARCHAR(100),
    postal_code VARCHAR(10),
    country VARCHAR(2) DEFAULT 'FR',
    notes TEXT,
    stripe_customer_id VARCHAR(255),
    -- Chorus Pro: valeurs par défaut pour soumission
    chorus_pro_code_destinataire VARCHAR(50),
    chorus_pro_cadre_facturation VARCHAR(50) DEFAULT 'A1_FACTURE_FOURNISSEUR',
    chorus_pro_code_service_executant VARCHAR(50),
    chorus_pro_numero_engagement VARCHAR(50),
    -- Chorus Pro: éligibilité (géré par verify-chorus, pas par CRUD)
    chorus_pro_eligibility_status VARCHAR(20) NOT NULL DEFAULT 'unchecked'
        CHECK (chorus_pro_eligibility_status IN ('unchecked', 'eligible', 'ineligible', 'error')),
    chorus_pro_structure_id INTEGER,
    chorus_pro_structure_label VARCHAR(255),
    chorus_pro_service_code_required BOOLEAN,
    chorus_pro_engagement_required BOOLEAN,
    chorus_pro_services JSONB,
    chorus_pro_last_checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS clients_company_id_idx ON public.clients(company_id);
CREATE INDEX IF NOT EXISTS clients_email_idx ON public.clients(email);
CREATE INDEX IF NOT EXISTS clients_signature_contact_email_idx ON public.clients(signature_contact_email);
CREATE INDEX IF NOT EXISTS clients_siren_idx ON public.clients(siren);
CREATE INDEX IF NOT EXISTS clients_siret_idx ON public.clients(siret);

DROP TRIGGER IF EXISTS on_clients_updated ON public.clients;
CREATE TRIGGER on_clients_updated
    BEFORE UPDATE ON public.clients
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- ============================================
-- TABLE: document_sequences
-- Numérotation automatique des documents
-- ============================================
CREATE TABLE IF NOT EXISTS public.document_sequences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    type document_type NOT NULL,
    year INTEGER NOT NULL,
    last_number INTEGER NOT NULL DEFAULT 0,
    prefix VARCHAR(10) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    UNIQUE(company_id, type, year)
);

-- ============================================
-- FUNCTION: Génération du numéro de document
-- ============================================
CREATE OR REPLACE FUNCTION public.generate_document_number(
    p_company_id UUID,
    p_type document_type
)
RETURNS VARCHAR(50) AS $$
DECLARE
    v_year INTEGER;
    v_prefix VARCHAR(10);
    v_next_number INTEGER;
    v_result VARCHAR(50);
BEGIN
    v_year := EXTRACT(YEAR FROM CURRENT_DATE);
    
    IF p_type = 'quote' THEN
        v_prefix := 'DEV';
    ELSE
        v_prefix := 'FAC';
    END IF;
    
    -- Insérer ou mettre à jour la séquence
    INSERT INTO public.document_sequences (company_id, type, year, last_number, prefix)
    VALUES (p_company_id, p_type, v_year, 1, v_prefix)
    ON CONFLICT (company_id, type, year)
    DO UPDATE SET 
        last_number = document_sequences.last_number + 1,
        updated_at = TIMEZONE('utc', NOW())
    RETURNING last_number INTO v_next_number;
    
    -- Format: DEV-2025-0001
    v_result := v_prefix || '-' || v_year || '-' || LPAD(v_next_number::TEXT, 4, '0');
    
    RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- TABLE: quotes
-- Devis
-- ============================================
CREATE TABLE IF NOT EXISTS public.quotes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
    created_by UUID NOT NULL REFERENCES public.profiles(id),
    quote_number VARCHAR(50) NOT NULL,
    status quote_status NOT NULL DEFAULT 'draft',
    title VARCHAR(255),
    subject TEXT,
    introduction TEXT,
    issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
    validity_date DATE NOT NULL,
    subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_vat DECIMAL(12,2) NOT NULL DEFAULT 0,
    total DECIMAL(12,2) NOT NULL DEFAULT 0,
    discount_type discount_type,
    discount_value DECIMAL(12,2) DEFAULT 0,
    notes TEXT,
    terms TEXT,
    terms_and_conditions TEXT,
    pdf_url TEXT,
    signature_token UUID DEFAULT gen_random_uuid(),
    signature_token_expires_at TIMESTAMPTZ,
    signature_provider VARCHAR(20) NOT NULL DEFAULT 'internal',
    yousign_signature_request_id VARCHAR(255),
    yousign_document_id VARCHAR(255),
    yousign_signer_id VARCHAR(255),
    yousign_status VARCHAR(50),
    yousign_signature_link_expires_at TIMESTAMPTZ,
    yousign_last_event_name VARCHAR(100),
    yousign_last_event_at TIMESTAMPTZ,
    signed_at TIMESTAMPTZ,
    signature_checkbox BOOLEAN DEFAULT false,
    signer_name VARCHAR(255),
    signer_ip INET,
    converted_to_invoice_id UUID,
    viewed_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    refused_at TIMESTAMPTZ,
    refusal_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    UNIQUE(company_id, quote_number),
    CONSTRAINT quotes_signature_provider_check CHECK (signature_provider IN ('internal', 'yousign'))
);

CREATE INDEX IF NOT EXISTS quotes_company_id_idx ON public.quotes(company_id);
CREATE INDEX IF NOT EXISTS quotes_client_id_idx ON public.quotes(client_id);
CREATE INDEX IF NOT EXISTS quotes_status_idx ON public.quotes(status);
CREATE INDEX IF NOT EXISTS quotes_signature_token_idx ON public.quotes(signature_token);
CREATE INDEX IF NOT EXISTS quotes_signature_provider_idx ON public.quotes(signature_provider);
CREATE INDEX IF NOT EXISTS quotes_yousign_signature_request_id_idx ON public.quotes(yousign_signature_request_id);

DROP TRIGGER IF EXISTS on_quotes_updated ON public.quotes;
CREATE TRIGGER on_quotes_updated
    BEFORE UPDATE ON public.quotes
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- ============================================
-- TABLE: quote_items
-- Lignes de devis
-- ============================================
CREATE TABLE IF NOT EXISTS public.quote_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id UUID NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
    product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
    position INTEGER NOT NULL DEFAULT 0,
    reference VARCHAR(50),
    description TEXT NOT NULL,
    quantity DECIMAL(12,3) NOT NULL DEFAULT 1,
    unit VARCHAR(50),
    unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
    vat_rate DECIMAL(5,2) NOT NULL DEFAULT 20.00,
    discount_type discount_type,
    discount_value DECIMAL(12,2) DEFAULT 0,
    line_total DECIMAL(12,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS quote_items_quote_id_idx ON public.quote_items(quote_id);

-- ============================================
-- TABLE: quote_signatures
-- Signatures électroniques des devis
-- ============================================
CREATE TABLE IF NOT EXISTS public.quote_signatures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id UUID NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE UNIQUE,
    signer_name VARCHAR(255) NOT NULL,
    signer_email VARCHAR(255) NOT NULL,
    signature_image_url TEXT,
    signed_at TIMESTAMPTZ NOT NULL DEFAULT TIMEZONE('utc', NOW()),
    ip_address INET NOT NULL,
    user_agent TEXT,
    document_hash VARCHAR(64) NOT NULL, -- SHA-256
    consent_text TEXT NOT NULL,
    consent_accepted BOOLEAN NOT NULL DEFAULT true,
    -- Pour certification future (site agréé)
    certified_at TIMESTAMPTZ,
    certification_reference VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS quote_signatures_quote_id_idx ON public.quote_signatures(quote_id);

-- ============================================
-- TABLE: quote_signature_events
-- Traçage des événements fournisseur de signature
-- ============================================
CREATE TABLE IF NOT EXISTS public.quote_signature_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id UUID NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL CHECK (provider IN ('yousign')),
    event_id VARCHAR(255) NOT NULL UNIQUE,
    event_name VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS quote_signature_events_quote_id_idx ON public.quote_signature_events(quote_id);
CREATE INDEX IF NOT EXISTS quote_signature_events_created_at_idx ON public.quote_signature_events(created_at DESC);

-- ============================================
-- TABLE: invoices
-- Factures
-- ============================================
CREATE TABLE IF NOT EXISTS public.invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
    quote_id UUID REFERENCES public.quotes(id) ON DELETE SET NULL,
    created_by UUID NOT NULL REFERENCES public.profiles(id),
    invoice_number VARCHAR(50) NOT NULL,
    status invoice_status NOT NULL DEFAULT 'draft',
    title VARCHAR(255),
    issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE NOT NULL,
    subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_vat DECIMAL(12,2) NOT NULL DEFAULT 0,
    total DECIMAL(12,2) NOT NULL DEFAULT 0,
    discount_type discount_type,
    discount_value DECIMAL(12,2) DEFAULT 0,
    amount_paid DECIMAL(12,2) DEFAULT 0,
    notes TEXT,
    payment_method VARCHAR(50),
    pdf_url TEXT,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    UNIQUE(company_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS invoices_company_id_idx ON public.invoices(company_id);
CREATE INDEX IF NOT EXISTS invoices_client_id_idx ON public.invoices(client_id);
CREATE INDEX IF NOT EXISTS invoices_quote_id_idx ON public.invoices(quote_id);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON public.invoices(status);

DROP TRIGGER IF EXISTS on_invoices_updated ON public.invoices;
CREATE TRIGGER on_invoices_updated
    BEFORE UPDATE ON public.invoices
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- ============================================
-- TABLE: invoice_items
-- Lignes de facture
-- ============================================
CREATE TABLE IF NOT EXISTS public.invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
    position INTEGER NOT NULL DEFAULT 0,
    reference VARCHAR(50),
    description TEXT NOT NULL,
    quantity DECIMAL(12,3) NOT NULL DEFAULT 1,
    unit VARCHAR(50),
    unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
    vat_rate DECIMAL(5,2) NOT NULL DEFAULT 20.00,
    discount_type discount_type,
    discount_value DECIMAL(12,2) DEFAULT 0,
    line_total DECIMAL(12,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS invoice_items_invoice_id_idx ON public.invoice_items(invoice_id);

-- ============================================
-- TABLE: documents
-- Gestion des fichiers (PDFs, images, etc.)
-- ============================================
CREATE TABLE IF NOT EXISTS public.documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    uploaded_by UUID NOT NULL REFERENCES public.profiles(id),
    type storage_document_type NOT NULL,
    related_type VARCHAR(50), -- 'quote', 'invoice', 'company', 'profile'
    related_id UUID,
    filename VARCHAR(255) NOT NULL,
    storage_path TEXT NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL,
    expires_at TIMESTAMPTZ DEFAULT (TIMEZONE('utc', NOW()) + INTERVAL '10 years'),
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS documents_company_id_idx ON public.documents(company_id);
CREATE INDEX IF NOT EXISTS documents_uploaded_by_idx ON public.documents(uploaded_by);
CREATE INDEX IF NOT EXISTS documents_related_idx ON public.documents(related_type, related_id);

-- ============================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================

-- Activer RLS sur toutes les tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_signature_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- ============================================
-- POLICIES: profiles
-- ============================================
CREATE POLICY "Users can view own profile"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
    ON public.profiles FOR INSERT
    WITH CHECK (auth.uid() = id);

-- ============================================
-- POLICIES: subscription_plans (lecture publique)
-- ============================================
CREATE POLICY "Anyone can view active plans"
    ON public.subscription_plans FOR SELECT
    USING (is_active = true);

-- ============================================
-- POLICIES: subscriptions
-- ============================================
CREATE POLICY "Users can view company subscription"
    ON public.subscriptions FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM public.user_companies uc
            WHERE uc.company_id = subscriptions.company_id
              AND uc.user_id = auth.uid()
        )
    );

CREATE POLICY "Owners can manage company subscription"
    ON public.subscriptions FOR ALL
    USING (
        EXISTS (
            SELECT 1
            FROM public.companies c
            JOIN public.user_companies uc ON uc.company_id = c.id
            WHERE c.id = subscriptions.company_id
              AND c.owner_id = auth.uid()
              AND uc.user_id = auth.uid()
              AND uc.role IN ('merchant_admin', 'accountant')
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.companies c
            JOIN public.user_companies uc ON uc.company_id = c.id
            WHERE c.id = subscriptions.company_id
              AND c.owner_id = auth.uid()
              AND uc.user_id = auth.uid()
              AND uc.role IN ('merchant_admin', 'accountant')
        )
    );

-- ============================================
-- POLICIES: companies (via user_companies)
-- ============================================
CREATE POLICY "Users can view their companies"
    ON public.companies FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = companies.id
            AND uc.user_id = auth.uid()
        )
    );

CREATE POLICY "Admins can update their companies"
    ON public.companies FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = companies.id
            AND uc.user_id = auth.uid()
            AND uc.role IN ('merchant_admin', 'accountant')
        )
    );

CREATE POLICY "Users can create companies"
    ON public.companies FOR INSERT
    WITH CHECK (true); -- Vérifié par la logique applicative (limite d'abonnement)

CREATE POLICY "Admins can delete their companies"
    ON public.companies FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = companies.id
            AND uc.user_id = auth.uid()
            AND uc.role IN ('merchant_admin', 'accountant')
        )
    );

-- ============================================
-- POLICIES: user_companies
-- ============================================
CREATE POLICY "Users can view their company memberships"
    ON public.user_companies FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY "Admins can view all company members"
    ON public.user_companies FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = user_companies.company_id
            AND uc.user_id = auth.uid()
            AND uc.role IN ('merchant_admin', 'accountant')
        )
    );

CREATE POLICY "Admins can manage company members"
    ON public.user_companies FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = user_companies.company_id
            AND uc.user_id = auth.uid()
            AND uc.role IN ('merchant_admin', 'accountant')
        )
    );

-- ============================================
-- POLICIES: units
-- ============================================
CREATE POLICY "Company members can view units"
    ON public.units FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = units.company_id
            AND uc.user_id = auth.uid()
        )
    );

CREATE POLICY "Admins can manage units"
    ON public.units FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = units.company_id
            AND uc.user_id = auth.uid()
            AND uc.role IN ('merchant_admin', 'accountant')
        )
    );

-- ============================================
-- POLICIES: products
-- ============================================
CREATE POLICY "Company members can view products"
    ON public.products FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = products.company_id
            AND uc.user_id = auth.uid()
        )
    );

CREATE POLICY "Company members can manage products"
    ON public.products FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = products.company_id
            AND uc.user_id = auth.uid()
        )
    );

-- ============================================
-- POLICIES: clients
-- ============================================
CREATE POLICY "Company members can view clients"
    ON public.clients FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = clients.company_id
            AND uc.user_id = auth.uid()
        )
    );

CREATE POLICY "Company members can manage clients"
    ON public.clients FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = clients.company_id
            AND uc.user_id = auth.uid()
        )
    );

-- ============================================
-- POLICIES: quotes
-- ============================================
CREATE POLICY "Company members can view quotes"
    ON public.quotes FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = quotes.company_id
            AND uc.user_id = auth.uid()
        )
    );

CREATE POLICY "Company members can manage quotes"
    ON public.quotes FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = quotes.company_id
            AND uc.user_id = auth.uid()
        )
    );

-- ============================================
-- POLICIES: quote_items
-- ============================================
CREATE POLICY "Company members can view quote items"
    ON public.quote_items FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.quotes q
            JOIN public.user_companies uc ON uc.company_id = q.company_id
            WHERE q.id = quote_items.quote_id
            AND uc.user_id = auth.uid()
        )
    );

CREATE POLICY "Company members can manage quote items"
    ON public.quote_items FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.quotes q
            JOIN public.user_companies uc ON uc.company_id = q.company_id
            WHERE q.id = quote_items.quote_id
            AND uc.user_id = auth.uid()
        )
    );

-- ============================================
-- POLICIES: quote_signatures (accès public via token)
-- ============================================
CREATE POLICY "Anyone can view signature via token"
    ON public.quote_signatures FOR SELECT
    USING (true); -- Vérifié par la logique applicative

CREATE POLICY "Anyone can create signature via valid token"
    ON public.quote_signatures FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.quotes q
            WHERE q.id = quote_signatures.quote_id
            AND q.signature_token IS NOT NULL
            AND (q.signature_token_expires_at IS NULL OR q.signature_token_expires_at > NOW())
            AND q.status = 'sent'
        )
    );

-- ============================================
-- POLICIES: invoices
-- ============================================
CREATE POLICY "Company members can view invoices"
    ON public.invoices FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = invoices.company_id
            AND uc.user_id = auth.uid()
        )
    );

CREATE POLICY "Company members can manage invoices"
    ON public.invoices FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = invoices.company_id
            AND uc.user_id = auth.uid()
        )
    );

-- ============================================
-- POLICIES: invoice_items
-- ============================================
CREATE POLICY "Company members can view invoice items"
    ON public.invoice_items FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.invoices i
            JOIN public.user_companies uc ON uc.company_id = i.company_id
            WHERE i.id = invoice_items.invoice_id
            AND uc.user_id = auth.uid()
        )
    );

CREATE POLICY "Company members can manage invoice items"
    ON public.invoice_items FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.invoices i
            JOIN public.user_companies uc ON uc.company_id = i.company_id
            WHERE i.id = invoice_items.invoice_id
            AND uc.user_id = auth.uid()
        )
    );

-- ============================================
-- POLICIES: documents
-- ============================================
CREATE POLICY "Users can view their documents"
    ON public.documents FOR SELECT
    USING (
        uploaded_by = auth.uid()
        OR EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = documents.company_id
            AND uc.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can upload documents"
    ON public.documents FOR INSERT
    WITH CHECK (uploaded_by = auth.uid());

CREATE POLICY "Users can delete their documents"
    ON public.documents FOR DELETE
    USING (uploaded_by = auth.uid());

-- ============================================
-- POLICIES: document_sequences
-- ============================================
CREATE POLICY "Company members can view sequences"
    ON public.document_sequences FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_companies uc
            WHERE uc.company_id = document_sequences.company_id
            AND uc.user_id = auth.uid()
        )
    );

-- ============================================
-- FUNCTION: Création automatique du profil utilisateur
-- Déclenché lors de l'inscription via Supabase Auth
-- ============================================
ALTER TABLE public.company_invitations
    ADD COLUMN IF NOT EXISTS signup_company_name text,
    ADD COLUMN IF NOT EXISTS signup_siren text,
    ADD COLUMN IF NOT EXISTS signup_siret text,
    ADD COLUMN IF NOT EXISTS signup_address text,
    ADD COLUMN IF NOT EXISTS signup_postal_code text,
    ADD COLUMN IF NOT EXISTS signup_city text,
    ADD COLUMN IF NOT EXISTS signup_country text;

CREATE OR REPLACE FUNCTION public.accept_pending_invitations(p_user_id uuid, p_email text)
RETURNS void AS $$
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
                    (v_accountant_company_id, 'Unité', 'u'),
                    (v_accountant_company_id, 'Forfait', 'forf.'),
                    (v_accountant_company_id, 'Mètre', 'm'),
                    (v_accountant_company_id, 'Mètre carré', 'm²'),
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
                RAISE EXCEPTION 'Aucune entreprise marchande n''a été créée pour cette invitation';
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

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

-- Trigger pour créer automatiquement un profil lors de l'inscription
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- ============================================
-- STORAGE BUCKETS (à exécuter via Supabase Dashboard)
-- ============================================
-- Note: Ces commandes doivent être exécutées via l'interface Supabase
-- ou via l'API de gestion Storage

-- Bucket pour les documents (PDFs, signatures)
-- INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
-- VALUES (
--     'documents',
--     'documents',
--     false,
--     52428800, -- 50MB
--     ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
-- ) ON CONFLICT (id) DO NOTHING;

-- Bucket pour les images publiques (logos, avatars)
-- INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
-- VALUES (
--     'public-images',
--     'public-images',
--     true,
--     5242880, -- 5MB
--     ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
-- ) ON CONFLICT (id) DO NOTHING;

-- ============================================
-- FIN DU SCHÉMA
-- ============================================
