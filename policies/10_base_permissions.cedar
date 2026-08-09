// ============================================================================
// PERMISSIONS DE BASE
//
// Le défaut est le refus (`policy.defaultDecision = "deny"`) : ce qui n'est pas
// explicitement permis ici est refusé. Ajouter une permission est donc un acte
// délibéré et visible en revue.
//
// Ces règles répondent uniquement à « a-t-il le droit ? ». La cérémonie —
// faut-il une confirmation, laquelle, sur quelle valeur — est décidée par le
// Policy Gate (src/core/policy/gate.ts), conformément à l'ADR-005.
// ============================================================================

// --- Lecture (L1) -----------------------------------------------------------
// Consulter l'agenda, chercher en mémoire, lire une note.
permit(principal, action, resource)
when { context.autonomyLevel == "L1" };


// --- Actions réversibles à faible risque (L2) -------------------------------
// Créer une note, ajouter une tâche, lancer une recherche locale.
permit(principal, action, resource)
when { context.autonomyLevel == "L2" };


// --- Actions à validation (L3) ----------------------------------------------
// Envoyer un email, déplacer un rendez-vous, publier.
// La permission existe ; l'exécution reste soumise à confirmation par le Gate.
permit(principal, action, resource)
when { context.autonomyLevel == "L3" };


// --- Actions à confirmation forte (L4) --------------------------------------
// Paiement, suppression, donnée sensible, action irréversible.
// Réservées à l'utilisateur : ni Jarvis seul, ni une automation.
permit(principal, action, resource)
when {
    context.autonomyLevel == "L4" &&
    (principal == Actor::"USER" || principal == Actor::"JARVIS")
};
