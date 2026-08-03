'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const PAGES = [
  { href: '/', label: 'Aujourd’hui' },
  { href: '/veillee', label: 'Veillée' },
  { href: '/recits', label: 'Récits' },
  { href: '/brouillons', label: 'À mettre au propre' },
  { href: '/archives', label: 'Archives' },
  { href: '/traditions', label: 'Traditions' },
  { href: '/graphe', label: 'Graphe' },
  { href: '/transmission', label: 'Transmission' },
];

/**
 * Navigation. Aucun badge, aucun compteur, aucune pastille rouge (§6.1).
 * « Raconter » est le seul appel à l'action permanent (§5.1).
 */
export function Nav({
  familyName,
  member,
}: {
  familyName: string | null;
  member: { id: string; name: string } | null;
}) {
  const pathname = usePathname();

  return (
    <header className="border-b border-rule pt-6">
      <div className="flex items-baseline justify-between gap-4">
        <Link href="/" className="text-2xl tracking-tight">
          Héritage
        </Link>
        {member ? (
          <span className="flex items-center gap-3">
            <Link href="/famille" className="justification underline">
              Famille
            </Link>
            <Link href="/qui" className="justification underline">
              {member.name}
            </Link>
          </span>
        ) : familyName ? (
          <Link href="/qui" className="justification underline">
            Qui êtes-vous ?
          </Link>
        ) : null}
      </div>

      <nav aria-label="Sections" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 pb-2">
        {PAGES.map((page) => {
          const current = page.href === '/' ? pathname === '/' : pathname.startsWith(page.href);
          return (
            <Link
              key={page.href}
              href={page.href}
              // Lu par les lecteurs d'écran, et souligné pour tout le monde :
              // la couleur seule ne dirait rien à qui ne la perçoit pas.
              aria-current={current ? 'page' : undefined}
              className={`py-2 font-sans text-sm hover:text-ink ${
                current ? 'text-ink underline underline-offset-4' : 'text-muted'
              }`}
            >
              {page.label}
            </Link>
          );
        })}
        <Link href="/recits/nouveau" className="py-2 font-sans text-sm text-accent hover:underline">
          Raconter
        </Link>
      </nav>
    </header>
  );
}
