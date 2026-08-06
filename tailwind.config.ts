import type { Config } from 'tailwindcss';

/**
 * PALETTE « ORGANIC » — direction 2a, pleins aplats.
 *
 * L'ancienne palette tenait en cinq couleurs : papier, encre, gris, filet,
 * un accent. Sobre, et un peu morte. Celle-ci donne une teinte par écran —
 * on sait où l'on est sans lire — sans rien coûter à la §6.1 : la
 * parcimonie porte sur ce qu'on MONTRE, pas sur l'austérité.
 *
 * Les rampes viennent du design system fourni. Deux corrections mesurées,
 * documentées dans `redesign/REVUE_2A.md` :
 *
 *  · `muted` était un mélange à 55 % du texte sur le fond, soit 3,57:1 sur
 *    crème — sous le seuil de 4,5:1 de la §6.4. Or cette couleur porte les
 *    justifications, c'est-à-dire le texte explicatif dont dépend le
 *    lecteur le plus âgé, celui pour qui le plancher de 16 px existe. Les
 *    valeurs ci-dessous sont les mélanges à 65 % et 70 %, calculés.
 *  · Les polices sont auto-hébergées. Un `@import` vers Google Fonts se
 *    résout silencieusement en `system-ui` hors ligne, et l'application est
 *    une PWA avec page hors-ligne.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Fonds et texte
        paper: '#f5ead8',
        surface: '#ebddc5',
        ink: '#201e1d',

        // Gris mesurés pour tenir 4.5:1 — jamais une opacité.
        muted: '#6b655e', // 4,84:1 sur paper
        'muted-clair': '#6c6966', // 4,98:1 sur neutral-100
        'muted-chaud': '#635046', // 5,01:1 sur accent-300

        rule: '#dcd3c4',
        divider: '#c0b6a5',

        neutre: {
          100: '#f9f4ed',
          200: '#eee7db',
          300: '#dcd3c4',
          400: '#c0b6a5',
          500: '#a19786',
          600: '#82796a',
          700: '#645c50',
          800: '#474238',
          900: '#2e2b25',
        },

        // Terre cuite — l'accent historique du produit, en rampe.
        accent: {
          100: '#fff2eb',
          200: '#ffe1d0',
          300: '#ffc6a5',
          400: '#f6a06b',
          500: '#d67f48',
          600: '#b2622d',
          700: '#8c491a',
          800: '#643312',
          900: '#402310',
          DEFAULT: '#8c491a',
        },

        // Sauge — la seconde teinte, pour les écrans de lecture.
        sauge: {
          100: '#f0fae1',
          200: '#e1eecc',
          300: '#ccdbb2',
          400: '#aebf92',
          500: '#8fa073',
          600: '#728157',
          700: '#56633f',
          800: '#3d472b',
          900: '#272e1b',
        },
      },
      fontFamily: {
        // Caprasimo n'a qu'une graisse : c'est une police d'affichage.
        titre: ['Caprasimo', 'Iowan Old Style', 'Palatino', 'Georgia', 'serif'],
        serif: ['Figtree', 'system-ui', 'sans-serif'],
        sans: ['Figtree', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        sm: '8px',
        DEFAULT: '16px',
        md: '16px',
        lg: '28px',
      },
      maxWidth: {
        reading: '38rem',
      },
      boxShadow: {
        // Teintées encre, jamais noir pur : le noir pur sur un fond crème
        // fait une ombre grise qui ne ressemble à rien.
        sm: '0 1px 2px rgba(46, 43, 37, .08)',
        md: '0 2px 6px rgba(46, 43, 37, .10), 0 8px 20px rgba(46, 43, 37, .08)',
      },
    },
  },
  plugins: [],
};

export default config;
