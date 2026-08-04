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
