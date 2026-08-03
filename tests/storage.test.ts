import { describe, expect, it } from 'vitest';
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
