import { prisma } from '@/lib/prisma';
import { assertProductionSecrets } from '@/lib/secrets';

export const dynamic = 'force-dynamic';

/**
 * Sonde de vie, interrogée par le proxy et par l'orchestrateur.
 *
 * Elle vérifie deux choses, parce qu'un serveur qui rend 200 dans ces
 * deux cas est un serveur qui ment :
 *
 *  1. La base répond.
 *  2. Les secrets de production sont réellement configurés. Next journalise
 *     l'erreur d'instrumentation au démarrage mais continue de servir : sans
 *     cette vérification, un déploiement dont la clé manque serait déclaré
 *     sain, et n'échouerait qu'au moment où une famille tente d'entrer.
 *
 * Elle ne divulgue rien : ni version, ni nom de famille, ni compte de
 * récits. Cette route est publique.
 */
/*
 * ── LA SEULE ROUTE QUI N'EST PAS LIMITÉE, ET POURQUOI ──
 *
 * La §8.2 demande 100 req/min par IP sur les routes de l'API. Celle-ci en
 * est exemptée délibérément : c'est la sonde que l'orchestrateur interroge,
 * et il l'interroge depuis une IP unique, sans arrêt. La limiter reviendrait
 * à lui répondre 429 aux heures chargées — c'est-à-dire à lui faire
 * redémarrer un conteneur en bonne santé au moment précis où il sert le
 * plus de monde. Le remède serait la panne.
 *
 * Elle ne coûte rien à servir et ne divulgue rien : deux conditions sans
 * lesquelles cette exemption ne tiendrait pas.
 * `tests/rate-limit.test.ts` la nomme comme exception, pour qu'elle reste
 * un choix et non un oubli.
 */
export async function GET() {

  try {
    assertProductionSecrets();
  } catch (error) {
    return Response.json(
      { statut: 'configuration incomplète', detail: (error as Error).message },
      { status: 503 },
    );
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return Response.json({ statut: 'base injoignable' }, { status: 503 });
  }

  return Response.json({ statut: 'ok' });
}
