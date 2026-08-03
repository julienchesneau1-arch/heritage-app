import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { chooseMember, setReadingSize } from '../actions';
import { currentReadingSize, READING_LABELS, READING_SIZES } from '@/lib/reading';

export const dynamic = 'force-dynamic';

/**
 * V1 : pas de mot de passe (§4.1). On demande simplement qui consulte,
 * parce que le Passeur et le Conservateur raisonnent par membre.
 */
export default async function WhoPage() {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const reading = currentReadingSize();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl">Qui êtes-vous ?</h1>
      <p className="justification">
        Cette information reste dans votre navigateur. Elle sert à savoir à qui le Passeur s’adresse.
      </p>

      <form action={chooseMember} className="space-y-2">
        <ul className="divide-y divide-rule border-y border-rule">
          {context.members.map((member) => (
            <li key={member.id}>
              <button
                type="submit"
                name="memberId"
                value={member.id}
                className="tap w-full justify-between px-1 text-left"
              >
                <span className="text-lg">{member.name}</span>
                <span className="justification">génération {member.generation}</span>
              </button>
            </li>
          ))}
        </ul>
      </form>

      {/* Une condition d'accès, pas une préférence esthétique : un récit
          qu'on ne peut pas lire n'est pas transmis. Réglage par appareil. */}
      <section className="space-y-3 border-t border-rule pt-6">
        <h2 className="section-label">Taille du texte</h2>
        <p className="justification">Ce réglage ne vaut que pour cet appareil.</p>
        <form action={setReadingSize} className="flex flex-wrap gap-2">
          {READING_SIZES.map((size) => (
            <button
              key={size}
              type="submit"
              name="size"
              value={size}
              aria-pressed={size === reading}
              className={size === reading ? 'btn-primary' : 'btn'}
            >
              {READING_LABELS[size]}
            </button>
          ))}
        </form>
      </section>
    </div>
  );
}
