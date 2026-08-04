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
          // Pas de géolocalisation, pas de micro sans action explicite : §3.1 entrées interdites.
          { key: 'Permissions-Policy', value: 'geolocation=(), camera=(), microphone=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
