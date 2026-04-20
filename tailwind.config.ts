import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111110",
        paper: "#f2efe8",
        "paper-2": "#e6e2d7",
        mute: "#8a8776",
        signal: "#c8371d",
        moss: "#4a5a3a",
      },
      fontFamily: {
        display: ["var(--font-archivo)", "Archivo", "sans-serif"],
        body: ["var(--font-grotesk)", "Space Grotesk", "sans-serif"],
        serif: ["var(--font-instrument)", "Instrument Serif", "serif"],
        mono: ["var(--font-jbm)", "JetBrains Mono", "monospace"],
      },
      letterSpacing: {
        tightest: "-0.05em",
        tighter2: "-0.04em",
      },
    },
  },
  plugins: [],
};

export default config;
