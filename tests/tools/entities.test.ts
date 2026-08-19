/**
 * `entity_create` / `entity_delete` — le chemin sans modèle. ADR-071.
 *
 * `docs/26 §4.12` avait établi que le Context Engine n'est **pas atteignable** :
 * `resolver.ts` sait résoudre une mention et un référent anaphorique, mais
 * `entities` n'est peuplée par **aucun `INSERT` de `src/`**. Un résolveur sans
 * rien à résoudre.
 *
 * L'ADR qui l'a acté écrivait sa propre condition de révision :
 *
 * > *Si un jour la reconnaissance d'entités arrive par un chemin non prévu — un
 * > outil qui crée explicitement une entité sur demande de l'utilisateur, sans
 * > modèle — alors A2 se débloquerait sans Tier 1.*
 *
 * Ce fichier éprouve ce chemin. **Zéro modèle, zéro euro, zéro dépendance.**
 *
 * CE QUE L'OUTIL NE FAIT PAS
 * ---------------------------------------------------------------------------
 * Il n'EXTRAIT rien d'une phrase. L'utilisateur nomme ce qu'il veut voir
 * exister ; la déclaration vient de l'humain, jamais d'une inférence. C'est ce
 * qui le rend compatible avec `Tier 0` — la reconnaissance reste hors de
 * portée, la RÉSOLUTION cesse de tourner à vide.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { createEntityResolver } from '../../src/core/context/resolver.js';
import { createSessionStore } from '../../src/core/session/session.js';
import { EntityKind } from '../../src/tools/entities.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const suffixe = (): string => `${String(Date.now())}-${String(++compteur)}`;

describe('le miroir des genres d’entité ne diverge pas de la base', () => {
  it('EntityKind liste exactement la contrainte CHECK de `entities.kind`', () => {
    /* DEUX REGISTRES DU MÊME FAIT, RAPPROCHÉS PAR UN TEST (ADR-041). Le schéma
       fait autorité ; le miroir TypeScript existe pour refuser une valeur
       invalide AVANT la base, avec un message utile. Sans ce test, l'ajout d'un
       genre en SQL laisserait l'outil incapable de le créer, sans rien dire. */
    const sql = readFileSync(
      'infrastructure/db/migrations/0001_core_schema.up.sql',
      'utf8',
    );
    const bloc = /kind\s+TEXT NOT NULL CHECK \(kind IN \(([\s\S]*?)\)\)/.exec(sql);
    expect(bloc, 'contrainte CHECK de entities.kind introuvable').not.toBeNull();

    const enBase = [...(bloc?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(enBase.length).toBeGreaterThan(0);
    expect([...EntityKind.options].sort()).toEqual([...enBase].sort());
  });
});

