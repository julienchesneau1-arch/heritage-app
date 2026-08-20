/**
 * Porte de sortie Phase 7 — vérification exécutable.
 *
 * Les trois conditions de `docs/02` :
 *
 * ```text
 * [ ] Une mise à jour volontairement défectueuse est bloquée avant la production.
 * [ ] Le rollback automatique se déclenche sur régression d'une métrique critique.
 * [ ] Le LAB n'a AUCUN accès aux secrets de production.
 * ```
 *
 * ⚠ CETTE PORTE ÉPROUVE LA DÉCISION, PAS L'EXÉCUTION — ET C'EST ÉNORME
 * ---------------------------------------------------------------------------
 * `docs/07` décrit douze étapes. Le dépôt en implémente **une** : celle qui
 * décide. Franchir cette porte signifie donc quelque chose de précis, et de
 * beaucoup plus étroit que « Jarvis sait se mettre à jour » :
 *
 * ```text
 * ÉPROUVÉ       une version défectueuse reçoit REFUSER
 *               une régression critique reçoit ROLLBACK
 *               le coffre du LAB ne rend aucun secret réel
 *
 * NON ÉPROUVÉ   qu'une signature soit réellement vérifiée (TUF/Sigstore, §4)
 *               qu'une promotion refusée soit réellement empêchée d'installer
 *               qu'un rollback décidé soit réellement exécuté (§9)
 *               le canary sur trafic réel (§8)
 *               les backups et la reprise après sinistre (§11, §12)
 * ```
 *
 * C'est la distinction que `docs/26 §4.10` fait déjà pour l'annulation :
 * **vrai au sens de la DÉCISION, faux au sens de l'ACTION.** La porte imprime
 * cette réserve à chaque exécution — une limite qu'il faut aller chercher dans
 * un fichier n'est pas une limite déclarée (ADR-087).
 *
 * ⚠ ET LA CONSÉQUENCE LA PLUS IMPORTANTE : aucun appelant ne peut aujourd'hui
 * produire honnêtement `signature: 'VERIFIEE'`, faute de vérificateur. Le
 * système refuse donc **toute** mise à jour. C'est le bon état par défaut, et
 * il est délibéré — pas un effet de bord du travail inachevé.
 */
import { execFileSync } from 'node:child_process';
import { deciderPromotion } from '../../src/core/update/promotion.js';
import { surveiller } from '../../src/core/update/surveillance.js';
import { coffreEstPrive, createLabVault } from '../../src/core/update/lab.js';
import { createEnvSecretVault } from '../../src/core/secrets/vault.js';
import type { Candidat, Mesures } from '../../src/core/update/candidat.js';
import type { Metriques } from '../../src/core/update/surveillance.js';

interface Check {
  readonly id: string;
  readonly label: string;
  run(): Promise<boolean> | boolean;
}

function runCommand(command: string, args: readonly string[]): boolean {
  try {
    execFileSync(command, [...args], { stdio: 'pipe', env: process.env });
    return true;
  } catch {
    return false;
  }
}

const MESURES_PARFAITES: Mesures = {
  testsCritiques: 1,
  testsSecurite: 1,
  testsPolitique: 1,
  regressions: 0,
  qualite: 0.92,
  qualiteReference: 0.9,
  latenceMs: 800,
  latenceSeuilMs: 1200,
  integriteMemoire: true,
  fausseConfirmation: 0,
};

const SAINE: Candidat = {
  version: '1.0.1',
  canal: 'STABLE',
  signature: 'VERIFIEE',
  portees: ['DEPENDANCE'],
  mesures: MESURES_PARFAITES,
};

const REFERENCE: Metriques = {
  appels: 5000,
  tauxSucces: 0.9,
  tauxVerification: 0.95,
  latenceP95Ms: 900,
  coutEur: 0,
  tauxClarification: 0.12,
  erreursOutils: 3,
  tauxFausseConfirmation: 0,
};

