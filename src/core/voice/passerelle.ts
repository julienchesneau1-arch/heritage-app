/**
 * LA PASSERELLE AUDIO ABSTRAITE — ADR-103.
 *
 * Livrable de la Phase 5 (`docs/02`), et **le seul de cette phase qui s'écrit
 * et se PROUVE sans matériel**. Les cinq autres — VAD, mot d'activation, STT,
 * TTS, barge-in — demandent du son. La substituabilité, non :
 *
 *   > Porte de sortie, `docs/02` : *« Le pipeline audio est substituable
 *   >  (test : changer de moteur STT par configuration seule). »*
 *
 * C'est une propriété de **forme**. Elle se cloue à froid, et c'est le bon
 * moment : une fois qu'un moteur marche, personne ne casse l'assemblage qui
 * marche pour vérifier qu'on pouvait en changer.
 *
 * ⚠ CE FICHIER NE NOMME AUCUN MOTEUR — et ce n'est pas une coquetterie
 * ---------------------------------------------------------------------------
 * ADR-003 / invariant I6 : *le noyau ne connaît aucun fournisseur.* Il n'existe
 * ici ni `WHISPER`, ni `PIPER`, ni énumération de produits. Le noyau connaît un
 * **identifiant de moteur**, qui est une chaîne venue de la configuration, et
 * un registre — vivant dans `src/providers/` — sait ce qu'elle désigne.
 *
 * Un `z.enum(['WHISPER_CPP', 'PARAKEET'])` ici aurait été bien plus agréable à
 * écrire. Il aurait aussi rendu la porte de sortie fausse : « changer de moteur
 * par configuration seule » deviendrait « changer de moteur par configuration
 * ET par modification du noyau ». Un test le vérifie sur ce fichier.
 *
 * ⚠ ET IL NE FAIT AUCUNE ENTRÉE-SORTIE AUDIO
 * ---------------------------------------------------------------------------
 * Il n'ouvre pas de périphérique, ne lit pas de flux, ne décode rien. Il
 * ASSEMBLE : il choisit les moteurs d'après la configuration, et il tient les
 * deux règles de sûreté qu'ADR-093 avait écrites sans pouvoir les brancher.
 *
 * ```text
 * R1   rien ne sort du tampon avant le mot d'activation   → `transcrire`
 * R3   une phrase non sollicitée ne révèle pas tout       → `dire`
 * ```
 *
 * `micro.ts` disait : *« le jour où le code audio existera, c'est cette
 * fonction qui devra garder l'écriture — et non un commentaire demandant de
 * faire attention. »* C'est ce jour-là pour R1 : `transcrire` prend l'`EtatMicro`
 * en paramètre et refuse tout ce qui n'est pas `TRANSCRIT`. Un appelant ne peut
 * pas transcrire un tampon sans affirmer l'état — et cet état est **le même**
 * que celui dont le témoin est dérivé.
 */
import { z } from 'zod';
import type {
  SynthesisProvider,
  TranscriptionProvider,
  TranscriptionResult,
} from '../../providers/contract.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import type { DataLevel, Provenance } from '../types/domain.js';
import { sortDuTampon, type EtatMicro } from './micro.js';
import { faconDeDire, type Declencheur, type FaconDeDire } from './plafond.js';

/* -------------------------------------------------------------------------- */
/* Les licences — ADR-009 comme MÉCANISME, pas comme liste noire              */
/* -------------------------------------------------------------------------- */

/**
 * Les licences qu'un moteur peut déclarer.
 *
 * ⚠ CE N'EST PAS UNE LISTE DE PRODUITS. Une licence n'est pas un fournisseur :
 * l'énumérer ici ne recrée pas le couplage qu'ADR-003 interdit.
 *
 * ADR-009 dit : *« la licence est un critère de sélection, pas une note de bas
 * de page »*, et exclut XTTS v2 (CPML, usage commercial interdit). La manière
 * évidente de tenir cette décision aurait été d'écrire `'XTTS'` dans une liste
 * noire quelque part.
 *
 * **On ne l'a pas fait, et c'est le point de ce bloc.** Une liste noire d'un
 * nom protège contre ce nom-là. Elle ne dit rien du prochain modèle sous
 * licence non commerciale, qui arrivera et qu'on intégrera sans y penser —
 * exactement le « silencieux » qu'ADR-009 nomme dans son contexte.
 *
 * Un moteur déclare donc sa licence, et le registre refuse celles qui ne sont
 * pas permissives. La règle vaut pour tout ce qui viendra, pas pour ce qu'on
 * connaissait le jour où on l'a écrite.
 */
