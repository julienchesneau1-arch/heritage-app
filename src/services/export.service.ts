import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';

/**
 * Amendement 3 — la famille possède ses données.
 *
 * L'export renvoie tout ce qui appartient à la famille, en JSON structuré,
 * sans traitement et sans filtre : récits archivés, mis en quarantaine ou
 * suspendus, journaux de visibilité compris. Rien n'est retenu de ce que
 * l'application a décidé de moins montrer.
 *
 * ── Ce qu'il disait, et ce qu'il faisait ──
 *
 * Cet en-tête annonçait « TOUT ». Quatre modèles n'y étaient pas :
 * les brouillons de transcription, les mises en sourdine, les demandes de
 * suspension et les réserves. Les trois premiers manquaient par oubli, et
 * les brouillons contenaient des MOTS — la transcription d'un
 * enregistrement, en attente de relecture. Une famille qui exportait avant
 * de partir laissait ces phrases derrière elle sans en être avertie.
 *
 * ── LA RÉSERVE N'Y EST PAS, ET C'EST UN CHOIX ──
 *
 * Une réserve silencieuse est une promesse faite à une personne : « cela ne
 * se voit nulle part, et personne dans la famille n'en est informé ». Or
 * l'export est un fichier que N'IMPORTE QUEL membre télécharge depuis le
 * pied de page. L'y mettre livrerait à toute la famille la liste des sujets
 * qui font mal à chacun — exactement ce que la fonctionnalité existe pour
 * empêcher.
 *
 * Les deux principes se contredisent ici, et il n'y a pas de solution qui
 * les satisfasse tous les deux. Le silence l'emporte : une promesse faite à
 * une personne pèse plus qu'une exhaustivité de format. La conséquence est
 * réelle et elle est assumée — après une restauration, les réserves sont à
 * reposer. Le fichier le DIT, plutôt que de le taire (`nonInclus`).
 */
export class ExportService {
  constructor(private prisma: PrismaClient = defaultPrisma) {}

  async exportFamily(familyId: string) {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      include: {
        members: true,
        stories: {
          include: {
            linkedEntities: { select: { id: true, name: true, type: true } },
            archives: true,
          },
        },
        entities: true,
        archives: true,
        traditions: true,
        threads: true,
        messages: { include: { marks: true } },
        passages: true,
        visibilityLogs: true,
      },
    });

    if (!family) return null;

    // Les brouillons ne pendent pas à `Family` dans le schéma : ils se
    // lisent à part. C'est précisément pour cela qu'ils avaient été
    // oubliés — l'export listait les relations, et ils n'en étaient pas une.
    // Trois modèles ne pendent pas à `Family` dans le schéma : ils se lisent
    // à part. C'est précisément pour cela qu'ils avaient été oubliés —
    // l'export listait les relations, et ils n'en étaient pas.
    const [brouillons, sourdines, demandes] = await Promise.all([
      this.prisma.transcriptionDraft.findMany({ where: { familyId } }),
      this.prisma.storyMute.findMany({ where: { familyId } }),
      this.prisma.suspensionRequest.findMany({ where: { familyId } }),
    ]);

    return {
      // v2 : `conversations` est devenu `threads` + `messages`. L'import
      // relit les deux — une famille qui a exporté avant ce changement doit
      // pouvoir restaurer (amendement 3).
      // v3 : ajout des sourdines, des demandes de suspension et des
      // brouillons. L'import relit v1, v2 et v3 — une famille qui a exporté
      // il y a six mois doit pouvoir restaurer (amendement 3).
      format: 'heritage-export/v3',
      exportedAt: new Date().toISOString(),
      family: {
        id: family.id,
        name: family.name,
        createdAt: family.createdAt,
      },
      members: family.members,
      stories: family.stories,
      entities: family.entities,
      archives: family.archives,
      traditions: family.traditions,
      threads: family.threads,
      messages: family.messages,
      passages: family.passages,
      visibilityLogs: family.visibilityLogs,
      storyMutes: sourdines,
      suspensionRequests: demandes,
      // Des mots dits à voix haute, transcrits, pas encore relus. Ils
      // n'entrent pas dans la mémoire tant qu'un humain ne les a pas
      // validés — mais ils existent, et ils appartiennent à la famille.
      transcriptionDrafts: brouillons,
      counts: {
        members: family.members.length,
        stories: family.stories.length,
        entities: family.entities.length,
        archives: family.archives.length,
        traditions: family.traditions.length,
        threads: family.threads.length,
        messages: family.messages.length,
        passages: family.passages.length,
        visibilityLogs: family.visibilityLogs.length,
        storyMutes: sourdines.length,
        suspensionRequests: demandes.length,
        transcriptionDrafts: brouillons.length,
      },
      /**
       * Ce que ce fichier NE contient pas, écrit dans le fichier lui-même.
       *
       * Un export silencieux sur ses propres trous laisse croire à une
       * exhaustivité qu'il n'a pas — et c'est au moment de restaurer, des
       * mois plus tard, qu'on découvre ce qui manquait.
       */
      nonInclus: {
        fichiers:
          'Les photos, documents et enregistrements ne sont pas dans ce fichier : il ne contient que leurs descriptions. Les octets restent sur le serveur.',
        reserves:
          'Les réserves — les sujets dont quelqu’un a demandé qu’on ne lui parle plus — ne sont pas exportées. Elles ont été promises invisibles à toute la famille, et ce fichier est lisible par tout le monde. Après une restauration, elles sont à reposer.',
      },
    };
  }
}

export const exportService = new ExportService();
