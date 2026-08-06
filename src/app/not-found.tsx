import Link from 'next/link';

/**
 * INTROUVABLE — et la différence avec « supprimé ».
 *
 * Un récit peut être introuvable pour trois raisons très différentes :
 * l'adresse est fausse, il appartient à une autre famille, ou il a été
 * supprimé par son auteur. Le produit ne dit PAS laquelle, et c'est
 * délibéré : distinguer « ce récit n'existe pas » de « ce récit ne vous
 * regarde pas » apprendrait à quiconque tâtonne qu'il existe quelque part.
 *
 * Ce qu'on peut dire sans rien trahir : nous ne l'avons pas trouvé ici, et
 * ce que vous cherchez peut-être se cherche là.
 */
export default function Introuvable() {
  return (
    <div className="space-y-6">
      <h1 className="text-[2rem] leading-[1.12]">Introuvable</h1>
      <p className="text-lg leading-relaxed">
        Cette page n’existe pas dans la mémoire de votre famille.
      </p>
      <p className="justification">
        Une adresse recopiée à la main, un lien vieilli, ou un récit que son auteur a retiré : nous
        ne faisons pas la différence ici, et c’est volontaire — dire lequel des trois reviendrait à
        renseigner qui tâtonne.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Link href="/" className="btn-primary">
          Aujourd’hui
        </Link>
        <Link href="/recits" className="btn">
          Chercher dans les récits
        </Link>
      </div>
    </div>
  );
}