export const LicenceDeMoteur = z.enum([
  'APACHE_2_0',
  'MIT',
  'BSD_3_CLAUSE',
  'MPL_2_0',
  'CC0',
  /** Toute licence interdisant ou restreignant l'usage commercial. */
  'NON_COMMERCIALE',
  /** Licence inconnue ou non vérifiée. Traitée comme un refus. */
  'INDETERMINEE',
]);
export type LicenceDeMoteur = z.infer<typeof LicenceDeMoteur>;

const PERMISSIVES: ReadonlySet<LicenceDeMoteur> = new Set<LicenceDeMoteur>([
  'APACHE_2_0',
  'MIT',
  'BSD_3_CLAUSE',
  'MPL_2_0',
  'CC0',
]);

/**
 * Cette licence autorise-t-elle l'intégration ?
 *
 * ⚠ ÉCRITE EN ENSEMBLE EXPLICITE, PAS EN `!== 'NON_COMMERCIALE'`. La négation
 * serait ouverte par défaut : une licence ajoutée demain à l'énumération serait
 * permissive sans que personne ne l'ait décidé. C'est le défaut qu'ADR-101 a
 * corrigé sur `Surface`, et il se reproduit partout où l'on teste ce qu'on
 * refuse plutôt que ce qu'on accepte.
 */
export function licenceEstPermissive(licence: LicenceDeMoteur): boolean {
  return PERMISSIVES.has(licence);
}

/* -------------------------------------------------------------------------- */
/* Ce qu'un moteur déclare, et ce que le registre en fait                      */
/* -------------------------------------------------------------------------- */

/**
 * Un moteur enregistré, vu par le noyau.
 *
 * ⚠ `licence` et `local` sont DÉCLARÉS, pas vérifiés — même réserve que
 * `capabilities.local` en `docs/26 §4.9`. Un adaptateur qui mentirait sur sa
 * licence passerait ; un adaptateur qui mentirait sur `local` ferait sortir de
 * la voix de la machine.
 *
 * Ce que cette structure obtient n'est donc pas une garantie : c'est que la
 * question soit **posée à l'enregistrement**, par écrit, plutôt qu'oubliée. Un
 * champ obligatoire ne se remplit pas par distraction.
 */
export interface MoteurDeclare<P> {
  /** L'identifiant que la configuration nomme. */
  readonly id: string;
  readonly licence: LicenceDeMoteur;
  /** Le moteur tourne-t-il sur la machine ? `docs/02` : STT hors réseau. */
  readonly local: boolean;
  /** Construit l'adaptateur. Appelée une fois, au démarrage. */
  readonly construire: () => Result<P>;
}

export type RegistreSTT = readonly MoteurDeclare<TranscriptionProvider>[];
export type RegistreTTS = readonly MoteurDeclare<SynthesisProvider>[];

/** Ce que la configuration dit de la voix. Rien de plus, rien de moins. */
export interface ConfigVoix {
  readonly enabled: boolean;
  readonly stt: { readonly moteur: string; readonly langue: string };
  readonly tts: { readonly moteur: string; readonly voix: string };
}

/* -------------------------------------------------------------------------- */
/* Ce que la passerelle rend                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Le résultat d'une demande de parole.
 *
 * ⚠ `A_RESUMER` N'EST PAS UN ÉCHEC, ET LA PASSERELLE NE RÉSUME PAS.
 *
 * `plafond.ts` le dit de lui-même : *« elle décide de la FAÇON, pas du TEXTE.
 * Le résumé est produit par un modèle, donc lui-même non fiable. »* Une
 * passerelle qui fabriquerait le résumé ferait deux choses fausses d'un coup :
 * elle produirait du texte sans passer par le Policy Gate, et elle laisserait
 * croire qu'un résumé « nettoie » un contenu hostile (`docs/13`).
 *
 * Elle rend donc une INSTRUCTION à l'appelant, qui a un modèle et un Gate.
 */
