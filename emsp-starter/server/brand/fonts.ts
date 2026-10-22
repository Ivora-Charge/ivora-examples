import localFont from "next/font/local";

/**
 * The brand fonts, self-hosted for the admin web (all SIL Open Font License 1.1; the
 * licence texts are next to the files in brand/fonts/). The same families and weights
 * as the driver app: Bricolage Grotesque 800 for headings, Instrument Sans 400 and 600
 * for text, DM Mono 500 for IDs. To change a font, set its name in tokens.json and
 * replace its files here.
 */
const bricolageGrotesque = localFont({
  src: "./fonts/bricolage-grotesque-latin-800-normal.woff2",
  weight: "800",
  display: "swap",
});

const instrumentSans = localFont({
  src: [
    { path: "./fonts/instrument-sans-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/instrument-sans-latin-600-normal.woff2", weight: "600" },
  ],
  display: "swap",
});

const dmMono = localFont({
  src: "./fonts/dm-mono-latin-500-normal.woff2",
  weight: "500",
  display: "swap",
});

/** The generated font-family of each `font` token, for `cssVariables()`. */
export const fontFamilies = {
  heading: bricolageGrotesque.style.fontFamily,
  body: instrumentSans.style.fontFamily,
  mono: dmMono.style.fontFamily,
};
