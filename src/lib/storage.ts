import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';

/**
 * Stockage des archives familiales.
 *
 * Un choix explicite : les fichiers ne sont JAMAIS exposés à une URL
 * publique, même longue et imprévisible. Une photo de famille sur un
 * bucket public est une photo de famille indexable. Tout passe par une
 * route authentifiée qui vérifie la famille avant de servir un octet.
 *
 * Le pilote par défaut écrit sur disque. Un pilote S3/R2 se branche ici
 * sans changer le reste de l'application : l'interface se limite à
 * poser, lire et retirer des octets.
 */

export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

const DATA_DIR = process.env.STORAGE_DIR ?? join(process.cwd(), '.data', 'archives');

class LocalDiskDriver implements StorageDriver {
  /**
   * La clé vient d'une donnée que nous fabriquons, jamais du nom de
   * fichier fourni. On vérifie tout de même qu'elle ne sort pas du
   * répertoire : une traversée de chemin sur un stockage familial
   * donnerait accès à tout le disque.
   */
  private resolve(key: string): string {
    const target = resolve(join(DATA_DIR, normalize(key)));
    if (!target.startsWith(resolve(DATA_DIR))) throw new Error('Clé de stockage invalide');
    return target;
  }

  async put(key: string, data: Buffer) {
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string) {
    try {
      return await readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async remove(key: string) {
    try {
      await unlink(this.resolve(key));
    } catch {
      /* Déjà absent : le résultat voulu est atteint. */
    }
  }
}

export const storage: StorageDriver = new LocalDiskDriver();

/** Ce que la famille peut déposer, et jusqu'à quelle taille. */
export const ACCEPTED_TYPES: Record<string, { archiveType: string; extension: string }> = {
  'image/jpeg': { archiveType: 'PHOTO', extension: 'jpg' },
  'image/png': { archiveType: 'PHOTO', extension: 'png' },
  'image/webp': { archiveType: 'PHOTO', extension: 'webp' },
  'image/heic': { archiveType: 'PHOTO', extension: 'heic' },
  'application/pdf': { archiveType: 'DOCUMENT', extension: 'pdf' },
  'audio/mpeg': { archiveType: 'AUDIO', extension: 'mp3' },
  'audio/mp4': { archiveType: 'AUDIO', extension: 'm4a' },
  'audio/wav': { archiveType: 'AUDIO', extension: 'wav' },
  'audio/webm': { archiveType: 'AUDIO', extension: 'webm' },
  'video/mp4': { archiveType: 'VIDEO', extension: 'mp4' },
};

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function isAcceptedType(mimeType: string): boolean {
  return mimeType in ACCEPTED_TYPES;
}

/** Clé de stockage : cloisonnée par famille, jamais dérivée du nom fourni. */
export function buildStorageKey(familyId: string, mimeType: string): string {
  const { extension } = ACCEPTED_TYPES[mimeType]!;
  return `${familyId}/${randomUUID()}.${extension}`;
}

/** Empreinte du contenu — permet de reconnaître un doublon déposé deux fois. */
export function fingerprint(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