/** Les noms de secrets RÉELLEMENT utilisés par le produit. */
const SECRETS_REELS = [
  'JARVIS_GOOGLE_CLIENT_ID',
  'JARVIS_GOOGLE_CLIENT_SECRET',
  'JARVIS_GOOGLE_REFRESH_TOKEN',
  'JARVIS_DB_PASSWORD',
];

const checks: readonly Check[] = [
  {
    id: 'G7.1',
    label: 'Une mise à jour volontairement défectueuse est BLOQUÉE',
    run() {
      /* Elle cumule tout ce qu'une mise à jour hostile aurait de plausible :
         le canal le plus pressant, aucune signature, des portées sensibles, et
         des mesures dégradées. Chaque défaut suffirait seul. */
      const defectueuse: Candidat = {
        version: '9.9.9',
        canal: 'SECURITY',
        signature: 'ABSENTE',
        portees: ['POLITIQUE_SECURITE', 'MODELE_PERMISSIONS'],
        mesures: {
          ...MESURES_PARFAITES,
          testsSecurite: 0.5,
          fausseConfirmation: 3,
          integriteMemoire: false,
        },
      };
      const v = deciderPromotion(defectueuse);
      if (v.kind !== 'REFUSER') return false;

      /* L'urgence ne rachète rien : le même artefact, signé « SECURITY » et
         rien d'autre, reste refusé. */
      const urgente = deciderPromotion({
        ...SAINE,
        canal: 'SECURITY',
        signature: 'ABSENTE',
      });
      return urgente.kind === 'REFUSER';
    },
  },
  {
    id: 'G7.2',
    label: 'Et une version SAINE est promue — sans quoi le contrôle précédent est vide',
    run() {
      /* ⚠ LE CONTRÔLE NÉGATIF. Un moteur qui refuserait tout passerait G7.1
         parfaitement, et la porte certifierait un système incapable de se
         mettre à jour comme s'il était prudent. */
      return deciderPromotion(SAINE).kind === 'PROMOUVOIR';
    },
  },
  {
    id: 'G7.3',
    label: 'Ce qui touche §3 exige un HUMAIN, même tout vert',
    run() {
      const v = deciderPromotion({ ...SAINE, portees: ['POLITIQUE_SECURITE'] });
      if (v.kind !== 'DECISION_HUMAINE_REQUISE') return false;

      /* Et l'ordre : un défaut refuse AVANT qu'on dérange l'humain. Lui
         demander d'approuver une version défectueuse reviendrait à lui faire
         couvrir un défaut que la machine a déjà vu. */
      const defectueuseEtSensible = deciderPromotion({
        ...SAINE,
        portees: ['POLITIQUE_SECURITE'],
        mesures: { ...MESURES_PARFAITES, testsSecurite: 0.9 },
      });
      return defectueuseEtSensible.kind === 'REFUSER';
    },
  },
  {
    id: 'G7.4',
    label: 'Le rollback automatique se déclenche sur régression critique',
    run() {
      const courant: Metriques = { ...REFERENCE, appels: 500, tauxVerification: 0.6 };
      if (surveiller(REFERENCE, courant).kind !== 'ROLLBACK') return false;

      /* Une seule fausse confirmation suffit — aucune tolérance. */
      const menteuse: Metriques = {
        ...REFERENCE,
        appels: 500,
        tauxFausseConfirmation: 0.001,
      };
      return surveiller(REFERENCE, menteuse).kind === 'ROLLBACK';
    },
  },
  {
    id: 'G7.5',
    label: 'Il ne se déclenche PAS sur du bruit, ni sur un échantillon insuffisant',
    run() {
      /* Deux façons de rendre le rollback inutile : ne jamais se déclencher, ou
         se déclencher tout le temps. La seconde se paie en confiance, et un
         mécanisme auquel personne ne croit est un mécanisme désactivé. */
      const bruit: Metriques = { ...REFERENCE, appels: 500, tauxSucces: 0.891 };
      if (surveiller(REFERENCE, bruit).kind !== 'RIEN') return false;

      /* Et « trop tôt pour dire » n'est jamais « tout va bien ». */
      const minuscule: Metriques = { ...REFERENCE, appels: 3, tauxSucces: 0.66 };
      return surveiller(REFERENCE, minuscule).kind === 'INSUFFISANT';
    },
  },
  {
    id: 'G7.6',
    label: 'Le LAB n\'a AUCUN accès aux secrets de production',
    run() {
      const prive = coffreEstPrive(createLabVault(), SECRETS_REELS);
      if (!prive.ok) return false;

      /* ⚠ ET LE CONTRÔLE NÉGATIF, SANS LEQUEL LE PRÉCÉDENT NE PROUVE RIEN.

         Un coffre PORTANT réellement ces secrets doit être refusé. Sans cette
         moitié, le contrôle passerait aussi dans un environnement vide — où
         tout coffre, y compris celui de production, refuse faute de matière. */
      const production = createEnvSecretVault({
        JARVIS_GOOGLE_CLIENT_ID: 'identifiant',
        JARVIS_GOOGLE_CLIENT_SECRET: 'secret',
        JARVIS_GOOGLE_REFRESH_TOKEN: 'jeton',
        JARVIS_DB_PASSWORD: 'motdepasse',
      });
      return !coffreEstPrive(production, SECRETS_REELS).ok;
    },
  },
  {
    id: 'G7.7',
    label: 'Tests de l\'Update Engine passent',
    run() {
      return runCommand('pnpm', ['vitest', 'run', 'tests/update']);
    },
  },
  {
    id: 'G7.8',
    label: 'Les Phases 0 à 3 restent franchies (aucune régression)',
    run() {
      /* ⚠ ON N'APPELLE QUE LA PORTE 3, ET C'EST SUFFISANT.

         Sa propre condition G3.5 chaîne déjà les portes 0, 1 et 2. Les
         rappeler ici les exécuterait DEUX fois — ce qui n'ajoute aucune
         garantie et faisait dépasser le délai d'exécution.

         Mesuré, pas supposé : la première rédaction listait les quatre, et le
         contrôle n'aboutissait pas. Une porte qui n'a pas le temps de rendre
         son verdict ne garde rien. */
      return runCommand('pnpm', ['gate:phase3']);
    },
  },
];

