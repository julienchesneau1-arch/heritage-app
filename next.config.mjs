/** @type {import('next').NextConfig} */
const nextConfig = {
  // Sortie autonome : Next embarque ses dépendances utiles dans .next/standalone.
  // L'image Docker finale n'a plus besoin de node_modules — elle passe de
  // ~1,2 Go à ~200 Mo, ce qui compte sur un VPS à 8 Go de disque.
  output: 'standalone',
  reactStrictMode: true,
  // Exécute src/instrumentation.ts au démarrage du serveur : les secrets de
  // production sont vérifiés avant la première requête.
  experimental: { instrumentationHook: true },
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Sécurité classique — §8.2 de la spec.
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          /*
           * ── `microphone=(self)` INTERDISAIT LE MICRO À L'APPLICATION ──
           *
           * Une liste vide ne veut pas dire « sur action explicite » : elle
           * veut dire PERSONNE, l'origine elle-même comprise. En production,
           * `navigator.mediaDevices.getUserMedia({ audio: true })` levait
           * `NotAllowedError` avant que le navigateur ne demande quoi que ce
           * soit à qui que ce soit.
           *
           * Conséquence : le mode entretien — un écran, une question, un
           * bouton, tout le chemin construit POUR CEUX QUI N'ÉCRIVENT PAS —
           * ne pouvait enregistrer aucun mot une fois déployé. Rien ne le
           * signalait : le bouton s'affichait, on appuyait, il ne se passait
           * rien. Le commentaire d'origine décrivait l'intention (« pas de
           * micro sans action explicite ») ; l'en-tête, lui, disait autre
           * chose, et c'est l'en-tête que le navigateur applique.
           *
           * `(self)` : la page peut demander le micro, et le navigateur
           * demande alors à la personne. C'est bien « sur action explicite »,
           * et cette fois c'est ce qui est écrit.
           *
           * La caméra reste fermée : les photos passent par un champ de
           * fichier, qui ouvre l'appareil photo du téléphone sans passer par
           * cette API. La géolocalisation n'est demandée nulle part — §3.1.
           *
           * Constaté en appelant `getUserMedia` dans un vrai navigateur, pas
           * en relisant la chaîne : `NotAllowedError — Permission denied`,
           * `document.featurePolicy.allowsFeature('microphone') === false`.
           */
          { key: 'Permissions-Policy', value: 'geolocation=(), camera=(), microphone=(self)' },
        ],
      },
    ];
  },
};

export default nextConfig;
