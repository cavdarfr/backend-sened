ALTER TABLE public.accountant_link_requests
ADD COLUMN IF NOT EXISTS request_origin TEXT NOT NULL DEFAULT 'existing_merchant'
CHECK (request_origin IN ('existing_merchant', 'new_client_invitation'));

CREATE INDEX IF NOT EXISTS idx_accountant_link_requests_origin
ON public.accountant_link_requests (request_origin, status, created_at DESC);
