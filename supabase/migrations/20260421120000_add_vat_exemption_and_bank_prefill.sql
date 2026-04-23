ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS is_vat_exempt BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vat_exemption_note TEXT NOT NULL DEFAULT 'TVA non applicable, art. 293 B du CGI';

UPDATE public.companies
SET vat_exemption_note = 'TVA non applicable, art. 293 B du CGI'
WHERE vat_exemption_note IS NULL OR btrim(vat_exemption_note) = '';
