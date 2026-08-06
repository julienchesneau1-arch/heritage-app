import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';

/**
 * LA RÉSERVE — le droit de ne pas parler d'un sujet.
 *
 * `StoryMute` répond à « je ne veux plus voir CE récit ». La réserve répond
 * à ce qui vient avant : « ne me demande jamais rien sur CECI ».
 *
 * ── Trois droits, et ils ne sont pas égaux ──
 *
 * La §2.6 fixe la ligne, et tout ce fichier en découle :
 *
 *   « Un membre peut décider de ne plus voir un récit ; il ne peut pas
 *     décider à la place des autres. »
 *
 *  · Sur SES PROPRES MOTS : absolu. Retirer, corriger, se taire.
 *  · Sur SA PROPRE ÉCOUTE : absolu. C'est ce module.
 *  · Sur LES MOTS DES AUTRES : aucun — mais pas rien (voir `portee`).
 *
 * La troisième ligne tient même quand elle fait mal, et pour une raison
 * précise : dans une famille, la personne la plus capable d'exiger le
 * silence est rarement celle qui souffre le plus. Un bouton « interdire
 * qu'on parle de ça » servirait au membre le plus autoritaire avant de
 * servir au plus blessé — c'est le mécanisme même qui fabrique les secrets
 * de famille, et ce produit existe en partie contre lui.
 *
 * ── Le piège, et pourquoi le défaut est le silence ──
 *
 * Si l'application affichait « Jeanne a demandé qu'on ne parle pas de X »,
 * elle apprendrait à toute la famille que X existe et que ça fait mal. La
 * réserve peut être plus révélatrice que le récit. Elle est donc silencieuse
 * par défaut, et seule l'intéressée peut la porter à la famille.
 *
 * ── Ce que ce module ne fait jamais ──
 *
 * Aucune détection automatique de sensibilité. Amendement 1 : le produit ne
 * déduit rien d'une donnée. Une réserve est toujours DÉCLARÉE par un humain.
 * Aucun compte non plus — « 3 sujets en réserve » serait un score sur la
 * douleur (§12).
 */

export type Portee = 'silencieuse' | 'portee';

export interface NouvelleReserve {
  memberId: string;
  entityId?: string;
  sujet?: string;
  portee?: Portee;
  /** Les mots de l'intéressé, s'il choisit d'adresser une demande. */
  demande?: string;
}

export interface ReserveVisible {
  id: string;
  /** Le nom de qui l'a posée. Une demande anonyme n'engage personne. */
  parQui: string;
  /** Ses mots, jamais reformulés. */
  demande: string;
}

export class ReserveService {
  constructor(private prisma: PrismaClient = defaultPrisma) {}

  /**
   * Poser une réserve. Rien n'est interprété : ni l'entité, ni les mots.
   *
   * La base refuse déjà une réserve sans objet et une portée hors
   * vocabulaire — on ne les revalide pas ici, on laisse la contrainte
   * parler. Deux gardes valent moins qu'une garde à l'endroit sûr.
   */
  async poser(familyId: string, reserve: NouvelleReserve) {
    return this.prisma.reserve.create({
      data: {
        familyId,
        memberId: reserve.memberId,
        entityId: reserve.entityId ?? null,
        sujet: reserve.sujet?.trim() || null,
        portee: reserve.portee ?? 'silencieuse',
        demande: reserve.demande?.trim() || null,
      },
    });
  }

  /** Lever sa réserve. Par l'intéressé seul — comme `StoryMute` (§2.6). */
  async lever(familyId: string, memberId: string, reserveId: string): Promise<boolean> {
    const result = await this.prisma.reserve.deleteMany({
      where: { id: reserveId, familyId, memberId },
    });
    return result.count > 0;
  }

  /** Les réserves d'une personne. Nul autre ne les lit — pas même la famille. */
  async siennes(familyId: string, memberId: string) {
    return this.prisma.reserve.findMany({
      where: { familyId, memberId },
      orderBy: { createdAt: 'desc' },
      include: { entity: { select: { id: true, name: true } } },
    });
  }

