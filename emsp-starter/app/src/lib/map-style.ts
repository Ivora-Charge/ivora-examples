import type { StyleSpecification } from "maplibre-gl";
import type { Palette, Scheme } from "../../brand";
import { config } from "./config";

/**
 * The map, for MapLibre on the web, iOS and Android (the same style JSON on all three).
 *
 * By default the app draws its own style, coloured from the brand tokens (`map*`
 * colours, light and dark), on OpenFreeMap's vector tiles: free, no key, no account,
 * OpenStreetMap data in the OpenMapTiles schema. For production you may point
 * EXPO_PUBLIC_MAP_STYLE_URL at your own provider instead; see the README.
 */
export const OPENFREEMAP = {
  tiles: "https://tiles.openfreemap.org/planet",
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  attribution: "OpenFreeMap © OpenMapTiles © OpenStreetMap contributors",
  copyrightUrl: "https://www.openstreetmap.org/copyright",
};

const FONT = ["Noto Sans Regular"];

/** The style with no tiles: a plain background, for EXPO_PUBLIC_MAP_STYLE_URL=none. */
function plain(c: Palette): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": c.mapLand },
      },
    ],
  };
}

/** The app's own style on OpenFreeMap tiles, in the brand's map colours. */
export function brandStyle(c: Palette): StyleSpecification {
  const road = (
    id: string,
    classes: string[],
    width: [number, number, number, number],
    color: string,
    minzoom = 5,
  ) => ({
    id,
    type: "line" as const,
    source: "omt",
    "source-layer": "transportation",
    minzoom,
    filter: ["in", ["get", "class"], ["literal", classes]] as never,
    layout: { "line-cap": "round" as const, "line-join": "round" as const },
    paint: {
      "line-color": color,
      "line-width": [
        "interpolate",
        ["exponential", 1.5],
        ["zoom"],
        width[0],
        width[1],
        width[2],
        width[3],
      ] as never,
    },
  });
  const major = ["motorway", "trunk", "primary", "secondary", "tertiary"];
  const minor = ["minor", "service", "track"];
  return {
    version: 8,
    glyphs: OPENFREEMAP.glyphs,
    sources: {
      omt: { type: "vector", url: OPENFREEMAP.tiles },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": c.mapLand },
      },
      {
        id: "park",
        type: "fill",
        source: "omt",
        "source-layer": "park",
        paint: { "fill-color": c.mapPark },
      },
      {
        id: "landcover-green",
        type: "fill",
        source: "omt",
        "source-layer": "landcover",
        filter: [
          "in",
          ["get", "class"],
          ["literal", ["grass", "wood", "farmland"]],
        ],
        paint: { "fill-color": c.mapPark, "fill-opacity": 0.6 },
      },
      {
        id: "water",
        type: "fill",
        source: "omt",
        "source-layer": "water",
        paint: { "fill-color": c.mapWater },
      },
      {
        id: "waterway",
        type: "line",
        source: "omt",
        "source-layer": "waterway",
        paint: { "line-color": c.mapWater, "line-width": 2 },
      },
      {
        id: "building",
        type: "fill",
        source: "omt",
        "source-layer": "building",
        minzoom: 14,
        paint: { "fill-color": c.mapBuilding },
      },
      road("road-minor-casing", minor, [12, 1, 18, 16], c.mapRoadCasing, 12),
      road("road-major-casing", major, [6, 1, 18, 26], c.mapRoadCasing),
      road("road-minor", minor, [12, 0.5, 18, 13], c.mapRoad, 12),
      road("road-major", major, [6, 0.5, 18, 22], c.mapRoad),
      {
        id: "rail",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 11,
        filter: ["==", ["get", "class"], "rail"],
        paint: {
          "line-color": c.mapLabel,
          "line-width": 1.5,
          "line-opacity": 0.35,
          "line-dasharray": [3, 3],
        },
      },
      {
        id: "road-label",
        type: "symbol",
        source: "omt",
        "source-layer": "transportation_name",
        minzoom: 14,
        layout: {
          "symbol-placement": "line",
          "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
          "text-font": FONT,
          "text-size": 12,
          "text-transform": "uppercase",
          "text-letter-spacing": 0.08,
        },
        paint: {
          "text-color": c.mapLabel,
          "text-halo-color": c.mapLabelHalo,
          "text-halo-width": 1.5,
        },
      },
      {
        id: "water-label",
        type: "symbol",
        source: "omt",
        "source-layer": "water_name",
        minzoom: 12,
        layout: {
          "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
          "text-font": FONT,
          "text-size": 12,
          "text-letter-spacing": 0.12,
        },
        paint: {
          "text-color": c.mapLabel,
          "text-halo-color": c.mapLabelHalo,
          "text-halo-width": 1.5,
        },
      },
      {
        id: "place-label",
        type: "symbol",
        source: "omt",
        "source-layer": "place",
        layout: {
          "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
          "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 8, 12, 14, 16],
        },
        paint: {
          "text-color": c.mapLabel,
          "text-halo-color": c.mapLabelHalo,
          "text-halo-width": 2,
        },
      },
    ],
  };
}

/** The style for the configured map and the colour scheme, and the attribution to show. */
export function mapStyle(
  c: Palette,
  scheme: Scheme,
): { style: string | StyleSpecification; attribution: string; tiles: boolean } {
  const url = config.mapStyle;
  if (url?.toLowerCase() === "none")
    return { style: plain(c), attribution: "", tiles: false };
  if (url)
    return {
      style: (scheme === "dark" && config.mapStyleDark) || url,
      attribution: config.mapAttribution ?? "© OpenStreetMap contributors",
      tiles: true,
    };
  return {
    style: brandStyle(c),
    attribution: OPENFREEMAP.attribution,
    tiles: true,
  };
}
