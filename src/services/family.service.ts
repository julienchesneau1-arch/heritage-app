import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { signMemberToken } from '@/lib/session';

/**
 * Création et administration d'une famille.
 *
 * Sans cela, l'application n'a qu'un seul utilisateur : la famille du seed.
 * Une famille se crée avec son premier membre — une mémoire sans personne
 * pour la porter n'a pas de sens, et le Trigger Model a besoin d'au moins
 * une date pour exister.
 */

export interface NewMember {
  name: string;
  generation: number;
  birthDate?: Date | null;
  deathDate?: Date | null;
  role?: string | null;
  /** Retiré du flux `.ics`. Absent = on y figure, comme avant la case. */
  calendarOptOut?: boolean;
}

export class FamilyService {
  constructor(private prisma: PrismaClient = defaultPrisma) {}

  async createFamily(name: string, firstMember: NewMember) {
    return this.prisma.family.create({
      data: {
        name,
        members: { create: normalize(firstMember) },
      },
      include: { members: true },
    });
  }

  async addMember(familyId: string, member: NewMember) {
    return this.prisma.member.create({
      data: { familyId, ...normalize(member) },
    });
  }

  async updateMember(familyId: string, memberId: string, member: NewMember) {
    const result = await this.prisma.member.updateMany({
      where: { id: memberId, familyId },
      data: normalize(member),
    });
    return result.count > 0;
  }

  /**
   * §2.1 règle 1 : soft-delete uniquement. Les récits restent, l'auteur
   * devient « Auteur anonymisé ». Le lien personnel est révoqué au passage —
   * on ne retire pas quelqu'un de la famille en lui laissant sa clé.
   */
  async removeMember(familyId: string, memberId: string) {
    const result = await this.prisma.member.updateMany({
      where: { id: memberId, familyId },
      data: { isDeleted: true, tokenVersion: { increment: 1 } },
    });
    return result.count > 0;
  }

  /** Révoque le lien personnel d'un membre, et lui seul. */
  async revokeMemberLink(familyId: string, memberId: string) {
    const result = await this.prisma.member.updateMany({
      where: { id: memberId, familyId },
      data: { tokenVersion: { increment: 1 } },
    });
    return result.count > 0;
  }

  /** Le chemin à transmettre à ce membre, et à lui seul. */
  async personalLink(familyId: string, memberId: string): Promise<string | null> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, familyId, isDeleted: false },
      select: { id: true, tokenVersion: true },
    });
    if (!member) return null;
    return `/f/${familyId}/m/${member.id}/${signMemberToken(member.id, member.tokenVersion)}`;
  }

  /**
   * Le flux iCalendar de ce membre. Il porte le même jeton que son lien
   * personnel : le révoquer coupe les deux d'un coup.
   */
  async calendarLink(familyId: string, memberId: string): Promise<string | null> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, familyId, isDeleted: false },
      select: { id: true, tokenVersion: true },
    });
    if (!member) return null;
    return `/api/calendrier/${member.id}/${signMemberToken(member.id, member.tokenVersion)}/heritage.ics`;
  }
}

function normalize(member: NewMember) {
  return {
    name: member.name.trim(),
    generation: member.generation,
    birthDate: member.birthDate ?? null,
    deathDate: member.deathDate ?? null,
    role: member.role?.trim() || null,
    calendarOptOut: member.calendarOptOut ?? false,
  };
}

export const familyService = new FamilyService();
