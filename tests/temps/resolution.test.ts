/**
 * RÉSOUDRE UNE DATE — la base calcule, le processus ne devine pas. ADR-077.
 *
 * Ce fichier éprouve les deux moitiés séparément, et c'est nécessaire :
 *
 *   `expression.ts`  PUR — reconnaît sans savoir quel jour on est
 *   `resolution.ts`  demande l'instant à PostgreSQL
 *
 * L'invariant d'ADR-036/037 — *toute fenêtre temporelle est calculée par la
 * base* — n'est pas éprouvable en lisant `resolution.ts` : le code peut appeler
 * `clock_timestamp()` ET contenir un `new Date()` de repli. Le test structurel
 * final regarde donc la source des DEUX fichiers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appDb, databaseAvailable } from '../helpers/db.js';
import {
  HEURE_PAR_DEFAUT,
  reconnaitre,
  type ExpressionTemporelle,
} from '../../src/core/temps/expression.js';
import { createResolveurTemporel } from '../../src/core/temps/resolution.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

/* ====================================================================== *
 * 1. RECONNAÎTRE — pur, sans horloge
 * ====================================================================== */

describe('reconnaître une expression temporelle', () => {
  it('reconnaît les formes du français courant', () => {
    const cas: readonly [string, ExpressionTemporelle][] = [
      ['demain', { base: 'DEMAIN', heure: HEURE_PAR_DEFAUT, minute: 0 }],
      ['demain matin', { base: 'DEMAIN', heure: 9, minute: 0 }],
      ['demain soir', { base: 'DEMAIN', heure: 19, minute: 0 }],
      ['après-demain', { base: 'APRES_DEMAIN', heure: HEURE_PAR_DEFAUT, minute: 0 }],
      ['jeudi', { base: 'JOUR_SEMAINE', jourSemaine: 4, heure: HEURE_PAR_DEFAUT, minute: 0 }],
      ['jeudi à 14h', { base: 'JOUR_SEMAINE', jourSemaine: 4, heure: 14, minute: 0 }],
      ['jeudi à 8h30', { base: 'JOUR_SEMAINE', jourSemaine: 4, heure: 8, minute: 30 }],
      ['dans 3 jours', { base: 'DANS_N_JOURS', jours: 3, heure: HEURE_PAR_DEFAUT, minute: 0 }],
      ['dans 2 heures', { base: 'DANS_N_HEURES', heures: 2 }],
      ['dans 30 minutes', { base: 'DANS_N_MINUTES', minutes: 30 }],
      ['ce soir', { base: 'AUJOURD_HUI', heure: 19, minute: 0 }],
    ];
    for (const [texte, attendu] of cas) {
      expect(reconnaitre(texte)?.expression, texte).toEqual(attendu);
    }
  });

  it('« après-demain » n’est PAS avalé par « demain »', () => {
    /* L'ORDRE DES ESSAIS EST UNE PROPRIÉTÉ, PAS UN DÉTAIL. « après-demain »
       contient « demain » : tester le plus court d'abord ferait perdre un jour
       à chaque rappel. C'est la faute qu'ADR-073 avait trouvée sur « ajoute ça
       à ma liste », transposée aux dates. */
    expect(reconnaitre('après-demain')?.expression.base).toBe('APRES_DEMAIN');
    expect(reconnaitre('apres-demain')?.expression.base).toBe('APRES_DEMAIN');
  });

  it('REND null quand il ne comprend pas — et c’est une réponse', () => {
    /* `null` fait DEMANDER l'appelant. Sans ce chemin, la seule issue serait
       une date par défaut : un rappel posé pour un moment que l'utilisateur n'a
       jamais dit. */
    for (const texte of [
      'appeler le plombier',
      'la semaine des quatre jeudis',
      'à 27h',
      'dans 0 jours',
      'dans 5000 jours',
    ]) {
      expect(reconnaitre(texte), texte).toBeNull();
    }
  });

  it('un moment SEUL ne fabrique pas une date', () => {
    /* « appelle Paul ce matin » désigne aujourd'hui ; « appelle Paul » ne
       désigne rien. Sans le démonstratif, un mot comme « soir » présent par
       hasard dans une phrase créerait un rappel. */
    expect(reconnaitre('ce matin')?.expression.base).toBe('AUJOURD_HUI');
    expect(reconnaitre('bonne soirée')).toBeNull();
  });

  it('DIT ce qu’elle a consommé — le `reste` est le texte du rappel', () => {
    /* ⚠ CE CHAMP A ÉTÉ AJOUTÉ APRÈS UNE MESURE, PAS PAR ANTICIPATION.

       La première version laissait l'appelant retirer la date lui-même, avec
       SA propre idée de ce qu'est une expression temporelle — donc deux
       registres du même fait (ADR-041). Ils ont divergé immédiatement :

         « rappelle-moi demain matin de sortir la poubelle »
           date  → « demain »              (l'heure du matin PERDUE)
           texte → « matin de sortir la poubelle »   (abîmé)

       Le module qui décide ce qu'est une date est désormais le seul à dire ce
       qu'il en a retiré. */
    const cas: readonly [string, string, number][] = [
      ['demain matin de sortir la poubelle', 'sortir la poubelle', 9],
      ['jeudi à 14h de rappeler le carreleur', 'rappeler le carreleur', 14],
      ['dans 2 heures de rappeler Paul', 'rappeler Paul', 9],
      ['ce soir d’arroser les plantes', 'arroser les plantes', 19],
    ];
    for (const [texte, reste, heure] of cas) {
      const lu = reconnaitre(texte);
      expect(lu, texte).not.toBeNull();
      if (lu === null) continue;
      expect(lu.reste, texte).toBe(reste);
      // L'heure survit au retrait : c'est la moitié qui avait été perdue.
      const e = lu.expression;
      if ('heure' in e) expect(e.heure, texte).toBe(heure);
    }
  });

  it('LES MINUTES SURVIVENT — « 8h30 » n’est pas 8h00', () => {
    /* ⚠ DÉFAUT TROUVÉ EN M'AUDITANT, ET IL ÉTAIT SILENCIEUX.

       Le motif capturait déjà les minutes en second groupe ; la fonction ne
       lisait que le premier. « jeudi à 8h30 » posait un rappel à 8 h 00, sans
       rien dire. Une demi-heure d'écart sur un rendez-vous médical, c'est un
       rendez-vous manqué.

       Aucun test ne portait de minutes : le défaut n'était pas caché, il
       n'était pas REGARDÉ. Une capture inutilisée ne saute pas aux yeux d'une
       relecture. */
    expect(reconnaitre('jeudi à 8h30')?.expression).toEqual({
      base: 'JOUR_SEMAINE',
      jourSemaine: 4,
      heure: 8,
      minute: 30,
    });
    expect(reconnaitre('demain à 14h45')?.expression).toEqual({
      base: 'DEMAIN',
      heure: 14,
      minute: 45,
    });
  });

  it('une MINUTE hors bornes ne se replie pas — elle n’est pas comprise', () => {
    /* Même refus que pour l'heure : « 8h75 » replié sur 9 h 15 inventerait un
       moment que personne n'a dit. `null` fait DEMANDER. */
    expect(reconnaitre('jeudi à 8h75')).toBeNull();
    expect(reconnaitre('jeudi à 8h99')).toBeNull();
  });

  it('un moment de la journée ne fabrique PAS de minutes', () => {
    // « demain matin » est 9 h pile. Prétendre 9 h 07 inventerait une précision.
    expect(reconnaitre('demain matin')?.expression).toEqual({
      base: 'DEMAIN',
      heure: 9,
      minute: 0,
    });
  });

  it('une HEURE SEULE désigne sa prochaine occurrence', () => {
    /* ⚠ CE CAS MANQUAIT, ET SON ABSENCE PRODUISAIT LE DÉFAUT INVERSE.

       « rappelle-moi à 14h d'appeler Paul » n'était pas reconnu comme daté :
       la règle des tâches s'en saisissait et créait une tâche INTITULÉE « à 14h
       d'appeler Paul », sans échéance, annoncée « c'est fait ». HIGH-5 mot pour
       mot — et la garde censée l'attraper ne se déclenchait pas, à cause du
       `\b` accentué (ADR-079). */
    expect(reconnaitre('à 14h')?.expression).toEqual({
      base: 'HEURE_SEULE',
      heure: 14,
      minute: 0,
    });
    expect(reconnaitre('à 14h d’appeler Paul')?.reste).toBe('appeler Paul');
  });

  it('un JOUR l’emporte sur l’heure seule — l’ordre est une propriété', () => {
    // « jeudi à 8h30 » doit rester un jeudi, pas la prochaine occurrence de 8h30.
    expect(reconnaitre('jeudi à 8h30')?.expression.base).toBe('JOUR_SEMAINE');
  });

  it('LE MODULE DE RECONNAISSANCE N’A AUCUNE HORLOGE', () => {
    /* ⚠ L'INVARIANT D'ADR-036/037, ÉPROUVÉ PAR LA STRUCTURE.

       Un module qui reconnaît « demain » n'a pas le droit de savoir quel jour
       on est : s'il le savait, il serait tentant d'y calculer la date, et le
       calcul quitterait la base sans que rien ne le signale. */
    const source = readFileSync('src/core/temps/expression.ts', 'utf8');
    expect(source).not.toContain('new Date');
    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('getTime');
  });
});

