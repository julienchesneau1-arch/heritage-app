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
      <header className="aplat bg-accent-800 py-4">
        <Link href="/" className="font-titre text-[22px] text-accent-100">
          Héritage
        </Link>
      </header>
    );
  }

  const ouvertes = SECTIONS.filter((page) => page.utile(inv));
  const repliees = SECTIONS.filter((page) => !page.utile(inv));

  /**
   * Le premier jour, la barre est posée sur l'aplat terre cuite de la page :
   * un bandeau crème au-dessus d'un aplat couperait l'écran en deux. Elle
   * prend donc la teinte la plus foncée de la même rampe.
   */
  const surAplat = pathname === '/' && inv.recits === 0 && inv.fils === 0;

  const lien = (page: Section) => {
    const current = pathname.startsWith(page.href);
    return (
      <Link
        key={page.href}
        href={page.href}
        // Lu par les lecteurs d'écran, et souligné pour tout le monde :
        // la couleur seule ne dirait rien à qui ne la perçoit pas.
        aria-current={current ? 'page' : undefined}
        className={`py-2 font-sans text-base hover:opacity-100 ${
          current
            ? 'font-semibold underline decoration-2 underline-offset-[6px]'
            : 'opacity-80'
        } ${surAplat ? 'text-accent-100' : current ? 'text-ink' : 'text-muted'}`}
      >
        {page.label}
      </Link>
    );
  };

  return (
    <header className={`aplat pt-5 ${surAplat ? 'bg-accent-800' : 'border-b border-rule'}`}>
      <div className="flex items-baseline justify-between gap-4">
        <Link
          href="/"
          className={`font-titre text-[22px] ${surAplat ? 'text-accent-100' : 'text-ink'}`}
        >
          Héritage
        </Link>
        {member ? (
          <span className="flex items-center gap-4">
            <Link
              href="/famille"
              className={`font-sans text-base underline ${surAplat ? 'text-accent-200' : 'text-muted'}`}
            >
              Famille
            </Link>
            <Link
              href="/qui"
              className={`font-sans text-base underline ${surAplat ? 'text-accent-200' : 'text-muted'}`}
            >
              {member.name}
            </Link>
          </span>
        ) : familyName ? (
          <Link href="/qui" className="justification underline">
            Qui êtes-vous ?
          </Link>
        ) : null}
      </div>

      <nav aria-label="Sections" className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 pb-3">
        <Link
          href="/"
          aria-current={pathname === '/' ? 'page' : undefined}
          className={`py-2 font-sans text-base ${
            pathname === '/'
              ? 'font-semibold underline decoration-2 underline-offset-[6px]'
              : 'opacity-80'
          } ${surAplat ? 'text-accent-100' : pathname === '/' ? 'text-ink' : 'text-muted'}`}
        >
          Aujourd’hui
        </Link>

        {ouvertes.map(lien)}

        {/* « Raconter » reste un LIEN sur le premier jour : en bouton, il
            rivaliserait avec le champ de saisie et renverrait vers un
            formulaire complet — c'est-à-dire vers la page blanche que cet
            écran a été construit pour éviter. Ailleurs, il est un bouton. */}
        <Link
          href="/recits/nouveau"
          className={
            surAplat
              ? 'py-2 font-sans text-base font-semibold text-accent-200 underline'
              : 'btn-primary ml-auto text-base'
          }
        >
          Raconter
        </Link>

        {repliees.length > 0 ? (
          <details className="w-full">
            <summary
              className={`cursor-pointer py-2 font-sans text-base ${
                surAplat ? 'text-accent-200' : 'text-muted'
              }`}
            >
              Tout le reste
            </summary>
            <ul className="space-y-3 py-2">
              {repliees.map((page) => (
                <li key={page.href}>
                  <Link
                    href={page.href}
                    className={`font-sans text-base underline ${surAplat ? 'text-accent-100' : ''}`}
                  >
                    {page.label}
                  </Link>
                  <span className={surAplat ? 'justification-claire block' : 'justification block'}>
                    {page.role}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </nav>
    </header>
  );
}
