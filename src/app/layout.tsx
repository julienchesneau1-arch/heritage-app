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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const context = await loadContext();
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
                <a href={`/api/family/${context.family.id}/export`} className="justification underline">
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
