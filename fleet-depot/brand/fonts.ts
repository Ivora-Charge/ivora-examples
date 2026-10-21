import localFont from "next/font/local";

// Self-hosted SIL OFL 1.1 fonts; the license is brand/fonts/OFL-IBMPlex.txt.
const sans = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/ibm-plex-sans-latin-600-normal.woff2", weight: "600" },
  ],
  variable: "--font-plex-sans",
});
const cond = localFont({
  src: "./fonts/ibm-plex-sans-condensed-latin-600-normal.woff2",
  weight: "600",
  variable: "--font-plex-cond",
});
const mono = localFont({
  src: "./fonts/ibm-plex-mono-latin-500-normal.woff2",
  weight: "500",
  variable: "--font-plex-mono",
});

export const fontVariables = [sans, cond, mono]
  .map((f) => f.variable)
  .join(" ");
