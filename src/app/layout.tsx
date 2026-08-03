import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Nav } from '@/components/Nav';
import { loadContext } from '@/lib/context';

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

  return (
    <html lang="fr">
      <body className="min-h-screen">
        <div className="mx-auto flex min-h-screen max-w-reading flex-col px-5">
          <Nav familyName={context?.family.name ?? null} member={context?.member ?? null} />
          <main className="flex-1 py-8">{children}</main>
          <footer className="border-t border-rule py-6">
            {/* §6.3 : « Exporter » est visible dans le pied de chaque page. */}
            {context ? (
              <a href={`/api/family/${context.family.id}/export`} className="justification underline">
                Exporter la mémoire
              </a>
            ) : null}
          </footer>
        </div>
      </body>
    </html>
  );
}
