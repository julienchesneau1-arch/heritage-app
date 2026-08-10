/**
 * LE BANC NE DOIT RIEN CHANGER À CE QU'IL MESURE — Foundation 3.
 *
 * Deux risques, et le second est le plus insidieux.
 *
 * 1. Que le code de production finisse par dépendre d'une infrastructure de
 *    test — un fournisseur hostile importé « juste pour un cas limite ».
 *
 * 2. Que le banc, à force de vouloir faire passer ses scénarios, introduise
 *    exactement ce que tout le reste interdit : un rejeu automatique.
 *    Le mandat Foundation 3 le nomme explicitement (§10).
 *
 * Ces deux propriétés sont vérifiées MÉCANIQUEMENT, sur le texte des sources.
 * Une relecture humaine ne tient pas dans le temps.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourcesUnder(root: string, extension = '.ts'): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(extension)) found.push(full);
    }
  };
  walk(root);
  return found;
}

describe('banc — isolation et innocuité', () => {
  it('aucun module de src/ n\'importe le banc', () => {
    const offenders = sourcesUnder('src')
      .filter((file) => {
        const content = readFileSync(file, 'utf8');
        return /from\s+['"].*tests\/lab/.test(content);
      });

    expect(offenders).toEqual([]);
  });

  it('aucun module de src/ n\'importe quoi que ce soit de tests/', () => {
    const offenders = sourcesUnder('src').filter((file) =>
      /from\s+['"][^'"]*\/tests\//.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it(
    'le banc n\'a introduit AUCUN rejeu automatique dans le noyau',
    () => {
      // Le seul appel récursif légitime du Gateway est celui du chemin
      // `NO_EFFECT` — qui exige une affirmation POSITIVE d'absence d'effet.
      // Tout autre `gateway.invoke` interne serait un rejeu déguisé.
      const gateway = readFileSync('src/core/tools/gateway.ts', 'utf8');
      const recursions = [...gateway.matchAll(/gateway\.invoke\(/g)];

      expect(recursions.length).toBe(1);

      // Et il est bien dans la branche NO_EFFECT.
      const noEffectBlock = gateway.slice(
        gateway.indexOf("case 'NO_EFFECT'"),
        gateway.indexOf("case 'INCONCLUSIVE'"),
      );
      expect(noEffectBlock).toContain('gateway.invoke(call)');
    },
  );

  it('aucune boucle de tentative n\'existe dans le noyau', () => {
    // Un `for` autour d'une exécution d'outil serait un rejeu, quel que soit
    // le nom qu'on lui donne.
    const gateway = readFileSync('src/core/tools/gateway.ts', 'utf8');
    expect(gateway).not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*tool\.execute/s);
    expect(gateway).not.toMatch(/while\s*\([^)]*\)\s*\{[^}]*tool\.execute/s);

    // `tool.execute` n'est appelé QU'UNE FOIS dans tout le fichier.
    const executions = [...gateway.matchAll(/tool\.execute\(/g)];
    expect(executions.length).toBe(1);
  });

  it('maxRetries reste déclaré et consommé par personne', () => {
    // Reconduit depuis `fail-closed.test.ts` : le banc était l'occasion rêvée
    // de « réparer » ce champ dormant. Il ne l'a pas été.
    const consumers = sourcesUnder('src').filter((file) =>
      /\.\s*maxRetries/.test(readFileSync(file, 'utf8')),
    );
    expect(consumers).toEqual([]);
  });

  it('le monde du banc n\'est pas une migration de production', () => {
    // `lab_world_effects` ne doit exister que dans les tests. L'introduire en
    // migration livrerait à l'utilisateur une table dont l'unique raison
    // d'être est de mesurer nos pannes.
    const migrations = sourcesUnder('infrastructure/db/migrations', '.sql');
    const leaked = migrations.filter((file) =>
      readFileSync(file, 'utf8').includes('lab_world_effects'),
    );
    expect(leaked).toEqual([]);
  });
});
