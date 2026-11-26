import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { getVersion, setWorkerUrl } from "maplibre-gl";
import Map, { Marker, type MapRef } from "react-map-gl/maplibre";
import { t } from "../i18n";
import {
  cluster,
  splitZoom,
  tapOpensChooser,
  type Clustered,
} from "../lib/cluster";
import { mapStyle } from "../lib/map-style";
import type { LocationSummary } from "../lib/types";
import { useTheme, useWide } from "../theme";
import { useClusterChooser } from "./ClusterChooser";
import {
  Attribution,
  ClusterMarker,
  FALLBACK_CENTER,
  MapBoundary,
  PlaceMarker,
  YouMarker,
  type MapProps,
} from "./MapParts";

// The map's worker file, copied into public/ by scripts/copy-map-worker.mjs.
setWorkerUrl(`/maplibre-gl-worker.mjs?v=${getVersion()}`);

/** The map on the web: MapLibre GL JS. Same style, markers and clusters as on phones. */
function WebMap({
  items,
  selectedId,
  onSelect,
  you,
  target,
  insets,
}: MapProps) {
  const { c, scheme } = useTheme();
  const ref = useRef<MapRef>(null);
  const [zoom, setZoom] = useState(13);
  const map = useMemo(() => mapStyle(c, scheme), [c, scheme]);
  const level = Math.floor(zoom * 2) / 2;
  const groups = useMemo(() => cluster(items, level), [items, level]);
  const { open, chooser } = useClusterChooser({ items, selectedId, onSelect });
  // Room around framed places. Phones have less map to spare above and below.
  const margin = useWide() ? 40 : 24;
  const padding = {
    top: insets.top + margin,
    right: insets.right + 40,
    bottom: insets.bottom + margin,
    left: insets.left + 40,
  };

  useEffect(() => {
    const m = ref.current;
    if (!m || !target) return;
    if (target.bounds) {
      const b = target.bounds;
      m.fitBounds(
        [
          [b.west, b.south],
          [b.east, b.north],
        ],
        { padding, maxZoom: 15, duration: 600 },
      );
    } else if (target.center)
      m.flyTo({
        center: [target.center.lng, target.center.lat],
        zoom: target.zoom ?? 14,
        padding,
        duration: 600,
      });
    // Only a new target moves the camera, not new insets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.key]);

  /** Zoom to a cluster's places, always far enough to tell some of them apart. */
  const zoomTo = (
    g: Extract<Clustered<LocationSummary>, { kind: "cluster" }>,
  ) => {
    const m = ref.current;
    if (!m) return;
    const { west, south, east, north } = g.bounds;
    const bounds: [[number, number], [number, number]] = [
      [west, south],
      [east, north],
    ];
    const options = { padding, maxZoom: 17 };
    const least = splitZoom(g.items, level);
    const fit = m.getMap().cameraForBounds(bounds, options);
    if ((fit?.zoom ?? 0) >= least) {
      m.fitBounds(bounds, { ...options, duration: 500 });
      return;
    }
    // Centred in the room left, allowing for any padding the camera already keeps.
    const kept = m.getMap().getPadding();
    m.easeTo({
      center: [(west + east) / 2, (south + north) / 2],
      zoom: least,
      offset: [
        (padding.left - padding.right - (kept.left ?? 0) + (kept.right ?? 0)) /
          2,
        (padding.top - padding.bottom - (kept.top ?? 0) + (kept.bottom ?? 0)) /
          2,
      ],
      duration: 500,
    });
  };

  return (
    <View
      style={StyleSheet.absoluteFill}
      role="region"
      aria-label={t("map.region")}
      testID="map"
    >
      <Map
        ref={ref}
        mapStyle={map.style}
        initialViewState={{
          longitude: (you ?? FALLBACK_CENTER).lng,
          latitude: (you ?? FALLBACK_CENTER).lat,
          zoom: 13,
        }}
        onMove={(e) => setZoom(e.viewState.zoom)}
        attributionControl={false}
        dragRotate={false}
        touchPitch={false}
        style={{ position: "absolute", inset: 0 }}
      >
        {groups.map((g) =>
          g.kind === "point" ? (
            <Marker
              key={g.key}
              longitude={g.at.lng}
              latitude={g.at.lat}
              anchor="bottom"
              // Above the clusters and your position.
              style={{ zIndex: g.item.id === selectedId ? 3 : 2 }}
            >
              <PlaceMarker
                place={g.item}
                selected={g.item.id === selectedId}
                onPress={() => onSelect(g.item)}
              />
            </Marker>
          ) : (
            <Marker
              key={g.key}
              longitude={g.at.lng}
              latitude={g.at.lat}
              anchor="center"
            >
              <ClusterMarker
                count={g.count}
                chooses={tapOpensChooser(g, level)}
                onPress={() => {
                  if (tapOpensChooser(g, level)) open(g.items);
                  else zoomTo(g);
                }}
              />
            </Marker>
          ),
        )}
        {you && (
          <Marker longitude={you.lng} latitude={you.lat} anchor="center">
            <YouMarker />
          </Marker>
        )}
      </Map>
      <Attribution
        text={map.attribution}
        url={map.attributionUrl}
        bottom={insets.bottom}
      />
      {chooser}
    </View>
  );
}

export function LocationMap(props: MapProps) {
  return (
    <MapBoundary>
      <WebMap {...props} />
    </MapBoundary>
  );
}
