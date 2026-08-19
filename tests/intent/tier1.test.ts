/**
 * TIER 1 — ce qu'un modèle a le droit de proposer, et ce qu'il ne décide pas.
 * ADR-081.
 *
 * ⚠ AUCUN MODÈLE N'A TOURNÉ ICI. Le `ModelProvider` est simulé : ces tests
 * vérifient la forme du dialogue, la validation de la réponse et le traitement
 * des cas hostiles — **rien** de ce qu'un modèle réel produit.
 *
 * Ce qu'ils éprouvent est plus important que la compréhension : ils éprouvent
 * que **la compréhension ne donne aucune autorité**. Un modèle qui comprend mal
 * doit produire une demande de confirmation, jamais une action.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTier1 } from '../../src/core/intent/tier1.js';
import { ok, err, jarvisError, type Result } from '../../src/core/types/result.js';
import type { ModelProvider } from '../../src/providers/contract.js';
import type { RegisteredTool } from '../../src/core/tools/contract.js';

/** Deux outils suffisent : un sensible, un non sensible. */
const OUTILS = [
  {
    definition: {
      id: 'task_create',
      description: 'Créer une tâche',
      parameters: [{ name: 'title', sensitive: true }],
    },
  },
  {
    definition: {
      id: 'task_list',
      description: 'Lister les tâches ouvertes',
      parameters: [],
    },
  },
] as unknown as readonly RegisteredTool[];

/**
 * Modèle simulé — il rend ce qu'on lui dicte, sans rien comprendre.
 *
 * `structuredOutput` applique le `validate` de l'appelant, exactement comme le
 * ferait un vrai fournisseur : c'est LÀ que la frontière se joue, et le double
 * doit donc la traverser aussi.
 */
function modele(reponse: unknown): ModelProvider {
  return {
    capabilities: {
      id: 'faux',
      local: true,
      requiresNetwork: false,
      maxPrivacyClass: 'ORANGE',
      costPerMillionTokensEur: 0,
    },
    health: () => Promise.resolve(ok({ available: true })),
    chat: () => Promise.resolve(err(jarvisError('INTERNAL', 'non utilisé'))),
    structuredOutput: <T,>(
      _req: unknown,
      validate: (raw: unknown) => Result<T>,
    ): Promise<Result<T>> => Promise.resolve(validate(reponse)),
    embeddings: () => Promise.resolve(err(jarvisError('INTERNAL', 'non utilisé'))),
  } as unknown as ModelProvider;
}

const tier1 = (reponse: unknown) =>
  createTier1({ model: modele(reponse), outils: () => OUTILS });

/* ====================================================================== *
 * 1. CE QUE ÇA APPORTE — comprendre une formulation libre
 * ====================================================================== */

describe('comprendre une phrase que les règles ratent', () => {
  it('une formulation libre devient un appel d’outil', async () => {
    /* « faudrait que je pense au café » ne matche AUCUNE règle `Tier 0`
       (mesuré : `REFERENCE` 0/8, ADR-080). C'est tout l'objet de ce module. */
    const r = await tier1({
      action: 'APPEL',
      outil: 'task_create',
      parametres: { title: 'acheter du café' },
    }).propose('faudrait que je pense au café');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('TOOL_CALL');
    if (r.value.kind !== 'TOOL_CALL') return;
    expect(r.value.toolId).toBe('task_create');
    expect(r.value.input['title']).toBe('acheter du café');
    expect(r.value.tier).toBe(1);
  });

  it('le modèle peut dire qu’il ne voit RIEN, et c’est une réponse', async () => {
    const r = await tier1({ action: 'AUCUN', compris: 'que tu parles de météo' })
      .propose('il fait beau non ?');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('UNSUPPORTED');
    if (r.value.kind !== 'UNSUPPORTED') return;
    // Ce qu'il a cru comprendre est REPRIS : « je n'ai pas compris » est interdit.
    expect(r.value.understood).toContain('météo');
  });
});

/* ====================================================================== *
 * 2. CE QUE ÇA NE DONNE PAS — l'autorité
 * ====================================================================== */

