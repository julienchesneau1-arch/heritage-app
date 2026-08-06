'use client';

import { useState } from 'react';
import {
  decouperEnMoments,
  detecterSource,
  EXTENSIONS_ACCEPTEES,
  SOURCES,
  type Lecture,
  type Moment,
  type Source,
} from '@/lib/import';

/**
 * IMPORTER UNE CONVERSATION DE FAMILLE.
 *
 * ── Le fichier ne quitte jamais l'appareil ──
 *
 * Tout est lu et découpé ici, dans le navigateur, comme la transcription.
 * Ce qui part au serveur, ce sont uniquement les moments qu'un humain a
 * cochés — jamais le fichier, jamais les milliers de messages écartés.
 * Ce n'est pas une optimisation : un export de groupe familial contient
 * des années de logistique, de disputes et de numéros de téléphone, et
 * rien de tout cela n'a demandé à entrer dans une archive permanente.
 *
 * ── Trois refus ──
 *
 * 1. On n'importe pas tout. Le produit ne sait pas ce qui compte pour une
 *    famille, et l'amendement 6 lui interdit de faire semblant. Il propose
 *    un découpage TEMPOREL — vérifiable, explicable en une phrase — et la
 *    famille choisit.
 * 2. On ne devine aucune identité. Un nom de l'export n'est rattaché à un
 *    membre que si quelqu'un l'a dit. « Maman » n'est pas un identifiant.
 * 3. On ne résume rien. L'aperçu montre les mots réellement écrits : on ne
 *    choisit pas sur la foi d'une machine.
 */

interface Membre {
  id: string;
  name: string;
}

type Etat = 'attente' | 'lecture' | 'proprietaire' | 'choix' | 'envoi' | 'fait' | 'erreur';

