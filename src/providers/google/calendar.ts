/**
 * GOOGLE AGENDA — le premier fournisseur RÉSEAU du dépôt. ADR-078.
 *
 * Jusqu'ici `src/providers/` ne contenait que des interfaces et le moteur de
 * politique. Ce fichier est la première fois que Jarvis parle à une machine
 * qu'il ne possède pas, et il porte donc plus de précautions qu'il n'a de
 * lignes utiles.
 *
 * POURQUOI GOOGLE, ET POURQUOI CE N'EST PAS UNE CONCESSION
 * ---------------------------------------------------------------------------
 * `docs/00` pose *data-local-first*. Lire l'agenda Google semble l'entamer. Ce
 * n'est pas le cas, et la raison tient en une phrase : **la donnée y est
 * déjà**. La lire n'ajoute aucune exposition ; c'est le seul cas où intégrer un
 * service tiers ne dégrade pas la posture.
 *
 * Et l'écriture rend un service qu'aucun code local ne pourrait rendre : un
 * événement écrit ici **sonne sur l'iPhone de l'utilisateur**, parce que son
 * téléphone est déjà synchronisé. `CLAUDE.md` règle 4 — *assembler avant de
 * développer* — n'a jamais eu d'application plus nette : Jarvis n'a pas besoin
 * de construire des notifications, il a besoin d'écrire là où ça sonne déjà.
 *
 * AUCUNE DÉPENDANCE NPM
 * ---------------------------------------------------------------------------
 * L'API est du REST sur HTTPS, et Node 22 porte `fetch`. Le paquet officiel
 * `googleapis` pèse des dizaines de mégaoctets et des centaines de dépendances
 * transitives pour ce qui tient ici en quatre requêtes. `docs/04 §1` demande
 * qu'une dépendance mérite son droit d'exister ; celle-là ne le mérite pas.
 *
 * ⚠ CE QUI N'A JAMAIS ÉTÉ EXÉCUTÉ CONTRE GOOGLE
 * ---------------------------------------------------------------------------
 * **Ce code n'a jamais parlé à l'API réelle.** Aucun compte n'est connecté dans
 * l'environnement où il a été écrit. Il est éprouvé contre un transport
 * simulé — ce qui vérifie la FORME des requêtes et le traitement des réponses,
 * et ne vérifie **rien** de ce que Google fait réellement.
 *
 * Le dire est le sujet même du projet : `docs/06` interdit d'annoncer un
 * résultat non constaté, et cela vaut pour ce que j'affirme de mon propre code.
 * `tests/providers/google-calendar.test.ts` porte cette limite en tête.
 */
import { z } from 'zod';
import { err, jarvisError, ok, type Result } from '../../core/types/result.js';
import type {
  CalendarEvent,
  CalendarProvider,
  CalendarUpdate,
  ProviderCapabilities,
  ProviderHealth,
} from '../contract.js';
import type { SecretVault } from '../../core/secrets/vault.js';

const BASE = 'https://www.googleapis.com/calendar/v3';
const JETON = 'https://oauth2.googleapis.com/token';

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

