/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces
        bg:        'var(--c-bg)',
        surface:   'var(--c-surface)',
        'surface-2': 'var(--c-surface-2)',
        'surface-3': 'var(--c-surface-3)',
        // Borders
        border:        'var(--c-border)',
        'border-subtle': 'var(--c-border-subtle)',
        // Text
        fg:        'var(--c-fg)',
        'fg-muted':  'var(--c-fg-muted)',
        'fg-subtle': 'var(--c-fg-subtle)',
        // Accent — gold
        accent:       'var(--c-accent)',
        'accent-hover': 'var(--c-accent-hover)',
        'accent-dim':   'var(--c-accent-dim)',
        // Link / secondary — steel blue
        link:         'var(--c-link)',
        'link-hover': 'var(--c-link-hover)',
        'link-dim':   'var(--c-link-dim)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
