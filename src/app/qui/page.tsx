import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { chooseMember } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * V1 : pas de mot de passe (§4.1). On demande simplement qui consulte,
 * parce que le Passeur et le Conservateur raisonnent par membre.
 */
export default async function WhoPage() {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

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
    </div>
  );
}
