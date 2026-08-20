/**
 * OLLAMA — la garde d'adresse, et le reste. ADR-082.
 *
 * ⚠ AUCUN OLLAMA N'A TOURNÉ ICI. Le transport est simulé : ces tests vérifient
 * la forme des requêtes, le traitement des réponses et les cas hostiles —
 * **rien** de ce qu'un vrai modèle produit, ni la qualité de ses choix d'outil,
 * ni sa latence réelle.
 *
 * Le test le plus important du fichier n'est pas celui qui fait parler le
 * modèle : c'est celui qui **refuse une adresse non locale**. Toute
 * l'affirmation « aucune donnée ne quitte la machine » repose sur lui.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createOllama, estLocale } from '../../src/providers/ollama/model.js';
import { modeleLocalConfigure } from '../../src/apps/runtime.js';
import { ok, type Result } from '../../src/core/types/result.js';
import type { ReponseHttp, Transport } from '../../src/providers/google/calendar.js';

interface Appel {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
}

function simuler(reponses: readonly ReponseHttp[]): {
  transport: Transport;
  appels: Appel[];
} {
  const appels: Appel[] = [];
  let i = 0;
  const transport: Transport = (url, init) => {
    appels.push({ url, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
    return Promise.resolve(reponses[i++] ?? { status: 500, body: '{}', headers: {} });
  };
  return { transport, appels };
}

function chat(contenu: string): ReponseHttp {
  return {
    status: 200,
    body: JSON.stringify({
      message: { content: contenu },
      model: 'llama3.1:8b',
      prompt_eval_count: 120,
      eval_count: 18,
    }),
    headers: {},
  };
}

/** Construit un fournisseur local, ou fait échouer le test bruyamment. */
function ollama(reponses: readonly ReponseHttp[]) {
  const { transport, appels } = simuler(reponses);
  const r = createOllama({ url: 'http://127.0.0.1:11434', model: 'llama3.1:8b', transport });
  if (!r.ok) throw new Error(`construction refusée : ${r.error.message}`);
  return { provider: r.value, appels };
}

/* ====================================================================== *
 * 1. LA GARDE D'ADRESSE — le test le plus important du fichier
 * ====================================================================== */

