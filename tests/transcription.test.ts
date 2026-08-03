import { describe, expect, it, vi } from 'vitest';
import {
  countSuspect,
  draftTextFrom,
  DOUBT_THRESHOLDS,
  hasConfidenceSignals,
  isKnownArtifact,
  reviewSegments,
  formatTimecode,
} from '@/lib/transcription-doubt';
import {
  readOutcome,
  TranscriptionService,
  TRANSCRIPTION_LANGUAGE,
  TRANSCRIPTION_MODEL,
} from '@/services/transcription.service';

/**
 * Aucun de ces tests ne prétend garantir l'exactitude d'une transcription :
 * c'est impossible avec un modèle génératif. Ils fixent la seule chose qui
 * puisse être garantie — que le doute soit VISIBLE, que les inventions
 * connues soient retirées, et qu'aucun texte non relu n'entre dans la
 * mémoire de la famille.
 */

describe('Artefacts connus — des phrases jamais prononcées', () => {
  const inventions = [
    'Sous-titres réalisés par la communauté d’Amara.org',
    'Sous-titrage: SousTitreur.com',
    'Merci d’avoir regardé cette vidéo !',
    'Abonnez-vous à la chaîne',
    'Sous-titres : Antoine',
  ];

  it.each(inventions)('reconnaît : %s', (text) => {
    expect(isKnownArtifact(text)).toBe(true);
  });

  const vraiesPhrases = [
    'Mon père réparait les vélos de tout le quartier.',
    'Le poirier a été planté en 1958, derrière la maison.',
    'On l’a regardée longtemps, cette montre.',
    'Merci, disait-il toujours, avant de refermer l’atelier.',
  ];

  it.each(vraiesPhrases)('laisse passer : %s', (text) => {
    expect(isKnownArtifact(text)).toBe(false);
  });

  it('ne signale pas une chaîne vide', () => {
    expect(isKnownArtifact('   ')).toBe(false);
  });
});

describe('Indicateurs de doute du modèle', () => {
  const bon = { start: 0, end: 3, text: 'Il réparait les vélos.', avgLogprob: -0.2, compressionRatio: 1.4, noSpeechProb: 0.01 };

  it('ne signale rien quand le modèle était sûr de lui', () => {
    const [segment] = reviewSegments([bon]);
    expect(segment!.suspect).toBe(false);
    expect(segment!.reasons).toEqual([]);
  });

  it('signale une confiance faible', () => {
    const [segment] = reviewSegments([{ ...bon, avgLogprob: DOUBT_THRESHOLDS.avgLogprob - 0.1 }]);
    expect(segment!.reasons).toContain('CONFIANCE_FAIBLE');
  });

  it('signale une boucle de répétition', () => {
    const [segment] = reviewSegments([
      { ...bon, compressionRatio: DOUBT_THRESHOLDS.compressionRatio + 0.1 },
    ]);
    expect(segment!.reasons).toContain('REPETITION');
  });

  it('signale un passage probablement sans parole', () => {
    const [segment] = reviewSegments([{ ...bon, noSpeechProb: DOUBT_THRESHOLDS.noSpeechProb + 0.1 }]);
    expect(segment!.reasons).toContain('SILENCE_PROBABLE');
  });

  it('signale deux segments identiques consécutifs', () => {
    const segments = reviewSegments([bon, { ...bon, start: 3, end: 6 }]);
    expect(segments[1]!.reasons).toContain('REPETITION_VOISINE');
    expect(segments[0]!.reasons).not.toContain('REPETITION_VOISINE');
  });

  it('cumule les raisons plutôt que d’en retenir une seule', () => {
    const [segment] = reviewSegments([
      { ...bon, avgLogprob: -2, noSpeechProb: 0.9, compressionRatio: 3 },
    ]);
    expect(segment!.reasons.length).toBe(3);
  });

  it('n’invente pas de doute quand le modèle ne fournit pas d’indicateur', () => {
    const [segment] = reviewSegments([{ start: 0, end: 1, text: 'Bonjour.' }]);
    expect(segment!.suspect).toBe(false);
  });
});

describe('Ce qui est retiré, et ce qui ne l’est pas', () => {
  const segments = reviewSegments([
    { start: 0, end: 4, text: 'Il réparait les vélos du quartier.', avgLogprob: -0.3 },
    { start: 4, end: 6, text: 'Sous-titres réalisés par la communauté d’Amara.org', noSpeechProb: 0.9 },
    { start: 6, end: 9, text: 'Il refusait, sans jamais dire pourquoi.', avgLogprob: -1.5 },
  ]);

  it('retire les inventions certaines du texte proposé', () => {
    expect(draftTextFrom(segments)).not.toContain('Amara');
  });

  it('conserve un passage douteux — c’est à l’humain de trancher', () => {
    // avgLogprob très bas : le modèle doutait. Mais ça reste peut-être de la
    // parole. Supprimer serait décider à la place de la famille.
    const texte = draftTextFrom(segments);
    expect(texte).toContain('Il refusait, sans jamais dire pourquoi.');
    expect(segments[2]!.suspect).toBe(true);
    expect(segments[2]!.artifact).toBe(false);
  });

  it('compte les passages à vérifier', () => {
    expect(countSuspect(segments)).toBe(2);
  });

  it('marque l’artefact comme invention certaine', () => {
    expect(segments[1]!.artifact).toBe(true);
  });
});

