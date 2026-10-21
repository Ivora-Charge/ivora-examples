import localFont from "next/font/local";

// Self-hosted SIL OFL 1.1 fonts; the licenses are in brand/fonts/OFL-*.txt.
const archivo = localFont({
  src: "./fonts/archivo-black-latin-400-normal.woff2",
  weight: "400",
  variable: "--font-archivo",
});
const atkinson = localFont({
  src: [
    {
      path: "./fonts/atkinson-hyperlegible-latin-400-normal.woff2",
      weight: "400",
    },
    {
      path: "./fonts/atkinson-hyperlegible-latin-700-normal.woff2",
      weight: "700",
    },
  ],
  variable: "--font-atkinson",
});

export const fontVariables = `${archivo.variable} ${atkinson.variable}`;
