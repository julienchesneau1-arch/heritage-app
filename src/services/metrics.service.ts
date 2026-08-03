import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';

/**
 * MÉTRIQUES — §9.
 *
 * North Star : transmission_rate = histoires ayant engendré au moins une
 * autre histoire / total histoires.
 *
 * Nuance importante : la spec écrit `passages_count / stories_count`, mais
 * définit la primitive comme « histoires ayant engendré au moins une autre ».
 * Une histoire qui en engendre trois ne vaut pas 300 %. On compte donc les
 * PARENTS DISTINCTS — et on expose aussi le ratio brut pour comparaison.
 */

export interface TransmissionMetrics {
  storiesCount: number;
  passagesCount: number;
  /** Part des récits ayant engendré au moins un autre récit. 0-1. */
  transmissionRate: number;
  /** passages / stories, tel qu'écrit littéralement dans la spec. 0-n. */
  rawPassageRatio: number;
  /** Latence médiane, en jours, entre un récit et celui qu'il engendre. */
  medianLatencyDays: number | null;
  /** Plus longue chaîne de transmission (nombre de récits). */
  maxChainDepth: number;
  conversationsTotal: number;
  conversationsAnswered: number;
  conversationsConverted: number;
  /** Part des conversations devenues un récit. 0-1. */
  passeurConversion: number;
}

export class MetricsService {
  constructor(private prisma: PrismaClient = defaultPrisma) {}

  async transmission(familyId: string): Promise<TransmissionMetrics> {
    const [storiesCount, passages, conversations] = await Promise.all([
      this.prisma.story.count({ where: { familyId } }),
      this.prisma.passage.findMany({
        where: { familyId },
        select: { parentStoryId: true, childStoryId: true, latencyDays: true },
      }),
      this.prisma.conversation.groupBy({ by: ['status'], where: { familyId }, _count: { status: true } }),
    ]);

    const distinctParents = new Set(passages.map((p) => p.parentStoryId));
    const latencies = passages.map((p) => p.latencyDays).sort((a, b) => a - b);

    const byStatus = new Map(conversations.map((c) => [c.status, c._count.status]));
    const conversationsTotal = [...byStatus.values()].reduce((sum, n) => sum + n, 0);
    const converted = byStatus.get('converted') ?? 0;

    return {
      storiesCount,
      passagesCount: passages.length,
      transmissionRate: storiesCount === 0 ? 0 : distinctParents.size / storiesCount,
      rawPassageRatio: storiesCount === 0 ? 0 : passages.length / storiesCount,
      medianLatencyDays: median(latencies),
      maxChainDepth: longestChain(passages),
      conversationsTotal,
      conversationsAnswered: byStatus.get('answered') ?? 0,
      conversationsConverted: converted,
      passeurConversion: conversationsTotal === 0 ? 0 : converted / conversationsTotal,
    };
  }
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!;
}

/**
 * Profondeur de la plus longue chaîne parent → enfant.
 * Le graphe des passages peut contenir des cycles (A engendre B, B rappelle A) :
 * la traversée mémorise les nœuds du chemin courant pour ne jamais boucler.
 */
function longestChain(passages: Array<{ parentStoryId: string; childStoryId: string }>): number {
  if (passages.length === 0) return 0;

  const children = new Map<string, string[]>();
  for (const passage of passages) {
    const list = children.get(passage.parentStoryId) ?? [];
    list.push(passage.childStoryId);
    children.set(passage.parentStoryId, list);
  }

  // Pas de mémoïsation : une profondeur calculée sous un chemin donné n'est
  // pas réutilisable sous un autre quand le graphe contient des cycles.
  function depth(node: string, path: Set<string>): number {
    if (path.has(node)) return 0; // cycle : on s'arrête
    path.add(node);
    let best = 0;
    for (const child of children.get(node) ?? []) best = Math.max(best, depth(child, path));
    path.delete(node);
    return best + 1;
  }

  let max = 0;
  for (const node of children.keys()) max = Math.max(max, depth(node, new Set()));
  return max;
}

export const metricsService = new MetricsService();