describe('Lecture de la réponse de l’API', () => {
  const response = {
    text: 'Texte complet.',
    duration: 12.5,
    segments: [
      {
        start: 0,
        end: 5,
        text: ' Il réparait les vélos.',
        avg_logprob: -0.25,
        compression_ratio: 1.3,
        no_speech_prob: 0.02,
      },
      {
        start: 5,
        end: 7,
        text: ' Merci d’avoir regardé cette vidéo !',
        avg_logprob: -0.9,
        compression_ratio: 1.1,
        no_speech_prob: 0.85,
      },
    ],
  };

  it('convertit les indicateurs de l’API en raisons lisibles', () => {
    const outcome = readOutcome(response);
    expect(outcome.segments[1]!.reasons).toContain('ARTEFACT_CONNU');
    expect(outcome.segments[1]!.reasons).toContain('SILENCE_PROBABLE');
  });

  it('exclut l’artefact du texte proposé', () => {
    expect(readOutcome(response).rawText).toBe('Il réparait les vélos.');
  });

  it('retient la durée et le nombre de passages douteux', () => {
    const outcome = readOutcome(response);
    expect(outcome.durationSeconds).toBe(12.5);
    expect(outcome.suspectCount).toBe(1);
  });

  it('retombe sur le texte brut si l’API ne segmente pas', () => {
    const outcome = readOutcome({ text: 'Tout le texte.', segments: [] });
    expect(outcome.rawText).toBe('Tout le texte.');
    expect(outcome.segments).toEqual([]);
  });

  it('ne plante pas sur une réponse malformée', () => {
    expect(() => readOutcome({})).not.toThrow();
    expect(readOutcome({}).rawText).toBe('');
  });
});

describe('Appel au modèle — les réglages qui limitent l’invention', () => {
  function serviceWithSpy() {
    const create = vi.fn(async (_args: Record<string, unknown>) => ({ text: 'ok', segments: [] }));
    const service = new TranscriptionService(undefined as never, 'clef-de-test');
    (service as unknown as { client: unknown }).client = {
      audio: { transcriptions: { create } },
    };
    return { service, create };
  }

  it('utilise whisper-1, température 0, langue forcée, et AUCUN prompt', async () => {
    const { service, create } = serviceWithSpy();
    await service.transcribe(Buffer.from('audio'), 'audio/webm', 'enregistrement');

    const args = create.mock.calls[0]![0];
    expect(args.model).toBe(TRANSCRIPTION_MODEL);
    expect(args.temperature).toBe(0);
    expect(args.language).toBe(TRANSCRIPTION_LANGUAGE);
    expect(args.response_format).toBe('verbose_json');
    // Un prompt orienterait la sortie vers ce qu'il contient : c'est
    // exactement le biais qu'on refuse.
    expect(args.prompt).toBeUndefined();
  });

  it('demande whisper-1 et non gpt-4o-transcribe', () => {
    // gpt-4o-transcribe rend un texte plus lisse, donc plus reformulé, et
    // n'expose pas les indicateurs de doute par segment.
    expect(TRANSCRIPTION_MODEL).toBe('whisper-1');
  });

  it('sans clé, refuse de transcrire plutôt que d’échouer en silence', async () => {
    const service = new TranscriptionService(undefined as never, undefined);
    expect(service.isAvailable).toBe(false);
    await expect(service.transcribe(Buffer.from('x'), 'audio/webm', 'x')).rejects.toThrow();
  });
});

describe('Repères de lecture', () => {
  it('affiche un minutage lisible', () => {
    expect(formatTimecode(0)).toBe('00:00');
    expect(formatTimecode(75)).toBe('01:15');
    expect(formatTimecode(-4)).toBe('00:00');
  });
});

describe('« Sûr de lui » et « n’a rien dit » ne sont pas la même chose', () => {
  /**
   * Le défaut corrigé : un brouillon local n'a AUCUN indicateur de confiance
   * (le navigateur ne rend que des horodatages). Afficher « aucun passage
   * signalé » y laissait croire à une assurance inexistante — le mensonge le
   * plus dangereux pour un produit dont la promesse est la justesse.
   */
  it('reconnaît qu’un moteur s’est prononcé sur sa confiance', () => {
    const segments = reviewSegments([
      { start: 0, end: 3, text: 'Il réparait les vélos.', avgLogprob: -0.2, noSpeechProb: 0.01 },
      { start: 3, end: 6, text: 'Un passage douteux.', avgLogprob: -1.8 },
    ]);
    expect(hasConfidenceSignals(segments)).toBe(true);
  });

  it('reconnaît qu’un moteur n’a rien dit, même quand tout semble propre', () => {
    // Sortie typique du moteur local : du texte, des horodatages, rien d'autre.
    const segments = reviewSegments([
      { start: 0, end: 3, text: 'Il réparait les vélos.' },
      { start: 3, end: 6, text: 'Il refusait sans dire pourquoi.' },
    ]);
    expect(segments.every((segment) => !segment.suspect)).toBe(true);
    // Aucun segment suspect, mais aucune confiance mesurée non plus.
    expect(hasConfidenceSignals(segments)).toBe(false);
  });

  it('un artefact détecté ne vaut pas indicateur de confiance', () => {
    // Repérer une phrase interdite ne dit rien de la fiabilité du reste.
    const segments = reviewSegments([
      { start: 0, end: 3, text: 'Il réparait les vélos.' },
      { start: 3, end: 5, text: 'Sous-titres réalisés par la communauté d’Amara.org' },
    ]);
    expect(segments[1]!.artifact).toBe(true);
    expect(hasConfidenceSignals(segments)).toBe(false);
  });

  it('ne prétend rien sur une transcription vide', () => {
    expect(hasConfidenceSignals([])).toBe(false);
  });
});
