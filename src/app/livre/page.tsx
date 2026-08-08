import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { rassemblerLivre } from '@/services/livre.service';
import { compterImprimes, dateDe, provenanceDe, type Branche } from '@/lib/livre';

export const dynamic = 'force-dynamic';

/**
 * Le livre. Une page, faite pour l'imprimante.
 *
 * Aucune dépendance : le navigateur fabrique le PDF. Un générateur externe
 * ferait dépendre la sortie du produit d'un service qu'on ne contrôle pas —
 * exactement ce que le point 7 refuse.
 *
 * Rien n'est borné ici, et c'est délibéré. Partout ailleurs le produit
 * limite ce qu'il montre (§6.1) ; le livre est la SORTIE, et une sortie
 * incomplète ne libère personne. Le compte imprimé en fin de volume permet
 * de vérifier qu'aucun récit n'a été perdu.
 */
export default async function LivrePage() {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const livre = await rassemblerLivre(context.family.id);

  const imprimes = compterImprimes(livre.branches);

  return (
    <div className="livre">
      <p className="rappel-impression">
        Pour l’imprimer ou en faire un PDF : Fichier → Imprimer. Cette page est composée pour le
        papier ; ce rappel n’y figurera pas.
      </p>

      <section className="page-titre">
        <h1>{context.family.name}</h1>
        <p className="sous-titre">Ce que la famille s’est raconté</p>
      </section>

      {livre.branches.length === 0 ? (
        <p>Ce livre est vide. Il attend une première phrase.</p>
      ) : (
        livre.branches.map((branche) => (
          <BrancheImprimee key={branche.recit.id} branche={branche} profondeur={0} />
        ))
      )}

      {/* ── Ce que ce livre ne dit pas ──
          Amendement 6, en papier. Tous les livres de famille font semblant
          d'être complets. Les manques sont énoncés comme des faits, jamais
          comme des reproches (§6.2). */}
      <section className="trous">
        <h2>Ce que ce livre ne dit pas</h2>
        <p className="avant-propos">
          Un livre de famille donne toujours l’impression d’être complet. Celui-ci ne l’est pas, et
          voici où. Les pages qui suivent ont de la place pour écrire.
        </p>

        {livre.trous.questionsSansReponse.length > 0 ? (
          <section className="questions">
            <h3>Questions restées sans réponse</h3>
            {livre.trous.questionsSansReponse.map((question, index) => (
              <article key={index} className="question">
                <p className="enonce">{question.texte}</p>
                <p className="provenance">
                  Posée par {question.posePar}
                  {question.aPropos ? ` — à propos de « ${question.aPropos} »` : ''}
                </p>
                <div className="lignes" aria-hidden>
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              </article>
            ))}
          </section>
        ) : null}

        {livre.trous.recitsSansDate.length > 0 ? (
          <section>
            <h3>Récits dont on ignore la date</h3>
            <p className="provenance">
              Ces récits ont été notés, mais personne n’a dit quand les faits ont eu lieu. La date
              de saisie n’est pas la date de l’événement, et elle n’a pas été mise à sa place.
            </p>
            <ul className="liste-trous">
              {livre.trous.recitsSansDate.map((recit) => (
                <li key={recit.titre}>{recit.titre}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {livre.trous.membresJamaisMentionnes.length > 0 ? (
          <section>
            <h3>Personnes qu’aucun récit ne mentionne</h3>
            <ul className="liste-trous">
              {livre.trous.membresJamaisMentionnes.map((membre) => (
                <li key={membre.id}>{membre.nom}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {livre.trous.questionsSansReponse.length === 0 &&
        livre.trous.recitsSansDate.length === 0 &&
        livre.trous.membresJamaisMentionnes.length === 0 ? (
          <p>
            Aucune question n’est restée sans réponse, chaque récit porte sa date, et chaque membre
            de la famille apparaît quelque part.
          </p>
        ) : null}
      </section>

      {/* Le compte, pour vérifier qu'aucun récit n'a été perdu à l'impression. */}
      <section className="colophon">
        <p>
          {imprimes} récit{imprimes > 1 ? 's' : ''} imprimé{imprimes > 1 ? 's' : ''} sur{' '}
          {livre.compte.recits} conservé{livre.compte.recits > 1 ? 's' : ''} par la famille{' '}
          {context.family.name}. {livre.compte.liens} récit
          {livre.compte.liens > 1 ? 's sont nés' : ' est né'} d’un autre.
        </p>
        <p>
          Les récits archivés et mis en quarantaine ne figurent pas ici : ils restent dans
          l’application, et dans l’export.
        </p>
      </section>
    </div>
  );
}

function BrancheImprimee({ branche, profondeur }: { branche: Branche; profondeur: number }) {
  const { recit } = branche;
  const date = dateDe(recit);

  return (
    <>
      <article className={profondeur === 0 ? 'recit recit-racine' : 'recit recit-ne'}>
        {profondeur > 0 ? <p className="filiation">Né du récit précédent</p> : null}
        <h2>{recit.titre}</h2>
        <p className="provenance">
          {provenanceDe(recit)}
          {date ? ` · ${date}` : ''}
        </p>
        {recit.contenu.split(/\n{2,}/).map((paragraphe, index) => (
          <p key={index} className="corps">
            {paragraphe}
          </p>
        ))}
        {date === null ? <p className="sans-date">Date de l’événement non renseignée.</p> : null}
      </article>

      {branche.nes.map((ne) => (
        <BrancheImprimee key={ne.recit.id} branche={ne} profondeur={profondeur + 1} />
      ))}
    </>
  );
}
