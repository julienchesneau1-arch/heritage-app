import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { ImportConversation } from '@/components/ImportConversation';

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
      {/* Sauge : la teinte des écrans où l'on lit ce qui existe déjà, par
          opposition au terre cuite des écrans où l'on produit du neuf. */}
      <header className="aplat relative -mt-8 space-y-3 overflow-hidden bg-sauge-800 pb-8 pt-7 text-sauge-100">
        <span aria-hidden="true" className="rond -right-20 -top-16 h-48 w-48 bg-sauge-700" />
        <h1 className="relative text-[2.1rem] leading-[1.12]">
          La famille se parle déjà quelque part.
        </h1>
        <p className="relative max-w-[38ch] text-lg leading-relaxed">
          Des années de conversation dorment dans un groupe WhatsApp, un fil Messenger ou les SMS
          d’un téléphone — là où tout défile et où personne ne retrouve rien. Vous pouvez en garder
          ce qui mérite de rester.
        </p>
      </header>

      <ImportConversation familyId={context.family.id} members={context.members} />
    </div>
  );
}
