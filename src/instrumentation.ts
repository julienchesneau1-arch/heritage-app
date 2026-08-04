/**
 * Vérifications au démarrage du serveur.
 *
 * La garde de `FAMILY_TOKEN_SECRET` échouait à la première signature, donc à
 * la première visite d'une famille : le déploiement paraissait sain, la page
 * d'accueil répondait 200, et le produit ne révélait le problème qu'au
 * moment où quelqu'un tentait d'entrer. Un exploitant a le droit de savoir
 * tout de suite que sa mise en ligne est inutilisable.
 *
 * On échoue donc ici. Next ne coupe pas le processus pour autant : il
 * journalise la cause exacte et fait échouer CHAQUE requête en 500. Le
 * résultat est le bon — l'application est inutilisable et le dit — mais il
 * faut le savoir : le serveur « démarre », il ne sert simplement rien.
 * `/api/sante` refait la vérification pour que l'orchestrateur marque le
 * conteneur défaillant plutôt que sain.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertProductionSecrets } = await import('@/lib/secrets');
  assertProductionSecrets();
}
