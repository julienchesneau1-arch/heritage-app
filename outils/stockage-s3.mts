/**
 * LE PILOTE S3/R2, CONTRE UN VRAI SERVEUR.
 *
 * Le dossier disait, depuis le premier jour : « le pilote S3/R2 n'a jamais
 * été testé contre un vrai bucket ; les tests sont des tests unitaires sur
 * le pilote, pas sur le service distant ». C'était honnête, et c'était
 * aussi une manière de ne pas essayer. Docker Hub est bloqué depuis cet
 * environnement, mais pas le registre npm : un serveur S3 complet s'y
 * installe, et le pilote peut lui parler pour de bon.
 *
 * Ce que ce contrôle établit, et qu'un test unitaire ne peut pas :
 *
 *  · Que le SDK négocie réellement avec un service HTTP — signature v4,
 *    `forcePathStyle`, région, informations d'identification. Un pilote
 *    peut être parfait et ne jamais s'authentifier.
 *  · Que les octets reviennent IDENTIQUES. Une photo de famille qui
 *    revient corrompue est pire qu'une photo perdue : on ne le voit qu'en
 *    l'ouvrant, des années plus tard.
 *  · Que `get` d'une clé absente rend `null` plutôt que de lever, et que
 *    `remove` d'une clé absente ne lève pas non plus — deux comportements
 *    sur lesquels tout le reste de l'application compte.
 *  · Que la clé cloisonne bien par famille.
 *
 * Ce que ce contrôle N'ÉTABLIT PAS, et qu'il ne faut pas lui faire dire :
 * s3rver n'est pas Cloudflare R2. Il ne dit rien de la latence, des quotas,
 * des politiques de bucket, ni du fait que R2 ignore certaines en-têtes.
 * Il établit que le pilote sait parler S3. C'est un cran de plus qu'avant,
 * pas la vérification complète.
 *
 * USAGE :   npx tsx outils/stockage-s3.mts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import S3rver from 's3rver';

const PORT = 4569;
const BUCKET = 'heritage-essai';
const racine = mkdtempSync(join(tmpdir(), 's3rver-'));

const serveur = new S3rver({
  port: PORT,
  address: '127.0.0.1',
  silent: true,
  directory: racine,
  configureBuckets: [{ name: BUCKET, configs: [] }],
});
await serveur.run();

// Les variables doivent être posées AVANT l'import du module : `storage`
// est construit à l'import, et c'est bien le comportement qu'on veut
// vérifier — celui de production, pas une instance fabriquée pour le test.
process.env.STORAGE_S3_BUCKET = BUCKET;
process.env.STORAGE_S3_ENDPOINT = `http://127.0.0.1:${PORT}`;
process.env.STORAGE_S3_REGION = 'us-east-1';
process.env.STORAGE_S3_ACCESS_KEY_ID = 'S3RVER';
process.env.STORAGE_S3_SECRET_ACCESS_KEY = 'S3RVER';

const { storage, buildStorageKey, fingerprint } = await import('../src/lib/storage');

const resultats: Array<[string, boolean, string]> = [];
function verifier(nom: string, condition: boolean, detail = '') {
  resultats.push([nom, condition, detail]);
  console.log(`${condition ? '✓' : '✗'} ${nom}${detail ? ` — ${detail}` : ''}`);
}

verifier(
  'le pilote S3 est bien celui qui est actif',
  storage.constructor.name === 'S3Driver',
  storage.constructor.name,
);

// ── Une photo, dans les deux sens ──
//
// Des octets aléatoires, pas une chaîne de texte : un pilote qui traite
// tout en UTF-8 passe un test sur « bonjour » et détruit un JPEG.
const famille = 'cmsdzwxe90000w8cjgx06wtq1';
const cle = buildStorageKey(famille, 'image/jpeg');
const octets = randomBytes(512 * 1024);

await storage.put(cle, octets);
const relus = await storage.get(cle);

verifier('un objet déposé se relit', relus !== null);
verifier(
  'les octets reviennent identiques',
  relus !== null && fingerprint(relus) === fingerprint(octets),
  `${octets.length} octets`,
);
verifier('la clé cloisonne par famille', cle.startsWith(`${famille}/`), cle);

// ── L'absence n'est pas une erreur ──
const absente = await storage.get(`${famille}/inexistante.jpg`);
verifier('une clé absente rend null, sans lever', absente === null);

let leve = false;
try {
  await storage.remove(`${famille}/inexistante.jpg`);
} catch {
  leve = true;
}
verifier('retirer une clé absente ne lève pas', !leve);

// ── Le retrait retire ──
await storage.remove(cle);
verifier('un objet retiré ne se relit plus', (await storage.get(cle)) === null);

// ── Le contrôle vérifie-t-il quelque chose ? ──
//
// Sans ceci, un pilote qui rendrait `null` en toutes circonstances passerait
// la moitié des lignes ci-dessus.
const temoin = buildStorageKey(famille, 'audio/webm');
await storage.put(temoin, Buffer.from([0, 1, 2, 3]));
verifier(
  'le contrôle sait distinguer présent et absent',
  (await storage.get(temoin)) !== null && (await storage.get(`${famille}/rien`)) === null,
);
await storage.remove(temoin);

// ── LA DISTINCTION QUI COMPTE : absent n'est pas injoignable ──
//
// C'est ce serveur qui a permis de la mesurer plutôt que de la supposer.
// Une clé absente rend `NoSuchKey`. Un bucket mal nommé rend `NoSuchBucket`
// — et 404 lui aussi : reconnaître l'absence au code HTTP ferait passer un
// `STORAGE_S3_BUCKET` erroné pour une famille sans photos, en silence, sur
// toutes ses archives d'un coup. Le pilote reconnaît donc le NOM.
{
  const { StorageUnavailableError } = await import('../src/lib/storage');

  // 1. Le service tombe.
  await serveur.close();

  let capturee: unknown = null;
  try {
    await storage.get(`${famille}/quelque-chose.jpg`);
  } catch (error) {
    capturee = error;
  }
  verifier(
    'un stockage injoignable lève au lieu de rendre « absent »',
    capturee instanceof StorageUnavailableError,
    capturee instanceof Error ? capturee.name : 'aucune exception',
  );

  let capturee2: unknown = null;
  try {
    await storage.remove(`${famille}/quelque-chose.jpg`);
  } catch (error) {
    capturee2 = error;
  }
  verifier(
    'un retrait qui n’a pas eu lieu ne se déclare pas fait',
    capturee2 instanceof StorageUnavailableError,
    capturee2 instanceof Error ? capturee2.name : 'aucune exception',
  );
}

rmSync(racine, { recursive: true, force: true });

const echecs = resultats.filter(([, ok]) => !ok);
console.log(`\nTOTAL : ${resultats.length - echecs.length}/${resultats.length} contrôles passés`);
if (echecs.length > 0) process.exit(1);
