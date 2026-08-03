import type { Config } from 'tailwindcss';

// Palette sobre : papier, encre, un seul accent. La parcimonie est aussi visuelle (§6.1).
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#faf8f4',
        ink: '#1c1917',
        muted: '#6b6864',
        rule: '#e3ded5',
        accent: '#7c4a2d',
      },
      fontFamily: {
        serif: ['Iowan Old Style', 'Palatino', 'Georgia', 'serif'],
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      maxWidth: {
        reading: '38rem',
      },
    },
  },
  plugins: [],
};

export default config;
