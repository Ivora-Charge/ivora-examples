// The web map (maplibre-gl) runs its tile work in a Web Worker loaded from its own
// file, which Metro does not bundle. This copies that file into public/, which the
// dev server serves and `expo export` copies into dist/. Runs after `npm ci`.
import { copyFile, mkdir } from "node:fs/promises";

const from = new URL(
  "../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs",
  import.meta.url,
);
const to = new URL("../public/maplibre-gl-worker.mjs", import.meta.url);
await mkdir(new URL("../public/", import.meta.url), { recursive: true });
await copyFile(from, to);
