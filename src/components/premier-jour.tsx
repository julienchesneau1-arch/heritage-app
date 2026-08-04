import Link from 'next/link';
import { ChampDeParole } from '@/components/fil';
import { PREMIER_JOUR } from '@/lib/sections';

/**
 * LE PREMIER JOUR.
 *
 * Une famille qui arrive voyait ceci : le nom de la famille, et rien.
 * Zéro récit, donc zéro Passeur, zéro signal — la parcimonie, parfaitement
 * appliquée, produisait un écran muet. Le principe est juste pour une
 * mémoire installée ; il est mortel pour une mémoire qui commence.
 *
 * Trois lignes, dans cet ordre, et rien d'autre :
 *   1. ce que c'est,
 *   2. comment ça marche,
 *   3. quoi faire maintenant.
 *
 * ── Ce que la Constitution interdit ici ──
 *
 * §6.2 interdit « Vous n'avez pas… » et « Il y a longtemps que… ». On ne
 * dit donc jamais à cette famille qu'elle n'a rien écrit : on lui dit ce
 * qu'est l'endroit où elle vient d'entrer. La différence n'est pas
 * cosmétique — l'une constate un manque, l'autre décrit un lieu.
 *
 * §6.1 interdit plus d'une suggestion par écran. Il y a donc UNE action :
 * parler. Pas de visite guidée, pas de liste de fonctionnalités, pas de
 * cases à cocher pour « compléter son profil ».
 */
export function PremierJour({
  familyName,
  members,
  memberId,
}: {
  familyName: string;
  members: Array<{ id: string; name: string }>;
  memberId: string | null;
}) {
  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h1 className="text-2xl leading-snug">{PREMIER_JOUR.quoi(familyName)}</h1>
        <p className="text-lg leading-relaxed">{PREMIER_JOUR.comment}</p>
        <p className="justification">{PREMIER_JOUR.rassurance}</p>
      </div>

      {memberId ? (
        <div className="space-y-4 border-t border-rule pt-6">
          <ChampDeParole
            members={members}
            memberId={memberId}
            retour="/"
            label={PREMIER_JOUR.action}
          />
          {/* Une seule ACTION sur cet écran (§6.1), mais deux chemins pour y
              venir : celui qui commence quelque chose, et celui qui reprend
              ce qui existe déjà. Le second n'est pas un bouton — il ne
              rivalise pas avec le premier. */}
          <p className="justification">
            {PREMIER_JOUR.autreChemin}{' '}
            <Link href="/importer" className="underline">
              Reprendre une conversation existante
            </Link>
          </p>
        </div>
      ) : null}
    </div>
  );
}
