// ============================================================================
// POLITIQUES DURES — rang SYSTEM dans la hiérarchie de 03 §5
//
// Ces règles ne peuvent être assouplies par aucune règle utilisateur, aucune
// préférence apprise, aucune suggestion de modèle. En Cedar, `forbid` prime
// toujours sur `permit` : la hiérarchie est donc portée par le langage
// lui-même, pas par notre ordre d'évaluation.
//
// Ne jamais éditer ce fichier pour faire passer un test.
// ============================================================================

// --- L0 : interdit par construction (03 §4) ---------------------------------
// Exfiltration, contournement de sécurité, modification de politique par le
// modèle. Le Gate court-circuite déjà L0 ; cette règle est la seconde barrière.
forbid(principal, action, resource)
when { context.autonomyLevel == "L0" };


// --- Donnée RED : jamais vers l'extérieur (03 §6) ---------------------------
// Secrets, données financières, mémoire privée protégée. Sans exception et
// sans option de configuration permettant de l'ignorer.
forbid(principal, action, resource)
when { context.privacyClass == "RED" && context.egress == true };


// --- Mode privé (03 §7) -----------------------------------------------------
// Objectif mesuré : 0 requête sortante inattendue.
forbid(principal, action, resource)
when { context.mode == "PRIVATE" && context.egress == true };


// --- Cloud désactivé globalement (invariant I2) -----------------------------
// L'utilisateur doit pouvoir couper le cloud, et cela doit être vrai.
forbid(principal, action, resource)
when { context.egress == true && context.cloudEnabled == false };


// --- Une automation n'escalade jamais ses privilèges (03 §1, T3) ------------
// Une automation ne peut pas exécuter ce qui exige un humain. Si une action
// demande une confirmation, elle demande une confirmation À UN HUMAIN.
forbid(principal, action, resource)
when {
    principal == Actor::"AUTOMATION" &&
    (context.autonomyLevel == "L3" || context.autonomyLevel == "L4")
};


// --- Un service externe n'agit jamais de sa propre initiative ---------------
// Un résultat d'outil ou un serveur MCP tiers est une donnée, pas un acteur.
forbid(principal, action, resource)
when { principal == Actor::"EXTERNAL_SERVICE" };
