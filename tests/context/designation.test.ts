/**
 * DÉSIGNER PAR LE NOM — ADR-096.
 *
 * Six outils étaient écrits, éprouvés, conformes, et **hors d'atteinte** :
 * ils exigent un identifiant qu'une phrase ne porte pas. Ce fichier éprouve le
 * mécanisme qui le fournit.
 *
 * DEUX PROPRIÉTÉS, ET LA SECONDE N'ÉTAIT PAS ÉVIDENTE
 * ---------------------------------------------------------------------------
 *   1. **On ne départage jamais.** Quatre des six outils sont `L4`,
 *      irréversibles. Une heuristique — « le plus récent » — effacerait
 *      parfois la mauvaise ligne, et personne ne le saurait.
 *
 *   2. **La question ne cite pas ce qu'elle n'a pas le droit de citer.** Une
 *      désambiguïsation ÉNUMÈRE les candidats. Sur une mémoire `CREDENTIAL`,
 *      elle imprimerait le secret — dans le terminal, dans la passerelle web,
 *      et dans tout ce qui journalise la conversation.
 *
 * La seconde n'est attrapée par aucune règle existante : ce n'est ni une
 * égression, ni un log, ni un contexte de modèle. C'est une **question posée à
 * l'utilisateur**, et rien ne classait ce canal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseAvailable, ownerDb } from '../helpers/db.js';
import {
  createDesignationResolver,
  libelleSur,
  type DesignationResolver,
} from '../../src/core/context/designation.js';
import { DataCategory } from '../../src/core/types/domain.js';
import { err, jarvisError } from '../../src/core/types/result.js';
import { floorFor } from '../../src/core/privacy/classify.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

/* ====================================================================== *
 * LA FUITE — éprouvée SANS base, parce qu'elle est une pure décision
 * ====================================================================== */

describe('une question de désambiguïsation ne cite pas un secret', () => {
  it('⚠ CREDENTIAL n’apparaît JAMAIS en clair', () => {
    /* LE CAS QUI A MOTIVÉ `libelleSur`.

       Sans elle, « oublie mon mot de passe » aurait pu répondre :

         « J'en trouve deux : “mot de passe banque : hunter2” ou … ? »

       Le module qui sert à EFFACER une donnée sensible l'aurait affichée en
       chemin. Si ce test rougit, cette phrase est redevenue possible. */
    const rendu = libelleSur('mot de passe banque : hunter2', 'CREDENTIAL');
    expect(rendu).not.toContain('hunter2');
    expect(rendu).toContain('CREDENTIAL');
  });

  it.each(DataCategory.options)('%s : cité si et seulement si son plancher l’autorise', (cat) => {
    /* ⚠ BALAYAGE SUR `DataCategory.options`, PAS SUR UNE LISTE ÉCRITE.

       Une catégorie ajoutée demain y passe sans qu'on ait pensé à l'ajouter —
       et c'est ce jour-là que la règle risquait de tomber. La frontière est
       celle de `docs/14 §3` : `PERSONAL` et en dessous se citent, au-dessus
       se nomment. Un seul registre du plancher, partagé avec le Policy Gate. */
    /* ⚠ LA VARIABLE NE S'APPELLE PAS `secret`, ET CE N'EST PAS UN DÉTAIL.

       Elle s'est appelée ainsi, et `pnpm secrets:scan` a rougi :
       `secret = '…'` matche le motif « mot de passe en dur ». Ce n'en était
       pas un — mais la bonne réponse n'était pas d'ajouter une EXCEPTION au
       scanner.

       Chaque exception affaiblit la garde pour tout le fichier concerné. Ici
       il suffisait de nommer la variable ce qu'elle est. Renommer coûte un
       mot ; une exception coûte une zone aveugle permanente. */
    const temoin = 'CONTENU-TEMOIN-42';
    const rendu = libelleSur(temoin, cat);
    const plancher = floorFor(cat);
    const citable = plancher === 'PUBLIC' || plancher === 'PERSONAL';
    expect(rendu.includes(temoin), `${cat} (plancher ${plancher})`).toBe(citable);
  });

  it('⚠ une catégorie ILLISIBLE est masquée, pas citée', () => {
    /* LE REPLI, ET IL VA VERS LA PROTECTION.

       `OTHER` a un plancher `PERSONAL`, donc citable. Faire retomber une
       catégorie inconnue sur `OTHER` aurait donc AUTORISÉ la citation — le
       repli le plus naturel était le mauvais. Même leçon que `provenanceLue`,
       qui fait retomber l'inconnu sur `EXTERNAL_UNTRUSTED`. */
    const rendu = libelleSur('CONTENU-TEMOIN-42', 'CATEGORIE_INVENTEE');
    expect(rendu).not.toContain('CONTENU-TEMOIN-42');
    expect(rendu).toContain('illisible');
  });

  it('CONTRÔLE — hors mémoire, le libellé passe tel quel', () => {
    /* Sans lui, un `libelleSur` qui masquerait TOUT passerait les assertions
       ci-dessus, et les questions deviendraient illisibles : « lequel ? [1]
       ou [2] ». Une tâche ou une note n'a pas de catégorie — `null` — et son
       titre est exactement ce qui permet de choisir. */
    expect(libelleSur('acheter du terreau', null)).toBe('acheter du terreau');
  });
});

/* ====================================================================== *
 * LA RÉSOLUTION — sur la base réelle
 * ====================================================================== */

