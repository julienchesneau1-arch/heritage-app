import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { traditionService } from '@/services/tradition.service';
import { moisJourEnClair } from '@/lib/normalize';
import { createTradition, traditionAction } from '@/app/actions';

export const dynamic = 'force-dynamic';

/**
 * LES TRADITIONS — et ce qu'on a cessé d'en dire.
 *
 * Chaque ligne portait « relevée 3 fois · dernière fois 15 octobre 2024 ».
 * Deux chiffres, deux fautes :
 *
 *  - Un COMPTE d'accomplissements est un score, et la §12 l'interdit sans
 *    exception. Une tarte aux poires faite huit fois ne vaut pas mieux
 *    qu'une faite deux fois.
 *  - Une DATE DE DERNIÈRE FOIS est l'affichage de l'inactivité, que le fil
 *    interdit déjà dans les mêmes termes : « personne n'a parlé depuis
 *    trois semaines » transforme un rythme familial normal en reproche.
 *    Sur une tradition annuelle c'est pire — onze mois sur douze, la ligne
 *    dit à la famille qu'elle est en retard sur elle-même.
 *
 * Cette règle avait été écrite pour le fil et n'en était jamais sortie.
 * `activationCount` et `lastActivatedAt` restent en base : ils servent au
 * Trigger Model à ne pas proposer deux fois la même tradition le même jour.
 * Ils ne sont simplement plus montrés — ce sont des rouages, pas un bilan.
 *
 * Ce qui reste : ce qu'est la tradition, quand elle revient, si elle dort.
 * « Endormir » est le seul verbe qui compte ici — une tradition qui s'arrête
 * n'est pas un échec, et le produit doit avoir un mot pour le dire.
 */

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
    <div className="space-y-6">
      <h1 className="text-[2rem] leading-[1.12]">Traditions</h1>

      {traditions.length === 0 ? (
        <p className="justification">Aucune tradition enregistrée.</p>
      ) : (
        <ul className="space-y-3">
          {traditions.map((tradition) => (
            <li key={tradition.id} className="carte space-y-2">
              <p className="text-lg">{tradition.name}</p>
              <p className="leading-relaxed">{tradition.description}</p>
              <p className="justification">
                {tradition.periodicity === 'annual' && tradition.monthDay
                  ? `Chaque année, ${moisJourEnClair(tradition.monthDay)}`
                  : tradition.periodicity === 'weekly' && tradition.weekDay !== null
                    ? `Chaque ${WEEK_DAYS[tradition.weekDay]}`
                    : 'Chaque mois'}
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

      <section className="carte space-y-4">
        <h2 className="text-xl leading-snug">Ajouter une tradition</h2>
        <form action={createTradition} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="name" className="etiquette">
              Nom
            </label>
            <input
              id="name"
              name="name"
              required
              className="champ"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="description" className="etiquette">
              Description
            </label>
            <textarea
              id="description"
              name="description"
              required
              rows={3}
              className="champ py-3"
            />
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="space-y-1">
              <label htmlFor="periodicity" className="etiquette">
                Périodicité
              </label>
              <select
                id="periodicity"
                name="periodicity"
                defaultValue="annual"
                className="champ w-auto"
              >
                <option value="annual">Annuelle</option>
                <option value="monthly">Mensuelle</option>
                <option value="weekly">Hebdomadaire</option>
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="monthDay" className="etiquette">
                Jour (MM-JJ)
              </label>
              <input
                id="monthDay"
                name="monthDay"
                placeholder="10-15"
                pattern="(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])"
                className="champ w-auto"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="weekDay" className="etiquette">
                Jour de la semaine
              </label>
              <select
                id="weekDay"
                name="weekDay"
                defaultValue=""
                className="champ w-auto"
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