/* ====================================================================== *
 * 2. RÉSOUDRE — c'est la base qui calcule
 * ====================================================================== */

describe.runIf(enabled)('résoudre par la base', () => {
  let db: Db;

  beforeAll(() => {
    db = appDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('rend un instant ISO et une forme LISIBLE, issus du même calcul', async () => {
    const r = await createResolveurTemporel(db).resoudre({ base: 'DEMAIN', heure: 9, minute: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    /* UTC avec « Z » : c'est la seule forme que `z.string().datetime()`
       accepte par défaut, et `reminder_create` valide son entrée ainsi. Un
       décalage `+02:00` faisait échouer l'outil sur « Entrée invalide ». */
    expect(r.value.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
    /* La forme humaine sert la CONFIRMATION : elle doit se relire, EN
       FRANÇAIS. La première version déléguait les noms à `TMDay`/`TMMonth`,
       donc au `lc_time` de la base — mesuré : « Wednesday 19 August ». La
       phrase à relire avant d'écrire un rappel s'affichait en anglais, et
       aurait différé d'une machine à l'autre. */
    expect(r.value.humain).toMatch(/à 09:00$/u);
    expect(r.value.humain).not.toMatch(/ {2}/u);
    expect(r.value.humain).toMatch(
      /^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche) \d{1,2} /u,
    );
    expect(r.value.humain).toMatch(
      /(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)/u,
    );
  });

  it('« demain » tombe bien le LENDEMAIN — comparé à la base, pas au processus', async () => {
    /* La comparaison se fait contre `clock_timestamp()` de la MÊME base. La
       faire contre `new Date()` du test reproduirait ici l'erreur que le module
       existe pour empêcher. */
    const resolveur = createResolveurTemporel(db);
    const demain = await resolveur.resoudre({ base: 'DEMAIN', heure: 9, minute: 0 });
    expect(demain.ok).toBe(true);
    if (!demain.ok) return;

    const attendu = await db.query<{ jour: string }>(
      `SELECT to_char(date_trunc('day', clock_timestamp()) + interval '1 day',
              'YYYY-MM-DD') AS jour`,
    );
    expect(attendu.ok).toBe(true);
    if (!attendu.ok) return;
    expect(demain.value.iso.slice(0, 10)).toBe(attendu.value.rows[0]?.jour);
  });

  it('un JOUR DE LA SEMAINE est toujours STRICTEMENT futur', async () => {
    /* ⚠ LE CAS LIMITE QUI COMPTE PLUS QUE LA FORMULE.

       Dit un jeudi, « jeudi » ne doit pas désigner le jour même : le rappel
       serait posé à 9 h alors qu'il est 15 h, donc dans le PASSÉ, et
       `reminder_create` le refuserait pour une raison incompréhensible.

       On éprouve les SEPT jours, dont celui d'aujourd'hui — que le test ne
       connaît pas et n'a pas besoin de connaître. */
    const resolveur = createResolveurTemporel(db);
    for (let jour = 1; jour <= 7; jour++) {
      const r = await resolveur.resoudre({ base: 'JOUR_SEMAINE', jourSemaine: jour, heure: 9, minute: 0 });
      expect(r.ok, `jour ${String(jour)}`).toBe(true);
      if (!r.ok) continue;

      /* ⚠ ON COMPARE DES JOURS, PAS DES INSTANTS — ET C'EST UN SABOTAGE QUI
         L'A IMPOSÉ.

         La première version demandait `iso > clock_timestamp()`. Elle est
         restée VERTE en remplaçant la formule par un `% 7` nu — c'est-à-dire
         avec le défaut exact qu'elle devait attraper : le jour d'aujourd'hui
         donnait alors 9 h CE MATIN, et comme le test tournait à 8 h, 9 h était
         encore dans le futur.

         Un test qui ne dit vrai qu'avant 9 h du matin est le motif déjà
         recensé en `docs/26 §2.6` — « un test qui ne passait que 23 heures sur
         24 ». La propriété voulue n'a jamais été « plus tard dans la journée »
         mais **un autre jour**, et elle s'écrit ainsi. */
      const plusTard = await db.query<{ jourSuivant: boolean }>(
        `SELECT (date_trunc('day', $1::timestamptz)
                 > date_trunc('day', clock_timestamp())) AS "jourSuivant"`,
        [r.value.iso],
      );
      expect(plusTard.ok).toBe(true);
      if (!plusTard.ok) continue;
      expect(
        plusTard.value.rows[0]?.jourSuivant,
        `jour ${String(jour)} : ${r.value.humain} n'est pas un jour ULTÉRIEUR`,
      ).toBe(true);
    }
  });

  it('« dans N » part de MAINTENANT, pas du début de journée', async () => {
    const resolveur = createResolveurTemporel(db);
    const r = await resolveur.resoudre({ base: 'DANS_N_MINUTES', minutes: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const ecart = await db.query<{ minutes: string }>(
      `SELECT round(EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) / 60)::text
              AS minutes`,
      [r.value.iso],
    );
    expect(ecart.ok).toBe(true);
    if (!ecart.ok) return;
    expect(Number(ecart.value.rows[0]?.minutes)).toBe(30);
  });

  it('la chaîne COMPLÈTE : « jeudi à 14h » devient un instant à 14 h', async () => {
    const lu = reconnaitre('jeudi à 14h');
    expect(lu).not.toBeNull();
    if (lu === null) return;
    const r = await createResolveurTemporel(db).resoudre(lu.expression);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // L'heure LOCALE demandée est 14 h ; l'ISO est en UTC. On vérifie donc que
    // la forme lisible — celle que l'utilisateur relit — porte bien 14:00.
    expect(lu.reste).toBe('');
    expect(r.value.humain).toContain('à 14:00');
  });

  it('la BASE honore les minutes — bout en bout', async () => {
    const lu = reconnaitre('jeudi à 8h30');
    expect(lu).not.toBeNull();
    if (lu === null) return;
    const r = await createResolveurTemporel(db).resoudre(lu.expression);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // La forme LISIBLE est celle que l'utilisateur relit : elle doit dire 08:30.
    expect(r.value.humain).toContain('à 08:30');
  });

  it('l’heure seule ne tombe JAMAIS dans le passé', async () => {
    /* Éprouvé sur les VINGT-QUATRE heures, dont celle qu'il est — que le test
       ne connaît pas et n'a pas besoin de connaître. C'est la base qui tranche
       entre aujourd'hui et demain. */
    const resolveur = createResolveurTemporel(db);
    for (let h = 0; h < 24; h++) {
      const r = await resolveur.resoudre({ base: 'HEURE_SEULE', heure: h, minute: 0 });
      expect(r.ok, `heure ${String(h)}`).toBe(true);
      if (!r.ok) continue;
      const futur = await db.query<{ futur: boolean }>(
        'SELECT ($1::timestamptz > clock_timestamp()) AS futur',
        [r.value.iso],
      );
      expect(futur.ok && futur.value.rows[0]?.futur, `${String(h)} h → ${r.value.humain}`).toBe(
        true,
      );
    }
  });

  it('AUCUNE HORLOGE DE PROCESSUS dans le résolveur non plus', () => {
    /* Le module PEUT appeler `clock_timestamp()` ET porter un repli en
       JavaScript. Seule la lecture de la source l'exclut. */
    const source = readFileSync('src/core/temps/resolution.ts', 'utf8');
    expect(source).not.toContain('new Date');
    expect(source).not.toContain('Date.now');
    // Et il demande bien l'heure à la base, dans la forme qui ne fige pas.
    expect(source).toContain('clock_timestamp()');
    expect(source).not.toMatch(/\bnow\(\)/u);
  });

  it('AUCUNE INTERPOLATION de valeur utilisateur dans le SQL', () => {
    /* Les entiers partent en PARAMÈTRES. Une concaténation dans du SQL est une
       porte, même quand la valeur vient d'un type borné : le type peut changer,
       la porte reste. */
    const source = readFileSync('src/core/temps/resolution.ts', 'utf8');
    expect(source).toContain('make_interval');
    // Aucun `${expr.` — le seul `${}` autorisé est le fragment SQL figé `jour`.
    expect(source).not.toMatch(/\$\{expr\./u);
  });
});
