import {
    Injectable,
    BadRequestException,
    NotFoundException,
    Logger,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { stripNonDigits, detectQueryType } from '../../shared/utils/business-identifiers.util';
import { GouvRechercheEntreprisesProvider, type GouvUpstreamSearchResponse } from './gouv-recherche-entreprises.provider';
import { InseeSireneProvider } from './insee-sirene.provider';
import { SirenRateLimitError } from './siren.types';
import type { SirenSearchResult } from './siren.types';

export { SirenRateLimitError, type SirenSearchResult } from './siren.types';

const RESULTS_CACHE_TTL_MS = 60 * 60 * 1000;
const EMPTY_RESULTS_CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedLookupEntry {
    expiresAt: number;
    data: SirenSearchResult[];
}

@Injectable()
export class SirenService implements OnModuleInit {
    private readonly logger = new Logger(SirenService.name);
    private readonly USER_AGENT = `SenedBackend/1.0 (${process.env.NODE_ENV ?? 'development'})`;
    private readonly queryCache = new Map<string, CachedLookupEntry>();
    private readonly inFlightQueries = new Map<string, Promise<SirenSearchResult[]>>();
    private cooldownUntil = 0;

    private gouvProvider: GouvRechercheEntreprisesProvider | null = null;
    private inseeProvider: InseeSireneProvider | null = null;

    constructor(private readonly configService: ConfigService) {}

    onModuleInit(): void {
        if (this.isInseeProvider()) {
            const key = this.configService.get<string>('INSEE_SIRENE_API_KEY')?.trim();
            if (!key) {
                throw new Error(
                    'INSEE_SIRENE_API_KEY is required when SIREN_PROVIDER=insee',
                );
            }
            this.logger.log('SIREN provider: INSEE (API Sirene)');
        } else {
            this.logger.log('SIREN provider: recherche-entreprises (gouv)');
        }
    }

    private isInseeProvider(): boolean {
        const v = (this.configService.get<string>('SIREN_PROVIDER') ?? 'gouv').trim().toLowerCase();
        return v === 'insee';
    }

    private getGouv(): GouvRechercheEntreprisesProvider {
        if (!this.gouvProvider) {
            this.gouvProvider = new GouvRechercheEntreprisesProvider(this.USER_AGENT, (seconds) => {
                this.cooldownUntil = Date.now() + seconds * 1000;
            });
        }
        return this.gouvProvider;
    }

    private getInsee(): InseeSireneProvider {
        if (!this.inseeProvider) {
            const key = this.configService.get<string>('INSEE_SIRENE_API_KEY')?.trim();
            if (!key) {
                throw new BadRequestException(
                    'Configuration INSEE incomplète : INSEE_SIRENE_API_KEY manquante',
                );
            }
            const baseUrl =
                this.configService.get<string>('INSEE_SIRENE_BASE_URL')?.trim() ||
                'https://api.insee.fr/api-sirene/3.11';
            const header =
                this.configService.get<string>('INSEE_SIRENE_API_KEY_HEADER')?.trim() ||
                'X-INSEE-Api-Key-Integration';
            this.inseeProvider = new InseeSireneProvider(
                baseUrl,
                key,
                header,
                this.USER_AGENT,
                (seconds) => {
                    this.cooldownUntil = Date.now() + seconds * 1000;
                },
            );
        }
        return this.inseeProvider;
    }

    private getCacheKey(query: string, limit: number): string {
        return `${query.trim().toLowerCase()}::${limit}`;
    }

    private getCachedResults(cacheKey: string): SirenSearchResult[] | null {
        const cached = this.queryCache.get(cacheKey);
        if (!cached) {
            return null;
        }

        if (cached.expiresAt <= Date.now()) {
            this.queryCache.delete(cacheKey);
            return null;
        }

        return cached.data;
    }

    private setCachedResults(cacheKey: string, data: SirenSearchResult[]): void {
        this.queryCache.set(cacheKey, {
            data,
            expiresAt: Date.now() + (data.length > 0 ? RESULTS_CACHE_TTL_MS : EMPTY_RESULTS_CACHE_TTL_MS),
        });
    }

    private getRemainingCooldownSeconds(): number {
        if (this.cooldownUntil <= Date.now()) {
            return 0;
        }

        return Math.max(1, Math.ceil((this.cooldownUntil - Date.now()) / 1000));
    }

    private async executeTextSearchGouv(
        query: string,
        limit: number,
        cacheKey: string,
    ): Promise<SirenSearchResult[]> {
        const gouv = this.getGouv();
        const retryAfterSeconds = this.getRemainingCooldownSeconds();
        if (retryAfterSeconds > 0) {
            throw new SirenRateLimitError(retryAfterSeconds);
        }

        const upstream: GouvUpstreamSearchResponse = await gouv.fetchSearch(query.trim(), limit);
        if ([400, 404].includes(upstream.status)) {
            console.warn(
                `[SIREN/gouv] upstream lookup returned ${upstream.status} for query "${query.trim()}"`,
            );
            this.setCachedResults(cacheKey, []);
            return [];
        }

        if (upstream.status >= 400 || !upstream.data?.results) {
            throw new BadRequestException('Erreur lors de la recherche');
        }

        const results = upstream.data.results.map((entreprise) => gouv.mapEntreprise(entreprise));
        this.setCachedResults(cacheKey, results);
        return results;
    }

    private async executeTextSearchInsee(
        query: string,
        limit: number,
        cacheKey: string,
    ): Promise<SirenSearchResult[]> {
        const retryAfterSeconds = this.getRemainingCooldownSeconds();
        if (retryAfterSeconds > 0) {
            throw new SirenRateLimitError(retryAfterSeconds);
        }

        const results = await this.getInsee().searchByText(query, limit);
        this.setCachedResults(cacheKey, results);
        return results;
    }

    private async executeTextSearch(query: string, limit: number, cacheKey: string): Promise<SirenSearchResult[]> {
        const cached = this.getCachedResults(cacheKey);
        if (cached) {
            return cached;
        }

        if (this.isInseeProvider()) {
            return this.executeTextSearchInsee(query, limit, cacheKey);
        }
        return this.executeTextSearchGouv(query, limit, cacheKey);
    }

    /**
     * Recherche une entreprise par numéro SIREN ou SIRET
     */
    async search(sirenOrSiret: string): Promise<SirenSearchResult> {
        const cleanedNumber = stripNonDigits(sirenOrSiret);

        if (cleanedNumber.length !== 9 && cleanedNumber.length !== 14) {
            throw new BadRequestException(
                'Le numéro doit être un SIREN (9 chiffres) ou un SIRET (14 chiffres)',
            );
        }

        try {
            const siren = cleanedNumber.substring(0, 9);
            const cacheKey = this.getCacheKey(`exact:${cleanedNumber}`, 1);
            const cached = this.getCachedResults(cacheKey);
            if (cached?.[0]) {
                return cached[0];
            }

            const retryAfterSeconds = this.getRemainingCooldownSeconds();
            if (retryAfterSeconds > 0) {
                throw new SirenRateLimitError(retryAfterSeconds);
            }

            if (this.isInseeProvider()) {
                const result =
                    cleanedNumber.length === 14
                        ? await this.getInsee().searchBySiret(cleanedNumber)
                        : await this.getInsee().searchBySiren(cleanedNumber);
                this.setCachedResults(cacheKey, [result]);
                return result;
            }

            const gouv = this.getGouv();
            const upstream = await gouv.fetchSearch(siren, 1);

            if (upstream.status === 404) {
                throw new NotFoundException('Entreprise non trouvée');
            }

            if (upstream.status >= 400 || !upstream.data) {
                throw new BadRequestException('Erreur lors de la recherche SIREN');
            }

            const data = upstream.data;

            if (!data.results || data.results.length === 0) {
                throw new NotFoundException('Entreprise non trouvée');
            }

            const result = gouv.mapEntreprise(data.results[0]);
            this.setCachedResults(cacheKey, [result]);
            return result;
        } catch (error) {
            if (
                error instanceof NotFoundException ||
                error instanceof BadRequestException ||
                error instanceof SirenRateLimitError
            ) {
                throw error;
            }
            console.error('Error searching SIREN:', error);
            throw new BadRequestException('Erreur lors de la recherche SIREN');
        }
    }

    /**
     * Recherche des entreprises par texte (nom, SIREN, etc.)
     */
    async searchByText(query: string, limit: number = 10): Promise<SirenSearchResult[]> {
        if (!query || query.trim().length < 3) {
            return [];
        }

        const cacheKey = this.getCacheKey(query, limit);
        const existingRequest = this.inFlightQueries.get(cacheKey);
        if (existingRequest) {
            return existingRequest;
        }

        const request = this.executeTextSearch(query, limit, cacheKey)
            .catch((error) => {
                if (error instanceof SirenRateLimitError || error instanceof BadRequestException) {
                    throw error;
                }

                console.error('Error searching by text:', error);
                throw new BadRequestException('Erreur lors de la recherche');
            })
            .finally(() => {
                this.inFlightQueries.delete(cacheKey);
            });

        this.inFlightQueries.set(cacheKey, request);
        return request;
    }

    /**
     * Recherche unifiée : détecte automatiquement le type de requête
     * (SIREN exact, SIRET exact, ou recherche textuelle).
     */
    async lookup(query: string, limit: number = 10): Promise<SirenSearchResult[]> {
        if (!query || query.trim().length === 0) {
            return [];
        }

        const trimmed = query.trim();
        const queryType = detectQueryType(trimmed);

        if (queryType === 'siren' || queryType === 'siret') {
            try {
                const result = await this.search(trimmed);
                return [result];
            } catch (error) {
                if (error instanceof NotFoundException) {
                    return [];
                }
                throw error;
            }
        }

        if (trimmed.length < 3) {
            return [];
        }

        return this.searchByText(trimmed, limit);
    }
}