export type Prononciation =
  | { readonly kind: 'PRONONCE'; readonly audio: Uint8Array }
  /** Contenu non fiable : à reformuler et à attribuer avant d'être dit. */
  | { readonly kind: 'A_RESUMER' }
  /**
   * Le plafond refuse la parole. Jarvis dit que l'information existe, et
   * l'AFFICHE.
   *
   * ⚠ Cette branche suppose un écran où se rabattre. Sur une surface portée,
   * elle n'en a pas — `docs/26 §4.19`, arbitrage non pris.
   */
  | { readonly kind: 'NON_PRONONCE'; readonly facon: FaconDeDire };

export interface DemandeDeParole {
  readonly texte: string;
  readonly niveau: DataLevel;
  readonly provenance: Provenance;
  readonly declencheur: Declencheur;
}

/**
 * La passerelle audio.
 *
 * Les identifiants de moteur sont exposés **pour être affichés** — par
 * `system_status`, par un écran de réglages — jamais pour décider quoi que ce
 * soit. Aucun code de ce dépôt ne doit s'en servir dans un `if`.
 */
export interface PasserelleAudio {
  readonly moteurSTT: string;
  readonly moteurTTS: string;
  readonly langue: string;
  transcrire(
    etat: EtatMicro,
    audio: Uint8Array,
  ): Promise<Result<TranscriptionResult>>;
  dire(demande: DemandeDeParole): Promise<Result<Prononciation>>;
}

/**
 * L'état de la voix dans cet assemblage.
 *
 * ⚠ TROIS ÉTATS, ET LA FORME EST COPIÉE D'`EtatModeleLocal` (ADR-086)
 * VOLONTAIREMENT.
 *
 * ADR-086 avait trouvé `DESACTIVE` et `REFUSE` confondus dans un seul `null` :
 * un Ollama mal configuré produisait exactement le silence d'une absence de
 * modèle. La voix pose le même problème mot pour mot, et il aurait été absurde
 * de le redécouvrir un an plus tard dans un autre module.
 *
 * ```text
 * DESACTIVE   personne n'a demandé la voix        → normal, c'est le défaut
 * REFUSE      on l'a demandée, elle est refusée   → l'utilisateur DOIT savoir
 * CONFIGURE   les moteurs sont construits         → répondront-ils ? une sonde
 * ```
 *
 * ⚠ `CONFIGURE` ne veut pas dire « le micro marche ». Construire un adaptateur
 * ne valide pas un périphérique.
 */
export type EtatPasserelleAudio =
  | { readonly kind: 'DESACTIVE' }
  | { readonly kind: 'REFUSE'; readonly raison: string }
  | { readonly kind: 'CONFIGURE'; readonly passerelle: PasserelleAudio };

/* -------------------------------------------------------------------------- */
/* La sélection — par configuration SEULE                                     */
/* -------------------------------------------------------------------------- */

/**
 * Choisit un moteur dans un registre, d'après un identifiant de configuration.
 *
 * ⚠ LE MESSAGE DE REFUS LISTE CE QUI EXISTE, et c'est la moitié de son intérêt.
 * « moteur inconnu » envoie chercher une faute de frappe dans un fichier ;
 * « moteur "wisper" inconnu — enregistrés : whisper-cpp » la montre.
 */
function choisir<P>(
  registre: readonly MoteurDeclare<P>[],
  demande: string,
  role: string,
): Result<{ readonly declare: MoteurDeclare<P>; readonly provider: P }> {
  if (registre.length === 0) {
    return err(
      jarvisError(
        'CONFIGURATION',
        `Aucun moteur ${role} n'est installé. La voix demande un moteur ; ce dépôt n'en embarque aucun.`,
        { role },
      ),
    );
  }

  const declare = registre.find((m) => m.id === demande);
  if (declare === undefined) {
    const connus = registre.map((m) => m.id).join(', ');
    return err(
      jarvisError(
        'CONFIGURATION',
        `Moteur ${role} « ${demande} » inconnu. Enregistrés : ${connus}.`,
        { role, demande },
      ),
    );
  }

  /* LA LICENCE EST UN CRITÈRE DE SÉLECTION — ADR-009, appliqué ici et pas
     dans une revue de code. Un moteur non permissif est refusé même s'il est
     installé, nommé dans la configuration et fonctionnel. */
  if (!licenceEstPermissive(declare.licence)) {
    return err(
      jarvisError(
        'CONFIGURATION',
        `Moteur ${role} « ${demande} » refusé : licence ${declare.licence}. `
          + `ADR-009 n'intègre que des licences permissives — hériter d'une `
          + `restriction d'usage au cœur du produit est une impasse silencieuse.`,
        { role, demande, licence: declare.licence },
      ),
    );
  }

  const construit = declare.construire();
  if (!construit.ok) return err(construit.error);
  return ok({ declare, provider: construit.value });
}

