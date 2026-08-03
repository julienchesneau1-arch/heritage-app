import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

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

/**
 * Pilote S3/R2. Activé dès que STORAGE_S3_BUCKET est renseigné.
 *
 * Indispensable sur un hébergement au système de fichiers éphémère
 * (Vercel) : sans lui, les photos de la famille disparaissent au premier
 * redéploiement, en laissant en base des clés qui ne pointent plus sur rien.
 *
 * Le bucket n'a AUCUN besoin d'être public — et ne doit pas l'être : les
 * fichiers ne sont jamais servis directement, ils transitent par la route
 * authentifiée qui vérifie la famille.
 */
class S3Driver implements StorageDriver {
  private client: S3Client;

  constructor(private bucket: string) {
    this.client = new S3Client({
      region: process.env.STORAGE_S3_REGION ?? 'auto',
      endpoint: process.env.STORAGE_S3_ENDPOINT || undefined,
      forcePathStyle: Boolean(process.env.STORAGE_S3_ENDPOINT),
      credentials:
        process.env.STORAGE_S3_ACCESS_KEY_ID && process.env.STORAGE_S3_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID,
              secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY,
            }
          : undefined,
    });
  }

  async put(key: string, data: Buffer) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }));
  }

  async get(key: string) {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await response.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch {
      return null;
    }
  }

  async remove(key: string) {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch {
      /* Déjà absent : le résultat voulu est atteint. */
    }
  }
}

function createDriver(): StorageDriver {
  const bucket = process.env.STORAGE_S3_BUCKET;
  if (bucket) return new S3Driver(bucket);

  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[storage] Aucun bucket configuré : les archives sont écrites sur disque. ' +
        'Sur un hébergement éphémère, elles seront perdues au redéploiement.',
    );
  }
  return new LocalDiskDriver();
}

export const storage: StorageDriver = createDriver();

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
