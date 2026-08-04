import { NextRequest } from 'next/server';
import { apiError } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { exportService } from '@/services/export.service';

export const dynamic = 'force-dynamic';

/**
 * GET — Amendement 3 : la famille possède ses données.
 * Export complet, sans traitement, sans filtre, en téléchargement direct.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const data = await exportService.exportFamily(params.id);
  if (!data) return apiError('NOT_FOUND');

  const filename = `heritage-${slug(data.family.name)}-${new Date().toISOString().split('T')[0]}.json`;

  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
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
    .replace(/(^-|-$)/g, '');
}