  /**
   * Les entités sur lesquelles ce membre ne veut pas être questionné.
   *
   * C'est ce que le Passeur consulte avant de choisir. Rendu comme un
   * `Set` : la question à poser se décide dans une boucle, et une requête
   * par candidat serait absurde.
   */
  async entitesEnReserve(familyId: string, memberId: string): Promise<Set<string>> {
    const reserves = await this.prisma.reserve.findMany({
      where: { familyId, memberId, entityId: { not: null } },
      select: { entityId: true },
    });
    return new Set(reserves.map((r) => r.entityId!).filter(Boolean));
  }

  /**
   * Les RÉCITS qui parlent d'un sujet mis en réserve.
   *
   * Une réserve porte sur une entité, mais les questions ne portent pas
   * toutes sur des entités : un fil ouvert par « d'où venait ce vélo ? »
   * est accroché à un RÉCIT, et ce récit peut parler du sujet réservé.
   *
   * Trouvé en éprouvant le filtre sur la base réelle, pas en relisant le
   * code : une réserve posée sur « Robert » laissait passer la question du
   * vélo, parce que le fil qui la portait était accroché à un récit et non
   * à l'entité. Un silence demandé qui ne tient qu'un chemin sur deux ne
   * vaut rien.
   */
  async recitsEnReserve(familyId: string, memberId: string): Promise<Set<string>> {
    const entites = await this.entitesEnReserve(familyId, memberId);
    if (entites.size === 0) return new Set();

    const recits = await this.prisma.story.findMany({
      where: { familyId, linkedEntities: { some: { id: { in: [...entites] } } } },
      select: { id: true },
    });
    return new Set(recits.map((r) => r.id));
  }

  /**
   * Les demandes que la famille doit voir au moment d'écrire.
   *
   * ── L'application PORTE la demande. Elle ne l'applique jamais. ──
   *
   * Cette méthode rend un texte à afficher, et rien d'autre : aucun blocage,
   * aucune confirmation à cocher, aucun enregistrement de qui a passé outre.
   * Le jour où une machine impose le respect d'un souhait familial, ce n'est
   * plus un acte de respect — c'est une règle qu'on contourne.
   *
   * Les réserves silencieuses ne sortent jamais d'ici. C'est la garantie que
   * tout le reste repose dessus.
   */
  async demandesPortees(familyId: string, entityId: string | null): Promise<ReserveVisible[]> {
    if (!entityId) return [];

    const reserves = await this.prisma.reserve.findMany({
      where: { familyId, entityId, portee: 'portee', demande: { not: null } },
      select: { id: true, demande: true, member: { select: { name: true, isDeleted: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return reserves.map((r) => ({
      id: r.id,
      // §2.1 règle 1 : un membre retiré est anonymisé partout, sans exception.
      parQui: r.member.isDeleted ? 'Membre anonymisé' : r.member.name,
      demande: r.demande!,
    }));
  }
}

export const reserveService = new ReserveService();

/**
 * LE SIGNAL COMPORTEMENTAL NE PEUT QUE RETIRER, JAMAIS AJOUTER.
 *
 * Quelqu'un passe deux fois une question sur la même entité : on cesse de
 * la poser. Silencieusement — sans le nommer à l'écran, sans le compter,
 * sans demander pourquoi. Passer une question ne s'explique pas.
 *
 * Ce n'est pas de l'inférence émotionnelle : l'amendement 1 vise la
 * déduction d'un SENTIMENT à partir d'une donnée. Ici on obéit à un
 * COMPORTEMENT, et toujours dans le sens de la retenue. La règle est la
 * garde : un signal comportemental peut réduire ce que le produit propose,
 * jamais l'augmenter. Toute utilisation qui ajouterait — pousser un sujet
 * parce qu'il a plu — est interdite, et testée.
 */
export const PASSAGES_AVANT_RETRAIT = 2;

export function doitCesserDeDemander(passages: number): boolean {
  return passages >= PASSAGES_AVANT_RETRAIT;
}
