/**
 * UPDATE ENGINE — le LAB, et ce qu'il n'a pas. `docs/07 §5`. Phase 7.
 *
 * > *« Le LAB n'a jamais accès aux secrets de production. C'est la propriété
 * > qui rend l'ensemble sûr : une mise à jour malveillante testée dans le LAB
 * > ne peut rien exfiltrer, parce qu'il n'y a rien à exfiltrer. »*
 *
 * C'EST UNE PROPRIÉTÉ DE CONSTRUCTION, PAS UNE RÈGLE DE CONDUITE
 * ---------------------------------------------------------------------------
 * On pourrait « faire attention à ne pas passer le coffre de production au
 * LAB ». Ce dépôt a démontré huit fois ce que valent les protections tenues
 * par la vigilance : `docs/26 §2` les recense.
 *
 * Le coffre du LAB **refuse tout**, quoi qu'on lui demande et quoi qu'il y ait
 * dans l'environnement. Il n'y a donc rien à oublier, et rien à contourner.
 *
 * ⚠ POURQUOI IL REFUSE AU LIEU DE RENDRE DES FAUX SECRETS
 * ---------------------------------------------------------------------------
 * La tentation est forte : rendre `"faux-jeton"` permettrait aux tests du LAB
 * d'aller plus loin. Elle est refusée pour une raison qui a un nom dans ce
 * dépôt.
 *
 * Un faux secret laisse l'appelant croire qu'il a un secret. Il tenterait
 * alors l'appel réseau, échouerait à l'authentification, et le LAB
 * rapporterait un échec de FOURNISSEUR là où il y a une absence de SECRET —
 * `docs/26 §4.7` et ADR-043 : *« un agenda vide et un agenda inaccessible se
 * ressemblent, et se racontent différemment. »*
 *
 * Pire : un artefact malveillant testé dans le LAB apprendrait la FORME de nos
 * secrets — quels noms existent, lesquels sont attendus — ce qui est déjà une
 * information.
 *
 * Le refus est donc explicite et nommé : `SECRET_INDISPONIBLE_EN_LAB`.
 */
import { err, jarvisError, type Result } from '../types/result.js';
import type { Secret, SecretVault } from '../secrets/vault.js';

/**
 * Le motif exact rendu par le coffre du LAB.
 *
 * Nommé et exporté pour qu'un test puisse l'exiger : « ça a échoué » ne
 * distingue pas un LAB correctement privé d'un coffre en panne.
 */
export const MOTIF_LAB = 'SECRET_INDISPONIBLE_EN_LAB';

/**
 * Le coffre du LAB : il ne rend jamais rien.
 *
 * ⚠ IL NE PREND AUCUN PARAMÈTRE, ET C'EST LA GARDE.
 *
 * Une fabrique acceptant un coffre « de repli » ou une liste de secrets
 * « autorisés en LAB » rouvrirait exactement le trou qu'elle prétend fermer :
 * il suffirait d'un appelant distrait, ou pressé, pour lui passer le coffre de
 * production.
 *
 * Ne rien accepter rend le mauvais usage **impossible à écrire**, pas
 * seulement déconseillé. C'est la différence entre une garde et une consigne.
 */
export function createLabVault(): SecretVault {
  return {
    get(name: string): Result<Secret> {
      return err(
        jarvisError('CONFIGURATION', `${MOTIF_LAB} : ${name}`, {
          /* On journalise le NOM demandé, jamais une valeur — il n'y en a pas,
             et c'est justement ce qu'on veut pouvoir prouver. Savoir QUELS
             secrets une mise à jour candidate réclame est en soi un signal :
             une mise à jour de dépendance qui demande le jeton Google mérite
             qu'on la regarde de près. */
          secret: name,
          motif: MOTIF_LAB,
        }),
      );
    },
    /**
     * `has` rend TOUJOURS `false`, et ce n'est pas cosmétique.
     *
     * Le code de production s'en sert pour décider s'il construit un
     * fournisseur (`googleAgendaConfigure`, ADR-078). Rendre `true` ferait
     * construire dans le LAB un adaptateur réseau qui échouerait ensuite à
     * l'authentification — un effet externe TENTÉ, dans un environnement dont
     * `docs/07 §5` dit qu'il n'en produit aucun.
     *
     * `false` fait que le LAB n'essaie même pas.
     */
    has(): boolean {
      return false;
    },
  };
}

/**
 * Vérifie qu'un coffre se comporte comme un coffre de LAB.
 *
 * ⚠ CETTE FONCTION EXISTE POUR ÊTRE APPELÉE PAR LA PORTE DE SORTIE, et son
 * intérêt est d'être **falsifiable** : on lui donne des noms de secrets
 * RÉELLEMENT utilisés par le produit, et elle exige que tous soient refusés.
 *
 * Un contrôle qui interrogerait un nom inventé passerait aussi bien avec un
 * coffre de production — celui-ci refuserait un secret qui n'existe pas, et on
 * en conclurait qu'il est privé. C'est le défaut d'ADR-087 : un contrôle qui
 * ne peut pas échouer.
 */
export function coffreEstPrive(
  vault: SecretVault,
  nomsReels: readonly string[],
): Result<true> {
  if (nomsReels.length === 0) {
    return err(
      jarvisError(
        'VALIDATION',
        'aucun nom de secret à éprouver — le contrôle serait vide, donc décoratif',
      ),
    );
  }

  for (const nom of nomsReels) {
    /* `CONFIGURATION` et non un nouveau genre d'erreur : un LAB qui atteint
       les secrets de production n'est pas une attaque, c'est un CÂBLAGE — on
       lui a passé le mauvais coffre. Nommer précisément vaut mieux qu'élargir
       la taxonomie d'erreurs du noyau au passage. */
    if (vault.has(nom)) {
      return err(jarvisError('CONFIGURATION', `le coffre déclare détenir ${nom}`));
    }
    const lu = vault.get(nom);
    if (lu.ok) {
      /* ⚠ ON NE RECOPIE PAS LA VALEUR DANS L'ERREUR. Le message d'un défaut de
         confidentialité ne doit pas être lui-même une fuite — il finirait dans
         un journal, puis dans un rapport. */
      return err(jarvisError('CONFIGURATION', `le coffre a RENDU le secret ${nom}`));
    }
  }
  return { ok: true, value: true };
}
