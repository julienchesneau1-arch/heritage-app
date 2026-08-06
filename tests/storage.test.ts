import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCEPTED_TYPES,
  buildStorageKey,
  fingerprint,
  isAcceptedType,
  MAX_UPLOAD_BYTES,
} from '@/lib/storage';

describe('Types de fichiers acceptés', () => {
  it('accepte les formats qu’une famille produit réellement', () => {
    for (const mimeType of ['image/jpeg', 'image/png', 'image/heic', 'audio/mpeg', 'application/pdf']) {
      expect(isAcceptedType(mimeType)).toBe(true);
    }
  });

  it('refuse tout ce qui est exécutable ou inconnu', () => {
    for (const mimeType of [
      'application/x-sh',
      'application/x-msdownload',
      'text/html',
      'image/svg+xml', // vecteur de script
      '',
    ]) {
      expect(isAcceptedType(mimeType)).toBe(false);
    }
  });

  it('déduit le type d’archive du type MIME, sans le demander à la famille', () => {
    expect(ACCEPTED_TYPES['image/jpeg']!.archiveType).toBe('PHOTO');
    expect(ACCEPTED_TYPES['audio/mpeg']!.archiveType).toBe('AUDIO');
    expect(ACCEPTED_TYPES['application/pdf']!.archiveType).toBe('DOCUMENT');
  });

  it('plafonne le dépôt à une taille qu’un téléphone produit', () => {
    expect(MAX_UPLOAD_BYTES).toBeGreaterThanOrEqual(10 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBeLessThanOrEqual(50 * 1024 * 1024);
  });
});

describe('Clé de stockage', () => {
  it('cloisonne par famille', () => {
    expect(buildStorageKey('fam_1', 'image/png').startsWith('fam_1/')).toBe(true);
  });

  it('ne réutilise jamais la même clé', () => {
    const keys = new Set(Array.from({ length: 200 }, () => buildStorageKey('fam_1', 'image/png')));
    expect(keys.size).toBe(200);
  });

  it('ne dérive jamais la clé du nom de fichier fourni', () => {
    // Un nom hostile ne doit pas pouvoir remonter l'arborescence.
    const key = buildStorageKey('fam_1', 'image/png');
    expect(key).not.toContain('..');
    expect(key).toMatch(/^fam_1\/[0-9a-f-]+\.png$/);
  });
});

describe('Empreinte du contenu', () => {
  it('est stable pour un même fichier', () => {
    const data = Buffer.from('les mêmes octets');
    expect(fingerprint(data)).toBe(fingerprint(Buffer.from('les mêmes octets')));
  });

  it('diffère dès qu’un octet change', () => {
    expect(fingerprint(Buffer.from('abc'))).not.toBe(fingerprint(Buffer.from('abd')));
  });
});

describe('Une panne de stockage n’est pas une disparition', () => {
  /**
   * Les deux pilotes attrapaient TOUTE erreur de lecture et rendaient
   * `null`. Une panne devenait indiscernable d'un fichier effacé, et
   * l'application affirmait une absence qu'elle n'avait pas établie.
   *
   * Deux conséquences, mesurées dans le code :
   *  · la route des archives répondait `NOT_FOUND` sur une photo intacte ;
   *  · le travailleur de transcription marquait le brouillon `failed` avec
   *    « Fichier audio introuvable dans le stockage » — il annonçait à une
   *    famille que son enregistrement était perdu pendant qu'il dormait,
   *    intact, dans un service momentanément injoignable.
   *
   * Le comportement contre un VRAI serveur S3 est vérifié par
   * `outils/stockage-s3.mts` : c'est là qu'on a mesuré qu'une clé absente
   * rend `NoSuchKey` et un bucket mal nommé `NoSuchBucket` — tous deux en
   * 404. Ces tests-ci gardent la forme du code ; l'outil garde le fond.
   */
  const sansCommentaires = (chemin: string) =>
    readFileSync(join(process.cwd(), chemin), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const STORAGE = sansCommentaires('src/lib/storage.ts');

  it('aucun pilote n’avale une erreur de lecture', () => {
    // `catch { return null }` : la forme exacte du défaut.
    expect(STORAGE).not.toMatch(/catch\s*\{\s*return null;?\s*\}/);
  });

  it('aucun pilote ne déclare fait un retrait qui a échoué', () => {
    expect(STORAGE).not.toMatch(/catch\s*\{\s*\}/);
  });

  it('reconnaît l’absence au nom de l’erreur, jamais au code 404', () => {
    // Un bucket mal nommé rend 404 lui aussi : sur un code, un
    // `STORAGE_S3_BUCKET` erroné passerait pour une famille sans photos.
    expect(STORAGE).toMatch(/name\s*===\s*'NoSuchKey'/);
    expect(STORAGE).not.toMatch(/httpStatusCode\s*===\s*404/);
  });

  it('distingue ENOENT du reste sur le disque local', () => {
    expect(STORAGE).toMatch(/code\s*===\s*'ENOENT'/);
  });

  it('donne à l’appelant un type qu’il peut distinguer', () => {
    expect(STORAGE).toMatch(/class StorageUnavailableError extends Error/);
  });

  it('la route des archives ne transforme pas une panne en 404', () => {
    const ROUTE = sansCommentaires('src/app/api/family/[id]/archives/[archiveId]/file/route.ts');
    expect(ROUTE).toMatch(/status: 503/);
    expect(ROUTE).toMatch(/n’est pas perdu/);
  });

  it('le travailleur laisse le brouillon en attente plutôt qu’en échec', () => {
    const SERVICE = sansCommentaires('src/services/transcription.service.ts');
    // Le `continue` saute la mise à jour en `failed` : le cron repassera.
    expect(SERVICE).toMatch(/reportes \+= 1;\s*continue;/);
  });
});
