import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { formatDateFr } from '@/lib/normalize';

export const dynamic = 'force-dynamic';

const TYPE_LABELS: Record<string, string> = {
  PHOTO: 'Photo',
  DOCUMENT: 'Document',
  AUDIO: 'Enregistrement',
  VIDEO: 'Vidéo',
};

export default async function ArchivesPage() {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const archives = await prisma.archive.findMany({
    where: { familyId: context.family.id },
    orderBy: { createdAt: 'desc' },
    include: {
      uploader: { select: { name: true } },
      story: { select: { id: true, title: true } },
    },
  });

  return (
    <div className="space-y-8">
      <h1 className="text-2xl">Archives</h1>

      {archives.length === 0 ? (
        <p className="justification">
          Aucune archive. Les fichiers se déposent sur le stockage familial, puis se rattachent à un récit.
        </p>
      ) : (
        <ul className="divide-y divide-rule border-y border-rule">
          {archives.map((archive) => (
            <li key={archive.id} className="space-y-1 py-4">
              <p className="text-lg">{archive.title}</p>
              <p className="justification">
                {TYPE_LABELS[archive.type] ?? archive.type} · déposé par {archive.uploader.name} ·{' '}
                {formatDateFr(archive.createdAt)} · {Math.round(archive.sizeBytes / 1024)} Ko
              </p>
              {archive.story ? (
                <p className="justification">
                  Rattachée à{' '}
                  <Link href={`/recits/${archive.story.id}`} className="underline">
                    {archive.story.title}
                  </Link>
                </p>
              ) : (
                <p className="justification">Non rattachée à un récit.</p>
              )}
              {archive.extractedText ? (
                <p className="justification">Transcription disponible ({archive.extractedText.length} car.)</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