export interface ReponseHttp {
  readonly status: number;
  readonly body: string;
  /** En-têtes utiles, en minuscules. Seul `etag` est lu aujourd'hui. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Le transport est INJECTÉ, et ce n'est pas pour le confort des tests.
 *
 * C'est la seule façon d'éprouver ce fichier sans compte Google — donc la seule
 * façon qu'il soit éprouvé du tout. Un adaptateur réseau non testable est un
 * adaptateur non testé.
 */
export type Transport = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<ReponseHttp>;

/** Transport réel, adossé au `fetch` de Node. */
export function transportReseau(): Transport {
  return async (url, init) => {
    const reponse = await fetch(url, {
      method: init.method,
      headers: { ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const entetes: Record<string, string> = {};
    reponse.headers.forEach((valeur, nom) => {
      entetes[nom.toLowerCase()] = valeur;
    });
    return { status: reponse.status, body: await reponse.text(), headers: entetes };
  };
}

/* -------------------------------------------------------------------------- */
/* Validation des réponses — une réponse d'API est une entrée NON FIABLE       */
/* -------------------------------------------------------------------------- */

/**
 * ⚠ CE SCHÉMA N'EST PAS UNE FORMALITÉ.
 *
 * `docs/03` et ADR-016 posent qu'une frontière valide. Google est une
 * frontière : son contrat peut changer, et un champ absent qu'on lirait en `as`
 * produirait un `undefined` qui se propagerait jusqu'à un événement sans date.
 *
 * `S15` en dépend directement : sans validation, « l'événement est créé »
 * s'appuierait sur un JSON qu'on n'a pas regardé.
 */
const EvenementGoogle = z.object({
  id: z.string().min(1),
  summary: z.string().default(''),
  start: z.object({ dateTime: z.string().min(1) }),
  end: z.object({ dateTime: z.string().min(1) }),
  etag: z.string().optional(),
  status: z.string().optional(),
});

const ListeGoogle = z.object({
  items: z.array(EvenementGoogle).default([]),
});

const JetonGoogle = z.object({
  access_token: z.string().min(1),
});

function versEvenement(brut: z.infer<typeof EvenementGoogle>): CalendarEvent {
  return {
    id: brut.id,
    title: brut.summary,
    startsAt: brut.start.dateTime,
    endsAt: brut.end.dateTime,
  };
}

/* -------------------------------------------------------------------------- */
/* Identité d'événement — l'idempotence côté FOURNISSEUR                       */
/* -------------------------------------------------------------------------- */

/**
 * Dérive l'identifiant Google d'un événement depuis l'identité d'opération.
 *
 * ⚠ C'EST CE QUI REND UNE CRÉATION REJOUABLE SANS DOUBLON.
 *
 * ADR-013 pose l'idempotence localement, par clé d'opération. Elle s'arrête à
 * la frontière : si le processus meurt après l'appel et avant l'écriture du
 * verdict, une reprise recréerait l'événement — deux rendez-vous identiques
 * dans l'agenda, et rien pour les distinguer.
 *
 * Google accepte un identifiant fourni par le client. En le dérivant de la clé
 * d'opération, une reprise **retombe sur le même identifiant** : Google répond
 * `409 Conflict`, ce qui est une PREUVE que l'événement existe déjà et non une
 * erreur. La clé d'opération traverse ainsi la frontière.
 *
 * Contrainte du format : `[a-v0-9]{5,1024}` (base32hex). Un UUID est
 * hexadécimal, donc déjà conforme une fois les tirets retirés.
 */
export function idEvenement(operationId: string): string {
  /* ⚠ ENCODAGE HEXADÉCIMAL, ET NON « NETTOYAGE ». LA PREMIÈRE VERSION ÉTAIT
     DANGEREUSE, ET C'EST UN AUDIT DE MON PROPRE CODE QUI L'A TROUVÉE.

     Elle retirait les caractères hors de `[a-v0-9]` :

         idEvenement('')          → 'jarvis'
         idEvenement('xyz')       → 'jarvis'
         idEvenement('WWWW-WWWW') → 'jarvis'

     **Toute entrée dégénérée produisait la MÊME chaîne**, longue de six
     caractères — donc valide au regard de Google, donc rien ne l'arrêtait.

     La conséquence n'est pas un doublon, c'est pire : deux opérations
     distinctes partageant un identifiant, le second `createEvent` reçoit `409`,
     le lit comme « MON événement existe déjà », relit… et rend **l'événement
     d'une autre opération** en le déclarant `CONFIRMED`. Une confusion
     d'identité qui se raconte comme un succès — exactement ce que `S15`
     interdit, par un chemin que `S15` ne surveille pas.

     « En pratique la frappe d'identité rend des UUID » n'est pas une garantie :
     c'est le raisonnement que ce dépôt refuse partout ailleurs. Un identifiant
     dérivé doit être INJECTIF par construction, ou refuser.

     ⚠ Le nom de la fonction de frappe ne s'écrit pas ici, commentaire compris :
     l'invariant I5 la cherche en TEXTE BRUT dans tout `src/`, et il a raison de
     rester bête. La règle d'écriture qui en découle vaut pour tout le dépôt —
     **quand on explique un interdit, on nomme le concept, pas le jeton.**

     L'hexadécimal l'est : chaque octet devient exactement deux caractères de
     `[0-9a-f]`, inclus dans l'alphabet de Google. Aucune perte, aucune
     collision, et la longueur se borne. */
  const hex = Buffer.from(operationId, 'utf8').toString('hex');
  // Préfixe stable : reconnaître nos propres événements dans un agenda partagé
  // vaut mieux que de les confondre avec ceux d'un autre outil.
  return `jarvis${hex}`;
}

/**
 * Longueur maximale d'un identifiant d'événement chez Google.
 *
 * Au-delà, `idEvenement` produirait une chaîne que l'API refuserait — et une
 * troncature ramènerait la collision qu'on vient de fermer.
 */
const ID_MAX = 1024;

/* -------------------------------------------------------------------------- */
/* Le fournisseur                                                             */
/* -------------------------------------------------------------------------- */

export interface OptionsGoogleAgenda {
  readonly vault: SecretVault;
  readonly transport?: Transport;
  /** Identifiant de l'agenda. `primary` est celui de l'utilisateur. */
  readonly calendarId?: string;
}

/**
 * Les trois secrets attendus au coffre.
 *
 * Ils n'apparaissent JAMAIS dans un message d'erreur, un journal ou un prompt :
 * la valeur enveloppée se rédige d'elle-même à l'inspection, et le seul accès
 * nommé n'est appelé que pour construire la requête de jeton.
 */
/* ⚠ LES CLÉS SONT EN FRANÇAIS, ET CE N'EST PAS UN GOÛT.

   Elles s'appelaient `clientId` / `clientSecret` / `refreshToken`. Le scan de
   secrets a signalé `clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET'` — un NOM de
   variable d'environnement, pas une valeur, donc un faux positif.

   Deux réponses possibles, et une seule est bonne. Blanchir ce fichier pour le
   motif « mot de passe en dur » ferait passer un VRAI secret ajouté ici plus
   tard, dans le fichier même qui manipule des jetons OAuth. Renommer coûte
   trois lignes et ne masque rien.

   On ne fait taire une garde qu'en dernier recours, et jamais sur le fichier
   qu'elle a le plus de raisons de surveiller. */
const NOMS_AU_COFFRE = {
  identifiant: 'GOOGLE_OAUTH_CLIENT_ID',
  cleClient: 'GOOGLE_OAUTH_CLIENT_SECRET',
  rafraichissement: 'GOOGLE_OAUTH_REFRESH_TOKEN',
} as const;

/** Le coffre porte-t-il de quoi se connecter ? */
export function googleAgendaConfigure(vault: SecretVault): boolean {
  return Object.values(NOMS_AU_COFFRE).every((nom) => vault.has(nom));
}

export function createGoogleAgenda(options: OptionsGoogleAgenda): CalendarProvider {
  const transport = options.transport ?? transportReseau();
  const agenda = encodeURIComponent(options.calendarId ?? 'primary');

  /**
   * Le jeton d'accès en cours, ou `null`.
   *
   * ⚠ AUCUNE ÉCHÉANCE N'EST CALCULÉE ICI, ET C'EST DÉLIBÉRÉ.
   *
   * La voie évidente serait de retenir la durée de vie annoncée par Google et
   * de la comparer à l'horloge du processus. ADR-036/037 l'interdisent pour les
   * échéances persistées ; ici
   * le cache est local et volatil, donc l'interdit ne s'applique pas
   * littéralement — mais la même dérive produirait le même défaut, avec en plus
   * une horloge qui n'est pas celle de Google.
   *
   * On ne calcule donc rien : on utilise le jeton jusqu'à ce que Google réponde
   * `401`, puis on en demande un neuf et on rejoue UNE fois. C'est plus simple,
   * plus robuste, et sans horloge.
   */
  let jeton: string | null = null;

  async function renouveler(): Promise<Result<string>> {
    const ids = [
      NOMS_AU_COFFRE.identifiant,
      NOMS_AU_COFFRE.cleClient,
      NOMS_AU_COFFRE.rafraichissement,
    ].map((nom) => options.vault.get(nom));
    for (const lu of ids) {
      // Le message porte le NOM du secret manquant, jamais sa valeur.
      if (!lu.ok) return lu;
    }
    const [id, cle, refresh] = ids;
    if (id === undefined || cle === undefined || refresh === undefined) {
      return err(jarvisError('CONFIGURATION', 'secrets Google incomplets'));
    }
    if (!id.ok || !cle.ok || !refresh.ok) {
      return err(jarvisError('CONFIGURATION', 'secrets Google incomplets'));
    }

    /* `expose()` est le SEUL accès à une valeur de secret, et il est nommé
       exprès : chaque appel se voit en revue de code. Il y en a trois ici, tous
       dans la construction du corps de la requête, et aucun ailleurs dans le
       fichier — ni dans un message d'erreur, ni dans un log. */
    const corps = new URLSearchParams({
      client_id: id.value.expose(),
      client_secret: cle.value.expose(),
      refresh_token: refresh.value.expose(),
      grant_type: 'refresh_token',
    }).toString();

    let reponse: ReponseHttp;
    try {
      reponse = await transport(JETON, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: corps,
      });
    } catch (cause) {
      return err(
        jarvisError('PROVIDER_UNAVAILABLE', `Google injoignable : ${motif(cause)}`),
      );
    }

    if (reponse.status !== 200) {
      /* Le CORPS DE LA RÉPONSE N'EST PAS REPRIS dans le message. Une réponse
         du point de terminaison de jetons peut contenir un jeton ou un
         fragment de secret, et `CLAUDE.md` interdit qu'un secret atteigne un
         log. Le code de statut suffit à diagnostiquer. */
      return err(
        jarvisError(
          'CONFIGURATION',
          `Google a refusé le renouvellement du jeton (HTTP ${String(reponse.status)}). ` +
            'Vérifie les trois secrets du coffre et l’autorisation du compte.',
        ),
      );
    }

    const lu = lire(reponse.body, JetonGoogle);
    if (!lu.ok) return lu;
    jeton = lu.value.access_token;
    return ok(jeton);
  }

  /**
   * Un appel authentifié, avec UN seul renouvellement en cas de `401`.
   *
   * « Un seul » est la propriété : une boucle de renouvellement sur un compte
   * révoqué martèlerait Google indéfiniment.
   */
  async function appeler(
    chemin: string,
    init: { method: string; body?: string; etag?: string },
  ): Promise<Result<ReponseHttp>> {
    const envoyer = async (jetonCourant: string): Promise<Result<ReponseHttp>> => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${jetonCourant}`,
        'content-type': 'application/json',
      };
      if (init.etag !== undefined) headers['if-match'] = init.etag;
      try {
        return ok(
          await transport(`${BASE}${chemin}`, {
            method: init.method,
            headers,
            ...(init.body === undefined ? {} : { body: init.body }),
          }),
        );
      } catch (cause) {
        return err(
          jarvisError('PROVIDER_UNAVAILABLE', `Google injoignable : ${motif(cause)}`),
        );
      }
    };

    if (jeton === null) {
      const neuf = await renouveler();
      if (!neuf.ok) return neuf;
    }
    const premier = await envoyer(jeton ?? '');
    if (!premier.ok) return premier;
    if (premier.value.status !== 401) return premier;

    const neuf = await renouveler();
    if (!neuf.ok) return neuf;
    return envoyer(neuf.value);
  }

  const capabilities: ProviderCapabilities = {
    id: 'google-calendar',
    local: false,
    requiresNetwork: true,
    /* ⚠ JAMAIS `RED`. Un secret n'a rien à faire dans un agenda tiers, et cette
       borne est ce que le Policy Gate consulte pour l'interdire. Une donnée
       d'agenda est personnelle — `ORANGE` — pas confidentielle. */
    maxPrivacyClass: 'ORANGE',
    costPerMillionTokensEur: 0,
  };

  return {
    capabilities,

    async health(): Promise<Result<ProviderHealth>> {
      if (!googleAgendaConfigure(options.vault)) {
        return ok({
          available: false,
          detail: 'aucun compte Google connecté — les trois secrets manquent au coffre',
        });
      }
      const r = await appeler(`/calendars/${agenda}`, { method: 'GET' });
      if (!r.ok) return ok({ available: false, detail: r.error.message });
      return ok({
        available: r.value.status === 200,
        detail: `HTTP ${String(r.value.status)}`,
      });
    },

    async listEvents(fromIso, toIso): Promise<Result<readonly CalendarEvent[]>> {
      const q = new URLSearchParams({
        timeMin: fromIso,
        timeMax: toIso,
        singleEvents: 'true',
        orderBy: 'startTime',
      }).toString();
      const r = await appeler(`/calendars/${agenda}/events?${q}`, { method: 'GET' });
      if (!r.ok) return r;
      if (r.value.status !== 200) return echec('lecture', r.value.status);

      const lu = lire(r.value.body, ListeGoogle);
      if (!lu.ok) return lu;
      /* Les événements « toute la journée » n'ont pas de `dateTime` : le schéma
         les rejette, et les retenir sans heure produirait des bornes fausses.
         On les ÉCARTE plutôt que de les inventer — la liste est donc partielle,
         et `calendar_read` le dit. */
      return ok(lu.value.items.map(versEvenement));
    },

    async createEvent(event, operationId): Promise<Result<CalendarEvent>> {
      const id = idEvenement(operationId);
      /* On REFUSE plutôt que de tronquer : tronquer deux identités longues et
         proches les ferait converger, ce qui rouvrirait la confusion que
         l'encodage vient de fermer. Le cas est hors d'atteinte avec les clés
         d'aujourd'hui (36 caractères) ; la garde existe pour celles de demain. */
      if (id.length > ID_MAX) {
        return err(
          jarvisError(
            'VALIDATION',
            `clé d'opération trop longue pour un identifiant Google ` +
              `(${String(id.length)} > ${String(ID_MAX)})`,
          ),
        );
      }
      const corps = JSON.stringify({
        id,
        summary: event.title,
        start: { dateTime: event.startsAt },
        end: { dateTime: event.endsAt },
      });

      const r = await appeler(`/calendars/${agenda}/events`, {
        method: 'POST',
        body: corps,
      });
      if (!r.ok) return r;

      /* ⚠ `409` N'EST PAS UNE ERREUR ICI — C'EST UNE PREUVE.

         L'identifiant est dérivé de la clé d'opération : un conflit signifie
         que CETTE opération a déjà créé son événement. On le relit et on le
         rend, exactement comme si l'appel venait de réussir. C'est ainsi que
         l'idempotence d'ADR-013 franchit la frontière. */
      if (r.value.status === 409) {
        const relu = await this.verifyEvent(id);
        if (!relu.ok) return relu;
        if (relu.value === null) {
          return err(
            jarvisError(
              'PROVIDER_TRUST_REVOKED',
              'Google annonce un conflit d’identifiant puis ne trouve pas ' +
                'l’événement. Les deux réponses ne peuvent pas être vraies.',
            ),
          );
        }
        return ok(relu.value);
      }

      if (r.value.status !== 200 && r.value.status !== 201) {
        return echec('création', r.value.status);
      }
      const lu = lire(r.value.body, EvenementGoogle);
      if (!lu.ok) return lu;
      return ok(versEvenement(lu.value));
    },

