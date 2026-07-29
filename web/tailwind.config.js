/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // An 8-colour ramp, hue-shifted the way the app tells models to shade:
      // shadows cool toward violet, highlights warm toward coral.
      colors: {
        ink: '#16141f',
        panel: '#1e1b2c',
        raised: '#282341',
        edge: '#3b3555',
        muted: '#6b6390',
        body: '#c9c4de',
        bright: '#f5f2ff',
        coral: '#ff7a5c',
        teal: '#4ad8c7',
        amber: '#ffc76b',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '2px',
      },
    },
  },
  plugins: [],
}
