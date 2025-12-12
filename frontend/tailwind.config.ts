/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#00C853",
        danger: "#FF6B6B",
        base: {
          100: "#0b0c0e",
          200: "#0f1113",
          300: "#191C1F",
          content: "#e6eef6",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["Roboto Mono", "ui-monospace"],
      },
      boxShadow: {
        glow: "0 0 20px rgba(0, 200, 83, 0.25)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography"), require("daisyui")],
  daisyui: {
    styled: true,
    themes: [
      {
        archangel: {
          primary: "#00C853",
          secondary: "#191C1F",
          accent: "#FF6B6B",
          neutral: "#1B1D1F",
          "base-100": "#0b0c0e",
          "base-200": "#0f1113",
          "base-content": "#e6eef6",
        },
      },
      "night",
      "retro",
    ],
    base: true,
    utils: true,
    logs: false,
    rtl: false,
  },
};
