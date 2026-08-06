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
    // L'aplat terre cuite déborde la colonne et va toucher les bords : un
    // bloc de couleur encadré de crème n'est plus un aplat, c'est une boîte.
    // Il descend jusqu'en bas de l'écran — cet écran n'a rien d'autre à
    // montrer, et un aplat qui s'arrête au milieu laisse une page inachevée.
    <div className="aplat -mt-8 flex min-h-[70vh] flex-col bg-accent-700 pb-10">
      <div className="relative space-y-5 overflow-hidden pt-8">
        {/* Décor. Il ne dit rien, donc il ne doit rien annoncer. */}
        <span
          aria-hidden="true"
          className="rond -right-16 -top-16 h-52 w-52 bg-sauge-600"
        />
        <h1 className="relative text-[2.4rem] leading-[1.08] text-accent-100">
          {PREMIER_JOUR.quoi(familyName)}
        </h1>
        <p className="lire relative text-accent-100">{PREMIER_JOUR.comment}</p>
        <p className="justification-claire relative">{PREMIER_JOUR.rassurance}</p>
      </div>

      {memberId ? (
        <div className="mt-8 space-y-5">
          {/* La carte crème posée sur l'aplat : le contenu qu'on manipule se
              distingue du fond par la matière, pas par un filet. */}
          <div className="carte">
            <ChampDeParole
              members={members}
              memberId={memberId}
              retour="/"
              label={PREMIER_JOUR.action}
            />
          </div>
          {/* Une seule ACTION sur cet écran (§6.1), mais deux chemins pour y
              venir : celui qui commence quelque chose, et celui qui reprend
              ce qui existe déjà. Le second n'est pas un bouton — il ne
              rivalise pas avec le premier. */}
          <p className="justification-claire">
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
