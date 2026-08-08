import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Nav } from '@/components/Nav';
import { ServiceWorker } from '@/components/ServiceWorker';
import { loadContext } from '@/lib/context';
import { currentReadingSize, READING_ROOT_CLASS } from '@/lib/reading';

export const metadata: Metadata = {
  title: 'Héritage',
  description: 'La mémoire d’une famille. Une histoire doit pouvoir engendrer une autre histoire.',
  manifest: '/manifest.webmanifest',
  robots: { index: false, follow: false }, // une mémoire familiale ne s'indexe pas
};

export const viewport: Viewport = {
  themeColor: '#faf8f4',
  width: 'device-width',
  initialScale: 1,
};

/**
 * ── LA COQUILLE NE DOIT PAS DÉPENDRE DE LA BASE ──
 *
 * `loadContext()` interroge PostgreSQL. Tant qu'il était appelé ici sans
 * protection, une base indisponible faisait échouer le GABARIT — et un
 * gabarit qui échoue met `error.tsx` hors circuit, puisque celui-ci se rend
 * À L'INTÉRIEUR du gabarit. Next servait alors sa propre page, en anglais,
 * sans un mot sur ce qu'il advient de la mémoire. Constaté en coupant la
 * base sur une application en marche : trois pages, trois fois
 * `__next_error__`.
 *
 * On rattrape donc ici, et ici seulement. La barre de navigation se rend
 * alors dans son état minimal — c'est une dégradation visible et modeste —
 * pendant que la PAGE, elle, lève normalement et laisse `error.tsx` dire en
 * français que rien n'est perdu.
 *
 * Ce qu'on ne fait surtout pas : servir une page qui ferait comme si de
 * rien n'était. Une panne déguisée en absence est le pire des deux.
 */
async function contexteTolerant() {
  try {
    return await loadContext();
  } catch (error) {
    console.error('[layout] contexte indisponible, coquille servie sans famille', error);
    return null;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const context = await contexteTolerant();
  const reading = currentReadingSize();

  return (
    <html lang="fr" className={READING_ROOT_CLASS[reading]}>
      <body className="min-h-screen">
        {/* Lien d'évitement : on doit pouvoir sauter la navigation au
            clavier. Visible seulement une fois focalisé. */}
        <a
          href="#contenu"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded-sm focus:bg-ink focus:px-4 focus:py-3 focus:text-paper"
        >
          Aller au contenu
        </a>
        <div className="mx-auto flex min-h-screen max-w-reading flex-col px-5">
          <Nav
            familyName={context?.family.name ?? null}
            member={context?.member ?? null}
            inventaire={context?.inventaire ?? null}
          />
          <main id="contenu" className="flex-1 py-8">
            {children}
          </main>
          <footer className="mt-auto flex flex-wrap gap-x-6 gap-y-2 border-t border-rule py-6">
            {/* §6.3 : « Exporter » est visible dans le pied de chaque page.
                À côté, la reddition de comptes — ce que l'algorithme écarte
                (§6.3, Annexe A point 5). Deux liens de même nature : ce que
                la famille possède, et ce que le produit en fait. Aucun des
                deux n'est un lieu où l'on passe tous les jours, et aucun
                n'a donc sa place dans la navigation du haut. */}
            {context ? (
              <>
                {/* Le lien pointait droit sur le JSON. Il mène maintenant à
                    la page qui offre le COFFRE — le fichier qui se lit sans
                    cette application (Annexe A point 7) — et qui donne le
                    JSON seul juste en dessous, pour qui n'a besoin que de
                    lui. Le geste le plus utile passe devant le plus
                    technique ; aucun des deux n'est retiré. */}
                <a href="/sortie" className="justification underline">
                  Exporter la mémoire
                </a>
                <a href="/transmission" className="justification underline">
                  Ce que l’application fait de votre mémoire
                </a>
              </>
            ) : null}
          </footer>
        </div>
        <ServiceWorker />
      </body>
    </html>
  );
}
