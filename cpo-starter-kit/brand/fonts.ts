import localFont from "next/font/local";

// Self-hosted SIL OFL 1.1 fonts; the licenses are brand/fonts/OFL-*.txt.
const ui = localFont({
  src: [
    { path: "./fonts/manrope-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/manrope-latin-600-normal.woff2", weight: "600" },
    { path: "./fonts/manrope-latin-800-normal.woff2", weight: "800" },
  ],
  variable: "--font-manrope",
});
const display = localFont({
  src: "./fonts/fraunces-latin-600-normal.woff2",
  weight: "600",
  variable: "--font-fraunces",
});

export const fontVariables = `${ui.variable} ${display.variable}`;
