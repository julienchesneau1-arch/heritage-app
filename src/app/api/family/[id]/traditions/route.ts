import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { createTraditionSchema, parseOrNull } from '@/lib/validation';
import { traditionService } from '@/services/tradition.service';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!authorizeFamily(request, params.id)) return apiError('FORBIDDEN');

  const [traditions, activeToday] = await Promise.all([
    prisma.tradition.findMany({ where: { familyId: params.id }, orderBy: { name: 'asc' } }),
    traditionService.getActiveToday(params.id),
  ]);

  return apiOk({ traditions, activeTodayIds: activeToday.map((t) => t.id) });
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  if (!authorizeFamily(request, params.id)) return apiError('FORBIDDEN');

  const { data, errors } = parseOrNull(createTraditionSchema, await request.json().catch(() => null));
  if (!data) return apiError('INVALID_INPUT', errors);

  const tradition = await prisma.tradition.create({
    data: {
      familyId: params.id,
      name: data.name,
      description: data.description,
      periodicity: data.periodicity,
      monthDay: data.monthDay ?? null,
      weekDay: data.weekDay ?? null,
    },
  });

  return apiOk({ id: tradition.id }, 201);
}
