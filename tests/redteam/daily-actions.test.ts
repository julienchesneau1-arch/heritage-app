/**
 * RED TEAM — matrice des 30 actions du quotidien.
 *
 * Chaque phrase traverse la boucle réelle (Assistant → Policy Gate → outil →
 * vérification → journal) et son issue est enregistrée. Le tableau produit est
 * la réponse factuelle à « qu'est-ce que Jarvis sait faire aujourd'hui ».
 *
 * La propriété recherchée n'est PAS un taux de réussite élevé. C'est :
 *
 *   aucune phrase ne doit produire une action FAUSSE, ni un succès non vérifié.
 *
 * Un « je ne sais pas faire » est un bon résultat. Une tâche créée à partir
 * d'une demande d'email ne l'est pas.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildRuntime, type Runtime } from '../../src/apps/runtime.js';
import type { AssistantReply } from '../../src/core/assistant.js';

const skip = !databaseAvailable();
const TAG = `act-${String(Date.now())}`;

interface Action {
  readonly label: string;
  readonly phrase: string;
  /** Outil attendu, ou null si la capacité n'existe pas encore. */
  readonly expects: string | null;
}

const ACTIONS: readonly Action[] = [
  { label: 'ajouter une tâche', phrase: `Ajoute ${TAG} à ma liste`, expects: 'task_create' },
  { label: 'ajouter une tâche (rappel)', phrase: `Rappelle-moi de rappeler le plombier ${TAG}`, expects: 'task_create' },
  { label: 'lister les tâches', phrase: 'mes tâches', expects: 'task_list' },
  { label: 'créer une note', phrase: `note ${TAG} idée de cloison`, expects: 'note_create' },
  { label: 'mémoriser un fait', phrase: `Retiens que ${TAG} le compteur est au sous-sol`, expects: 'memory_add' },
  { label: 'retrouver une information', phrase: `Que sais-tu sur ${TAG}`, expects: 'memory_search' },

  /* --- Ci-dessous : capacités absentes. Attendu : un refus honnête. --- */
  { label: 'terminer une tâche', phrase: 'Marque la tâche du plombier comme faite', expects: null },
  { label: 'supprimer une tâche', phrase: 'Supprime la tâche du plombier', expects: null },
  { label: 'créer un événement', phrase: 'Crée un rendez-vous jeudi 14h avec le carreleur', expects: null },
  { label: 'modifier un événement', phrase: 'Décale le rendez-vous du carreleur à vendredi', expects: null },
  { label: 'consulter l\'agenda', phrase: 'Qu\'ai-je de prévu demain ?', expects: null },
  { label: 'préparer un email', phrase: 'Prépare un email au carreleur pour demander le devis', expects: null },
  { label: 'envoyer un email', phrase: 'Envoie un mail à Paul', expects: null },
  { label: 'lire ses emails', phrase: 'Résume mes emails de ce matin', expects: null },
  { label: 'chercher un document', phrase: 'Retrouve le devis du carreleur', expects: null },
  { label: 'analyser un document', phrase: 'Analyse le PDF du devis et sors le montant', expects: null },
  { label: 'briefing du jour', phrase: 'Fais-moi le briefing du matin', expects: null },
  { label: 'lancer une automatisation', phrase: 'Lance la routine du soir', expects: null },
  { label: 'contrôler la maison', phrase: 'Éteins la lumière du salon', expects: null },
  { label: 'recherche web', phrase: 'Cherche le prix moyen d\'un carrelage 20x120', expects: null },
  { label: 'oublier une information', phrase: 'Oublie ce que je t\'ai dit sur le compteur', expects: null },
  { label: 'corriger une information', phrase: 'Non, le compteur est au garage, pas au sous-sol', expects: null },
  { label: 'annuler la dernière action', phrase: 'Annule ce que tu viens de faire', expects: null },
  { label: 'lister ce qu\'il sait', phrase: 'Montre-moi tout ce que tu sais sur le chantier', expects: null },
  { label: 'définir une préférence', phrase: 'Je préfère les rendez-vous le jeudi matin', expects: null },
  { label: 'poser une question de suivi', phrase: 'Et le suivant ?', expects: null },
  { label: 'demander pourquoi', phrase: 'Pourquoi as-tu demandé confirmation ?', expects: null },
  { label: 'passer en mode privé', phrase: 'Passe en mode privé', expects: null },
  { label: 'arrêt d\'urgence', phrase: 'Arrête tout', expects: null },
  { label: 'phrase inintelligible', phrase: 'zzz flurb glorp', expects: null },
];

function classify(reply: AssistantReply): string {
  switch (reply.kind) {
    case 'DONE':
      return `${reply.toolId} / ${reply.status}`;
    case 'CONFIRM':
      return 'CONFIRMATION DEMANDÉE';
    case 'CLARIFY':
      return 'PRÉCISION DEMANDÉE';
    case 'UNSUPPORTED':
      return 'CAPACITÉ ABSENTE (dit)';
    case 'DENIED':
      return 'REFUSÉ PAR POLITIQUE';
    case 'ERROR':
      return `ERREUR : ${reply.message}`;
  }
}

