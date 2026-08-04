'use client';

import { useState } from 'react';
import {
  decouperEnMoments,
  lireExportWhatsApp,
  type LectureWhatsApp,
  type Moment,
} from '@/lib/whatsapp';

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

type Etat = 'attente' | 'lecture' | 'choix' | 'envoi' | 'fait' | 'erreur';

export function ImportWhatsApp({ familyId, members }: { familyId: string; members: Membre[] }) {
  const [etat, setEtat] = useState<Etat>('attente');
  const [erreur, setErreur] = useState('');
  const [lecture, setLecture] = useState<LectureWhatsApp | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [retenus, setRetenus] = useState<Set<number>>(new Set());
  const [correspondances, setCorrespondances] = useState<Record<string, string>>({});
  const [importes, setImportes] = useState(0);

  async function lireFichier(fichier: File) {
    setEtat('lecture');
    setErreur('');
    try {
      const contenu = await fichier.text();
      const lu = lireExportWhatsApp(contenu);

      if (lu.messages.length === 0) {
        setEtat('erreur');
        setErreur(
          'Aucun message reconnu dans ce fichier. Vérifiez qu’il s’agit bien du .txt produit par « Exporter la discussion » de WhatsApp.',
        );
        return;
      }

      setLecture(lu);
      setMoments(decouperEnMoments(lu.messages));
      setRetenus(new Set());
      setCorrespondances({});
      setEtat('choix');
    } catch {
      setEtat('erreur');
      setErreur('Ce fichier n’a pas pu être lu.');
    }
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
        <div className="space-y-4">
          <label htmlFor="fichier" className="section-label block">
            Le fichier exporté
          </label>
          <input
            id="fichier"
            type="file"
            accept=".txt,text/plain"
            className="block w-full font-sans text-sm"
            onChange={(event) => {
              const fichier = event.target.files?.[0];
              if (fichier) void lireFichier(fichier);
            }}
          />
          <p className="justification">
            Dans WhatsApp : ouvrez la discussion de famille, puis « Exporter la discussion », puis
            « Sans les médias ». Le fichier <strong>reste sur cet appareil</strong> — il est lu ici,
            dans votre navigateur, et n’est jamais envoyé.
          </p>
          {erreur ? <p className="justification text-accent">{erreur}</p> : null}
        </div>
      ) : null}

      {etat === 'lecture' ? <p className="leading-relaxed">Lecture du fichier…</p> : null}

      {etat === 'choix' && lecture ? (
        <>
          {/* Ce qui a été lu, et ce qui ne l'a pas été. */}
          <section className="space-y-2">
            <h2 className="section-label">Ce que contient ce fichier</h2>
            <p className="leading-relaxed">
              {lecture.messages.length.toLocaleString('fr-FR')} messages de{' '}
              {lecture.participants.length} personnes, du{' '}
              {lecture.debut!.toLocaleDateString('fr-FR')} au{' '}
              {lecture.fin!.toLocaleDateString('fr-FR')}.
            </p>
            <p className="justification">
              {lecture.systeme > 0
                ? `${lecture.systeme} lignes écartées : elles viennent de WhatsApp lui-même (chiffrement, arrivées, appels manqués) et ne sont la parole de personne. `
                : ''}
              {lecture.ignorees > 0
                ? `${lecture.ignorees} lignes n’ont pas pu être rattachées à un message — elles ne seront pas importées.`
                : ''}
            </p>
            <p className="justification">
              Vérifiez la plage de dates : si l’année paraît fausse, c’est que le téléphone a exporté
              en mois/jour et non en jour/mois. Ne poursuivez pas dans ce cas.
            </p>
          </section>

          {/* Qui est qui. Rien n'est deviné. */}
          <section className="space-y-3 border-t border-rule pt-6">
            <h2 className="section-label">Qui est qui</h2>
            <p className="justification">
              Les noms viennent du carnet d’adresses de celui qui a exporté. Rattachez ceux que vous
              reconnaissez ; les autres resteront cités par leur nom, sans être rattachés à personne.
              Rien n’est deviné.
            </p>
            <ul className="space-y-2">
              {lecture.participants.map((nom) => (
                <li key={nom} className="flex flex-wrap items-center gap-3">
                  <span className="min-w-[10rem] font-sans text-sm">{nom}</span>
                  <label htmlFor={`m-${nom}`} className="sr-only">
                    Rattacher {nom}
                  </label>
                  <select
                    id={`m-${nom}`}
                    value={correspondances[nom] ?? ''}
                    onChange={(event) =>
                      setCorrespondances((actuel) => ({ ...actuel, [nom]: event.target.value }))
                    }
                    className="min-h-[44px] rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
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
          <section className="space-y-3 border-t border-rule pt-6">
            <h2 className="section-label">Les moments</h2>
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
