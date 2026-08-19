/**
 * GOOGLE AGENDA — ce que ces tests prouvent, et ce qu'ils NE prouvent PAS.
 * ADR-078.
 *
 * ⚠ À LIRE AVANT DE CITER CE FICHIER COMME UNE GARANTIE.
 *
 * **Aucun de ces tests n'a parlé à Google.** Le transport est simulé. Ils
 * vérifient donc :
 *
 * ```text
 * ✅ la FORME des requêtes émises          (URL, méthode, en-têtes, corps)
 * ✅ le traitement de chaque réponse       (200, 401, 409, 412, 404, 5xx)
 * ✅ qu'aucun secret ne fuit               (message d'erreur, corps, en-têtes)
 * ✅ que l'idempotence traverse la frontière
 *
 * ❌ que Google se comporte comme simulé ici
 * ❌ que les identifiants d'événement sont acceptés par l'API réelle
 * ❌ que les etags fonctionnent comme documenté
 * ```
 *
 * Les trois lignes rouges ne sont pas des oublis : elles demandent un compte
 * connecté, et aucun ne l'est. `docs/06` interdit d'annoncer un résultat non
 * constaté — cela vaut pour ce que j'affirme de mon propre code, et pas
 * seulement pour ce que Jarvis dit à son utilisateur.
 *
 * **Condition de levée : un premier appel réel, avec un compte de test.**
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createGoogleAgenda,
  googleAgendaConfigure,
  idEvenement,
  type ReponseHttp,
  type Transport,
} from '../../src/providers/google/calendar.js';
import { createEnvSecretVault } from '../../src/core/secrets/vault.js';

const CLIENT = 'client-id-de-test';
const SECRET = 'ULTRA-SECRET-CLIENT-2f9a';
const REFRESH = 'ULTRA-SECRET-REFRESH-7c1b';
const ACCES = 'ULTRA-SECRET-ACCES-4e88';

const coffre = createEnvSecretVault({
  GOOGLE_OAUTH_CLIENT_ID: CLIENT,
  GOOGLE_OAUTH_CLIENT_SECRET: SECRET,
  GOOGLE_OAUTH_REFRESH_TOKEN: REFRESH,
});

interface Appel {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Transport simulé : enregistre ce qui part, rend ce qu'on lui dicte. */
function simuler(reponses: readonly ReponseHttp[]): {
  transport: Transport;
  appels: Appel[];
} {
  const appels: Appel[] = [];
  let i = 0;
  const transport: Transport = (url, init) => {
    appels.push({ url, method: init.method, ...(init.body === undefined ? {} : { body: init.body }), headers: init.headers });
    const r = reponses[i++] ?? { status: 500, body: '{}', headers: {} };
    return Promise.resolve(r);
  };
  return { transport, appels };
}

const jetonOk: ReponseHttp = {
  status: 200,
  body: JSON.stringify({ access_token: ACCES }),
  headers: {},
};

function evenement(id: string, titre = 'Carreleur', etag = '"v1"'): ReponseHttp {
  return {
    status: 200,
    body: JSON.stringify({
      id,
      summary: titre,
      start: { dateTime: '2026-08-20T14:00:00Z' },
      end: { dateTime: '2026-08-20T15:00:00Z' },
      etag,
    }),
    headers: { etag },
  };
}

/* ====================================================================== *
 * 1. LES SECRETS NE SORTENT PAS
 * ====================================================================== */

