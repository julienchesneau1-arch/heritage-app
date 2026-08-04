import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { familyService } from '@/services/family.service';
import { addMember, removeMember, revokeMemberLink, updateMember } from '@/app/actions';
import { signFamilyToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * La famille : qui la compose, et par quel lien chacun y accède.
 *
 * Deux liens, deux niveaux. Le lien familial ouvre la mémoire à qui le
 * détient. Le lien personnel prouve qui l'on est — c'est le seul qui
 * autorise à supprimer ses propres récits, et le seul qui se révoque
 * individuellement.
 */
export default async function FamilyPage({
  searchParams,
}: {
  searchParams: { bienvenue?: string; erreur?: string };
}) {
  const context = await loadContext();
  if (!context) redirect('/commencer');

  const members = await prisma.member.findMany({
    where: { familyId: context.family.id, isDeleted: false },
    orderBy: [{ generation: 'asc' }, { name: 'asc' }],
  });

  const links = await Promise.all(
    members.map(async (member) => ({
      id: member.id,
      path: await familyService.personalLink(context.family.id, member.id),
      calendar: await familyService.calendarLink(context.family.id, member.id),
    })),
  );
  const linkById = new Map(links.map((link) => [link.id, link.path]));
  const calendarById = new Map(links.map((link) => [link.id, link.calendar]));

  return (
    <div className="space-y-10">
      <h1 className="text-2xl">Famille {context.family.name}</h1>

      {searchParams.bienvenue ? (
        <p className="leading-relaxed">
          La mémoire est ouverte. Ajoutez maintenant les vôtres, puis transmettez à chacun son lien
          personnel.
        </p>
      ) : null}
      {searchParams.erreur ? (
        <p className="justification text-accent">
          Ce membre n’a pas pu être enregistré : nom manquant, ou dates incohérentes.
        </p>
      ) : null}

      <section className="space-y-3">
        <h2 className="section-label">Le lien de la famille</h2>
        <p className="justification break-all">/f/{context.family.id}</p>
        <p className="justification">
          Il donne accès à la mémoire, et permet de se déclarer membre. Il ne permet pas de supprimer.
          Quiconque le détient entre — ne le publiez nulle part.
        </p>
        <p className="justification break-all">
          Jeton de secours (si le cookie est perdu) : {signFamilyToken(context.family.id).slice(0, 16)}…
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="section-label">Les membres</h2>
        <ul className="divide-y divide-rule border-y border-rule">
          {members.map((member) => (
            <li key={member.id} className="space-y-3 py-5">
              <form action={updateMember} className="space-y-3">
                <input type="hidden" name="memberId" value={member.id} />
                <div className="flex flex-wrap gap-3">
                  <div className="min-w-[12rem] flex-1 space-y-1">
                    <label htmlFor={`n-${member.id}`} className="section-label block">
                      Nom
                    </label>
                    <input
                      id={`n-${member.id}`}
                      name="name"
                      defaultValue={member.name}
                      required
                      className="min-h-[44px] w-full rounded-sm border border-rule bg-transparent px-3 font-sans"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`g-${member.id}`} className="section-label block">
                      Génération
                    </label>
                    <input
                      id={`g-${member.id}`}
                      name="generation"
                      type="number"
                      min={1}
                      max={10}
                      defaultValue={member.generation}
                      className="min-h-[44px] w-20 rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-3">
                  <div className="space-y-1">
                    <label htmlFor={`b-${member.id}`} className="section-label block">
                      Naissance
                    </label>
                    <input
                      id={`b-${member.id}`}
                      name="birthDate"
                      type="date"
                      defaultValue={member.birthDate?.toISOString().split('T')[0] ?? ''}
                      className="min-h-[44px] rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`d-${member.id}`} className="section-label block">
                      Décès
                    </label>
                    <input
                      id={`d-${member.id}`}
                      name="deathDate"
                      type="date"
                      defaultValue={member.deathDate?.toISOString().split('T')[0] ?? ''}
                      className="min-h-[44px] rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
                    />
                  </div>
                  <div className="min-w-[12rem] flex-1 space-y-1">
                    <label htmlFor={`r-${member.id}`} className="section-label block">
                      En un mot
                    </label>
                    <input
                      id={`r-${member.id}`}
                      name="role"
                      defaultValue={member.role ?? ''}
                      className="min-h-[44px] w-full rounded-sm border border-rule bg-transparent px-3 font-sans text-sm"
                    />
                  </div>
                </div>

                <button type="submit" className="btn">
                  Enregistrer
                </button>
              </form>

              <p className="justification break-all">
                Lien personnel : {linkById.get(member.id) ?? '—'}
              </p>
              <p className="justification break-all">
                Calendrier : {calendarById.get(member.id) ?? '—'}
              </p>

              <div className="flex flex-wrap items-center gap-4">
                <form action={revokeMemberLink}>
                  <input type="hidden" name="memberId" value={member.id} />
                  <button type="submit" className="justification underline">
                    Révoquer ce lien
                  </button>
                </form>
                {/* §2.1 règle 1 : les récits restent, l'auteur s'anonymise. */}
                <form action={removeMember}>
                  <input type="hidden" name="memberId" value={member.id} />
                  <button type="submit" className="justification underline">
                    Retirer de la famille
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
        <p className="justification">
          Révoquer un lien n’affecte que ce membre : les autres restent connectés. Retirer quelqu’un ne
          supprime aucun récit — l’auteur devient « Auteur anonymisé ».
        </p>
      </section>

      <section className="space-y-3 border-t border-rule pt-6">
        <h2 className="section-label">Reprendre une conversation existante</h2>
        <p className="leading-relaxed">
          Des années d’échanges dorment dans un groupe WhatsApp. Vous pouvez en garder ce qui mérite
          de rester — le fichier est lu sur votre appareil, jamais envoyé.
        </p>
        <p className="justification">
          <Link href="/importer" className="underline">
            Importer une conversation
          </Link>
        </p>
      </section>

      <section className="space-y-3 border-t border-rule pt-6">
        <h2 className="section-label">Le calendrier de la famille</h2>
        <p className="leading-relaxed">
          Les dates de la famille — naissances, disparitions, traditions, événements racontés —
          peuvent être suivies depuis l’agenda que vous utilisez déjà. Chacun ajoute son adresse de
          calendrier ci-dessus, une fois. Elle se met à jour toute seule.
        </p>
        <p className="justification">
          N’y figurent que des dates saisies par la famille. Rien n’en est déduit, et la date de
          création d’un récit n’y entre pas : l’application ne se fabrique pas d’occasions.
        </p>
        {/* Ce que l'on donne à Google en s'abonnant doit être dit avant, pas
            découvert après. Une app de mémoire intime qui exporte vers un
            tiers sans le dire trahirait sa promesse en silence. */}
        <p className="justification">
          À savoir avant de vous abonner : votre agenda copie ce calendrier sur ses propres serveurs.
          Les noms de la famille et les titres des récits y seront donc lisibles par le fournisseur de
          cet agenda — Google, Apple ou un autre. <strong>Le texte des récits n’y figure jamais.</strong>{' '}
          L’adresse tient lieu de mot de passe : ne la publiez pas. « Révoquer ce lien » coupe aussi
          le calendrier.
        </p>
      </section>

      <section className="space-y-4 border-t border-rule pt-6">
        <h2 className="section-label">Ajouter un membre</h2>
        <form action={addMember} className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <div className="min-w-[12rem] flex-1 space-y-1">
              <label htmlFor="new-name" className="section-label block">
                Nom et prénom
              </label>
              <input
                id="new-name"
                name="name"
                required
                className="min-h-[44px] w-full rounded-sm border border-rule bg-transparent px-3 font-sans"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="new-generation" className="section-label block">
                Génération
              </label>
              <input
                id="new-generation"
                name="generation"
                type="number"
                min={1}
                max={10}
                defaultValue={2}
                className="min-h-[44px] w-20 rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="space-y-1">
              <label htmlFor="new-birth" className="section-label block">
                Naissance
              </label>
              <input
                id="new-birth"
                name="birthDate"
                type="date"
                className="min-h-[44px] rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="new-death" className="section-label block">
                Décès
              </label>
              <input
                id="new-death"
                name="deathDate"
                type="date"
                className="min-h-[44px] rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
              />
            </div>
          </div>

          <button type="submit" className="btn-primary">
            Ajouter
          </button>
        </form>
      </section>
    </div>
  );
}
