import {
    buildInseeTextSearchQuery,
    getNicSiegeFromUniteLegale,
    mapInseeUniteLegaleAndEtablissement,
    mapInseeEtablissementToResult,
} from './insee-sirene.mapper';

describe('buildInseeTextSearchQuery', () => {
    it('échappe les caractères Lucene et construit une requête OR sur dénomination et nom', () => {
        const q = buildInseeTextSearchQuery('ACME & Co');
        expect(q).toContain('periode(denominationUniteLegale:');
        expect(q).toContain('OR');
        expect(q).toContain('nomUniteLegale:');
        expect(q).toMatch(/\\&/); // & échappé pour Lucene
    });
});

describe('getNicSiegeFromUniteLegale', () => {
    it('retourne le NIC du siège sur 5 caractères', () => {
        const nic = getNicSiegeFromUniteLegale({
            siren: '123456789',
            periodesUniteLegale: [
                {
                    dateDebut: '2020-01-01',
                    nicSiegeUniteLegale: '12345',
                },
            ],
        });
        expect(nic).toBe('12345');
    });
});

describe('mapInseeUniteLegaleAndEtablissement', () => {
    it('mappe une UL et un établissement siège vers SirenSearchResult', () => {
        const result = mapInseeUniteLegaleAndEtablissement(
            {
                siren: '552100554',
                dateCreationUniteLegale: '1955-01-01',
                periodesUniteLegale: [
                    {
                        dateDebut: '2000-01-01',
                        denominationUniteLegale: 'TEST SA',
                        categorieJuridiqueUniteLegale: '5710',
                        nicSiegeUniteLegale: '00017',
                    },
                ],
            },
            {
                siret: '55210055400017',
                adresseEtablissement: {
                    numeroVoieEtablissement: '1',
                    typeVoieEtablissement: 'AV',
                    libelleVoieEtablissement: 'DES CHAMPS',
                    codePostalEtablissement: '75008',
                    libelleCommuneEtablissement: 'PARIS',
                },
                periodesEtablissement: [
                    {
                        activitePrincipaleEtablissement: '62.01Z',
                    },
                ],
            },
        );
        expect(result.siren).toBe('552100554');
        expect(result.siret).toBe('55210055400017');
        expect(result.company_name).toBe('TEST SA');
        expect(result.postal_code).toBe('75008');
        expect(result.city).toBe('PARIS');
        expect(result.naf_code).toBe('62.01Z');
        expect(result.vat_number).toMatch(/^FR/);
    });
});

describe('mapInseeEtablissementToResult', () => {
    it('mappe un établissement seul', () => {
        const result = mapInseeEtablissementToResult({
            siren: '552100554',
            siret: '55210055400017',
            uniteLegale: {
                denominationUniteLegale: 'TEST SA',
                categorieJuridiqueUniteLegale: '5710',
            },
            adresseEtablissement: {
                codePostalEtablissement: '75008',
                libelleCommuneEtablissement: 'PARIS',
            },
            periodesEtablissement: [{ activitePrincipaleEtablissement: '62.01Z' }],
        });
        expect(result.siret).toBe('55210055400017');
        expect(result.company_name).toBe('TEST SA');
    });
});