describe('aucun secret ne fuit', () => {
  it('le corps de la requête de jeton est le SEUL endroit où ils paraissent', async () => {
    const { transport, appels } = simuler([
      jetonOk,
      { status: 200, body: JSON.stringify({ items: [] }), headers: {} },
    ]);
    const agenda = createGoogleAgenda({ vault: coffre, transport });
    await agenda.listEvents('2026-08-20T00:00:00Z', '2026-08-21T00:00:00Z');

    const [jeton, liste] = appels;
    expect(jeton?.url).toContain('oauth2.googleapis.com/token');
    expect(jeton?.body).toContain(SECRET);

    /* ⚠ LA PROPRIÉTÉ QUI COMPTE : le second appel — celui qui part vers l'API —
       ne porte QUE le jeton d'accès. Ni le secret client, ni le jeton de
       rafraîchissement, qui sont les deux valeurs durables. Le premier expire ;
       les autres donnent un accès permanent. */
    const enTexte = JSON.stringify(liste);
    expect(enTexte).not.toContain(SECRET);
    expect(enTexte).not.toContain(REFRESH);
    expect(liste?.headers['authorization']).toBe(`Bearer ${ACCES}`);
  });

  it('un refus du point de terminaison de jetons ne recopie PAS sa réponse', async () => {
    /* ⚠ LE PIÈGE CLASSIQUE, ET IL EST GRAVE ICI.

       Reprendre le corps de la réponse dans le message d'erreur est le réflexe
       naturel — c'est utile pour diagnostiquer. Mais une réponse du point de
       terminaison de jetons peut contenir un jeton ou un fragment de secret, et
       ce message finit dans un log. `CLAUDE.md` l'interdit sans exception.

       Le code de statut suffit à diagnostiquer. */
    const { transport } = simuler([
      { status: 400, body: JSON.stringify({ error: 'invalid_grant', token: ACCES }), headers: {} },
    ]);
    const agenda = createGoogleAgenda({ vault: coffre, transport });
    const r = await agenda.listEvents('2026-08-20T00:00:00Z', '2026-08-21T00:00:00Z');

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).not.toContain(ACCES);
    expect(r.error.message).not.toContain(SECRET);
    // Et il reste diagnosticable : le statut est dit.
    expect(r.error.message).toContain('400');
  });

  it('STRUCTUREL — `expose()` n’est appelé QUE pour construire la requête de jeton', () => {
    /* `expose()` est le seul accès à une valeur de secret, et il est nommé pour
       être compté. Trois appels, tous dans `renouveler`. Un quatrième ailleurs
       serait un secret qui prend un chemin nouveau — ce test le signale. */
    const source = readFileSync('src/providers/google/calendar.ts', 'utf8');
    expect(source.split('.expose()').length - 1).toBe(3);
    // Et jamais dans une interpolation de message.
    expect(source).not.toMatch(/message[^\n]*expose\(\)/u);
  });

  it('le coffre incomplet est dit SANS nommer de valeur', async () => {
    const vide = createEnvSecretVault({ GOOGLE_OAUTH_CLIENT_ID: CLIENT });
    expect(googleAgendaConfigure(vide)).toBe(false);

    const agenda = createGoogleAgenda({ vault: vide, transport: simuler([]).transport });
    const sante = await agenda.health();
    expect(sante.ok).toBe(true);
    if (!sante.ok) return;
    expect(sante.value.available).toBe(false);
    // La santé DIT ce qui manque, en clair, sans exposer ce qui est présent.
    expect(sante.value.detail).toContain('aucun compte Google connecté');
    expect(sante.value.detail).not.toContain(CLIENT);
  });
});

/* ====================================================================== *
 * 2. L'IDEMPOTENCE TRAVERSE LA FRONTIÈRE
 * ====================================================================== */