export function ImportConversation({ familyId, members }: { familyId: string; members: Membre[] }) {
  const [etat, setEtat] = useState<Etat>('attente');
  const [erreur, setErreur] = useState('');
  const [lecture, setLecture] = useState<Lecture | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [proprietaire, setProprietaire] = useState('');
  const [fichierEnAttente, setFichierEnAttente] = useState<{ nom: string; contenu: string } | null>(
    null,
  );
  const [moments, setMoments] = useState<Moment[]>([]);
  const [retenus, setRetenus] = useState<Set<number>>(new Set());
  const [correspondances, setCorrespondances] = useState<Record<string, string>>({});
  const [importes, setImportes] = useState(0);

  async function lireFichier(fichier: File) {
    setEtat('lecture');
    setErreur('');
    try {
      const contenu = await fichier.text();
      const trouvee = detecterSource(contenu, fichier.name);

      if (!trouvee) {
        setEtat('erreur');
        setErreur(
          'Ce fichier ne correspond à aucun format connu. Aucune lecture n’a été tentée : deviner produirait un import silencieusement faux.',
        );
        return;
      }

      setSource(trouvee);

      // Un export SMS ne nomme jamais celui qui a envoyé. Sans réponse, la
      // moitié de la conversation serait sans auteur — on demande avant de lire.
      if (trouvee.demandeProprietaire && proprietaire.trim() === '') {
        setFichierEnAttente({ nom: fichier.name, contenu });
        setEtat('proprietaire');
        return;
      }

      analyser(trouvee, contenu, proprietaire);
    } catch {
      setEtat('erreur');
      setErreur('Ce fichier n’a pas pu être lu.');
    }
  }

  function analyser(source: Source, contenu: string, nomProprietaire: string) {
    const lu = source.lire(contenu, { proprietaire: nomProprietaire.trim() || undefined });

    if (lu.messages.length === 0) {
      setEtat('erreur');
      setErreur(
        `Aucun message reconnu dans ce fichier ${source.nom}. ${source.commentExporter}`,
      );
      return;
    }

    setLecture(lu);
    setMoments(decouperEnMoments(lu.messages));
    setRetenus(new Set());
    setCorrespondances({});
    setEtat('choix');
  }

  async function envoyer() {
    if (!lecture) return;
    setEtat('envoi');
    try {
      const choisis = moments.filter((_, i) => retenus.has(i));
      const reponse = await fetch(`/api/family/${familyId}/import-conversation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: lecture.source,
          correspondances,
          moments: choisis.map((moment) => ({
            debut: moment.debut.toISOString(),
            messages: moment.indices.map((index) => {
              const message = lecture.messages[index]!;
              return {
                auteur: message.auteur,
                texte: message.texte,
                date: message.date.toISOString(),
                pieceJointe: message.pieceJointe,
              };
            }),
          })),
        }),
      });
      if (!reponse.ok) throw new Error();
      const { fils } = (await reponse.json()) as { data?: { fils: number }; fils?: number };
      setImportes(fils ?? choisis.length);
      setEtat('fait');
    } catch {
      setEtat('erreur');
      setErreur('L’enregistrement a échoué. Rien n’a été ajouté à la mémoire.');
    }
  }

  const nonRattaches = (lecture?.participants ?? []).filter((nom) => !correspondances[nom]);

  return (
    <div className="space-y-8">
      {etat === 'attente' || etat === 'erreur' ? (
        <div className="carte space-y-4">
          <label htmlFor="fichier" className="etiquette">
            Le fichier exporté
          </label>
          <input
            id="fichier"
            type="file"
            accept={EXTENSIONS_ACCEPTEES}
            className="block w-full font-sans text-base"
            onChange={(event) => {
              const fichier = event.target.files?.[0];
              if (fichier) void lireFichier(fichier);
            }}
          />
          <p className="justification">
            Le fichier <strong>reste sur cet appareil</strong> : il est lu ici, dans votre
            navigateur, et n’est jamais envoyé. Seuls les passages que vous cocherez seront
            enregistrés.
          </p>

          <details>
            <summary className="cursor-pointer py-2 font-sans text-base text-muted hover:text-ink">
              Comment obtenir ce fichier
            </summary>
            <ul className="space-y-3 py-2">
              {SOURCES.map((disponible) => (
                <li key={disponible.id}>
                  <span className="section-label block">{disponible.nom}</span>
                  <span className="justification block">{disponible.commentExporter}</span>
                </li>
              ))}
            </ul>
          </details>
          {erreur ? <p className="justification text-accent">{erreur}</p> : null}
        </div>
      ) : null}

      {etat === 'lecture' ? <p className="leading-relaxed">Lecture du fichier…</p> : null}

      {etat === 'proprietaire' && source && fichierEnAttente ? (
        <div className="carte space-y-4">
          <h2 className="text-xl leading-snug">À qui est ce téléphone ?</h2>
          <p className="leading-relaxed">
            Une sauvegarde de SMS nomme la personne qui a écrit les messages <em>reçus</em>, mais
            jamais celle qui a envoyé les autres : elle sait seulement qu’ils sont sortis de cet
            appareil.
          </p>
          <p className="justification">
            Sans ce nom, la moitié de la conversation resterait sans auteur. L’application ne le
            devinera pas.
          </p>
          <label htmlFor="proprietaire" className="etiquette">
            Nom du propriétaire du téléphone
          </label>
          <input
            id="proprietaire"
            value={proprietaire}
            onChange={(event) => setProprietaire(event.target.value)}
            className="champ max-w-sm"
          />
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="btn-primary"
              onClick={() => analyser(source, fichierEnAttente.contenu, proprietaire)}
            >
              Continuer
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => analyser(source, fichierEnAttente.contenu, '')}
            >
              Je ne sais pas
            </button>
          </div>
        </div>
      ) : null}

      {etat === 'choix' && lecture ? (
        <>
          {/* Ce qui a été lu, et ce qui ne l'a pas été. */}
          <section className="carte space-y-2">
            <h2 className="text-xl leading-snug">Ce que contient ce fichier</h2>
            <p className="leading-relaxed">
              Format reconnu : {source?.nom ?? lecture.source}.{' '}
              {lecture.messages.length.toLocaleString('fr-FR')} messages de{' '}
              {lecture.participants.length} personnes, du{' '}
              {lecture.debut!.toLocaleDateString('fr-FR')} au{' '}
              {lecture.fin!.toLocaleDateString('fr-FR')}.
            </p>
            <p className="justification">
              {lecture.systeme > 0
                ? `${lecture.systeme} lignes écartées : elles viennent de la plateforme elle-même et ne sont la parole de personne. `
                : ''}
              {lecture.doublons > 0
                ? `${lecture.doublons} messages en double écartés — même minute, même auteur, même texte. `
                : ''}
              {lecture.ignorees > 0
                ? `${lecture.ignorees} lignes n’ont pas pu être rattachées à un message ; elles ne seront pas importées.`
                : ''}
            </p>
            {/* Ce que le lecteur sait d'incertain est dit avant le choix,
                jamais découvert après (amendement 6). */}
            {lecture.avertissements.map((avertissement) => (
              <p key={avertissement} className="justification">
                {avertissement}
              </p>
            ))}
            <p className="justification">
              Vérifiez la plage de dates : si l’année paraît fausse, le fichier a été lu en
              mois/jour au lieu de jour/mois. Ne poursuivez pas dans ce cas.
            </p>

            {/* §3.1 amendée. Un groupe est un espace que la famille a créé
                ensemble : chacun savait qui écoutait. Un échange à deux a été
                écrit à une seule personne — l'importer ne change pas de
                support, il change d'auditoire. On ne l'interdit pas : la
                mémoire d'une aïeule tient souvent dans ces échanges-là. On
                le dit avant qu'on coche. */}
            {lecture.participants.length === 2 ? (
              <p className="justification">
                Cette conversation n’a que deux voix. Ces mots ont été écrits à une seule personne,
                pas à la famille : les garder ici change qui les lira.{' '}
                {lecture.participants
                  .filter((nom) => correspondances[nom])
                  .map((nom) => nom)
                  .join(' et ') || 'Chacun'}{' '}
                pourra retirer les siens à tout moment.
              </p>
            ) : null}
          </section>

          {/* Qui est qui. Rien n'est deviné. */}
          <section className="carte space-y-3">
            <h2 className="text-xl leading-snug">Qui est qui</h2>
            <p className="justification">
              Les noms viennent du carnet d’adresses de celui qui a exporté — ou d’un numéro de
              téléphone. Rattachez ceux que vous reconnaissez ; les autres resteront cités par leur nom, sans être rattachés à personne.
              Rien n’est deviné.
            </p>
            <ul className="space-y-2">
              {lecture.participants.map((nom) => (
                <li key={nom} className="flex flex-wrap items-center gap-3">
                  <span className="min-w-[10rem] font-sans text-base">{nom}</span>
                  <label htmlFor={`m-${nom}`} className="sr-only">
                    Rattacher {nom}
                  </label>
                  <select
                    id={`m-${nom}`}
                    value={correspondances[nom] ?? ''}
                    onChange={(event) =>
                      setCorrespondances((actuel) => ({ ...actuel, [nom]: event.target.value }))
                    }
                    className="champ w-auto"
                  >
                    <option value="">Personne de la famille</option>
                    {members.map((membre) => (
                      <option key={membre.id} value={membre.id}>
                        {membre.name}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </section>

          {/* Les moments. */}
          <section className="carte space-y-3">
            <h2 className="text-xl leading-snug">Les moments</h2>
            <p className="justification">
              La conversation est découpée là où elle s’est interrompue plus d’une heure et demie.
              Ce n’est pas un tri par intérêt : l’application ne sait pas ce qui compte pour vous.
              Les échanges d’une seule personne, ou de moins de trois messages, ne sont pas proposés.
            </p>

            {moments.length === 0 ? (
              <p className="justification">
                Aucun échange d’au moins trois messages entre au moins deux personnes dans ce
                fichier.
              </p>
            ) : (
              <ul className="divide-y divide-rule border-y border-rule">
                {moments.map((moment, index) => (
                  <li key={index} className="py-3">
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={retenus.has(index)}
                        onChange={() =>
                          setRetenus((actuel) => {
                            const suivant = new Set(actuel);
                            if (suivant.has(index)) suivant.delete(index);
                            else suivant.add(index);
                            return suivant;
                          })
                        }
                        className="mt-1 h-5 w-5 shrink-0"
                      />
                      <span className="space-y-1">
                        <span className="block leading-relaxed">{moment.apercu}</span>
                        <span className="justification block">
                          {moment.debut.toLocaleDateString('fr-FR')} ·{' '}
                          {moment.indices.length} messages · {moment.participants.join(', ')}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="space-y-3 border-t border-rule pt-6">
            {nonRattaches.length > 0 && retenus.size > 0 ? (
              <p className="justification">
                {nonRattaches.length} nom{nonRattaches.length > 1 ? 's' : ''} non rattaché
                {nonRattaches.length > 1 ? 's' : ''} : {nonRattaches.join(', ')}. Leurs mots seront
                gardés, attribués à ce nom, sans lien avec un membre.
              </p>
            ) : null}
            <button
              type="button"
              className="btn-primary"
              disabled={retenus.size === 0}
              onClick={() => void envoyer()}
            >
              Garder {retenus.size} moment{retenus.size > 1 ? 's' : ''}
            </button>
            <p className="justification">
              Chaque moment retenu devient un fil, avec ses messages tels qu’ils ont été écrits.
              Rien d’autre ne sera enregistré.
            </p>
          </div>
        </>
      ) : null}

      {etat === 'envoi' ? <p className="leading-relaxed">Enregistrement…</p> : null}

      {etat === 'fait' ? (
        <div className="space-y-3">
          <p className="text-lg leading-relaxed">
            {importes} fil{importes > 1 ? 's' : ''} {importes > 1 ? 'ajoutés' : 'ajouté'} à la
            mémoire de la famille.
          </p>
          <p className="justification">
            Ils sont là comme n’importe quel fil : on peut y répondre, et en faire un récit.
          </p>
          <a href="/" className="btn">
            Revenir à l’accueil
          </a>
        </div>
      ) : null}
    </div>
  );
}
