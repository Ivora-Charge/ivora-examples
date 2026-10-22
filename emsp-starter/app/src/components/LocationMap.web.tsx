import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { getVersion, setWorkerUrl } from "maplibre-gl";
import Map, { Marker, type MapRef } from "react-map-gl/maplibre";
import { t } from "../i18n";
import { cluster } from "../lib/cluster";
import { mapStyle } from "../lib/map-style";
import { useTheme } from "../theme";
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
  const groups = useMemo(
    () => cluster(items, Math.floor(zoom * 2) / 2),
    [items, zoom],
  );
  const padding = {
    top: insets.top + 40,
    right: insets.right + 40,
    bottom: insets.bottom + 40,
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
              style={{ zIndex: g.item.id === selectedId ? 2 : 1 }}
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
                onPress={() =>
                  ref.current?.fitBounds(
                    [
                      [g.bounds.west, g.bounds.south],
                      [g.bounds.east, g.bounds.north],
                    ],
                    { padding, maxZoom: 17, duration: 500 },
                  )
                }
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
      <Attribution text={map.attribution} bottom={insets.bottom} />
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
