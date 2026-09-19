/**
 * LE REGISTRE DES MOTEURS AUDIO — le seul endroit où un moteur a un nom.
 *
 * ADR-103. `src/providers/**` est la seule zone du dépôt où un produit peut
 * être nommé (ADR-003 / I6), et c'est ici que la configuration
 * `voice.stt.moteur = "whisper-cpp"` rencontre le code qui sait ce que ça veut
 * dire.
 *
 * ⚠ LES DEUX REGISTRES SONT VIDES, ET C'EST L'ÉTAT EXACT DU DÉPÔT
 * ---------------------------------------------------------------------------
 * Il n'existe pas une ligne de code audio dans Jarvis. Pas de `whisper.cpp`,
 * pas de Piper, pas de liaison native, pas de périphérique ouvert. Les deux
 * tableaux ci-dessous sont donc vides — **pas en attendant mieux : parce que
 * c'est vrai.**
 *
 * Ce que cette absence produit est visible et dit : `creerPasserelleAudio`
 * rend `REFUSE` avec la phrase *« Aucun moteur STT n'est installé »* dès que
 * `voice.enabled` passe à `true`. C'est la leçon d'ADR-086 : une capacité
 * demandée et absente doit se DIRE, là où l'ancien `null` se taisait.
 *
 * ⚠ CE QU'IL FAUDRA ÉCRIRE ICI, ET DANS QUEL ORDRE
 * ---------------------------------------------------------------------------
 * ```text
 * 1. un adaptateur STT LOCAL      ADR-008 — Whisper, pour le français
 * 2. un adaptateur TTS permissif  ADR-009 — Piper ou Kokoro, jamais XTTS
 * ```
 *
 * Et chacun devra remplir la fiche de `docs/04` avant d'exister : un moteur
 * audio est une dépendance, même livrée en binaire, même locale.
 *
 * ⚠ LA LICENCE SE DÉCLARE, ELLE NE SE DEVINE PAS. Le champ `licence` est
 * obligatoire, et `INDETERMINEE` est un refus — pas une valeur par défaut
 * commode. Un moteur dont personne n'a vérifié la licence ne s'intègre pas ;
 * c'est exactement ce qu'ADR-009 appelle « une impasse silencieuse ».
 */
import type {
  RegistreSTT,
  RegistreTTS,
} from '../../core/voice/passerelle.js';

/**
 * Les moteurs de transcription installés.
 *
 * Vide. Voir l'en-tête : ce n'est pas un oubli, c'est l'état du dépôt.
 */
export const REGISTRE_STT: RegistreSTT = [];

/** Les moteurs de synthèse installés. Vide, pour la même raison. */
export const REGISTRE_TTS: RegistreTTS = [];
