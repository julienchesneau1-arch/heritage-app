import { compterImprimes, dateDe, provenanceDe, type Branche, type Livre } from './livre';

/**
 * LE COFFRE — un seul fichier, et l'application peut disparaître.
 *
 * L'Annexe A point 7 dit que « le succès ultime est que la famille continue
 * de transmettre sans l'app ». Le produit tient cette phrase à moitié :
 * `/livre` s'imprime, `/api/family/:id/export` rend le JSON. Les deux
 * exigent que le serveur réponde, donc que quelqu'un le paie, le
 * maintienne, et soit encore là.
 *
 * C'est le risque dominant de ce produit, et aucun test ne le couvre : une
 * mémoire qui promet cinquante ans repose aujourd'hui sur la présence
 * continue d'une seule personne. Le jour où elle s'arrête, tout s'arrête.
 *
 * ── CE QUE CE FICHIER EST ──
 *
 * Un HTML autonome, sans script, sans requête, sans police distante. Il
 * s'ouvre dans n'importe quel navigateur, sur une machine déconnectée, en
 * 2050. Il porte DEUX choses dans le même fichier :
 *
 *  · LE LIVRE, lisible par un humain — la mémoire telle qu'elle se lit,
 *    par filiation, avec ses trous imprimés (§5.2 ter) ;
 *  · L'EXPORT, lisible par une machine — le JSON complet, dans une balise
 *    `<script type="application/json">`, que le navigateur n'exécute pas et
 *    qu'un programme retrouve en trois lignes.
 *
 * Le second point est le plus important et le moins visible. Un PDF se lit
 * mais ne se relit pas : on ne réimporte pas une mémoire depuis une image
 * de page. Ici, le même fichier sert au petit-fils qui lit et au programme
 * qui, dans vingt ans, voudra la reprendre.
 *
 * ── CE QU'IL N'A PAS ──
 *
 * Aucun renvoi vers l'écran, comme le livre (§5.2 ter) : ni adresse, ni
 * code à scanner. Un objet qui ramène vers l'application n'affranchit de
 * rien. Et aucun script : un fichier qui exécute du code est un fichier
 * dont on ne sait pas ce qu'il fera dans vingt ans.
 */

/** La version du format porté par le coffre. Elle voyage AVEC le fichier. */
export const FORMAT_COFFRE = 'heritage-coffre-1';

export interface CoffreEntree {
  nomFamille: string;
  livre: Livre;
  /** L'export tel que `ExportService` le rend. Recopié sans traitement. */
  donnees: unknown;
  /** Ce que l'export ne contient pas, et pourquoi. Déjà décidé ailleurs. */
  nonInclus: readonly string[];
  fabriqueLe: Date;
}

