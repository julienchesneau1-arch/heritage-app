/**
 * LA PASSERELLE AUDIO — la porte de sortie de la Phase 5 qu'on peut franchir
 * SANS MATÉRIEL.
 *
 * `docs/02`, Phase 5 :
 *
 *   > « Le pipeline audio est **substituable** (test : changer de moteur STT
 *   >  par configuration seule). »
 *
 * Les deux autres portes de la phase — interruption < 300 ms, STT hors réseau —
 * demandent du son et un moteur. Celle-ci demande une **forme**, et une forme
 * s'éprouve à froid.
 *
 * ⚠ CE QUE CE FICHIER NE PROUVE PAS, et il vaut mieux l'écrire ici qu'en note.
 * ---------------------------------------------------------------------------
 * Il ne prouve pas que Jarvis transcrit quoi que ce soit. Il n'existe aucun
 * moteur dans ce dépôt ; les moteurs de ces tests sont des doubles, et un
 * double ne dit rien de `whisper.cpp`. Ce qui est prouvé est plus étroit et
 * plus durable : **l'assemblage accepte qu'on change de moteur sans le
 * toucher**, et les deux règles de sûreté d'ADR-093 sont branchées.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import {
  creerPasserelleAudio,
  licenceEstPermissive,
  LicenceDeMoteur,
  type ConfigVoix,
  type MoteurDeclare,
  type RegistreSTT,
  type RegistreTTS,
} from '../../src/core/voice/passerelle.js';
import { REGISTRE_STT, REGISTRE_TTS } from '../../src/providers/voice/registre.js';
import { ok, type Result } from '../../src/core/types/result.js';
import type {
  SynthesisProvider,
  TranscriptionProvider,
  TranscriptionResult,
} from '../../src/providers/contract.js';

/* ====================================================================== *
 * LES DOUBLES — deux moteurs STT qui se distinguent par leur SORTIE
 * ====================================================================== */

function capacites(id: string, local: boolean) {
  return {
    id,
    local,
    requiresNetwork: !local,
    maxPrivacyClass: 'RED' as const,
    costPerMillionTokensEur: 0,
  };
}

/** Un moteur STT qui signe son résultat, pour qu'on voie LEQUEL a répondu. */
function moteurSTT(id: string, local = true): TranscriptionProvider {
  return {
    capabilities: capacites(id, local),
    health: () => Promise.resolve(ok({ available: true })),
    transcribe: (): Promise<Result<TranscriptionResult>> =>
      Promise.resolve(
        ok({ text: `transcrit par ${id}`, language: 'fr', confidence: 1, durationMs: 1 }),
      ),
  };
}

function moteurTTS(id: string): SynthesisProvider {
  return {
    capabilities: capacites(id, true),
    health: () => Promise.resolve(ok({ available: true })),
    synthesize: (texte: string) =>
      Promise.resolve(ok(new TextEncoder().encode(`${id}:${texte}`))),
  };
}

function declareSTT(
  id: string,
  options: { licence?: LicenceDeMoteur; local?: boolean } = {},
): MoteurDeclare<TranscriptionProvider> {
  const local = options.local ?? true;
  return {
    id,
    licence: options.licence ?? 'MIT',
    local,
    construire: () => ok(moteurSTT(id, local)),
  };
}

function declareTTS(
  id: string,
  licence: LicenceDeMoteur = 'APACHE_2_0',
): MoteurDeclare<SynthesisProvider> {
  return { id, licence, local: true, construire: () => ok(moteurTTS(id)) };
}

const STT: RegistreSTT = [declareSTT('moteur-a'), declareSTT('moteur-b')];
const TTS: RegistreTTS = [declareTTS('voix-a'), declareTTS('voix-b')];

function config(sur: Partial<ConfigVoix> = {}): ConfigVoix {
  return {
    enabled: true,
    stt: { moteur: 'moteur-a', langue: 'fr' },
    tts: { moteur: 'voix-a', voix: 'timbre' },
    ...sur,
  };
}