/**
 * Construit la passerelle audio à partir de la configuration et des registres.
 *
 * ⚠ C'EST LA SEULE FONCTION QUI LIE UN IDENTIFIANT À UN MOTEUR, et elle ne
 * contient aucun nom de produit. Changer de moteur STT, c'est changer une
 * chaîne dans `config/` — pas une ligne de ce fichier.
 */
export function creerPasserelleAudio(
  config: ConfigVoix,
  registres: { readonly stt: RegistreSTT; readonly tts: RegistreTTS },
): EtatPasserelleAudio {
  if (!config.enabled) return { kind: 'DESACTIVE' };

  const stt = choisir(registres.stt, config.stt.moteur, 'STT');
  if (!stt.ok) return { kind: 'REFUSE', raison: stt.error.message };

  const tts = choisir(registres.tts, config.tts.moteur, 'TTS');
  if (!tts.ok) return { kind: 'REFUSE', raison: tts.error.message };

  /* `docs/02` : « STT fonctionnel réseau coupé ». Un moteur STT distant ne
     rendrait pas cette porte de sortie franchissable — et surtout, il ferait
     partir chaque énoncé de la maison. C'est la même règle qu'ADR-082 pour le
     modèle local : refusé au démarrage, pas signalé à l'usage. */
  if (!stt.value.declare.local) {
    return {
      kind: 'REFUSE',
      raison:
        `Moteur STT « ${config.stt.moteur} » refusé : il n'est pas local. `
        + `Toute parole captée sortirait de la machine, et « STT fonctionnel `
        + `réseau coupé » cesserait d'être vrai.`,
    };
  }

  return {
    kind: 'CONFIGURE',
    passerelle: passerelle(config, stt.value.provider, tts.value.provider),
  };
}

function passerelle(
  config: ConfigVoix,
  transcription: TranscriptionProvider,
  synthese: SynthesisProvider,
): PasserelleAudio {
  return {
    moteurSTT: config.stt.moteur,
    moteurTTS: config.tts.moteur,
    langue: config.stt.langue,

    async transcrire(etat, audio) {
      /* ⚠ R1, ET C'EST ICI QU'ELLE DEVIENT DU CODE.

         `micro.ts` : « rien de ce qui précède le mot d'activation n'existe ».
         La garde ne peut pas être dans l'appelant : l'appelant est précisément
         celui qui tient le tampon circulaire et qui serait tenté de le vider
         « juste pour voir ».

         L'état est passé en paramètre plutôt que mémorisé ici, pour qu'il
         n'existe qu'UN registre de « est-ce que ça écoute » (ADR-041). Celui
         dont le témoin est dérivé. */
      if (!sortDuTampon(etat)) {
        return err(
          jarvisError(
            'POLICY_DENIED',
            `Micro à l'état ${etat} : rien ne quitte le tampon avant le mot d'activation.`,
            { etat },
          ),
        );
      }
      if (audio.length === 0) {
        return err(jarvisError('VALIDATION', 'Aucun audio à transcrire.'));
      }
      return transcription.transcribe({ audio, language: config.stt.langue });
    },

    async dire(demande) {
      /* R3 — et la règle d'injection par l'oreille avec elle. */
      const facon = faconDeDire(
        demande.niveau,
        demande.provenance,
        demande.declencheur,
      );
      if (facon === 'REFUS') return ok({ kind: 'NON_PRONONCE', facon });
      if (facon === 'RESUME_ENCADRE') return ok({ kind: 'A_RESUMER' });

      const audio = await synthese.synthesize(demande.texte, config.tts.voix);
      /* ⚠ AUCUN REPLI VERS « DIRE QUAND MÊME ». Une synthèse en échec rend une
         erreur ; elle ne rend jamais un silence qu'un appelant pressé lirait
         comme un succès. Règle 3 de `CLAUDE.md` : jamais de succès non
         vérifié. */
      if (!audio.ok) return err(audio.error);
      return ok({ kind: 'PRONONCE', audio: audio.value });
    },
  };
}