/** Le texte n'entre jamais dans le HTML sans passer par là. */
function echapper(texte: string): string {
  return texte
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Le JSON embarqué.
 *
 * `</script>` à l'intérieur d'une chaîne fermerait la balise et casserait
 * le fichier — c'est la faute classique, et elle est silencieuse : le
 * fichier s'ouvre, le livre s'affiche, et seul le programme qui viendra
 * relire les données découvrira qu'elles sont tronquées. On neutralise donc
 * le chevron, d'une manière que `JSON.parse` défait tout seul.
 */
function jsonEmbarque(donnees: unknown): string {
  return JSON.stringify(donnees).replace(/</g, '\\u003c');
}

function brancheHtml(branche: Branche, profondeur: number): string {
  const r = branche.recit;
  const date = dateDe(r);
  const nes = branche.nes.map((n) => brancheHtml(n, profondeur + 1)).join('');
  return `
<article class="recit p${Math.min(profondeur, 4)}">
  <h3>${echapper(r.titre)}</h3>
  <p class="provenance">${echapper(provenanceDe(r))}${date ? ` · ${echapper(date)}` : ''}</p>
  <div class="texte">${echapper(r.contenu)
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => `<p>${l}</p>`)
    .join('')}</div>
  ${nes ? `<div class="nes"><p class="filiation">Ce récit en a fait naître :</p>${nes}</div>` : ''}
</article>`;
}

/**
 * Fabrique le coffre. Fonction pure : aucune base, aucun réseau, aucune
 * date implicite — tout entre par le paramètre, ce qui la rend vérifiable.
 */
export function fabriquerCoffre(entree: CoffreEntree): string {
  const { nomFamille, livre, donnees, nonInclus, fabriqueLe } = entree;
  const imprimes = compterImprimes(livre.branches);
  const jour = fabriqueLe.toISOString().slice(0, 10);

  const trous = livre.trous;
  const questions = trous.questionsSansReponse
    .map(
      (q) => `<li><p class="question">« ${echapper(q.texte)} »</p>
      <p class="provenance">Posée par ${echapper(q.posePar)}${q.aPropos ? ` · à propos de ${echapper(q.aPropos)}` : ''}</p>
      <div class="lignes"><span></span><span></span><span></span></div></li>`,
    )
    .join('');

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mémoire de la famille ${echapper(nomFamille)}</title>
<style>
  /* Aucune police distante : ce fichier doit s'ouvrir sans réseau. */
  html { font-family: Georgia, 'Times New Roman', serif; font-size: 17px; }
  body { max-width: 40rem; margin: 0 auto; padding: 2rem 1.25rem 6rem; line-height: 1.65; color: #1a1714; background: #fbf9f6; }
  h1 { font-size: 2rem; line-height: 1.15; margin: 0 0 .25rem; }
  h2 { font-size: 1.3rem; margin: 3rem 0 1rem; border-bottom: 1px solid #d8d0c4; padding-bottom: .4rem; }
  h3 { font-size: 1.1rem; margin: 0 0 .2rem; }
  .provenance, .justification { color: #6b6257; font-size: .9rem; margin: 0 0 .6rem; }
  .recit { margin: 0 0 2rem; }
  .nes { margin-top: 1.2rem; padding-left: 1.1rem; border-left: 2px solid #d8d0c4; }
  .filiation { color: #6b6257; font-size: .85rem; margin: 0 0 .8rem; }
  .lignes span { display: block; border-bottom: 1px solid #cfc6b8; height: 1.6rem; }
  .avis { background: #f2ece2; border: 1px solid #d8d0c4; padding: 1rem 1.1rem; margin: 2rem 0; }
  .avis p { margin: 0 0 .6rem; } .avis p:last-child { margin: 0; }
  ul { padding-left: 1.1rem; } li { margin-bottom: 1.2rem; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .85em; background: #f2ece2; padding: .1em .3em; }
  @media print {
    html { font-size: 11pt; } body { max-width: none; background: #fff; padding: 0; }
    .recit { break-inside: avoid; } h2 { break-after: avoid; }
  }
</style>
</head>
<body>

<h1>Mémoire de la famille ${echapper(nomFamille)}</h1>
<p class="provenance">Coffre fabriqué le ${echapper(jour)}.</p>

<div class="avis">
  <p><strong>Ce fichier se suffit à lui-même.</strong> Il n’a besoin d’aucun
  serveur, d’aucune connexion et d’aucun logiciel particulier : un
  navigateur suffit, aujourd’hui comme dans trente ans. Copiez-le, imprimez-le,
  donnez-le.</p>
  <p>Il contient aussi, invisible à la lecture, <strong>toutes les données de
  la famille</strong> au format <code>${FORMAT_COFFRE}</code> — de quoi
  reprendre cette mémoire dans un autre programme. Elles sont dans la balise
  <code>&lt;script id="heritage-donnees"&gt;</code> à la fin du fichier :
  ouvrez-le avec un éditeur de texte, ou lisez-la avec n’importe quel
  langage. Ce n’est pas du code, ce sont des données ; le navigateur ne
  l’exécute pas.</p>
</div>

<h2>Les récits, par filiation</h2>
${livre.branches.map((b) => brancheHtml(b, 0)).join('')}

${
  questions
    ? `<h2>Ce que personne n’a encore raconté</h2>
<p class="provenance">Des questions posées dans la famille, restées sans réponse. Les lignes sont là pour y répondre à la main.</p>
<ul>${questions}</ul>`
    : ''
}

${
  trous.recitsSansDate.length > 0
    ? `<h2>Récits dont la date de l’événement manque</h2>
<p class="provenance">La date de saisie n’est jamais mise à la place de celle de l’événement.</p>
<ul>${trous.recitsSansDate.map((r) => `<li>${echapper(r.titre)}</li>`).join('')}</ul>`
    : ''
}

${
  trous.membresJamaisMentionnes.length > 0
    ? `<h2>Personnes qu’aucun récit ne mentionne</h2>
<ul>${trous.membresJamaisMentionnes.map((m) => `<li>${echapper(m.nom)}</li>`).join('')}</ul>`
    : ''
}

<h2>Ce que ce coffre ne contient pas</h2>
<ul>${nonInclus.map((l) => `<li>${echapper(l)}</li>`).join('')}</ul>

<h2>Colophon</h2>
<p class="provenance">
  ${imprimes} récit${imprimes > 1 ? 's' : ''} imprimé${imprimes > 1 ? 's' : ''}
  sur ${livre.compte.recits} conservé${livre.compte.recits > 1 ? 's' : ''} ·
  ${livre.compte.racines} racine${livre.compte.racines > 1 ? 's' : ''} ·
  ${livre.compte.liens} lien${livre.compte.liens > 1 ? 's' : ''} de filiation.
  Format <code>${FORMAT_COFFRE}</code>.
</p>

<script type="application/json" id="heritage-donnees">${jsonEmbarque({
    format: FORMAT_COFFRE,
    fabriqueLe: fabriqueLe.toISOString(),
    famille: nomFamille,
    nonInclus,
    donnees,
  })}</script>
</body>
</html>`;
}
