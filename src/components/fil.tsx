import Link from 'next/link';
import { formatDateFr } from '@/lib/normalize';
import { MARK_LABELS, MARK_KINDS, type ThreadWithMessages } from '@/services/thread.service';
import { markMessage, postMessage, removeMessage } from '@/app/actions';

/**
 * LE FIL — l'affichage.
 *
 * Ce composant porte les interdits autant que le service. Ce qu'on ne
 * trouvera jamais ici, et qui définit la différence avec un salon de
 * discussion ordinaire :
 *
 *  - aucun compteur de non-lus, aucune pastille, aucun gras « nouveau » ;
 *  - aucune présence : ni « en ligne », ni « est en train d'écrire » ;
 *  - aucun décompte de réactions — on rend des NOMS, jamais des nombres ;
 *  - aucune mention de l'inactivité. Le fil montre ce qu'il contient,
 *    jamais ce qui lui manque. Dix messages par mois, c'est une famille,
 *    pas un échec — et un produit qui afficherait « inactif depuis trois
 *    semaines » transformerait ce rythme normal en reproche.
 */

interface Membre {
  id: string;
  name: string;
}

export function Fil({
  thread,
  members,
  memberId,
  retour,
}: {
  thread: ThreadWithMessages;
  members: Membre[];
  memberId: string | null;
  retour: string;
}) {
  return (
    <li className="space-y-4 py-5">
      {thread.title ? <h3 className="text-lg leading-snug">{thread.title}</h3> : null}

      <ul className="space-y-4">
        {thread.messages.map((message) => {
          // La voix d'abord, la plume ensuite — comme sur un récit.
          const voix = message.narrator ?? message.author;
          const scribe = message.narrator ? message.author : null;

          return (
            <li key={message.id} className="space-y-1">
              <p className="leading-relaxed">{message.body}</p>
              <p className="justification">
                {voix.name}
                {scribe ? `, noté par ${scribe.name}` : ''} · {formatDateFr(message.createdAt)}
              </p>

              {/* Des noms, jamais un nombre : « Jeanne y était » n'est pas
                  un score, c'est un fait. */}
              {message.marks.length > 0 ? (
                <ul className="justification space-y-0.5">
                  {MARK_KINDS.filter((kind) => message.marks.some((mark) => mark.kind === kind)).map(
                    (kind) => (
                      <li key={kind}>
                        {MARK_LABELS[kind]} :{' '}
                        {message.marks
                          .filter((mark) => mark.kind === kind)
                          .map((mark) => mark.member.name)
                          .join(', ')}
                      </li>
                    ),
                  )}
                </ul>
              ) : null}

              {memberId ? (
                <div className="flex flex-wrap gap-3 pt-1">
                  {MARK_KINDS.map((kind) => (
                    <form action={markMessage} key={kind}>
                      <input type="hidden" name="messageId" value={message.id} />
                      <input type="hidden" name="kind" value={kind} />
                      <input type="hidden" name="retour" value={retour} />
                      <button type="submit" className="justification underline">
                        {MARK_LABELS[kind]}
                      </button>
                    </form>
                  ))}

                  {/* Annexe A point 6 : le droit à l'oubli est absolu, et il
                      appartient à qui a écrit ces mots comme à qui les a
                      dits. Le bouton est visible, jamais caché dans un menu
                      (§6.3) — mais seulement pour ces deux personnes. */}
                  {message.author.id === memberId || message.narrator?.id === memberId ? (
                    <form action={removeMessage}>
                      <input type="hidden" name="messageId" value={message.id} />
                      <input type="hidden" name="retour" value={retour} />
                      <button type="submit" className="justification underline">
                        Retirer mes mots
                      </button>
                    </form>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {memberId ? (
        <ChampDeParole
          threadId={thread.id}
          members={members}
          memberId={memberId}
          retour={retour}
          label="Répondre"
        />
      ) : null}

      {thread.crystallizedStoryId ? (
        <p className="justification">
          Ce fil est devenu un récit :{' '}
          <Link href={`/recits/${thread.crystallizedStoryId}`} className="underline">
            le lire
          </Link>
        </p>
      ) : memberId && thread.messages.length >= 2 ? (
        <p className="justification">
          <Link href={`/fils/${thread.id}/recit`} className="underline">
            En faire un récit
          </Link>
        </p>
      ) : null}
    </li>
  );
}

/**
 * Le champ de parole.
 *
 * Aucun titre, aucun type, aucune structure : c'est tout l'intérêt du fil
 * sur la page de rédaction. Trois mots sur la montre de Robert doivent
 * coûter trois mots.
 *
 * Le sélecteur « qui parle » n'est pas un détail d'ergonomie : dans un fil
 * écrit, le clavier rapide parle à la place de celui qui se souvient. Sans
 * lui, l'interface amplifierait exactement la distorsion que le Conservateur
 * mesure.
 */
export function ChampDeParole({
  threadId,
  entityId,
  storyId,
  members,
  memberId,
  retour,
  label,
}: {
  threadId?: string;
  entityId?: string;
  storyId?: string;
  members: Membre[];
  memberId: string;
  retour: string;
  label: string;
}) {
  const champId = `parole-${threadId ?? entityId ?? storyId ?? 'nouveau'}`;

  return (
    <form action={postMessage} className="space-y-2">
      {threadId ? <input type="hidden" name="threadId" value={threadId} /> : null}
      {entityId ? <input type="hidden" name="entityId" value={entityId} /> : null}
      {storyId ? <input type="hidden" name="storyId" value={storyId} /> : null}
      <input type="hidden" name="retour" value={retour} />

      <label htmlFor={champId} className="section-label block">
        {label}
      </label>
      <textarea
        id={champId}
        name="body"
        rows={2}
        className="w-full rounded-sm border border-rule bg-transparent p-2 font-sans text-sm"
      />

      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={`${champId}-voix`} className="justification">
          Qui parle
        </label>
        <select
          id={`${champId}-voix`}
          name="narratorId"
          defaultValue={memberId}
          className="min-h-[44px] rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
        >
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.id === memberId ? `${member.name} (moi)` : member.name}
            </option>
          ))}
        </select>

        <button type="submit" className="btn">
          Envoyer
        </button>
      </div>
      <p className="justification">
        Si vous notez ce que quelqu’un d’autre raconte, choisissez son nom : la mémoire lui
        appartient, pas au clavier.
      </p>
    </form>
  );
}
