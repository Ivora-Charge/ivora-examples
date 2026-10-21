import localFont from "next/font/local";

// Self-hosted SIL OFL 1.1 fonts; licenses are in brand/fonts/.
const body = localFont({
  src: [
    { path: "./fonts/barlow-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/barlow-latin-600-normal.woff2", weight: "600" },
  ],
  variable: "--font-barlow",
});
const head = localFont({
  src: "./fonts/barlow-condensed-latin-700-normal.woff2",
  weight: "700",
  variable: "--font-barlow-condensed",
});
const mono = localFont({
  src: [
    { path: "./fonts/jetbrains-mono-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/jetbrains-mono-latin-600-normal.woff2", weight: "600" },
  ],
  variable: "--font-jetbrains-mono",
});

export const fontVariables = [body, head, mono]
  .map((f) => f.variable)
  .join(" ");
