import { SirenRateLimitError } from './siren.types';
import type { SirenSearchResult } from './siren.types';
import { calculateVatNumber } from '../../shared/utils/business-identifiers.util';

const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * Réponse JSON de l'API recherche-entreprises.api.gouv.fr
 */
export interface ApiRechercheEntrepriseResponse {
    results: Array<{
        siren: string;
        nom_complet: string;
        nom_raison_sociale?: string;
        nature_juridique?: string;
        date_creation?: string;
        siege: {
            siret: string;
            activite_principale?: string;
            adresse?: string;
            code_postal?: string;
            libelle_commune?: string;
            numero_voie?: string;
            type_voie?: string;
            libelle_voie?: string;
            complement_adresse?: string;
        };
    }>;
    total_results: number;
}

export interface GouvUpstreamSearchResponse {
    status: number;
    data: ApiRechercheEntrepriseResponse | null;
}

export class GouvRechercheEntreprisesProvider {
    private readonly API_BASE_URL = 'https://recherche-entreprises.api.gouv.fr';

    constructor(
        private readonly userAgent: string,
        private readonly onRateLimited: (retryAfterSeconds: number) => void,
    ) {}

    parseRetryAfterSeconds(retryAfter: string | null): number {
        if (!retryAfter) {
            return DEFAULT_RETRY_AFTER_SECONDS;
        }

        const parsedSeconds = Number.parseInt(retryAfter, 10);
        if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
            return parsedSeconds;
        }

        const parsedDate = Date.parse(retryAfter);
        if (!Number.isNaN(parsedDate)) {
            const seconds = Math.ceil((parsedDate - Date.now()) / 1000);
            if (seconds > 0) {
                return seconds;
            }
        }

        return DEFAULT_RETRY_AFTER_SECONDS;
    }

    private buildAddress(siege: {
        numero_voie?: string;
        type_voie?: string;
        libelle_voie?: string;
        complement_adresse?: string;
        adresse?: string;
    }): string {
        if (siege.adresse) {
            const match = siege.adresse.match(/^(.+?)\s+\d{5}/);
            if (match) {
                return match[1];
            }
            return siege.adresse;
        }

        const parts = [];
        if (siege.numero_voie) parts.push(siege.numero_voie);
        if (siege.type_voie) parts.push(siege.type_voie);
        if (siege.libelle_voie) parts.push(siege.libelle_voie);

        let address = parts.join(' ');

        if (siege.complement_adresse) {
            address += `, ${siege.complement_adresse}`;
        }

        return address;
    }

    mapEntreprise(entreprise: ApiRechercheEntrepriseResponse['results'][0]): SirenSearchResult {
        const siege = entreprise.siege;
        return {
            siren: entreprise.siren,
            siret: siege.siret,
            company_name: entreprise.nom_complet || entreprise.nom_raison_sociale || '',
            vat_number: calculateVatNumber(entreprise.siren),
            address: this.buildAddress(siege),
            postal_code: siege.code_postal || '',
            city: siege.libelle_commune || '',
            country_code: 'FR',
            legal_form: entreprise.nature_juridique || '',
            naf_code: siege.activite_principale || '',
            creation_date: entreprise.date_creation || '',
        };
    }

    async fetchSearch(query: string, limit: number): Promise<GouvUpstreamSearchResponse> {
        const response = await fetch(
            `${this.API_BASE_URL}/search?q=${encodeURIComponent(query)}&per_page=${limit}`,
            {
                headers: {
                    'User-Agent': this.userAgent,
                },
            },
        );

        if (response.status === 429) {
            const retryAfterSeconds = this.parseRetryAfterSeconds(response.headers.get('Retry-After'));
            this.onRateLimited(retryAfterSeconds);
            console.warn(
                `[SIREN/gouv] upstream rate limit status=429 query="${query}" retry_after=${retryAfterSeconds}s`,
            );
            throw new SirenRateLimitError(retryAfterSeconds);
        }

        if (!response.ok) {
            return {
                status: response.status,
                data: null,
            };
        }

        return {
            status: response.status,
            data: (await response.json()) as ApiRechercheEntrepriseResponse,
        };
    }
}