describe('comprendre ne donne aucune autorité', () => {
  it('CHAQUE paramètre est marqué `MODEL_OUTPUT` — sans exception', async () => {
    /* ⚠ LA PROPRIÉTÉ CENTRALE DU FICHIER.

       `MODEL_OUTPUT` est traité comme non fiable par le Policy Gate : sur un
       paramètre SENSIBLE, il force le niveau à `L4`, c'est-à-dire confirmation
       portant sur la VALEUR concrète.

       Marquer `USER` reviendrait à blanchir une déduction en intention
       utilisateur — l'inverse exact de `CLAUDE.md` règle 1, et ce serait
       invisible : tout marcherait, mieux même, et sans jamais demander. */
    const r = await tier1({
      action: 'APPEL',
      outil: 'task_create',
      parametres: { title: 'acheter du café', autre: 'peu importe' },
    }).propose('…');

    expect(r.ok).toBe(true);
    if (!r.ok || r.value.kind !== 'TOOL_CALL') return;
    const provenances = Object.values(r.value.parameterProvenance);
    expect(provenances.length).toBe(2);
    for (const p of provenances) expect(p).toBe('MODEL_OUTPUT');
  });

  it('`userConfirms` est TOUJOURS faux — le modèle ne se donne pas la permission', async () => {
    /* `userConfirms` dit « l'énoncé VAUT confirmation ». Une règle `Tier 0`
       peut l'affirmer : elle reconnaît une formule impérative exacte. Un modèle
       qui l'affirmerait affirmerait seulement qu'il le pense — et déciderait
       lui-même s'il faut demander la permission. */
    for (const phrase of ['ajoute du café', 'note ceci', 'retiens que je fume']) {
      const r = await tier1({
        action: 'APPEL',
        outil: 'task_create',
        parametres: { title: 'x' },
      }).propose(phrase);
      expect(r.ok && r.value.kind === 'TOOL_CALL' && r.value.userConfirms).toBe(false);
    }
  });

  it('STRUCTUREL — le modèle ne rend NI provenance, NI autonomie, NI confirmation', () => {
    /* Le schéma de frontière est délibérément pauvre. Y ajouter un de ces
       champs donnerait au modèle la clé du Policy Gate, et le ferait par une
       ligne anodine. Le test regarde la SOURCE parce que c'est la forme du
       schéma qui protège, pas la vigilance de son auteur. */
    const source = readFileSync('src/core/intent/tier1.ts', 'utf8');
    const schema = source.slice(
      source.indexOf('const ReponseModele'),
      source.indexOf('/* ---', source.indexOf('const ReponseModele')),
    );
    for (const interdit of ['provenance', 'autonomy', 'userConfirms:', 'sensitive']) {
      expect(schema.includes(interdit), interdit).toBe(false);
    }
  });
});

/* ====================================================================== *
 * 3. LES CAS HOSTILES — un modèle se trompe, ou est trompé
 * ====================================================================== */

describe('un modèle qui déraille ne fait pas dérailler Jarvis', () => {
  it('un outil INVENTÉ est refusé, et l’invention est DITE', async () => {
    /* ⚠ LA GARDE LA PLUS IMPORTANTE. Un modèle qui hallucine `email_send` ou
       `payment_make` ne doit produire aucun appel. On vérifie contre le
       catalogue RÉEL, relu à chaque appel — pas une liste recopiée. */
    const r = await tier1({
      action: 'APPEL',
      outil: 'payment_make',
      parametres: { montant: 5000 },
    }).propose('paye le carreleur');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('UNSUPPORTED');
    if (r.value.kind !== 'UNSUPPORTED') return;
    // L'invention est nommée : c'est plus honnête que « je n'ai pas compris ».
    expect(r.value.missing).toContain('payment_make');
    expect(r.value.missing).toContain('existe pas');
  });

  it('une réponse NON CONFORME ne devient pas une action', async () => {
    for (const bavardage of [
      'Bien sûr ! Voici votre tâche.',
      { action: 'APPEL' }, //                     `outil` manquant
      { action: 'APPEL', outil: '', parametres: {} }, // identifiant vide
      { action: 'AUTRE_CHOSE' },
      null,
      42,
    ]) {
      const r = await tier1(bavardage).propose('…');
      expect(r.ok, JSON.stringify(bavardage)).toBe(false);
    }
  });

  it('un modèle qui tente d’élargir sa propre autorité est IGNORÉ', async () => {
    /* Le modèle ajoute des champs qui, s'ils étaient lus, le laisseraient
       décider de son propre niveau. Le schéma ne les connaît pas : ils sont
       simplement absents du résultat. */
    const r = await tier1({
      action: 'APPEL',
      outil: 'task_create',
      parametres: { title: 'x' },
      userConfirms: true,
      autonomy: 'L1',
      parameterProvenance: { title: 'USER' },
    }).propose('…');

    expect(r.ok).toBe(true);
    if (!r.ok || r.value.kind !== 'TOOL_CALL') return;
    expect(r.value.userConfirms).toBe(false);
    expect(r.value.parameterProvenance['title']).toBe('MODEL_OUTPUT');
  });

  it('le catalogue est relu à CHAQUE appel — un outil retiré disparaît', async () => {
    /* Un catalogue capturé à la construction serait un second registre du même
       fait (ADR-041). Un outil retiré pour perte de confiance (I12) doit cesser
       d'être proposable immédiatement. */
    let visibles: readonly RegisteredTool[] = OUTILS;
    const t = createTier1({
      model: modele({ action: 'APPEL', outil: 'task_create', parametres: { title: 'x' } }),
      outils: () => visibles,
    });

    expect((await t.propose('…')).ok).toBe(true);
    // `task_create` retiré du catalogue, `task_list` reste.
    visibles = OUTILS.filter((t) => t.definition.id !== 'task_create');
    const apres = await t.propose('…');
    expect(apres.ok && apres.value.kind).toBe('UNSUPPORTED');
  });
});

