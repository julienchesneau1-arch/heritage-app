export const metadata = { title: 'Hors ligne — Héritage' };

/** Servie par le Service Worker quand le réseau manque et que rien n'est en cache. */
export default function OfflinePage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl">Hors ligne</h1>
      <p className="leading-relaxed">
        Cette page n’a pas encore été consultée sur cet appareil, et le réseau ne répond pas.
      </p>
      <p className="justification">
        Les récits déjà lus ici restent accessibles. Le reste attendra le retour de la connexion.
      </p>
    </div>
  );
}
