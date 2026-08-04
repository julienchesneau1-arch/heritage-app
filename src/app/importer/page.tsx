import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { ImportWhatsApp } from '@/components/ImportWhatsApp';

export const dynamic = 'force-dynamic';

/**
 * Reprendre une conversation qui existe déjà.
 *
 * C'est le seul chemin du produit qui ne demande à personne de produire du
 * neuf — et c'est pour cela qu'il existe : une mémoire vide le reste, et
 * c'est ce qui tue ces applications, pas un défaut de fonctionnalité.
 */
export default async function ImporterPage() {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');
  if (!context.member) redirect('/qui');

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-2xl leading-snug">La famille se parle déjà quelque part.</h1>
        <p className="text-lg leading-relaxed">
          Des années de conversation dorment dans un groupe WhatsApp, où tout défile et où personne
          ne retrouve rien. Vous pouvez en garder ce qui mérite de rester.
        </p>
      </div>

      <ImportWhatsApp familyId={context.family.id} members={context.members} />
    </div>
  );
}
