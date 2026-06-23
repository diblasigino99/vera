import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#111111",
        muted: "#6E6E73",
        line: "#E5E5EA",
        mist: "#F5F5F7",
        graphite: "#2C2C2E",
        signal: "#0071E3"
      },
      fontFamily: {
        serif: ["var(--font-serif)", "Georgia", "serif"],
        sans: ["var(--font-sans)", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"]
      },
      boxShadow: {
        soft: "0 18px 60px rgba(0, 0, 0, 0.08)",
        focus: "0 0 0 1px rgba(0, 113, 227, 0.16), 0 0 34px rgba(0, 113, 227, 0.18)"
      }
    }
  },
  plugins: []
};

export default config;
