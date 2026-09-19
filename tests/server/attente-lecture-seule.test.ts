/**
 * LE TÉLÉPHONE VOIT SA FILE, IL N'AGIT PAS DESSUS — ADR-101.
 *
 * LE MANQUE QUE ÇA FERME
 * ---------------------------------------------------------------------------
 * Depuis ADR-099, le téléphone peut préparer une suppression définitive : elle
 * part en file, et la machine la confirme. Mais il n'avait **aucun moyen de
 * savoir ce qui attendait** — il le découvrait devant le Mac, ou il oubliait.
 *
 * ⚠ ET LA TENTATION ÉTAIT D'ALLER UN PAS TROP LOIN
 * ---------------------------------------------------------------------------
 * Montrer la file, puis mettre un bouton « confirmer » à côté. Ce serait
 * défaire ADR-090 par la porte de derrière : la confirmation redeviendrait un
 * second appel HTTP du même appelant, et le second facteur — être devant la
 * machine — disparaîtrait sans qu'aucune ligne de sécurité ne soit modifiée.
 *
 *     **Voir n'est pas pouvoir.**
 *
 * Ce fichier tient cette frontière, et il la tient par ce qui N'EXISTE PAS :
 * aucune route d'écriture, et **aucun identifiant rendu au navigateur**. Un
 * résumé ne permet pas de confirmer ; un identifiant, si.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const HTTP = readFileSync('src/apps/server/http.ts', 'utf8');
const UI = readFileSync('src/apps/server/ui.ts', 'utf8');
const RAPPORTS = readFileSync('src/apps/reports.ts', 'utf8');

describe('la file est consultable depuis le téléphone', () => {
  it('une route la sert', () => {
    expect(HTTP).toContain("/api/attente");
    expect(RAPPORTS).toContain('attenteReport');
  });

  it('et le bouton existe — une capacité que rien n’annonce n’existe pas', () => {
    /* ADR-094 : une capacité que l'interface ne montre pas est, du siège de
       l'utilisateur, une capacité absente. Servir la route sans le bouton
       aurait été exactement ça. */
    expect(UI).toContain('data-cmd="/attente"');
  });
});

describe('⚠ mais elle ne donne AUCUN moyen d’agir', () => {
  it('la route est en LECTURE seule', () => {
    /* `/api/attente` est placée après le garde `request.method !== 'GET'`.
       On vérifie qu'aucun chemin d'écriture ne la nomme. */
    const ecritures = [...HTTP.matchAll(/method === 'POST'[\s\S]{0,400}?attente/g)];
    expect(ecritures.map((m) => m[0])).toEqual([]);
  });

  it('⚠ l’IDENTIFIANT n’est jamais rendu au navigateur', () => {
    /* LA LIGNE QUI TIENT TOUT.

       `confirmer(id)` prend un identifiant. Tant que le navigateur n'en reçoit
       aucun, il ne peut pas confirmer — même si une route d'écriture
       apparaissait demain par accident.

       C'est la même discipline que `micro.ts` et que `Secret` : la garantie
       vient de ce qu'on ne donne pas, pas de ce qu'on promet. */
    /* ⚠ `\}` ÉCHAPPÉ, et le drapeau `u` l'exige. Non échappé, il est lu comme
       un quantificateur orphelin et la regex ne COMPILE PAS — le fichier de
       test entier échouait au chargement, avec un message de rollup qui ne
       nommait ni le test ni la propriété. */
    const rapport = /export async function attenteReport[\s\S]*?\n\}/u.exec(RAPPORTS);
    expect(rapport, 'attenteReport introuvable').not.toBeNull();
    const corps = rapport?.[0] ?? '';
    expect(corps).toContain('resume');
    expect(corps, 'le rapport ne doit pas rendre d’identifiant').not.toMatch(
      /\bid:\s*d\.id\b/u,
    );
  });

  it('⚠ aucun bouton « confirmer » sur le téléphone', () => {
    /* Si ce test rougit, quelqu'un a mis la confirmation à portée du canal
       distant — et ADR-090 est défaite sans qu'aucune règle de sécurité n'ait
       été touchée. */
    expect(UI).not.toContain("'/api/confirmer'");
    expect(UI).not.toContain('data-cmd="/confirmer"');
  });

  it('CONTRÔLE — la confirmation existe bien, sur la surface LOCALE', () => {
    /* Sans lui, les assertions d'absence ci-dessus seraient vraies dans un
       système où PERSONNE ne peut confirmer — et la file serait un cimetière
       d'intentions. */
    const cli = readFileSync('src/apps/cli/main.ts', 'utf8');
    expect(cli).toContain('/confirmer');
    expect(cli).toContain('runtime.gateway.invoke');
    expect(cli).toContain("surface: 'LOCALE'");
  });
});
