import { calculateVatNumber } from '../../shared/utils/business-identifiers.util';
import type { SirenSearchResult } from './siren.types';

/** Période unité légale (extrait API Sirene 3.x) */
export interface InseePeriodeUniteLegale {
    dateFin?: string | null;
    dateDebut?: string;
    denominationUniteLegale?: string | null;
    nomUniteLegale?: string | null;
    nomUsageUniteLegale?: string | null;
    prenom1UniteLegale?: string | null;
    categorieJuridiqueUniteLegale?: string | null;
    nicSiegeUniteLegale?: string | null;
}

export interface InseeUniteLegale {
    siren: string;
    sigleUniteLegale?: string | null;
    dateCreationUniteLegale?: string | null;
    periodesUniteLegale?: InseePeriodeUniteLegale[];
}

export interface InseeAdresseEtablissement {
    complementAdresseEtablissement?: string | null;
    numeroVoieEtablissement?: string | null;
    typeVoieEtablissement?: string | null;
    libelleVoieEtablissement?: string | null;
    codePostalEtablissement?: string | null;
    libelleCommuneEtablissement?: string | null;
    libelleCommuneEtrangerEtablissement?: string | null;
    codePaysEtrangerEtablissement?: string | null;
}

export interface InseePeriodeEtablissement {
    dateFin?: string | null;
    activitePrincipaleEtablissement?: string | null;
}

export interface InseeUniteLegaleEtablissement {
    denominationUniteLegale?: string | null;
    nomUniteLegale?: string | null;
    prenom1UniteLegale?: string | null;
    categorieJuridiqueUniteLegale?: string | null;
    sigleUniteLegale?: string | null;
}

export interface InseeEtablissement {
    siret: string;
    siren?: string;
    etablissementSiege?: boolean | null;
    adresseEtablissement?: InseeAdresseEtablissement | null;
    periodesEtablissement?: InseePeriodeEtablissement[] | null;
    uniteLegale?: InseeUniteLegaleEtablissement | null;
}

export function getCurrentUlPeriod(
    periodes: InseePeriodeUniteLegale[] | undefined,
): InseePeriodeUniteLegale | undefined {
    if (!periodes?.length) return undefined;
    const open = periodes.find((p) => !p.dateFin);
    return open ?? periodes[periodes.length - 1];
}

export function getNicSiegeFromUniteLegale(ul: InseeUniteLegale): string | null {
    const p = getCurrentUlPeriod(ul.periodesUniteLegale);
    const nic = p?.nicSiegeUniteLegale;
    if (!nic || !String(nic).trim()) return null;
    return String(nic).replace(/\D/g, '').padStart(5, '0').slice(0, 5);
}

export function buildStreetFromInseeAdresse(addr: InseeAdresseEtablissement | null | undefined): string {
    if (!addr) return '';
    const parts: string[] = [];
    if (addr.numeroVoieEtablissement) parts.push(addr.numeroVoieEtablissement);
    if (addr.typeVoieEtablissement) parts.push(addr.typeVoieEtablissement);
    if (addr.libelleVoieEtablissement) parts.push(addr.libelleVoieEtablissement);
    let line = parts.join(' ').trim();
    if (addr.complementAdresseEtablissement) {
        line = line ? `${line}, ${addr.complementAdresseEtablissement}` : addr.complementAdresseEtablissement;
    }
    return line;
}

export function getCurrentEtabPeriode(
    periodes: InseePeriodeEtablissement[] | undefined,
): InseePeriodeEtablissement | undefined {
    if (!periodes?.length) return undefined;
    const open = periodes.find((p) => !p.dateFin);
    return open ?? periodes[periodes.length - 1];
}

function companyNameFromUlPeriod(periode: InseePeriodeUniteLegale | undefined, ul: InseeUniteLegale): string {
    if (periode?.denominationUniteLegale) return periode.denominationUniteLegale;
    const nom = periode?.nomUniteLegale;
    const prenom = periode?.prenom1UniteLegale;
    if (nom || prenom) {
        return [prenom, nom].filter(Boolean).join(' ').trim();
    }
    return ul.sigleUniteLegale || '';
}

export function companyNameFromUniteLegaleSnapshot(ulSnap: InseeUniteLegaleEtablissement | null | undefined): string {
    if (!ulSnap) return '';
    if (ulSnap.denominationUniteLegale) return ulSnap.denominationUniteLegale;
    const nom = ulSnap.nomUniteLegale;
    const prenom = ulSnap.prenom1UniteLegale;
    if (nom || prenom) {
        return [prenom, nom].filter(Boolean).join(' ').trim();
    }
    return ulSnap.sigleUniteLegale || '';
}

/**
 * Construit un SirenSearchResult à partir d'une unité légale et optionnellement l'établissement siège.
 */
export function mapInseeUniteLegaleAndEtablissement(
    ul: InseeUniteLegale,
    etab: InseeEtablissement | null,
): SirenSearchResult {
    const periode = getCurrentUlPeriod(ul.periodesUniteLegale);
    const siren = ul.siren;
    const nic = getNicSiegeFromUniteLegale(ul);
    const siret = etab?.siret ?? (nic ? `${siren}${nic}` : '');
    const addr = etab?.adresseEtablissement;
    const etabPeriode = getCurrentEtabPeriode(etab?.periodesEtablissement ?? undefined);
    const city =
        addr?.libelleCommuneEtablissement ||
        addr?.libelleCommuneEtrangerEtablissement ||
        '';

    return {
        siren,
        siret,
        company_name: companyNameFromUlPeriod(periode, ul),
        vat_number: calculateVatNumber(siren),
        address: buildStreetFromInseeAdresse(addr),
        postal_code: addr?.codePostalEtablissement || '',
        city,
        country_code: 'FR',
        legal_form: periode?.categorieJuridiqueUniteLegale || '',
        naf_code: etabPeriode?.activitePrincipaleEtablissement || '',
        creation_date: ul.dateCreationUniteLegale || '',
    };
}

/**
 * Cartographie depuis la réponse GET /siret/{siret} (établissement avec unité légale imbriquée).
 */
/**
 * Requête multicritères INSEE (syntaxe type Lucene) pour recherche par libellé / nom.
 */
export function buildInseeTextSearchQuery(raw: string): string {
    const trimmed = raw.trim();
    const escaped = trimmed.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
    return `periode(denominationUniteLegale:${escaped}*) OR periode(nomUniteLegale:${escaped}*)`;
}

export function mapInseeEtablissementToResult(etab: InseeEtablissement): SirenSearchResult {
    const ulSnap = etab.uniteLegale;
    const siren = etab.siren ?? etab.siret?.substring(0, 9) ?? '';
    const periode = getCurrentEtabPeriode(etab.periodesEtablissement ?? undefined);
    const addr = etab.adresseEtablissement;
    const name =
        companyNameFromUniteLegaleSnapshot(ulSnap) ||
        (siren ? `[SIREN ${siren}]` : '');

    const city =
        addr?.libelleCommuneEtablissement ||
        addr?.libelleCommuneEtrangerEtablissement ||
        '';

    return {
        siren,
        siret: etab.siret,
        company_name: name,
        vat_number: calculateVatNumber(siren),
        address: buildStreetFromInseeAdresse(addr),
        postal_code: addr?.codePostalEtablissement || '',
        city,
        country_code: 'FR',
        legal_form: ulSnap?.categorieJuridiqueUniteLegale || '',
        naf_code: periode?.activitePrincipaleEtablissement || '',
        creation_date: '',
    };
}