describe('créer un événement deux fois n’en crée qu’un', () => {
  it('l’identifiant est DÉRIVÉ de la clé d’opération — donc stable', () => {
    const op = '3f2a8c11-4d5e-6789-abcd-ef0123456789';
    expect(idEvenement(op)).toBe(idEvenement(op));
    // Format Google : `[a-v0-9]{5,1024}`. Les caractères hors alphabet tombent.
    expect(idEvenement(op)).toMatch(/^[a-v0-9]{5,1024}$/u);
    expect(idEvenement(op)).not.toContain('-');
    // Deux opérations distinctes ne partagent pas d'identifiant.
    expect(idEvenement(op)).not.toBe(idEvenement('11112222-3333-4444-5555-666677778888'));
  });

  it('un `409` est traité comme une PREUVE d’existence, pas comme un échec', async () => {
    /* ⚠ LE CŒUR DE L'IDEMPOTENCE DISTANTE.

       Le processus meurt entre l'appel et l'écriture du verdict. La reprise
       rejoue la création avec le MÊME identifiant dérivé. Google répond `409`.

       Le lire comme un échec créerait un `FAILED` sur un événement qui EXISTE —
       exactement le mensonge inverse de celui que `S15` interdit d'ordinaire, et
       tout aussi faux. On relit, et on rend l'événement. */
    const id = idEvenement('3f2a8c11-4d5e-6789-abcd-ef0123456789');
    const { transport, appels } = simuler([
      jetonOk,
      { status: 409, body: JSON.stringify({ error: 'duplicate' }), headers: {} },
      evenement(id),
    ]);
    const agenda = createGoogleAgenda({ vault: coffre, transport });
    const r = await agenda.createEvent(
      { title: 'Carreleur', startsAt: '2026-08-20T14:00:00Z', endsAt: '2026-08-20T15:00:00Z' },
      '3f2a8c11-4d5e-6789-abcd-ef0123456789',
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe(id);
    // La relecture a bien eu lieu : on ne s'est pas contenté du 409.
    expect(appels[2]?.method).toBe('GET');
    expect(appels[2]?.url).toContain(id);
  });

  it('CONTRÔLE NÉGATIF — un `409` suivi d’une ABSENCE rompt la confiance', async () => {
    /* Google ne peut pas annoncer un conflit d'identifiant ET ne pas trouver
       l'événement. Les deux réponses ne peuvent pas être vraies ensemble.

       C'est la définition de `PROVIDER_TRUST_REVOKED` (`docs/22 §9`) : le
       fournisseur a répondu, et il a répondu autre chose que ce qu'il annonce.
       Distinct d'une indisponibilité, qui se résout toute seule. */
    const { transport } = simuler([
      jetonOk,
      { status: 409, body: '{}', headers: {} },
      { status: 404, body: '{}', headers: {} },
    ]);
    const agenda = createGoogleAgenda({ vault: coffre, transport });
    const r = await agenda.createEvent(
      { title: 'x', startsAt: '2026-08-20T14:00:00Z', endsAt: '2026-08-20T15:00:00Z' },
      '3f2a8c11-4d5e-6789-abcd-ef0123456789',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('PROVIDER_TRUST_REVOKED');
  });
});

/* ====================================================================== *
 * 3. LA FENÊTRE ENTRE LECTURE ET ÉCRITURE EST FERMÉE
 * ====================================================================== */

describe('modifier sans écraser le travail d’un autre', () => {
  it('l’etag lu est RENVOYÉ en `If-Match`', async () => {
    /* ⚠ `docs/26 §4.7` — « la fenêtre entre lecture et écriture, chez un
       fournisseur » — était une zone d'ombre DÉCLARÉE et non levée.

       ADR-045 oblige à rendre l'état ANTÉRIEUR ; Google ne le rend pas, donc il
       faut lire avant d'écrire. Si quelqu'un modifie l'événement entre les
       deux, l'« avant » qu'on rendrait serait faux — et une annulation fondée
       dessus serait DESTRUCTRICE.

       `If-Match` est le même geste que la génération de bail d'ADR-035, sur une
       ressource qu'on ne possède pas. */
    const { transport, appels } = simuler([
      jetonOk,
      evenement('abc123', 'Avant', '"v7"'),
      evenement('abc123', 'Après', '"v8"'),
    ]);
    const agenda = createGoogleAgenda({ vault: coffre, transport });
    const r = await agenda.updateEvent('abc123', { title: 'Après' }, 'op-1');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.previous.title).toBe('Avant');
    expect(r.value.updated.title).toBe('Après');
    expect(appels[2]?.method).toBe('PATCH');
    expect(appels[2]?.headers['if-match']).toBe('"v7"');
  });

  it('un `412` ne modifie RIEN et le dit — l’état avait changé', async () => {
    const { transport } = simuler([
      jetonOk,
      evenement('abc123', 'Avant', '"v7"'),
      { status: 412, body: '{}', headers: {} },
    ]);
    const agenda = createGoogleAgenda({ vault: coffre, transport });
    const r = await agenda.updateEvent('abc123', { title: 'Après' }, 'op-1');

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('CONFLICT');
    // Le message doit être ACTIONNABLE : l'utilisateur doit savoir quoi faire.
    expect(r.error.message).toContain('rien n’a été modifié');
  });

  it('SANS etag, on REFUSE d’écrire plutôt que d’écrire à l’aveugle', async () => {
    /* Une modification qu'on ne pourrait pas annuler vaut moins qu'un refus.
       C'est le même arbitrage qu'ADR-070 sur la suppression : ne pas pouvoir
       prouver interdit d'affirmer, et ici interdit d'agir. */
    const sansEtag: ReponseHttp = {
      status: 200,
      body: JSON.stringify({
        id: 'abc123',
        summary: 'Avant',
        start: { dateTime: '2026-08-20T14:00:00Z' },
        end: { dateTime: '2026-08-20T15:00:00Z' },
      }),
      headers: {},
    };
    const { transport, appels } = simuler([jetonOk, sansEtag]);
    const agenda = createGoogleAgenda({ vault: coffre, transport });
    const r = await agenda.updateEvent('abc123', { title: 'Après' }, 'op-1');

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('PROVIDER_TRUST_REVOKED');
    // AUCUN PATCH n'est parti : deux appels seulement, jeton puis lecture.
    expect(appels).toHaveLength(2);
  });
});

/* ====================================================================== *
 * 4. VÉRIFIER, C'EST DISTINGUER L'ABSENCE DE L'ERREUR
 * ====================================================================== */

describe('vérifier un événement', () => {
  it('`404` rend une ABSENCE constatée, pas une erreur', async () => {
    const { transport } = simuler([jetonOk, { status: 404, body: '{}', headers: {} }]);
    const agenda = createGoogleAgenda({ vault: coffre, transport });
    const r = await agenda.verifyEvent('abc123');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeNull();
  });

  it('un événement ANNULÉ est une absence — il ne se verra pas', async () => {
    /* Google conserve les événements annulés avec `status: "cancelled"`. Les
       rendre comme présents ferait dire « c'est fait » sur un rendez-vous que
       l'utilisateur ne verra jamais dans son agenda. */
    const annule: ReponseHttp = {
      status: 200,
      body: JSON.stringify({
        id: 'abc123',
        summary: 'Annulé',
        start: { dateTime: '2026-08-20T14:00:00Z' },
        end: { dateTime: '2026-08-20T15:00:00Z' },
        status: 'cancelled',
      }),
      headers: {},
    };
    const { transport } = simuler([jetonOk, annule]);
    const agenda = createGoogleAgenda({ vault: coffre, transport });
    const r = await agenda.verifyEvent('abc123');
    expect(r.ok && r.value).toBeNull();
  });

  it('une réponse NON CONFORME rompt la confiance, elle ne se devine pas', async () => {
    /* Un `summary` absent est tolérable — il vaut chaîne vide. Une DATE absente
       ne l'est pas : la deviner produirait un rendez-vous à une heure inventée.
       Le schéma refuse, et le refus est classé comme une faute du FOURNISSEUR,
       pas de notre entrée. */
    const casse: ReponseHttp = {
      status: 200,
      body: JSON.stringify({ id: 'abc123', summary: 'x' }),
      headers: {},
    };
    const { transport } = simuler([jetonOk, casse]);
    const agenda = createGoogleAgenda({ vault: coffre, transport });
    const r = await agenda.verifyEvent('abc123');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('PROVIDER_TRUST_REVOKED');
  });

  it('une réponse qui n’est PAS du JSON ne fait pas planter', async () => {
    const { transport } = simuler([
      jetonOk,
      { status: 200, body: '<html>Service Unavailable</html>', headers: {} },
    ]);
    const agenda = createGoogleAgenda({ vault: coffre, transport });
    const r = await agenda.verifyEvent('abc123');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('PROVIDER_TRUST_REVOKED');
  });
});

/* ====================================================================== *
 * 5. LE JETON SE RENOUVELLE UNE FOIS, PAS EN BOUCLE
 * ====================================================================== */

describe('le renouvellement du jeton', () => {
  it('un `401` déclenche UN renouvellement et UN rejeu', async () => {
    const { transport, appels } = simuler([
      jetonOk,
      { status: 401, body: '{}', headers: {} },
      { status: 200, body: JSON.stringify({ access_token: 'NOUVEAU-JETON' }), headers: {} },
      evenement('abc123'),
    ]);
    const agenda = createGoogleAgenda({ vault: coffre, transport });
    const r = await agenda.verifyEvent('abc123');
    expect(r.ok).toBe(true);
    expect(appels).toHaveLength(4);
    // Le rejeu porte le NOUVEAU jeton, pas l'ancien.
    expect(appels[3]?.headers['authorization']).toBe('Bearer NOUVEAU-JETON');
  });

  it('un `401` PERSISTANT s’arrête — pas de martèlement', async () => {
    /* Sur un compte révoqué, une boucle de renouvellement enverrait des
       requêtes indéfiniment. Le second `401` remonte tel quel. */
    const { transport, appels } = simuler([
      jetonOk,
      { status: 401, body: '{}', headers: {} },
      jetonOk,
      { status: 401, body: '{}', headers: {} },
    ]);
    const agenda = createGoogleAgenda({ vault: coffre, transport });
    const r = await agenda.verifyEvent('abc123');
    expect(r.ok).toBe(false);
    expect(appels).toHaveLength(4);
  });

  it('AUCUNE HORLOGE n’est consultée pour l’expiration', () => {
    /* La voie évidente — retenir `expires_in` et comparer à l'horloge du
       processus — introduirait une dérive entre notre horloge et celle de
       Google, sur le chemin le plus visible du produit. On ne calcule rien : on
       réagit au `401`. */
    const source = readFileSync('src/providers/google/calendar.ts', 'utf8');
    expect(source).not.toContain('expires_in');
    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('new Date');
  });
});

/* ====================================================================== *
 * 6. CESSER D'ATTENDRE N'EST PAS ÉCHOUER
 * ====================================================================== */

describe('le délai d’attente', () => {
  /** Transport qui ne répond jamais — comme un réseau coupé après connexion. */
  function muet(nomErreur: string): Transport {
    return () =>
      Promise.reject(Object.assign(new Error('délai dépassé'), { name: nomErreur }));
  }

  it('un DÉLAI DÉPASSÉ rend TIMEOUT, jamais un échec', async () => {
    /* ⚠ LA DISTINCTION PORTE TOUT LE SENS.

       `PROVIDER_UNAVAILABLE` dit « il n'a pas répondu ». `TIMEOUT` dit « j'ai
       cessé d'attendre » — et la requête est peut-être arrivée. L'événement
       existe peut-être déjà dans l'agenda.

       Les confondre ferait conclure un échec sur une action réussie : le
       mensonge symétrique de celui que `S15` interdit d'ordinaire, et tout aussi
       faux. Le banc de défaillance le pose depuis longtemps — *timeout →
       UNKNOWN, jamais FAILED, et aucun rejeu automatique.* */
    const agenda = createGoogleAgenda({ vault: coffre, transport: muet('TimeoutError') });
    const r = await agenda.verifyEvent('abc123');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('TIMEOUT');
    // Le message DIT l'ignorance plutôt que de la masquer.
    expect(r.error.message).toContain('sais pas si ma demande');
    expect(r.error.message).toContain('ne la rejoue pas');
  });

  it('CONTRÔLE NÉGATIF — une panne ordinaire reste une INDISPONIBILITÉ', async () => {
    /* Sans lui, un code qui rendrait `TIMEOUT` sur toute exception passerait le
       test précédent. Les deux causes existent et ne se traitent pas pareil :
       une indisponibilité se retente, une ignorance se dit. */
    const agenda = createGoogleAgenda({ vault: coffre, transport: muet('TypeError') });
    const r = await agenda.verifyEvent('abc123');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('PROVIDER_UNAVAILABLE');
  });

  it('STRUCTUREL — le transport réel POSE un délai', () => {
    /* `fetch` n'en a aucun par défaut. Un serveur qui accepte la connexion puis
       se tait laisserait la promesse en suspens : Jarvis n'aurait ni succès, ni
       échec, ni message — il se tairait, la seule réponse que `docs/06` ne
       permet pas.

       Le test regarde la SOURCE : un délai qui existerait sans être passé à
       `fetch` ne protégerait rien. */
    const source = readFileSync('src/providers/google/calendar.ts', 'utf8');
    expect(source).toContain('AbortSignal.timeout(delaiMs)');
    expect(source).toMatch(/signal:\s*AbortSignal\.timeout/u);
  });
});

/* ====================================================================== *
 * 7. CE QUE CE FICHIER NE PROUVE PAS — déclaré, pas tu
 * ====================================================================== */

describe('les limites de cette éprouvette', () => {
  it('DÉMONSTRATION — aucun appel réel n’a jamais été fait', () => {
    /* ⚠ CE TEST DIT UNE ABSENCE, ET C'EST SA FONCTION.

       Tout ce fichier passe contre un transport simulé. Un lecteur pressé
       pourrait en conclure que l'adaptateur « marche ». Il ne marche pas : il
       est COHÉRENT. C'est autre chose, et la différence est celle que
       `docs/26 §2` recense depuis le début.

       CETTE LIGNE DOIT TOMBER le jour d'un premier appel réel avec un compte de
       test. C'est sa condition de levée. */
    const source = readFileSync('tests/providers/google-calendar.test.ts', 'utf8');
    expect(source).toContain('transportReseau');
    // `transportReseau` est IMPORTÉ comme type mais jamais APPELÉ ici.
    expect(source).not.toMatch(/transportReseau\(\)/u);
  });
});
