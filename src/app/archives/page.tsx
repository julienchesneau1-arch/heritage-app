import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { nomAffiche, QUI } from '@/lib/deces';
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
      uploader: { select: QUI },
      story: { select: { id: true, title: true } },
    },
  });

  return (
    <div className="space-y-8">
      <h1 className="text-[2rem] leading-[1.12]">Archives</h1>

      {archives.length === 0 ? (
        <p className="justification">
          Aucune archive. Les photos et les enregistrements se déposent depuis la page d’un récit.
        </p>
      ) : (
        <ul className="space-y-3">
          {archives.map((archive) => (
            <li key={archive.id} className="carte space-y-2">
              {archive.type === 'PHOTO' ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={`/api/family/${context.family.id}/archives/${archive.id}/file`}
                  alt={archive.title}
                  className="w-full rounded-md border border-rule"
                  loading="lazy"
                />
              ) : null}
              <p className="text-lg">{archive.title}</p>
              <p className="justification">
                {TYPE_LABELS[archive.type] ?? archive.type} · déposé par {nomAffiche(archive.uploader)} ·{' '}
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