async function main(): Promise<void> {
  console.log('\n  PORTE DE SORTIE — PHASE 7 (couche de DÉCISION)\n');

  let failures = 0;
  for (const check of checks) {
    process.stdout.write(`  ${check.id.padEnd(6)} ${check.label} … `);
    let passed = false;
    try {
      passed = await check.run();
    } catch {
      passed = false;
    }
    console.log(passed ? 'OK' : 'ÉCHEC');
    if (!passed) failures += 1;
  }

  console.log('');
  if (failures > 0) {
    console.log(`  ✗ ${String(failures)} contrôle(s) en échec.\n`);
    process.exit(1);
  }

  console.log('  ✓ La couche de DÉCISION de l\'Update Engine tient.\n');
  console.log('  ⚠ CE QUE CETTE PORTE NE DIT PAS — et il faut le lire :');
  console.log('');
  console.log('    La Phase 7 n\'est PAS franchie. Sont éprouvées les trois');
  console.log('    DÉCISIONS de `docs/02` ; ne le sont pas les EXÉCUTIONS :');
  console.log('');
  console.log('      · vérification de signature réelle (TUF/Sigstore, §4)');
  console.log('      · installation, promotion, retrait effectifs (§1)');
  console.log('      · canary sur trafic réel (§8)');
  console.log('      · backups et reprise après sinistre (§11, §12)');
  console.log('');
  console.log('    Conséquence assumée : aucun appelant ne peut produire');
  console.log('    `signature: VERIFIEE` honnêtement, donc TOUTE mise à jour');
  console.log('    est refusée aujourd\'hui. C\'est le bon état par défaut.\n');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('Vérification interrompue :', error);
  process.exit(1);
});