/* ====================================================================== *
 * 4. LE PROMPT — ce qui y entre, et ce qui n'y entre pas
 * ====================================================================== */

describe('le prompt ne transporte que du fiable', () => {
  it('le prompt ne contient QUE les instructions, le catalogue et l’énoncé', async () => {
    /* ⚠ PREUVE COMPORTEMENTALE, ET LA PREMIÈRE VERSION N'EN ÉTAIT PAS UNE.

       Elle cherchait des mots-clés — « email », « memory » — dans la source.
       C'était un mauvais indicateur à deux titres : elle attrapait mes propres
       COMMENTAIRES (septième fois), et surtout elle n'aurait rien vu d'une
       donnée injectée sous un autre nom.

       On regarde donc ce qui PART réellement. Le contenu du prompt est
       intégralement reconstructible à partir de trois éléments connus : si
       quoi que ce soit d'autre s'y glissait, cette égalité tomberait.

       L'enjeu n'est pas théorique : une donnée externe dans un prompt, c'est la
       menace T1 par la grande porte. */
    let capture: { role: string; content: string }[] = [];
    const espion: ModelProvider = {
      ...modele({ action: 'AUCUN', compris: 'rien' }),
      structuredOutput: <T,>(
        req: { messages: readonly { role: string; content: string }[] },
        validate: (raw: unknown) => Result<T>,
      ): Promise<Result<T>> => {
        capture = [...req.messages];
        return Promise.resolve(validate({ action: 'AUCUN', compris: 'rien' }));
      },
    } as unknown as ModelProvider;

    await createTier1({ model: espion, outils: () => OUTILS }).propose('ajoute du café');

    expect(capture).toHaveLength(2);
    expect(capture[1]).toEqual({ role: 'user', content: 'ajoute du café' });

    /* Le message système est EXACTEMENT les instructions plus le catalogue.
       On le recompose depuis les mêmes sources et on compare — rien d'autre ne
       peut s'y trouver sans faire tomber l'égalité. */
    const source = readFileSync('src/core/intent/tier1.ts', 'utf8');
    const instructions = /const INSTRUCTIONS = `([^`]*)`/u.exec(source)?.[1] ?? '';
    expect(instructions.length).toBeGreaterThan(100);
    const attendu =
      `${instructions}\n\nCatalogue :\n` +
      '- task_create : Créer une tâche (paramètres : title)\n' +
      '- task_list : Lister les tâches ouvertes';
    expect(capture[0]?.content).toBe(attendu);
  });

  it('le catalogue ne DIVULGUE pas les propriétés de sécurité', () => {
    /* Le modèle reçoit l'identifiant, la description et le nom des paramètres.
       Ni le niveau d'autonomie, ni le caractère sensible, ni la réversibilité :
       ce sont les propriétés sur lesquelles le Policy Gate décide, et un modèle
       n'a pas à raisonner dessus — encore moins à les optimiser. */
    const source = readFileSync('src/core/intent/tier1.ts', 'utf8');
    const fn = source.slice(
      source.indexOf('function catalogue('),
      source.indexOf('const INSTRUCTIONS'),
    );
    for (const interdit of ['autonomy', 'sensitive', 'reversible', 'privacyClass']) {
      expect(fn.includes(interdit), interdit).toBe(false);
    }
  });

  it('la température est NULLE — deux fois la même phrase, la même proposition', () => {
    /* Sans déterminisme, rien n'est reproductible : un scénario doré qui passe
       le lundi et tombe le mardi ne prouve rien, et un défaut ne se rejoue pas. */
    const source = readFileSync('src/core/intent/tier1.ts', 'utf8');
    expect(source).toContain('temperature: 0');
  });
});

/* ====================================================================== *
 * 5. L'ORDRE, ET CE QUI N'EST PAS BRANCHÉ
 * ====================================================================== */

describe('l’ordre des tiers, et l’état réel du câblage', () => {
  it('l’Assistant n’appelle le `Tier 1` QUE sur un échec du `Tier 0`', () => {
    /* L'ordre est une propriété, pas une optimisation. Les règles marquent
       leurs paramètres `USER` : là où elles suffisent, aucune confirmation
       n'est exigée. Passer par le modèle d'abord ajouterait latence,
       variabilité ET une confirmation, pour un résultat identique. */
    const assistant = readFileSync('src/core/assistant.ts', 'utf8');
    expect(assistant).toContain("proposal.kind === 'UNSUPPORTED' && deps.tier1 !== null");
    // Et `CLARIFY` ne le déclenche pas : une question posée est un travail fait.
    expect(assistant).not.toContain("proposal.kind === 'CLARIFY' && deps.tier1");
  });

  it('un `Tier 1` en PANNE ne casse pas Jarvis', () => {
    /* Une dégradation se subit, elle ne se propage pas. Si le modèle échoue, on
       garde la réponse du `Tier 0` — qui était honnête. */
    const assistant = readFileSync('src/core/assistant.ts', 'utf8');
    expect(assistant).toContain('if (repli.ok) proposal = repli.value;');
  });

  it('le `Tier 1` est CONSTRUCTIBLE, et désactivé par défaut', () => {
    /* ⚠ CE TEST A CHANGÉ DE CAMP — ADR-082.

       Il démontrait une absence : « aucun modèle local n'est branché », avec
       `tier1: null` en dur dans le runtime. `createOllama` existe désormais, et
       le `Tier 1` se construit dès que la configuration l'active.

       Ce qui reste vrai, et qui est un invariant PRODUIT et non un manque :
       le défaut livré est DÉSACTIVÉ. `I1` et `I2` exigent que Jarvis comprenne,
       mémorise, retrouve et exécute sans Internet et sans fournisseur IA.
       Livrer `enabled: true` ferait dépendre le premier démarrage d'une
       installation qui n'a pas eu lieu. */
    const runtime = readFileSync('src/apps/runtime.ts', 'utf8');
    expect(runtime).toContain('tier1Configure(options.localModel, gateway)');
    expect(runtime).not.toContain('tier1: null,');

    const defaut: unknown = JSON.parse(readFileSync('config/default.json', 'utf8'));
    expect((defaut as { localModel: { enabled: boolean } }).localModel.enabled).toBe(false);
  });

  it('DÉMONSTRATION — aucun MODÈLE n’a jamais répondu à ce code', () => {
    /* L'absence qui reste, et elle est plus étroite qu'avant ADR-082. Le
       câblage existe ; ce qui manque est la MESURE. Rien ici ne dit :

         — si un modèle 8B choisit le bon outil, et à quel taux ;
         — combien de temps il met sur la machine de Julien ;
         — si les 43 % d'ADR-080 montent, et de combien.

       ⚠ CE TEST NE LIT PLUS SA PROPRE SOURCE, ET C'EST UNE LEÇON GÉNÉRALE.

       Deux rédactions successives ont échoué en attrapant leur propre
       commentaire — la neuvième et la dixième fois qu'un détecteur de ce dépôt
       lit ma prose plutôt que mon code. Ce n'est pas de la malchance :

           un test qui grep son propre fichier finira toujours par
           matcher l'explication qu'il porte.

       La preuve passe donc par une VALEUR : le fournisseur employé s'identifie
       lui-même comme factice. Aucune phrase ne peut la contredire. */
    expect(modele({}).capabilities.id).toBe('faux');
    expect(modele({}).capabilities.local).toBe(true);
    expect(modele({}).capabilities.costPerMillionTokensEur).toBe(0);
  });
});