describe('« local » est une adresse, pas une intention', () => {
  it('REFUSE toute adresse qui n’est pas la boucle locale', () => {
    /* ⚠ SANS CETTE GARDE, LA PROMESSE DE CONFIDENTIALITÉ EST UNE DÉCLARATION.

       Pointer la configuration vers un serveur distant transformerait Jarvis en
       client d'un service tiers — **sans qu'aucune ligne de code ne change**.
       Le fournisseur continuerait de se déclarer `local`, le Policy Gate le
       croirait, et chaque énoncé de l'utilisateur partirait sur le réseau.

       Une promesse qui repose sur la vigilance de celui qui édite un fichier de
       configuration n'est pas une promesse. */
    for (const distante of [
      'http://serveur-distant:11434',
      'http://192.168.1.42:11434', //  le réseau local est une AUTRE machine
      'http://10.0.0.5:11434',
      'https://ollama.exemple.com',
      'http://evil.test/?x=127.0.0.1', // l'hôte est `evil.test`
      'ftp://127.0.0.1:11434',
      'pas une url',
      '',
    ]) {
      expect(estLocale(distante), distante).toBe(false);
      const r = createOllama({ url: distante, model: 'm' });
      expect(r.ok, distante).toBe(false);
      if (r.ok) continue;
      // Le refus EXPLIQUE, il ne se contente pas de bloquer.
      expect(r.error.message).toContain('non locale');
    }
  });

  it('CONTRÔLE NÉGATIF — la boucle locale, elle, est acceptée', () => {
    /* Sans lui, une garde qui refuserait TOUT passerait le test précédent, et
       le `Tier 1` serait mort sans que rien ne le dise. */
    for (const locale of [
      'http://localhost:11434',
      'http://127.0.0.1:11434',
      'http://[::1]:11434',
      'http://127.0.0.1:11434/',
    ]) {
      expect(estLocale(locale), locale).toBe(true);
      expect(createOllama({ url: locale, model: 'm' }).ok, locale).toBe(true);
    }
  });

  it('le REFUS est à la CONSTRUCTION, pas au premier appel', () => {
    /* Un refus tardif laisserait Jarvis démarrer en se croyant local, et
       n'échouerait qu'au moment où l'utilisateur parle — au pire moment, et
       après que la configuration a été acceptée en silence. */
    const r = createOllama({ url: 'http://serveur-distant:11434', model: 'm' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('CONFIGURATION');
  });

  it('la liste d’hôtes est FERMÉE — une énumération, pas un raisonnement', () => {
    /* ⚠ CE TEST A PERDU UNE ASSERTION, ET C'EST UNE AMÉLIORATION.

       Il vérifiait en plus qu'aucun motif d'adresse privée n'apparaisse dans la
       source. Deux problèmes :

         — il attrapait le COMMENTAIRE qui explique pourquoi un tel motif serait
           mauvais (huitième fois qu'un détecteur lit ma prose — et j'enfreignais
           là une règle que j'avais écrite un commit plus tôt : *nommer le
           concept, pas le jeton*) ;
         — il faisait DOUBLON avec le test comportemental ci-dessus, qui refuse
           déjà `192.168.1.42` et `10.0.0.5`.

       Un contrôle structurel qui duplique une preuve comportementale ajoute de
       la friction sans ajouter de preuve. On garde ce qu'il prouve seul : que la
       garde ÉNUMÈRE au lieu de raisonner. */
    const source = readFileSync('src/providers/ollama/model.ts', 'utf8');
    expect(source).toContain('HOTES_LOCAUX');
    expect(source).toContain('new Set([');
    expect(source).toContain('HOTES_LOCAUX.has(');
  });
});

/* ====================================================================== *
 * 2. UNE RÉPONSE DE MODÈLE EST UNE ENTRÉE NON FIABLE
 * ====================================================================== */

describe('la frontière valide, même en local', () => {
  it('`structuredOutput` applique le validateur de l’APPELANT', async () => {
    /* `format: 'json'` contraint Ollama à produire du JSON syntaxiquement
       valide. Cela ne dit RIEN de sa conformité au schéma attendu. */
    const { provider } = ollama([chat('{"action":"AUCUN","compris":"rien"}')]);
    const r = await provider.structuredOutput({ messages: [] }, (brut) => {
      expect(brut).toEqual({ action: 'AUCUN', compris: 'rien' });
      return ok('validé') as Result<string>;
    });
    expect(r.ok && r.value).toBe('validé');
  });

  it('un JSON MAL FORMÉ est une faute du MODÈLE, pas du fournisseur', async () => {
    /* ⚠ LA DISTINCTION PORTE UNE DÉCISION.

       `PROVIDER_TRUST_REVOKED` exige un humain (`docs/22 §9`) et coupe l'outil.
       Ollama, lui, a fait son travail : il a transmis ce que le modèle a
       produit. Rompre la confiance dans le fournisseur pour une réponse mal
       formée punirait le messager — et un modèle qui bavarde de temps en temps
       est un comportement NORMAL, pas une trahison. */
    const { provider } = ollama([chat('Bien sûr ! Voici : {"action":…')]);
    const r = await provider.structuredOutput({ messages: [] }, () => ok('jamais'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('VALIDATION');
  });

  it('une ENVELOPPE non conforme rompt la confiance, elle', async () => {
    /* Ici c'est bien Ollama qui répond autre chose que ce qu'il annonce : pas
       de champ `message`. La distinction avec le cas précédent est le sujet. */
    const { provider } = ollama([
      { status: 200, body: JSON.stringify({ autre: 'chose' }), headers: {} },
    ]);
    const r = await provider.structuredOutput({ messages: [] }, () => ok('jamais'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('PROVIDER_TRUST_REVOKED');
  });

  it('une réponse qui n’est PAS du JSON ne fait pas planter', async () => {
    const { provider } = ollama([{ status: 200, body: '<html>502</html>', headers: {} }]);
    const r = await provider.chat({ messages: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('PROVIDER_TRUST_REVOKED');
  });
});

/* ====================================================================== *
 * 3. CE QUI PART, ET CE QUE ÇA COÛTE
 * ====================================================================== */

describe('la forme de la demande', () => {
  it('la température est NULLE par défaut — le déterminisme ne se demande pas', async () => {
    /* Sans déterminisme, rien n'est reproductible : un scénario qui passe le
       lundi et tombe le mardi ne prouve rien, et un défaut ne se rejoue pas. */
    const { provider, appels } = ollama([chat('{}')]);
    await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
    const corps: unknown = JSON.parse(appels[0]?.body ?? '{}');
    expect((corps as { options: { temperature: number } }).options.temperature).toBe(0);
    expect((corps as { stream: boolean }).stream).toBe(false);
  });

  it('`structuredOutput` exige du JSON au FOURNISSEUR aussi', async () => {
    const { provider, appels } = ollama([chat('{"a":1}')]);
    await provider.structuredOutput({ messages: [] }, () => ok(1));
    expect(JSON.parse(appels[0]?.body ?? '{}')).toMatchObject({ format: 'json' });
  });

  it('le coût est ZÉRO — c’est tout l’objet du local', async () => {
    /* ADR-017 vise « 0 € marginal sur 80–95 % des interactions ». Un modèle
       local n'y contribue pas partiellement : il y contribue entièrement. */
    const { provider } = ollama([chat('bonjour')]);
    const r = await provider.chat({ messages: [] });
    expect(r.ok && r.value.costEur).toBe(0);
    expect(r.ok && r.value.promptTokens).toBe(120);
  });

  it('la santé DIT si le modèle demandé est réellement installé', async () => {
    /* Ollama accepte la connexion même sans le modèle, et n'échoue qu'à
       l'appel. Le dire ici évite un « indisponible » incompréhensible au moment
       où l'utilisateur parle. */
    const absent = ollama([
      { status: 200, body: JSON.stringify({ models: [{ name: 'mistral:latest' }] }), headers: {} },
    ]);
    const s1 = await absent.provider.health();
    expect(s1.ok && s1.value.available).toBe(false);
    expect(s1.ok && s1.value.detail).toContain('mistral:latest');

    const present = ollama([
      { status: 200, body: JSON.stringify({ models: [{ name: 'llama3.1:8b' }] }), headers: {} },
    ]);
    const s2 = await present.provider.health();
    expect(s2.ok && s2.value.available).toBe(true);
  });

  it('Ollama ÉTEINT est une indisponibilité, pas un plantage', async () => {
    const transport: Transport = () =>
      Promise.reject(Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' }));
    const r = createOllama({ url: 'http://127.0.0.1:11434', model: 'm', transport });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sante = await r.value.health();
    // `health` rend TOUJOURS un Result ok : l'indisponibilité est une réponse.
    expect(sante.ok && sante.value.available).toBe(false);
    expect(sante.ok && sante.value.detail).toContain('lancé');
  });
});

/* ====================================================================== *
 * 4. LE CÂBLAGE — et ce qu'il vaut aujourd'hui
 * ====================================================================== */

describe('le câblage réel', () => {
  it('le `Tier 1` n’est construit QUE si la configuration l’active', () => {
    /* Éprouvé par la VALEUR depuis ADR-086 : ce test cherchait un nom de
       fonction dans la source, et un renommage l'a cassé sans que la propriété
       ait bougé. */
    expect(modeleLocalConfigure(undefined).kind).toBe('DESACTIVE');
    expect(
      modeleLocalConfigure({ enabled: false, url: 'http://127.0.0.1:11434', model: 'm' }).kind,
    ).toBe('DESACTIVE');
    expect(
      modeleLocalConfigure({ enabled: true, url: 'http://127.0.0.1:11434', model: 'm' }).kind,
    ).toBe('CONFIGURE');

    // Et la clé de configuration est LUE, pas décorative.
    const runtime = readFileSync('src/apps/runtime.ts', 'utf8');
    expect(runtime).toContain('localModel: config.value.public.localModel');
  });

  it('une adresse REFUSÉE ne fait pas échouer le démarrage', () => {
    /* Un refus de démarrer punirait l'utilisateur d'une option qu'il peut
       corriger, et le laisserait sans assistant du tout. On retombe sur
       `Tier 0` : Jarvis comprend moins, et le dit. */
    /* ⚠ ET LE REFUS PORTE DÉSORMAIS SA RAISON — ADR-086.

       Il retombait sur `null`, indiscernable de « aucun modèle demandé ». La
       raison calculée par `createOllama` était jetée, alors même que le dépôt
       justifiait le silence du démarrage en affirmant qu'elle restait
       disponible. */
    const refus = modeleLocalConfigure({
      enabled: true,
      url: 'http://ailleurs.example:11434',
      model: 'm',
    });
    expect(refus.kind).toBe('REFUSE');
    if (refus.kind !== 'REFUSE') return;
    expect(refus.raison.length).toBeGreaterThan(5);
    expect(refus.raison).toContain('ailleurs.example');
  });

  it('le défaut livré est DÉSACTIVÉ — Jarvis marche sans modèle', () => {
    /* I1 et I2 : Jarvis comprend, mémorise, retrouve et exécute sans Internet
       et sans fournisseur IA. Livrer `enabled: true` ferait dépendre le premier
       démarrage d'une installation qui n'a pas eu lieu. */
    const defaut: unknown = JSON.parse(readFileSync('config/default.json', 'utf8'));
    const local = (defaut as { localModel: { enabled: boolean; url: string } }).localModel;
    expect(local.enabled).toBe(false);
    expect(estLocale(local.url)).toBe(true);
  });

  it('DÉMONSTRATION — aucun Ollama n’a jamais répondu à ce code', () => {
    /* ⚠ CE TEST DIT UNE ABSENCE, ET C'EST SA FONCTION.

       Tout ce fichier passe contre un transport simulé. Un lecteur pressé
       pourrait conclure que le `Tier 1` « marche ». Il est COHÉRENT — c'est
       autre chose, et la différence est celle que `docs/26 §2` recense depuis
       le début.

       CE QUI RESTE À MESURER, et qui ne se déduit d'aucun test ici :
         — un modèle 8B choisit-il le bon outil, et à quel taux ?
         — combien de temps met-il, sur la machine de Julien ?
         — les 43 % d'ADR-080 montent-ils, et de combien ?

       CETTE LIGNE DOIT TOMBER au premier appel réel. */
    const source = readFileSync('tests/providers/ollama.test.ts', 'utf8');
    expect(source).toContain('transport');
    // Le transport RÉSEAU n'est jamais construit ici.
    expect(source).not.toMatch(/transportReseau\(\)/u);
  });
});