describe.runIf(enabled)('entity_create / entity_delete', () => {
  let stack: Stack;
  let db: Db;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
  });

  afterAll(async () => {
    await db.close();
  });

  async function creer(nom: string, kind = 'DOCUMENT'): Promise<string> {
    const result = await stack.gateway.invoke({
      toolId: 'entity_create',
      input: { displayName: nom, kind },
      parameterProvenance: { displayName: 'USER', kind: 'USER' },
      operationId: operationId(`ent-${suffixe()}`),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    if (!result.ok) throw new Error(`entity_create refusé : ${result.error.message}`);
    return (result.value.output as { entityId: string }).entityId;
  }

  it('crée une entité NOMMÉE PAR L’UTILISATEUR, et rien de plus', async () => {
    /* ⚠ LE NOM ÉVITE DÉLIBÉRÉMENT « Pierre ».
       La première version employait « Pierre Dupont », et
       `tests/context/resolver.test.ts` — qui vérifie que trois homonymes
       déclenchent une demande — en a trouvé QUATRE. `entities` est partagée
       entre les fichiers, et le résolveur apparie par préfixe de nom.

       Le test existant avait raison contre le mien : un test qui peuple une
       table commune avec un nom significatif fabrique des faux positifs
       ailleurs. */
    const nom = `Solveig Ravnsborg ${suffixe()}`;
    const id = await creer(nom, 'PERSON');

    const ligne = await db.query<{ display_name: string; kind: string }>(
      'SELECT display_name, kind FROM entities WHERE id = $1',
      [id],
    );
    expect(ligne.ok).toBe(true);
    if (!ligne.ok) return;
    expect(ligne.value.rows[0]?.display_name).toBe(nom);
    expect(ligne.value.rows[0]?.kind).toBe('PERSON');
  });

  it('un genre INCONNU est refusé AVANT la base', async () => {
    /* La contrainte `CHECK` rattraperait, mais avec une erreur de base illisible.
       Le schéma Zod refuse plus tôt et nomme la faute. */
    const result = await stack.gateway.invoke({
      toolId: 'entity_create',
      input: { displayName: 'x', kind: 'LICORNE' },
      parameterProvenance: { displayName: 'USER', kind: 'USER' },
      operationId: operationId(`ent-bad-${suffixe()}`),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    expect(result.ok).toBe(false);
  });

  /* ==================================================================== *
   * LE POINT DE TOUT LE FICHIER — le résolveur a enfin quelque chose
   * ==================================================================== */

  it('05/A2 — le référent « ça » se RÉSOUT depuis le contexte récent', async () => {
    /* LA CONDITION DE RÉVISION, ÉPROUVÉE.

       `resolveAnaphora` lit `mentioned_entity_ids` du dernier tour qui en porte.
       Le mécanisme existait entièrement ; il tournait à vide faute d'entité.

       ⚠ CE TEST PROUVE LE MÉCANISME, PAS LE SCÉNARIO COMPLET. Voir l'assertion
       finale du fichier : la boucle produit ne renseigne toujours pas
       `mentionedEntityIds`, donc A2 reste bloqué au niveau PRODUIT. Confondre
       les deux serait exactement la faute que `docs/26 §4.12` a corrigée — la
       porte éprouvait le module, la case promettait Jarvis. */
    const resolver = createEntityResolver(db);
    const sessions = createSessionStore(db);

    const id = await creer(`Note de réunion ${suffixe()}`, 'DOCUMENT');

    const session = await sessions.start('NORMAL');
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const tour = await sessions.appendTurn(session.value.id, {
      speaker: 'USER',
      content: 'Regarde cette note',
      mentionedEntityIds: [id],
    });
    expect(tour.ok).toBe(true);

    const resolu = await resolver.resolveAnaphora(session.value.id);
    expect(resolu.ok).toBe(true);
    if (!resolu.ok) return;

    // AVANT cet outil, ce chemin rendait toujours NOT_FOUND : la table était
    // vide, donc `mentionedEntityIds` ne pouvait désigner aucune entité.
    expect(resolu.value.kind).toBe('RESOLVED');
  });

  it('CONTRÔLE NÉGATIF — sans entité évoquée, « ça » reste NOT_FOUND', async () => {
    /* Sans lui, un résolveur qui rendrait RESOLVED quoi qu'il arrive passerait
       le test précédent. Et le défaut fermé compte ici plus qu'ailleurs :
       `docs/05 §A2` interdit de DEVINER quand deux lectures diffèrent. */
    const resolver = createEntityResolver(db);
    const sessions = createSessionStore(db);

    const session = await sessions.start('NORMAL');
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    await sessions.appendTurn(session.value.id, {
      speaker: 'USER',
      content: 'Bonjour',
    });

    const resolu = await resolver.resolveAnaphora(session.value.id);
    expect(resolu.ok).toBe(true);
    if (!resolu.ok) return;
    expect(resolu.value.kind).toBe('NOT_FOUND');
  });

  /* ==================================================================== *
   * L'INVERSE — écrit, pas seulement déclaré
   * ==================================================================== */

  it('entity_create s’annule — l’inverse EXISTE', async () => {
    const enregistres = new Set(stack.gateway.list().map((t) => t.definition.id));
    expect(enregistres.has('entity_delete')).toBe(true);

    const id = await creer(`À supprimer ${suffixe()}`);
    const result = await stack.gateway.invoke({
      toolId: 'entity_delete',
      input: { entityId: id },
      parameterProvenance: { entityId: 'USER' },
      operationId: operationId(`ent-del-${suffixe()}`),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('CONFIRMED');

    const reste = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM entities WHERE id = $1',
      [id],
    );
    expect(reste.ok && reste.value.rows[0]?.n).toBe('0');
  });

  it('SUPPRIMER une entité est L4 — la cascade porte loin', () => {
    /* `relations` et `entity_aliases` référencent `entities` en
       `ON DELETE CASCADE` : supprimer une entité efface aussi ce qu'on savait
       d'elle. C'est ce qui justifie la confirmation forte, pas le fait qu'une
       ligne disparaisse. */
    const par = (id: string) =>
      stack.gateway.list().find((t) => t.definition.id === id)?.definition;
    expect(par('entity_delete')?.autonomy).toBe('L4');
    expect(par('entity_delete')?.rollback).toBeNull();
    // Créer reste L2 : rien n'est perdu, et l'inverse existe.
    expect(par('entity_create')?.autonomy).toBe('L2');
  });

  /* ==================================================================== *
   * CE QUI RESTE BLOQUÉ — mesuré, pas supposé
   * ==================================================================== */

  it('A2 est LEVÉ — et le chemin complet est nommé', () => {
    /* ⚠ CE TEST A CHANGÉ TROIS FOIS EN TROIS COMMITS, ET CHAQUE FOIS UNE CAUSE
       EST TOMBÉE POUR DE BON :

         rien ne peuple `entities`             → ADR-071
         aucun appelant n'évoque d'entité      → ADR-072
         aucune règle Tier 0 n'atteint l'outil → ADR-073

       Il vérifie désormais que la chaîne EXISTE aux trois endroits. Le
       scénario de bout en bout, lui, vit dans `tests/golden/a2-referent.test.ts`
       — par du texte, jamais par un appel direct. */
    const moteur = readFileSync('src/core/intent/engine.ts', 'utf8');
    expect(moteur).toContain('entity_create');
    expect(moteur).toContain("referents: { title: 'ANAPHORA' }");

    /* ET LA PROPRIÉTÉ QU'ON A REFUSÉ DE VENDRE : `propose` reste SYNCHRONE.
       La rendre asynchrone était la voie courte vers A2 ; elle aurait fait
       dépendre la compréhension d'une entrée-sortie. La résolution vit dans
       l'Assistant, qui était déjà asynchrone. */
    expect(moteur).toContain('propose(text: string): IntentProposal');

    const assistant = readFileSync('src/core/assistant.ts', 'utf8');
    expect(assistant).toContain('resolveAnaphora');
  });

  it('la boucle ÉVOQUE désormais les entités — la cause précédente est tombée', () => {
    /* La moitié levée par ADR-072, vérifiée dans les deux surfaces. Sans elle,
       le résolveur n'aurait jamais rien à lire, quelle que soit la suite. */
    const cli = readFileSync('src/apps/cli/main.ts', 'utf8');
    const http = readFileSync('src/apps/server/http.ts', 'utf8');
    expect(cli).toContain('mentionedEntityIds: reply.mentionedEntityIds');
    expect(http).toContain('mentionedEntityIds: reply.mentionedEntityIds');
  });
});
