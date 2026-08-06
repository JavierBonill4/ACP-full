import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#0b0d10", soft: "#14181d", line: "#232a32" },
        paper: "#f6f7f8",
        accent: { DEFAULT: "#5b8def", dim: "#38508a" },
        good: "#3fb37f",
        warn: "#d9a441",
        bad: "#e0655f",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
