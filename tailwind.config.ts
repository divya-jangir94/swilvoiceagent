import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        "va-bg": "#020817",
        "va-surface": "#020617",
        "va-surface-alt": "#020617",
        "va-accent": "#3b82f6",
        "va-accent-soft": "rgba(59,130,246,0.1)"
      }
    }
  },
  plugins: []
};

export default config;