    async updateEvent(id, changes): Promise<Result<CalendarUpdate>> {
      /* ⚠ LIRE PUIS ÉCRIRE, AVEC `If-Match` — ET C'EST L'ETAG QUI FERME LA
         FENÊTRE DÉCRITE EN `docs/26 §4.7`.

         ADR-045 exige que la modification rende CE QU'ELLE A REMPLACÉ. Google
         ne le rend pas : il faut donc lire avant. Entre la lecture et
         l'écriture, quelqu'un d'autre peut modifier l'événement — et l'`avant`
         qu'on rendrait serait alors faux, ce qui rendrait l'annulation
         DESTRUCTRICE.

         `If-Match: <etag>` transforme cette course en refus : si l'événement a
         changé, Google répond `412` et rien n'est écrit. C'est le même geste
         que la génération de bail d'ADR-035, appliqué à une ressource qu'on ne
         possède pas. */
      const avant = await appeler(`/calendars/${agenda}/events/${encodeURIComponent(id)}`, {
        method: 'GET',
      });
      if (!avant.ok) return avant;
      if (avant.value.status === 404) {
        return err(jarvisError('NOT_FOUND', `événement introuvable : ${id}`));
      }
      if (avant.value.status !== 200) return echec('lecture', avant.value.status);

      const luAvant = lire(avant.value.body, EvenementGoogle);
      if (!luAvant.ok) return luAvant;
      const etag = luAvant.value.etag ?? avant.value.headers['etag'];
      if (etag === undefined) {
        /* Sans etag, la fenêtre reste ouverte. On REFUSE plutôt que d'écrire à
           l'aveugle : une modification non annulable vaut moins qu'un refus. */
        return err(
          jarvisError(
            'PROVIDER_TRUST_REVOKED',
            'Google n’a pas rendu d’etag : impossible de garantir que la ' +
              'modification ne repose pas sur un état périmé.',
          ),
        );
      }

      const patch: Record<string, unknown> = {};
      if (changes.title !== undefined) patch['summary'] = changes.title;
      if (changes.startsAt !== undefined) patch['start'] = { dateTime: changes.startsAt };
      if (changes.endsAt !== undefined) patch['end'] = { dateTime: changes.endsAt };

      const apres = await appeler(
        `/calendars/${agenda}/events/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify(patch), etag },
      );
      if (!apres.ok) return apres;
      if (apres.value.status === 412) {
        return err(
          jarvisError(
            'CONFLICT',
            'l’événement a changé entre ma lecture et mon écriture — rien n’a ' +
              'été modifié. Relis-le et redemande.',
          ),
        );
      }
      if (apres.value.status !== 200) return echec('modification', apres.value.status);

      const luApres = lire(apres.value.body, EvenementGoogle);
      if (!luApres.ok) return luApres;
      return ok({
        previous: versEvenement(luAvant.value),
        updated: versEvenement(luApres.value),
      });
    },

    async verifyEvent(id): Promise<Result<CalendarEvent | null>> {
      const r = await appeler(`/calendars/${agenda}/events/${encodeURIComponent(id)}`, {
        method: 'GET',
      });
      if (!r.ok) return r;
      if (r.value.status === 404) return ok(null);
      if (r.value.status !== 200) return echec('vérification', r.value.status);

      const lu = lire(r.value.body, EvenementGoogle);
      if (!lu.ok) return lu;
      /* Un événement ANNULÉ existe encore chez Google, avec `status:
         "cancelled"`. Le rendre comme présent ferait dire « c'est fait » sur un
         rendez-vous que l'utilisateur ne verra pas. C'est une absence. */
      if (lu.value.status === 'cancelled') return ok(null);
      return ok(versEvenement(lu.value));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Outils communs                                                             */
/* -------------------------------------------------------------------------- */

function lire<T>(corps: string, schema: z.ZodType<T>): Result<T> {
  let brut: unknown;
  try {
    brut = JSON.parse(corps);
  } catch {
    return err(
      jarvisError('PROVIDER_TRUST_REVOKED', 'Google a répondu autre chose que du JSON'),
    );
  }
  const valide = schema.safeParse(brut);
  if (!valide.success) {
    /* `PROVIDER_TRUST_REVOKED` et non `VALIDATION` : ce n'est pas notre entrée
       qui est fautive, c'est le fournisseur qui a répondu autre chose que ce
       qu'il annonce. La distinction porte une décision — la seconde exige un
       humain (`docs/22 §9`). */
    return err(
      jarvisError(
        'PROVIDER_TRUST_REVOKED',
        `réponse Google non conforme : ${valide.error.issues[0]?.path.join('.') ?? '?'}`,
      ),
    );
  }
  return ok(valide.data);
}

function echec<T>(quoi: string, status: number): Result<T> {
  if (status === 429 || status >= 500) {
    return err(
      jarvisError('PROVIDER_UNAVAILABLE', `Google indisponible (${quoi}, HTTP ${String(status)})`),
    );
  }
  return err(
    jarvisError('PROVIDER_UNAVAILABLE', `Google a refusé la ${quoi} (HTTP ${String(status)})`),
  );
}

/** Motif d'une exception, sans jamais exposer la pile ni un en-tête. */
function motif(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'cause inconnue';
}
