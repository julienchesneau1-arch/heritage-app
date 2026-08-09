/**
 * Adaptateur Cedar.
 *
 * ADR-005 : Cedar évalue, notre code décide.
 * ADR-003 : ce fichier est le SEUL endroit du dépôt autorisé à importer le SDK
 * Cedar. Le test `tests/contracts/provider-isolation.test.ts` fait échouer le
 * build si cette règle est enfreinte ailleurs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isAuthorized } from '@cedar-policy/cedar-wasm/nodejs';
import type {
  PermissionVerdict,
  PolicyEvaluator,
} from '../../core/policy/evaluator.js';
import type { PolicyRequest } from '../../core/policy/types.js';
import { err, ok, jarvisError, type Result } from '../../core/types/result.js';

/** Charge récursivement les fichiers .cedar d'un répertoire, en ordre stable. */
export function loadPolicySource(directory: string): Result<string> {
  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.cedar')) files.push(full);
    }
  }

  try {
    walk(directory);
  } catch (cause) {
    return err(
      jarvisError(
        'CONFIGURATION',
        `Répertoire de politiques illisible : ${directory}`,
        undefined,
        cause,
      ),
    );
  }

  if (files.length === 0) {
    // Un moteur sans politique refuserait tout. Mieux vaut le dire ici que de
    // laisser Jarvis paraître cassé au premier appel d'outil.
    return err(
      jarvisError(
        'CONFIGURATION',
        `Aucune politique .cedar trouvée dans ${directory}.`,
      ),
    );
  }

  const parts = files.map(
    (f) => `// --- ${f} ---\n${readFileSync(f, 'utf8')}`,
  );
  return ok(parts.join('\n\n'));
}

export function createCedarEvaluator(policySource: string): PolicyEvaluator {
  return {
    evaluate(request: PolicyRequest): Result<PermissionVerdict> {
      const actionId = `${request.action.tool}.${request.action.operation}`;

      const answer = isAuthorized({
        principal: { type: 'Actor', id: request.actor },
        action: { type: 'Action', id: actionId },
        resource: { type: 'Resource', id: request.resource.id },
        context: {
          mode: request.context.mode,
          egress: request.context.egress,
          cloudEnabled: request.context.cloudEnabled,
          proactive: request.context.proactive,
          userConfirmed: request.context.userConfirmed,
          autonomyLevel: request.declaredAutonomy,
          privacyClass: request.resource.privacyClass,
          tool: request.action.tool,
          operation: request.action.operation,
        },
        policies: { staticPolicies: policySource },
        entities: [
          { uid: { type: 'Actor', id: request.actor }, attrs: {}, parents: [] },
          { uid: { type: 'Action', id: actionId }, attrs: {}, parents: [] },
          {
            uid: { type: 'Resource', id: request.resource.id },
            attrs: {
              resourceType: request.resource.type,
              privacyClass: request.resource.privacyClass,
            },
            parents: [],
          },
        ],
      });

      if (answer.type === 'failure') {
        // Une politique qui ne compile pas ne doit jamais dégrader en « allow ».
        return err(
          jarvisError('CONFIGURATION', 'Évaluation Cedar en échec', {
            errors: answer.errors.map((e) => e.message).join(' | '),
          }),
        );
      }

      const { response } = answer;
      return ok({
        decision: response.decision === 'allow' ? 'ALLOW' : 'DENY',
        determiningPolicies: response.diagnostics.reason,
      });
    },
  };
}
