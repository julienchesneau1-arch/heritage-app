import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { traditionService } from '@/services/tradition.service';
import { formatDateFr } from '@/lib/normalize';
import { createTradition, traditionAction } from '@/app/actions';

export const dynamic = 'force-dynamic';

const WEEK_DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

export default async function TraditionsPage() {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const [traditions, activeToday] = await Promise.all([
    prisma.tradition.findMany({ where: { familyId: context.family.id }, orderBy: { name: 'asc' } }),
    traditionService.getActiveToday(context.family.id),
  ]);
  const activeIds = new Set(activeToday.map((t) => t.id));

  return (
    <div className="space-y-10">
      <h1 className="text-2xl">Traditions</h1>

      {traditions.length === 0 ? (
        <p className="justification">Aucune tradition enregistrée.</p>
      ) : (
        <ul className="divide-y divide-rule border-y border-rule">
          {traditions.map((tradition) => (
            <li key={tradition.id} className="space-y-2 py-4">
              <p className="text-lg">{tradition.name}</p>
              <p className="leading-relaxed">{tradition.description}</p>
              <p className="justification">
                {tradition.periodicity === 'annual' && tradition.monthDay
                  ? `Chaque année, le ${tradition.monthDay}`
                  : tradition.periodicity === 'weekly' && tradition.weekDay !== null
                    ? `Chaque ${WEEK_DAYS[tradition.weekDay]}`
                    : 'Chaque mois'}
                {' · '}
                relevée {tradition.activationCount} fois
                {tradition.lastActivatedAt ? ` · dernière fois ${formatDateFr(tradition.lastActivatedAt)}` : ''}
                {tradition.isAsleep ? ` · endormie (${tradition.sleepReason ?? 'sans raison notée'})` : ''}
              </p>

              <div className="flex flex-wrap items-center gap-3">
                {activeIds.has(tradition.id) ? (
                  <form action={traditionAction}>
                    <input type="hidden" name="traditionId" value={tradition.id} />
                    <input type="hidden" name="action" value="activate" />
                    <button type="submit" className="btn">
                      Nous l’avons faite
                    </button>
                  </form>
                ) : null}

                <form action={traditionAction}>
                  <input type="hidden" name="traditionId" value={tradition.id} />
                  <input type="hidden" name="action" value={tradition.isAsleep ? 'wake' : 'sleep'} />
                  <button type="submit" className="justification underline">
                    {tradition.isAsleep ? 'Réveiller' : 'Endormir'}
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="space-y-4 border-t border-rule pt-6">
        <h2 className="section-label">Ajouter une tradition</h2>
        <form action={createTradition} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="name" className="section-label block">
              Nom
            </label>
            <input
              id="name"
              name="name"
              required
              className="min-h-[44px] w-full rounded-sm border border-rule bg-transparent px-3 font-sans"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="description" className="section-label block">
              Description
            </label>
            <textarea
              id="description"
              name="description"
              required
              rows={3}
              className="w-full rounded-sm border border-rule bg-transparent p-2 font-sans text-sm"
            />
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="space-y-1">
              <label htmlFor="periodicity" className="section-label block">
                Périodicité
              </label>
              <select
                id="periodicity"
                name="periodicity"
                defaultValue="annual"
                className="min-h-[44px] rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
              >
                <option value="annual">Annuelle</option>
                <option value="monthly">Mensuelle</option>
                <option value="weekly">Hebdomadaire</option>
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="monthDay" className="section-label block">
                Jour (MM-JJ)
              </label>
              <input
                id="monthDay"
                name="monthDay"
                placeholder="10-15"
                pattern="(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])"
                className="min-h-[44px] rounded-sm border border-rule bg-transparent px-3 font-sans text-sm"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="weekDay" className="section-label block">
                Jour de la semaine
              </label>
              <select
                id="weekDay"
                name="weekDay"
                defaultValue=""
                className="min-h-[44px] rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
              >
                <option value="">—</option>
                {WEEK_DAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button type="submit" className="btn-primary">
            Enregistrer
          </button>
        </form>
      </section>
    </div>
  );
}
