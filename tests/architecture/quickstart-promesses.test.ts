/**
 * LES PROMESSES DU QUICKSTART, REJOUÉES SUR LE MOTEUR RÉEL — ADR-094.
 *
 * LE DÉFAUT QUE CE FICHIER FERME, ET IL EST DU TYPE LE PLUS COÛTEUX
 * ---------------------------------------------------------------------------
 * `QUICKSTART.md` est la seule page que Julien lit avant d'essayer. Elle a
 * affirmé pendant trois ADR :
 *
 * ```text
 * « La désambiguïsation entre deux homonymes n'existe PAS ENCORE »   ADR-073 l'a livrée
 * « Rappelle-moi jeudi d'appeler le médecin EST REFUSÉ »             ADR-077 l'a livré
 * « il répond qu'il ne sait pas chercher dans vos documents »        il demande OÙ chercher
 * ```
 *
 * Les trois étaient vraies à la date d'écriture. Aucune ne l'était encore.
 *
 * ⚠ ET C'EST L'INVERSE DU DÉFAUT QU'ON SURVEILLE D'HABITUDE. Ce dépôt passe son
 * temps à traquer les affirmations TROP GÉNÉREUSES — « c'est fait » sans
 * vérification. Celles-ci sont trop MODESTES, et personne ne les cherchait :
 * une page qui sous-promet ne déclenche aucune alarme, ne casse aucun test, et
 * ne se voit jamais.
 *
 * Le coût est pourtant exactement le même que celui d'ADR-075 :
 *
 * > **Une capacité niée est aussi absente qu'une capacité manquante.**
 * > L'utilisateur renonce à demander ce que Jarvis sait faire.
 *
 * CE QUE CE FICHIER FAIT, ET CE QU'IL NE FAIT PAS
 * ---------------------------------------------------------------------------
 * Il ne relit pas la prose — un test ne sait pas lire du français. Il fait deux
 * choses vérifiables :
 *
 *   1. la LISTE de capacités de la page est exactement `capacitesParlees()` ;
 *   2. chaque phrase d'exemple que la page cite est REJOUÉE sur le moteur, et
 *      le comportement obtenu est celui que la page annonce.
 *
 * Chaque assertion vérifie donc DEUX choses : que la page dit bien ce qu'on
 * croit qu'elle dit (`toContain`), et que le moteur fait ce qu'elle dit. Sans
 * la première moitié, supprimer la phrase du QUICKSTART rendrait le test vert
 * en n'ayant plus rien à garder.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { capacitesParlees, createIntentEngine } from '../../src/core/intent/engine.js';

const QUICKSTART = readFileSync('QUICKSTART.md', 'utf8');

/**
 * Apostrophes ramenées à la droite — « l’agenda » et « l'agenda » sont un seul
 * mot français, et la page est écrite avec la courbe.
 *
 * ⚠ LE BACKTICK N'EN EST PAS UNE, ET LA PREMIÈRE VERSION LE CROYAIT.
 *
 * `capacites-declarees.test.ts` normalise `[’‘`]` — trois caractères, et c'est
 * correct sur du TypeScript, où le backtick apparaît comme apostrophe dactylo-
 * graphiée dans les commentaires.
 *
 * Recopié tel quel sur du Markdown, il transforme ```` ```text ```` en
 * `'''text` : les clôtures de bloc disparaissent, et la recherche du bloc de
 * capacités ne trouve rien. Le test échouait en disant « bloc introuvable »,
 * ce qui était exact et pointait au mauvais endroit.
 *
 * Un helper recopié d'un fichier voisin hérite de ses hypothèses avec lui.
 */
const droite = (s: string): string => s.replace(/[’‘]/gu, "'");

const moteur = createIntentEngine();

