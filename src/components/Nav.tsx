'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SECTIONS, INVENTAIRE_VIDE, type Section } from '@/lib/sections';
import type { Inventaire } from '@/lib/context';

/**
 * Navigation. Aucun badge, aucun compteur, aucune pastille rouge (§6.1).
 *
 * ── Un menu ne propose que ce qui existe ──
 *
 * La §6.1 dit « parcimonie visuelle ». Neuf entrées dont sept mènent à une
 * page vide ne sont pas parcimonieuses : elles sont décoratives, et elles
 * demandent à une famille qui arrive d'apprendre un vocabulaire — « Veillée »,
 * « À mettre au propre », « Transmission » — avant d'avoir dit un seul mot.
 *
 * Chaque section reste donc repliée tant qu'elle est vide. Mais rien ne
 * devient inatteignable : « Tout le reste » les rend toutes, avec une ligne
 * qui dit à quoi chacune sert. C'est un `<details>` : ni script, ni état, et
 * le clavier le manipule sans qu'on ait rien à écrire.
 */

export function Nav({
  familyName,
  member,
  inventaire,
}: {
  familyName: string | null;
  member: { id: string; name: string } | null;
  inventaire: Inventaire | null;
}) {
  const pathname = usePathname();
  const inv = inventaire ?? INVENTAIRE_VIDE;

  // ── L'écran où l'on parle n'a pas de menu ──
  //
  // « Un écran, une question, un bouton. Aucun texte à lire au-delà de la
  // question elle-même. » Neuf entrées de navigation au-dessus d'une
  // question posée à voix haute, c'est neuf choses à ne pas lire pour
  // quelqu'un qui doit seulement se souvenir.
  //
  // On retire, on ne cache pas : le pied de page garde l'export et la
  // reddition de comptes, et « Terminer » ramène à l'accueil. Rien ne
  // devient inatteignable.
  if (pathname.startsWith('/entretien/parler')) {
    return (
      <header className="border-b border-rule pt-6 pb-2">
        <Link href="/" className="text-2xl tracking-tight">
          Héritage
        </Link>
      </header>
    );
  }

  const ouvertes = SECTIONS.filter((page) => page.utile(inv));
  const repliees = SECTIONS.filter((page) => !page.utile(inv));

  const lien = (page: Section) => {
    const current = pathname.startsWith(page.href);
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
  };

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
        <Link
          href="/"
          aria-current={pathname === '/' ? 'page' : undefined}
          className={`py-2 font-sans text-sm hover:text-ink ${
            pathname === '/' ? 'text-ink underline underline-offset-4' : 'text-muted'
          }`}
        >
          Aujourd’hui
        </Link>

        {ouvertes.map(lien)}

        <Link href="/recits/nouveau" className="py-2 font-sans text-sm text-accent hover:underline">
          Raconter
        </Link>

        {repliees.length > 0 ? (
          <details className="w-full">
            <summary className="cursor-pointer py-2 font-sans text-sm text-muted hover:text-ink">
              Tout le reste
            </summary>
            <ul className="space-y-2 py-2">
              {repliees.map((page) => (
                <li key={page.href}>
                  <Link href={page.href} className="font-sans text-sm underline">
                    {page.label}
                  </Link>
                  <span className="justification block">{page.role}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </nav>
    </header>
  );
}
