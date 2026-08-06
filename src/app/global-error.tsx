'use client';

/**
 * L'ERREUR QUI EMPORTE LA MISE EN PAGE.
 *
 * `error.tsx` s'affiche À L'INTÉRIEUR du gabarit — il suppose donc que le
 * gabarit, lui, a pu se rendre. Quand c'est le gabarit qui casse (et il
 * charge le contexte, donc la base), Next remonte jusqu'ici et remplace
 * `<html>` en entier. Sans ce fichier, on retombe sur sa page anglaise.
 *
 * D'où la duplication des styles minimaux : rien de ce que fournit
 * `layout.tsx` n'est disponible ici, pas même la police.
 */
export default function ErreurGlobale({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="fr">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          background: '#f5ead8',
          color: '#201e1d',
          fontFamily: 'Figtree, system-ui, sans-serif',
          fontSize: '18px',
          lineHeight: 1.6,
        }}
      >
        <main style={{ maxWidth: '38rem', margin: '0 auto', padding: '3rem 1.25rem' }}>
          <h1 style={{ fontSize: '2rem', lineHeight: 1.12, marginBottom: '1.5rem' }}>
            Héritage ne répond pas
          </h1>
          <p style={{ fontSize: '1.125rem' }}>
            Vos récits ne sont pas perdus. L’application n’arrive pas à démarrer cette page ; ce
            que votre famille a écrit est ailleurs, intact.
          </p>
          <p style={{ marginTop: '1.5rem' }}>
            <button
              type="button"
              onClick={reset}
              style={{
                minHeight: 44,
                padding: '0 1.5rem',
                borderRadius: 999,
                border: 'none',
                background: '#8c491a',
                color: '#fff2eb',
                fontSize: '1rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Réessayer
            </button>
          </p>
          {error.digest ? (
            <p style={{ marginTop: '2rem', fontSize: '1rem', color: '#6b655e' }}>
              Référence pour l’administrateur : {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