describe('la liste de capacités du QUICKSTART est celle du moteur', () => {
  /* Le SEPTIÈME registre de la même liste. ADR-075 en avait dérivé cinq du
     sixième — mais tous en TypeScript. Le Markdown était hors de portée du
     test, et il a divergé exactement comme les cinq autres. */

  it.each(capacitesParlees())('« %s » est annoncée dans le QUICKSTART', (capacite) => {
    /* La capacité est écrite `« retiens que … »` par le moteur et
       `retiens que …` dans le tableau de la page : on compare le cœur, sans
       les guillemets. */
    const noyau = droite(capacite).replace(/^«\s*|\s*»$/gu, '').trim();
    expect(droite(QUICKSTART)).toContain(noyau);
  });

  it('⚠ et la page n\'annonce RIEN de plus — le sens qui trompe vraiment', () => {
    /* Le test ci-dessus empêche d'OUBLIER une capacité. Celui-ci empêche d'en
       INVENTER une, ce qui est le défaut plus grave : oublier fait renoncer,
       inventer fait essayer et échouer.

       On mesure le bloc de capacités de la page, pas la page entière : la prose
       cite forcément d'autres phrases, et les interdire rendrait la page
       illisible. */
    const bloc = /## Ce que Jarvis sait faire aujourd'hui[\s\S]*?```text\n([\s\S]*?)```/u
      .exec(droite(QUICKSTART));
    expect(bloc, 'bloc de capacités introuvable dans QUICKSTART.md').not.toBeNull();

    const lignes = (bloc?.[1] ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(lignes.length).toBe(capacitesParlees().length);

    const noyaux = capacitesParlees().map((c) =>
      droite(c).replace(/^«\s*|\s*»$/gu, '').trim(),
    );
    for (const ligne of lignes) {
      expect(
        noyaux.some((n) => ligne.startsWith(n)),
        `« ${ligne} » est annoncée par la page et n'existe pas dans le moteur`,
      ).toBe(true);
    }
  });
});

describe('les phrases citées par le QUICKSTART se comportent comme annoncé', () => {
  it('« Retrouve le devis du carreleur » DEMANDE où chercher', () => {
    /* La page a dit pendant longtemps qu'il « répond qu'il ne sait pas chercher
       dans vos documents ». Il sait : `file_search` existe depuis ADR-046, et
       depuis ADR-055 il y a TROIS portées. Deviner laquelle serait rouvrir
       HIGH-4 ; refuser serait mentir sur le catalogue. Il demande. */
    expect(droite(QUICKSTART)).toContain('il **demande où chercher**');

    const p = moteur.propose('Retrouve le devis du carreleur');
    expect(p.kind).toBe('CLARIFY');
    if (p.kind !== 'CLARIFY') return;
    for (const portee of ['que sais-tu sur', 'cherche sur le web', 'cherche dans mes documents']) {
      expect(droite(p.question)).toContain(portee);
    }
  });

  it('⚠ « Rappelle-moi jeudi de … » est HONORÉ — la page disait refusé', () => {
    /* Le mensonge par modestie, dans sa forme la plus pure. La page décrivait
       l'état d'avant ADR-077 : à l'époque, refuser était la bonne réponse,
       parce que créer une tâche intitulée « jeudi d'appeler le médecin » sans
       échéance était pire.

       Depuis, la date est résolue PAR LA BASE et un vrai rappel est créé. Une
       personne qui lisait la page n'a jamais essayé. */
    expect(droite(QUICKSTART)).toContain('rappelle-moi jeudi de');
    expect(droite(QUICKSTART)).not.toContain(
      'est refusé plutôt que transformé en tâche sans date',
    );

    const p = moteur.propose("Rappelle-moi jeudi d'appeler le médecin");
    expect(p.kind, 'un rappel daté doit produire un appel d’outil').toBe('TOOL_CALL');
    if (p.kind !== 'TOOL_CALL') return;
    expect(p.toolId).toBe('reminder_create');
  });

  it('« cherche … » tout court reste refusé, et la page le dit', () => {
    /* ⚠ LE CONTRÔLE NÉGATIF DE CE FICHIER, ET IL EST INDISPENSABLE.

       Tout ce qui précède pousse dans un seul sens : « la page sous-promet, il
       faut promettre plus ». Appliqué sans frein, ce raisonnement rouvrirait
       HIGH-4 — accepter « cherche X » en devinant la portée.

       Ce test tient l'autre bord. La modestie n'est un défaut que lorsqu'elle
       est FAUSSE. */
    expect(droite(QUICKSTART)).toContain('« cherche … » tout court');
    expect(moteur.propose('cherche le prix du carrelage').kind).toBe('CLARIFY');
  });

  it('la page ne réaffirme plus les limites levées', () => {
    /* Trois phrases précises, disparues et qui ne doivent pas revenir. Un test
       sur une ABSENCE est faible en général — celui-ci est adossé aux trois
       tests positifs ci-dessus, qui montrent que la capacité existe. */
    for (const perimee of [
      "n'existe **pas\n> encore**",
      'le Context Engine est écrit et testé, mais pas branché',
      'il répond qu\'il ne sait pas\nchercher dans vos documents',
    ]) {
      expect(droite(QUICKSTART)).not.toContain(perimee);
    }
  });
});
