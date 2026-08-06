'use client';

/**
 * QUAND QUELQUE CHOSE CASSE — ce que la famille doit lire.
 *
 * Sans ce fichier, Next rend sa propre page : « Application error: a
 * server-side exception has occurred », en anglais, sans un mot sur ce
 * qu'il advient de la mémoire. Constaté en coupant la base de données sur
 * une application en marche — les trois pages essayées ont rendu 500 et
 * cet écran-là.
 *
 * Le comportement technique, lui, est le bon : l'application échoue FERMÉE.
 * Elle ne dit pas « aucun récit », elle ne renvoie pas sur l'accueil comme
 * si la personne n'appartenait à aucune famille. Une panne qui se
 * déguiserait en absence serait bien pire — c'est exactement le défaut
 * corrigé côté stockage.
 *
 * Ce qui manquait est la phrase. Une famille dont le serveur a un hoquet a
 * droit à trois choses, dans cet ordre : que rien n'est perdu, que ce n'est
 * pas de son fait, et quoi faire. Le détail technique vient après, pour qui
 * administre — jamais en premier, et jamais seul.
 */
export default function Erreur({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="space-y-6">
      <h1 className="text-[2rem] leading-[1.12]">Quelque chose n’a pas répondu</h1>

      <p className="text-lg leading-relaxed">
        Vos récits ne sont pas perdus. C’est l’application qui n’a pas réussi à les lire à
        l’instant — la mémoire de votre famille, elle, est là où elle était.
      </p>

      <div className="flex flex-wrap items-center gap-4">
        <button type="button" onClick={reset} className="btn-primary">
          Réessayer
        </button>
        <a href="/" className="btn">
          Revenir à l’accueil
        </a>
      </div>

      <p className="justification">
        Si cela se répète, c’est le serveur qu’il faut regarder, pas ce que vous avez écrit. Une
        sauvegarde quotidienne existe si elle a été mise en place (voir <code>sauvegarde.sh</code>),
        et l’export reste le moyen le plus sûr d’emporter une copie dès que l’application répond de
        nouveau.
      </p>

      {/* L'identifiant technique, pour qui administre. Il ne dit rien à une
          famille, d'où sa place : en dernier, en petit, et nommé. */}
      {error.digest ? (
        <p className="justification">Référence pour l’administrateur : {error.digest}</p>
      ) : null}
    </div>
  );
}
