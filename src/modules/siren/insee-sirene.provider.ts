import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SirenRateLimitError } from './siren.types';
import type { SirenSearchResult } from './siren.types';
import {
    buildInseeTextSearchQuery,
    getNicSiegeFromUniteLegale,
    mapInseeEtablissementToResult,
    mapInseeUniteLegaleAndEtablissement,
    type InseeEtablissement,
    type InseeUniteLegale,
} from './insee-sirene.mapper';

const DEFAULT_RETRY_AFTER_SECONDS = 60;

interface ReponseUniteLegale {
    uniteLegale?: InseeUniteLegale;
}

interface ReponseUnitesLegales {
    unitesLegales?: InseeUniteLegale[];
}

interface ReponseEtablissement {
    etablissement?: InseeEtablissement;
}

export class InseeSireneProvider {
    private readonly baseUrlNormalized: string;

    constructor(
        baseUrl: string,
        private readonly apiKey: string,
        private readonly apiKeyHeader: string,
        private readonly userAgent: string,
        private readonly onRateLimited: (retryAfterSeconds: number) => void,
    ) {
        this.baseUrlNormalized = baseUrl.replace(/\/$/, '');
    }

    private parseRetryAfterSeconds(retryAfter: string | null): number {
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

    private async requestJson(path: string): Promise<{ status: number; data: unknown }> {
        const url = `${this.baseUrlNormalized}${path.startsWith('/') ? path : `/${path}`}`;
        const response = await fetch(url, {
            headers: {
                Accept: 'application/json',
                [this.apiKeyHeader]: this.apiKey,
                'User-Agent': this.userAgent,
            },
        });

        if (response.status === 429) {
            const retryAfterSeconds = this.parseRetryAfterSeconds(response.headers.get('Retry-After'));
            this.onRateLimited(retryAfterSeconds);
            console.warn(
                `[SIREN/insee] upstream rate limit status=429 path="${path}" retry_after=${retryAfterSeconds}s`,
            );
            throw new SirenRateLimitError(retryAfterSeconds);
        }

        if (response.status === 401) {
            throw new BadRequestException('Clé API INSEE invalide ou refusée');
        }

        if (!response.ok) {
            return { status: response.status, data: null };
        }

        const data = await response.json();
        return { status: response.status, data };
    }

    async searchBySiren(siren: string): Promise<SirenSearchResult> {
        const res = await this.requestJson(`/siren/${encodeURIComponent(siren)}`);

        if (res.status === 404) {
            throw new NotFoundException('Entreprise non trouvée');
        }

        if (res.status >= 400 || !res.data) {
            throw new BadRequestException('Erreur lors de la recherche SIREN');
        }

        const body = res.data as ReponseUniteLegale;
        const ul = body.uniteLegale;
        if (!ul?.siren) {
            throw new NotFoundException('Entreprise non trouvée');
        }

        const nic = getNicSiegeFromUniteLegale(ul);
        let etab: InseeEtablissement | null = null;
        if (nic) {
            const siret = `${ul.siren}${nic}`;
            const er = await this.requestJson(`/siret/${encodeURIComponent(siret)}`);
            if (er.status === 200 && er.data) {
                etab = (er.data as ReponseEtablissement).etablissement ?? null;
            }
        }

        return mapInseeUniteLegaleAndEtablissement(ul, etab);
    }

    async searchBySiret(siret: string): Promise<SirenSearchResult> {
        const res = await this.requestJson(`/siret/${encodeURIComponent(siret)}`);

        if (res.status === 404) {
            throw new NotFoundException('Entreprise non trouvée');
        }

        if (res.status >= 400 || !res.data) {
            throw new BadRequestException('Erreur lors de la recherche SIREN');
        }

        const body = res.data as ReponseEtablissement;
        const etab = body.etablissement;
        if (!etab?.siret) {
            throw new NotFoundException('Entreprise non trouvée');
        }

        return mapInseeEtablissementToResult(etab);
    }

    async searchByText(query: string, limit: number): Promise<SirenSearchResult[]> {
        const q = buildInseeTextSearchQuery(query);
        const path = `/siren?q=${encodeURIComponent(q)}&nombre=${limit}`;
        const res = await this.requestJson(path);

        if ([400, 404].includes(res.status)) {
            console.warn(`[SIREN/insee] text search returned ${res.status} for query "${query.trim()}"`);
            return [];
        }

        if (res.status >= 400 || !res.data) {
            throw new BadRequestException('Erreur lors de la recherche');
        }

        const body = res.data as ReponseUnitesLegales;
        const list = body.unitesLegales;
        if (!list?.length) {
            return [];
        }

        const results: SirenSearchResult[] = [];
        for (const ul of list) {
            if (!ul?.siren) continue;
            const nic = getNicSiegeFromUniteLegale(ul);
            let etab: InseeEtablissement | null = null;
            if (nic) {
                const siret = `${ul.siren}${nic}`;
                const er = await this.requestJson(`/siret/${encodeURIComponent(siret)}`);
                if (er.status === 200 && er.data) {
                    etab = (er.data as ReponseEtablissement).etablissement ?? null;
                }
            }
            results.push(mapInseeUniteLegaleAndEtablissement(ul, etab));
        }

        return results;
    }
}