describe.runIf(enabled)('le résolveur de désignation', () => {
  let db: Db;

  beforeAll(() => {
    db = ownerDb();
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * Sème des lignes puis interroge, dans une transaction TOUJOURS annulée.
   *
   * ⚠ Rend le `kind` de la RÉSOLUTION, pas le `Result` qui l'enveloppe. La
   * première rédaction lisait `r.kind` sur le `Result` — toujours `undefined`,
   * donc cinq tests rouges qui disaient « expected undefined ». Le message
   * était exact et pointait à côté.
   */
  async function resoudreAvec(
    semis: readonly string[],
    mention: string,
  ): Promise<string | null> {
    let vu: string | null = null;
    await db.transaction(async (tx) => {
      for (const ordre of semis) {
        const fait = await tx.query(ordre);
        if (!fait.ok) return err(jarvisError('INTERNAL', fait.error.message));
      }
      const r = await createDesignationResolver(tx).resoudre('TASK', mention);
      if (r.ok) vu = r.value.kind;
      // Échec délibéré : il provoque le rollback quoi qu'il arrive au-dessus.
      return err(jarvisError('INTERNAL', 'rollback volontaire'));
    });
    return vu;
  }

  const tache = (titre: string, etat = 'OPEN'): string =>
    `INSERT INTO tasks (title, state) VALUES ('${titre}', '${etat}')`;

  /** Comme `resoudreAvec`, mais rend la question posée. */
  async function questionAvec(
    semis: readonly string[],
    mention: string,
  ): Promise<{ kind: string; question: string; nb: number } | null> {
    let vu: { kind: string; question: string; nb: number } | null = null;
    await db.transaction(async (tx) => {
      for (const ordre of semis) {
        const fait = await tx.query(ordre);
        if (!fait.ok) return err(jarvisError('INTERNAL', fait.error.message));
      }
      const r = await createDesignationResolver(tx).resoudre('TASK', mention);
      if (r.ok && r.value.kind === 'AMBIGU') {
        vu = {
          kind: r.value.kind,
          question: r.value.question,
          nb: r.value.candidats.length,
        };
      } else if (r.ok) {
        vu = { kind: r.value.kind, question: '', nb: 0 };
      }
      return err(jarvisError('INTERNAL', 'rollback volontaire'));
    });
    return vu;
  }

  it('UN seul candidat — il résout', async () => {
    expect(await resoudreAvec([tache('acheter du terreau ADR096')], 'terreau ADR096')).toBe(
      'RESOLU',
    );
  }, 30_000);

  it('⚠ PLUSIEURS candidats — il DEMANDE, il ne départage pas', async () => {
    /* LE CŒUR DU FICHIER.

       La tentation est forte : « le plus récent », « celui qui correspond le
       mieux ». Les deux sont des heuristiques, et une heuristique appliquée à
       un `memory_forget` efface parfois la mauvaise ligne.

       Si ce test devient vert sur `RESOLU`, un départage automatique a été
       introduit — et la prochaine suppression ambiguë sera silencieuse. */
    const r = await questionAvec(
      /* ⚠ LA MENTION DOIT ÊTRE SOUS-CHAÎNE DES DEUX. Ma première rédaction
         cherchait « appeler le ADR096 », qui n'est contenu dans aucun des deux
         titres : le test rendait INTROUVABLE et semblait dire que
         l'ambiguïté n'était pas détectée. Elle l'était ; c'est le semis qui
         ne produisait aucun candidat. */
      [tache('appeler le plombier ZZQ96'), tache('appeler le carreleur ZZQ96')],
      'ZZQ96',
    );
    expect(r?.kind).toBe('AMBIGU');
    expect(r?.nb ?? 0).toBeGreaterThanOrEqual(2);
    expect(r?.question ?? '').toContain('Lequel');
  }, 30_000);

  it('AUCUN candidat — il le dit, sans proposer de repli', async () => {
    expect(await resoudreAvec([], 'quelque-chose-qui-n-existe-pas-ADR096')).toBe(
      'INTROUVABLE',
    );
  }, 30_000);

  it('⚠ une mention VIDE ne matche pas TOUT', async () => {
    /* LE CAS LE PLUS DANGEREUX DU MODULE, ET C'EST CELUI OÙ L'UTILISATEUR
       N'A RIEN DIT.

       Sans garde, `LIKE '%' || '' || '%'` matche chaque ligne de la table. Sur
       `memory_forget`, une phrase mal découpée aurait donc proposé d'effacer
       n'importe quelle mémoire — ou, pire, en aurait résolu une seule si la
       base n'en contenait qu'une. */
    expect(await resoudreAvec([tache('une tache quelconque ADR096')], '   ')).toBe(
      'INTROUVABLE',
    );
  }, 30_000);

  it('les ACCENTS ne font pas échouer la désignation', async () => {
    /* « le medecin » doit retrouver « le médecin ». Sans ça, la moitié des
       désignations françaises échouent sur un accent oublié, et l'utilisateur
       conclut que la ligne n'existe pas. */
    expect(await resoudreAvec([tache('appeler le médecin ADR096')], 'medecin ADR096')).toBe(
      'RESOLU',
    );
  }, 30_000);

  it('⚠ une tâche ANNULÉE n’est pas un candidat', async () => {
    /* Le filtre d'état n'est pas décoratif : sans lui, une tâche annulée le
       mois dernier rendrait « annule la tâche café » AMBIGU, et l'utilisateur
       se verrait poser une question dont une réponse ne fait rien. */
    const vu = await resoudreAvec(
      [tache('café ADR096', 'OPEN'), tache('café ADR096', 'CANCELLED')],
      'café ADR096',
    );
    expect(vu, 'une seule tâche OUVERTE porte ce nom').toBe('RESOLU');
  }, 30_000);
});