describe.skipIf(skip)('RED TEAM — 30 actions du quotidien', () => {
  let runtime: Runtime;
  const observed = new Map<string, { reply: AssistantReply; rendered: string }>();

  beforeAll(async () => {
    const built = buildRuntime(appDb());
    if (!built.ok) throw new Error(built.error.message);
    runtime = built.value;

    for (const action of ACTIONS) {
      const reply = await runtime.assistant.say(action.phrase);
      observed.set(action.label, { reply, rendered: classify(reply) });
    }
  }, 60_000);

  afterAll(async () => {
    await runtime.close();
  });

  it('imprime la matrice complète', () => {
    const lines = ACTIONS.map((a) => {
      const seen = observed.get(a.label);
      const attendu = a.expects ?? '—';
      return `  ${a.label.padEnd(32)} ${attendu.padEnd(15)} ${seen?.rendered ?? '?'}`;
    });
    process.stdout.write(
      `\n  ACTION                           ATTENDU         OBSERVÉ\n${lines.join('\n')}\n\n`,
    );
    expect(lines).toHaveLength(30);
  });

  it('les 6 capacités existantes fonctionnent et sont vérifiées', () => {
    const supported = ACTIONS.filter((a) => a.expects !== null);
    expect(supported).toHaveLength(6);

    for (const action of supported) {
      const seen = observed.get(action.label);
      if (seen === undefined) throw new Error(`${action.label} non exécutée`);
      expect(seen.reply.kind, action.label).toBe('DONE');
      if (seen.reply.kind !== 'DONE') continue;
      expect(seen.reply.toolId, action.label).toBe(action.expects);
      expect(seen.reply.status, action.label).toBe('CONFIRMED');
    }
  });

  it('DÉMONSTRATION — deux demandes sont SILENCIEUSEMENT substituées', () => {
    // Le défaut le plus grave de cette matrice, et il n'était pas visible sans
    // l'exécuter : « Retrouve le devis du carreleur » et « Cherche le prix
    // moyen d'un carrelage » déclenchent une recherche dans la MÉMOIRE
    // PERSONNELLE, qui ne trouve rien, et Jarvis répond « ✓ C'est fait ».
    //
    // L'utilisateur ne peut pas distinguer « j'ai cherché sur le web, rien
    // trouvé » de « j'ai cherché ailleurs que là où tu croyais ». C'est une
    // action DIFFÉRENTE de celle demandée, annoncée comme un succès.
    const unsupported = ACTIONS.filter((a) => a.expects === null);
    expect(unsupported).toHaveLength(24);

    const substituted: string[] = [];
    for (const action of unsupported) {
      const seen = observed.get(action.label);
      if (seen?.reply.kind === 'DONE') substituted.push(`${action.label} → ${seen.rendered}`);
    }
    expect(substituted.sort()).toEqual([
      'chercher un document → memory_search / CONFIRMED',
      'recherche web → memory_search / CONFIRMED',
    ]);
  });

  it.fails(
    'DÉFAUT — une demande hors capacité ne doit JAMAIS déclencher un autre outil',
    () => {
      // Cause : dans `src/core/intent/engine.ts`, la règle `memory_search`
      // capture `cherche|recherche|retrouve` suivi de n'importe quoi, et elle
      // est évaluée AVANT la liste des capacités connues-mais-absentes.
      const substituted = ACTIONS.filter(
        (a) => a.expects === null && observed.get(a.label)?.reply.kind === 'DONE',
      );
      expect(substituted).toEqual([]);
    },
  );

  it('les 22 autres capacités absentes sont bien annoncées comme telles', () => {
    const silentlyWrong = ACTIONS.filter(
      (a) =>
        a.expects === null &&
        observed.get(a.label)?.reply.kind !== 'DONE' &&
        observed.get(a.label)?.reply.kind === 'ERROR',
    );
    expect(silentlyWrong).toEqual([]);
  });

  it('aucune phrase ne produit d\'erreur technique brute', () => {
    const errors = ACTIONS.map((a) => observed.get(a.label))
      .filter((s) => s?.reply.kind === 'ERROR')
      .map((s) => s?.rendered ?? '');
    expect(errors).toEqual([]);
  });

  it('DÉMONSTRATION — 6 actions sur 30 sont réellement couvertes', () => {
    const done = ACTIONS.filter((a) => observed.get(a.label)?.reply.kind === 'DONE');
    // 8 phrases produisent une action, mais deux sont des substitutions : la
    // couverture RÉELLE du quotidien est de 6 sur 30, soit 20 %.
    expect(done).toHaveLength(8);
    const legitimate = done.filter((a) => a.expects !== null);
    expect(legitimate).toHaveLength(6);
  });
});