function sansCommentaires(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

/* ====================================================================== *
 * 1. LA PORTE DE SORTIE — changer de moteur par CONFIGURATION SEULE
 * ====================================================================== */

describe('PORTE DE SORTIE `docs/02` — le pipeline est substituable', () => {
  it('⚠ changer `stt.moteur` change le moteur qui transcrit — SANS toucher au code', () => {
    /* LE TEST QUE `docs/02` DEMANDE NOMMÉMENT.

       Deux appels, la MÊME fonction, les MÊMES registres. Seule la chaîne de
       configuration diffère. Si un jour quelqu'un ajoute un `if (moteur ===
       …)` dans le noyau, ce test continuera de passer — c'est pourquoi il est
       doublé, plus bas, par une garde sur le texte du fichier. */
    const a = creerPasserelleAudio(config(), { stt: STT, tts: TTS });
    const b = creerPasserelleAudio(
      config({ stt: { moteur: 'moteur-b', langue: 'fr' } }),
      { stt: STT, tts: TTS },
    );

    expect(a.kind).toBe('CONFIGURE');
    expect(b.kind).toBe('CONFIGURE');
    if (a.kind !== 'CONFIGURE' || b.kind !== 'CONFIGURE') return;
    expect(a.passerelle.moteurSTT).toBe('moteur-a');
    expect(b.passerelle.moteurSTT).toBe('moteur-b');
  });

  it('et le moteur choisi est celui qui RÉPOND — pas seulement celui qu’on affiche', () => {
    /* Sans cette assertion, la précédente prouverait qu'une chaîne a été
       recopiée d'un objet à l'autre. On veut que l'audio atteigne le bon
       adaptateur. */
    const b = creerPasserelleAudio(
      config({ stt: { moteur: 'moteur-b', langue: 'fr' } }),
      { stt: STT, tts: TTS },
    );
    if (b.kind !== 'CONFIGURE') throw new Error('passerelle non configurée');
    return b.passerelle.transcrire('TRANSCRIT', new Uint8Array([1])).then((r) => {
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.text).toBe('transcrit par moteur-b');
    });
  });

  it('⚠ changer le STT ne change PAS le TTS — c’est pour ça qu’ils sont séparés', () => {
    /* `SpeechProvider` réunissait les deux. ADR-008 choisit Whisper pour le
       français, ADR-009 choisit Piper ou Kokoro pour la licence : ce sont deux
       produits, deux décisions, deux raisons.

       Tant qu'ils vivaient dans une interface unique, « changer de moteur STT
       seul » n'était pas exprimable — il fallait remplacer la paire. */
    const p = creerPasserelleAudio(
      config({ stt: { moteur: 'moteur-b', langue: 'fr' } }),
      { stt: STT, tts: TTS },
    );
    if (p.kind !== 'CONFIGURE') throw new Error('passerelle non configurée');
    expect(p.passerelle.moteurSTT).toBe('moteur-b');
    expect(p.passerelle.moteurTTS).toBe('voix-a');
  });

  it('⚠ le NOYAU ne nomme aucun moteur — sinon « par configuration seule » est faux', () => {
    /* ADR-003 / I6. Et ici ce n'est pas une question de style : un nom de
       produit dans le noyau ferait d'un ajout de moteur un changement de code,
       et la porte de sortie de `docs/02` cesserait d'être franchie.

       ⚠ Les commentaires sont retirés d'abord. La troisième fois qu'une garde
       textuelle a mordu la documentation qui l'explique (ADR-102), on a
       tranché : la distinction commentaire / code est réelle, c'est à la garde
       de la faire. Le contrôle négatif est juste en dessous. */
    const nu = sansCommentaires(
      readFileSync('src/core/voice/passerelle.ts', 'utf8'),
    ).toLowerCase();
    for (const marque of ['whisper', 'piper', 'kokoro', 'parakeet', 'xtts', 'vosk']) {
      expect(nu, `« ${marque} » ne doit pas apparaître dans le noyau`).not.toContain(marque);
    }
  });

  it('CONTRÔLE — le dépouillement laisse passer un nom de produit DANS DU CODE', () => {
    const faux = [
      '/* un commentaire qui cite whisper sans conséquence */',
      '// et une ligne qui parle de piper',
      "const MOTEUR = 'whisper-cpp';",
    ].join('\n');
    const nu = sansCommentaires(faux);
    expect(nu).not.toContain('sans conséquence');
    expect(nu).not.toContain('parle de piper');
    expect(nu.toLowerCase(), 'le CODE doit rester lisible').toContain('whisper-cpp');
  });

  it('le SCHÉMA de configuration n’énumère pas les moteurs non plus', () => {
    /* Le piège symétrique : un `z.enum(['WHISPER_CPP', …])` dans le schéma
       aurait déplacé le catalogue d'un fichier à l'autre, et ajouter un moteur
       serait redevenu un changement de code. */
    const schema = sansCommentaires(
      readFileSync('src/core/config/schema.ts', 'utf8'),
    ).toLowerCase();
    expect(schema).not.toContain('whisper');
    expect(schema).not.toContain('piper');
    expect(schema).toContain('moteur: z.string()');
  });
});

