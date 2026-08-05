import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { veilleeService } from '@/services/veillee.service';
import { conservateur } from '@/services/conservateur.service';
import { dateDuRecit } from '@/lib/normalize';

export const dynamic = 'force-dynamic';

/**
 * LA VEILLÉE — §5.4.
 *
 * Un récit par écran, en grand, fait pour être lu à voix haute par
 * quelqu'un qui tient le téléphone pendant que les autres écoutent.
 * Trois écrans, puis on s'arrête. Il n'y a pas de quatrième.
 */
export default async function VeilleePage({ searchParams }: { searchParams: { etape?: string } }) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const veillee = await veilleeService.compose(context.family.id);
  const total = veillee.entries.length;

  if (total === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl">La veillée</h1>
        <p className="leading-relaxed">Il n’y a pas encore de récit à lire ensemble.</p>
        <Link href="/recits/nouveau" className="btn-primary">
          Raconter le premier
        </Link>
      </div>
    );
  }

  const etape = Number(searchParams.etape ?? 0);

  // ── Ouverture ──
  if (!etape) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl">La veillée</h1>
        <p className="text-lg leading-relaxed">
          {total} récits, à lire à voix haute. Ce sont les mêmes pour toute la famille ce soir.
        </p>
        <p className="justification">
          Personne n’a choisi ces récits pour vous plaire. Chacun est là pour une raison, qui vous sera
          dite avant de le lire.
        </p>
        <Link href="/veillee?etape=1" className="btn-primary">
          Commencer
        </Link>
      </div>
    );
  }

  // ── Clôture ──
  if (etape > total) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl">Voilà.</h1>
        <p className="text-lg leading-relaxed">
          Quelqu’un se souvient-il d’autre chose ? C’est le moment de le dire à voix haute — pas de
          l’écrire.
        </p>
        <p className="justification">
          Si un récit naît de cette veillée, il pourra être noté plus tard. L’application n’a pas besoin
          d’être ouverte pour que la mémoire passe.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link
            href={`/recits/nouveau?parent=${veillee.entries[total - 1]!.story.id}&trigger=veillee`}
            className="btn"
          >
            Noter ce qui a été dit
          </Link>
          <Link href="/" className="btn">
            Refermer
          </Link>
        </div>
      </div>
    );
  }

  const { story, justification } = veillee.entries[etape - 1]!;

  // Une lecture de veillée est une impression comme une autre : elle compte
  // dans le budget de visibilité, et elle est journalisée.
  if (context.member) {
    await conservateur.registerView({
      familyId: context.family.id,
      storyId: story.id,
      memberId: context.member.id,
      context: 'veillee',
    });
  }

  return (
    <article className="space-y-8">
      <header className="space-y-2">
        <p className="section-label">
          {etape} sur {total}
        </p>
        <h1 className="text-3xl leading-tight">{story.title}</h1>
        <p className="justification">
          Par {story.author.isDeleted ? 'Auteur anonymisé' : story.author.name} ·{' '}
          {dateDuRecit(story)}
        </p>
        {/* Pourquoi ce récit-là, et pas un autre. */}
        <p className="justification">{justification}</p>
      </header>

      {/* Corps de texte agrandi : on lit à voix haute, souvent le soir. */}
      <div className="whitespace-pre-wrap text-xl leading-loose">{story.content}</div>

      <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-6">
        <Link href={`/veillee?etape=${etape + 1}`} className="btn-primary">
          {etape === total ? 'Terminer' : 'Suivant'}
        </Link>
        <Link href={`/recits/${story.id}`} className="btn">
          Ouvrir le récit
        </Link>
      </div>
    </article>
  );
}
