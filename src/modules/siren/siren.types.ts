/**
 * Types et erreurs partagés pour les providers de recherche SIREN/SIRET.
 */

export class SirenRateLimitError extends Error {
    constructor(
        public readonly retryAfterSeconds: number,
        message = `Recherche temporairement indisponible, réessayez dans ${retryAfterSeconds} s.`,
    ) {
        super(message);
        this.name = 'SirenRateLimitError';
    }
}

export interface SirenSearchResult {
    siren: string;
    siret: string;
    company_name: string;
    vat_number: string;
    address: string;
    postal_code: string;
    city: string;
    country_code: string;
    legal_form: string;
    naf_code: string;
    creation_date: string;
}