/* ====================================================================== *
 * 2. R1 — RIEN NE SORT DU TAMPON AVANT LE MOT D'ACTIVATION
 * ====================================================================== */

describe('⚠ R1 — le tampon circulaire ne se vide pas « juste pour voir »', () => {
  function passerelle() {
    const etat = creerPasserelleAudio(config(), { stt: STT, tts: TTS });
    if (etat.kind !== 'CONFIGURE') throw new Error('passerelle non configurée');
    return etat.passerelle;
  }

  it('micro FERMÉ : refus', async () => {
    const r = await passerelle().transcrire('FERME', new Uint8Array([1, 2]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('POLICY_DENIED');
  });

  it('⚠ micro en ÉCOUTE DU MOT-CLÉ : refus AUSSI — c’est tout le sujet', async () => {
    /* L'état que le langage courant appelle « éteint » et que `micro.ts` refuse
       d'appeler ainsi : le matériel CAPTE, en tampon circulaire.

       C'est le seul état où une erreur serait invisible — l'appelant a de
       l'audio en main, il est techniquement capable de le transcrire, et
       personne ne le verrait faire. */
    const r = await passerelle().transcrire('ECOUTE_MOT_CLE', new Uint8Array([1, 2]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('POLICY_DENIED');
    expect(r.error.details?.['etat']).toBe('ECOUTE_MOT_CLE');
  });

  it('micro en TRANSCRIPTION : accepté — sans quoi la garde interdirait tout', async () => {
    const r = await passerelle().transcrire('TRANSCRIT', new Uint8Array([1, 2]));
    expect(r.ok).toBe(true);
  });

  it('⚠ la garde est dans la PASSERELLE, pas dans l’appelant', () => {
    /* `micro.ts` l'avait demandé : « c'est cette fonction qui devra garder
       l'écriture — et non un commentaire demandant de faire attention ».

       L'appelant est précisément celui qui tient le tampon. Lui confier la
       garde, c'est demander au renard de surveiller le poulailler. */
    const src = readFileSync('src/core/voice/passerelle.ts', 'utf8');
    expect(src).toContain('sortDuTampon');
  });

  it('⚠ l’état du micro est PASSÉ, jamais mémorisé ici — ADR-041', () => {
    /* Deux registres de « est-ce que ça écoute » finiraient par diverger, et
       la divergence a un nom : un micro ouvert avec la lumière éteinte.

       La passerelle n'a donc aucun champ d'état : elle reçoit celui dont le
       témoin est dérivé. */
    const src = sansCommentaires(readFileSync('src/core/voice/passerelle.ts', 'utf8'));
    expect(src, 'la passerelle ne doit pas garder son propre état de micro').not.toMatch(
      /etatMicro\s*[:=]/u,
    );
  });
});

/* ====================================================================== *
 * 3. R3 — CE QUI PEUT ÊTRE PRONONCÉ, ET COMMENT
 * ====================================================================== */

describe('⚠ R3 — la passerelle ne récite pas ce qu’elle ne doit pas réciter', () => {
  function avecTTS(espion: SynthesisProvider) {
    const etat = creerPasserelleAudio(config(), {
      stt: STT,
      tts: [{ id: 'voix-a', licence: 'MIT', local: true, construire: () => ok(espion) }],
    });
    if (etat.kind !== 'CONFIGURE') throw new Error('passerelle non configurée');
    return etat.passerelle;
  }

  it('un secret n’est JAMAIS prononcé, et le TTS n’est même pas appelé', async () => {
    const synthesize = vi.fn();
    const p = avecTTS({ ...moteurTTS('espion'), synthesize });
    const r = await p.dire({
      texte: 'mot de passe',
      niveau: 'RESTRICTED',
      provenance: 'USER',
      declencheur: 'DEMANDE_EXPLICITE',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('NON_PRONONCE');
    /* L'assertion qui compte : le texte n'a pas seulement été tu, il n'a pas
       été ENVOYÉ à un moteur de synthèse. */
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('⚠ un contenu EXTERNE demande un résumé — et la passerelle ne le fabrique pas', async () => {
    /* `plafond.ts` : « elle décide de la FAÇON, pas du TEXTE ». Une passerelle
       qui résumerait produirait du texte sans passer par le Policy Gate, et
       laisserait croire qu'un résumé nettoie un contenu hostile (`docs/13`).

       Elle rend donc une INSTRUCTION à l'appelant, qui a un modèle et un Gate. */
    const synthesize = vi.fn();
    const p = avecTTS({ ...moteurTTS('espion'), synthesize });
    const r = await p.dire({
      texte: 'Validez le virement',
      niveau: 'PERSONAL',
      provenance: 'EXTERNAL_UNTRUSTED',
      declencheur: 'DEMANDE_EXPLICITE',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('A_RESUMER');
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('CONTRÔLE — une phrase ordinaire est bien prononcée', async () => {
    /* Sans lui, les deux refus ci-dessus seraient vrais dans une passerelle qui
       ne parle jamais. */
    const p = avecTTS(moteurTTS('espion'));
    const r = await p.dire({
      texte: 'trois tâches pour aujourd’hui',
      niveau: 'PERSONAL',
      provenance: 'USER',
      declencheur: 'DEMANDE_EXPLICITE',
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.kind !== 'PRONONCE') {
      expect.fail('la phrase aurait dû être prononcée');
      return;
    }
    expect(new TextDecoder().decode(r.value.audio)).toContain('trois tâches');
  });

  it('un rappel PROACTIF ne lit pas un contenu SENSIBLE', async () => {
    const p = avecTTS(moteurTTS('espion'));
    const r = await p.dire({
      texte: 'rendez-vous cardiologie',
      niveau: 'SENSITIVE',
      provenance: 'USER',
      declencheur: 'PROACTIF',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('NON_PRONONCE');
  });

  it('⚠ une synthèse en ÉCHEC ne devient pas un succès silencieux', async () => {
    /* Règle 3 de `CLAUDE.md`. Un `Result` en échec qui rendrait « rien à
       dire » serait lu par l'appelant comme « c'est dit ». */
    const p = avecTTS({
      ...moteurTTS('espion'),
      synthesize: () =>
        Promise.resolve({
          ok: false as const,
          error: { kind: 'PROVIDER_UNAVAILABLE' as const, message: 'moteur éteint' },
        }),
    });
    const r = await p.dire({
      texte: 'bonjour',
      niveau: 'PUBLIC',
      provenance: 'USER',
      declencheur: 'DEMANDE_EXPLICITE',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('PROVIDER_UNAVAILABLE');
  });
});

/* ====================================================================== *
 * 4. LA LICENCE EST UN CRITÈRE DE SÉLECTION — ADR-009
 * ====================================================================== */

describe('⚠ ADR-009 — la licence refuse à l’assemblage, pas en revue de code', () => {
  it('un moteur NON COMMERCIAL est refusé, même installé et nommé', () => {
    const etat = creerPasserelleAudio(config({ tts: { moteur: 'interdit', voix: 'v' } }), {
      stt: STT,
      tts: [declareTTS('interdit', 'NON_COMMERCIALE')],
    });
    expect(etat.kind).toBe('REFUSE');
    if (etat.kind !== 'REFUSE') return;
    expect(etat.raison).toContain('licence');
  });

  it('⚠ une licence INDÉTERMINÉE est un refus, pas un défaut commode', () => {
    /* C'est la valeur que prendrait quelqu'un qui intègre un moteur sans
       vérifier. Si elle passait, le champ ne servirait à rien : il suffirait
       de ne pas savoir. */
    const etat = creerPasserelleAudio(config({ tts: { moteur: 'flou', voix: 'v' } }), {
      stt: STT,
      tts: [declareTTS('flou', 'INDETERMINEE')],
    });
    expect(etat.kind).toBe('REFUSE');
  });

  it('⚠ la règle est un ENSEMBLE de licences permises, pas une liste noire', () => {
    /* ADR-009 exclut XTTS v2. La manière évidente était d'écrire ce nom dans
       une liste noire — elle aurait protégé contre CE produit, et contre rien
       de ce qui viendra.

       On teste donc la forme : toute valeur hors de l'ensemble permissif est
       refusée, y compris celles qu'on n'a pas prévues. */
    for (const licence of LicenceDeMoteur.options) {
      const permise = licenceEstPermissive(licence);
      expect(permise, licence).toBe(
        ['APACHE_2_0', 'MIT', 'BSD_3_CLAUSE', 'MPL_2_0', 'CC0'].includes(licence),
      );
    }
  });

  it('CONTRÔLE — une licence permissive passe', () => {
    const etat = creerPasserelleAudio(config(), { stt: STT, tts: TTS });
    expect(etat.kind).toBe('CONFIGURE');
  });
});

/* ====================================================================== *
 * 5. CE QUE L'UTILISATEUR APPREND QUAND ÇA NE MARCHE PAS — ADR-086
 * ====================================================================== */

describe('⚠ désactivé et refusé sont DEUX choses — la leçon d’ADR-086', () => {
  it('voix désactivée : DESACTIVE, et rien à signaler', () => {
    const etat = creerPasserelleAudio(config({ enabled: false }), { stt: STT, tts: TTS });
    expect(etat.kind).toBe('DESACTIVE');
  });

  it('⚠ voix demandée, aucun moteur installé : REFUSE — et la raison le DIT', () => {
    /* L'état réel du dépôt aujourd'hui. Avant ADR-086, ce cas et le précédent
       étaient le même `null` : un utilisateur qui activait la voix obtenait
       exactement le silence de quelqu'un qui ne l'avait pas activée. */
    const etat = creerPasserelleAudio(config(), { stt: [], tts: [] });
    expect(etat.kind).toBe('REFUSE');
    if (etat.kind !== 'REFUSE') return;
    expect(etat.raison).toContain('Aucun moteur STT');
  });

  it('⚠ un moteur mal orthographié : le refus NOMME ceux qui existent', () => {
    /* « moteur inconnu » envoie chercher une faute de frappe dans un fichier.
       Nommer les moteurs installés la montre. C'est aussi ce qu'on perd en
       choisissant `z.string()` plutôt qu'un `z.enum` — et ce qu'on regagne
       ici, en mieux. */
    const etat = creerPasserelleAudio(
      config({ stt: { moteur: 'moteur-aa', langue: 'fr' } }),
      { stt: STT, tts: TTS },
    );
    expect(etat.kind).toBe('REFUSE');
    if (etat.kind !== 'REFUSE') return;
    expect(etat.raison).toContain('moteur-a');
    expect(etat.raison).toContain('moteur-b');
  });

  it('⚠ un moteur STT NON LOCAL est refusé au démarrage', () => {
    /* `docs/02` : « STT fonctionnel réseau coupé ». Et au-delà de la porte de
       sortie : un STT distant ferait partir de la maison chaque phrase captée,
       y compris celles des tiers que `micro.ts` protège.

       Refusé au DÉMARRAGE, pas signalé à l'usage — même geste qu'ADR-082 pour
       l'adresse du modèle local. */
    const etat = creerPasserelleAudio(config({ stt: { moteur: 'distant', langue: 'fr' } }), {
      stt: [declareSTT('distant', { local: false })],
      tts: TTS,
    });
    expect(etat.kind).toBe('REFUSE');
    if (etat.kind !== 'REFUSE') return;
    expect(etat.raison).toContain('pas local');
  });
});

/* ====================================================================== *
 * 6. L'ÉTAT RÉEL DU DÉPÔT — écrit, pas sous-entendu
 * ====================================================================== */

describe('⚠ aucun moteur audio n’existe dans ce dépôt', () => {
  it('les deux registres sont VIDES', () => {
    /* Ce test n'a pas l'air d'en être un. Il l'est : le jour où quelqu'un
       ajoutera un moteur, il rougira — et obligera à revenir ici, à mettre à
       jour `docs/28` (Phase 5), `docs/26 §4.1`, et à remplir la fiche de
       `docs/04` pour la dépendance.

       Sans lui, un moteur pourrait apparaître et la documentation continuer
       d'affirmer qu'il n'y en a aucun. C'est le motif de `wiring.test.ts`,
       appliqué à une absence plutôt qu'à un branchement. */
    expect(REGISTRE_STT).toEqual([]);
    expect(REGISTRE_TTS).toEqual([]);
  });

  it('⚠ et la configuration par défaut laisse donc la voix ÉTEINTE', () => {
    /* Une voix activée par défaut sans moteur installé afficherait un refus à
       chaque démarrage. Le défaut est ce que prend quelqu'un qui ne choisit
       pas : il doit marcher. */
    const defaut: unknown = JSON.parse(readFileSync('config/default.json', 'utf8'));
    const lu = z
      .object({ voice: z.object({ enabled: z.boolean() }) })
      .safeParse(defaut);
    expect(lu.success, 'config/default.json doit porter la section voice').toBe(true);
    if (!lu.success) return;
    expect(lu.data.voice.enabled).toBe(false);
  });
});
