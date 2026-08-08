import { NextRequest } from 'next/server';
import { apiError } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { limiteParIp } from '@/lib/rate-limit';
import { exportService } from '@/services/export.service';
import { rassemblerLivre } from '@/services/livre.service';
import { fabriquerCoffre } from '@/lib/coffre';

export const dynamic = 'force-dynamic';

/**
 * GET — LE COFFRE. Un fichier, et l'application peut disparaître.
 *
 * L'export rend le JSON, le livre s'imprime : les deux existent, et les
 * deux exigent que ce serveur réponde. L'Annexe A point 7 demande que la
 * famille continue « sans l'app » — ce fichier-ci est le seul objet du
 * produit dont ce soit vrai à la lettre.
 *
 * Voir `src/lib/coffre.ts` pour ce qu'il contient et pourquoi.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const donnees = await exportService.exportFamily(params.id);
  if (!donnees) return apiError('NOT_FOUND');

  const livre = await rassemblerLivre(params.id);

  const html = fabriquerCoffre({
    nomFamille: donnees.family.name,
    livre,
    donnees,
    // Les mêmes réserves que l'export, mot pour mot : deux listes
    // divergeraient, et le coffre finirait par promettre autre chose que
    // ce que le fichier contient.
    nonInclus: Object.values(donnees.nonInclus),
    fabriqueLe: new Date(),
  });

  const nom = `memoire-${slug(donnees.family.name)}-${new Date().toISOString().slice(0, 10)}.html`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="${nom}"`,
      'Cache-Control': 'no-store',
    },
  });
}

function slug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
