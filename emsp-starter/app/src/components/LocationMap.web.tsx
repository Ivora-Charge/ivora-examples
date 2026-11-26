import "maplibre-gl/dist/maplibre-gl.css";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
} from "react";
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
import { clearOfCredit } from "../lib/credit";
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
  usePhoneFrame,
  YouMarker,
  type MapProps,
} from "./MapParts";

// The map's worker file, copied into public/ by scripts/copy-map-worker.mjs.
setWorkerUrl(`/maplibre-gl-worker.mjs?v=${getVersion()}`);

/**
 * Phones: keeps every marker out from under the map credit's strip, lifting it clear
 * or not drawing it (see `clearOfCredit`) until the map or the sheet moves it away.
 * Framing keeps the framed points clear (see `usePhoneFrame`); this is for the other
 * markers, and for a cluster centred away from them. Desktop has no strip.
 */
function keepClearOfCredit(map: HTMLElement) {
  const credit = map
    .querySelector('[data-testid="map-credit"]')
    ?.getBoundingClientRect();
  // Nothing to measure while another screen covers this one.
  if (credit && !credit.width) return;
  map.querySelectorAll<HTMLElement>(".maplibregl-marker").forEach((marker) => {
    const lifted = Number(marker.dataset.lift ?? 0);
    const { left, right, top, bottom } = marker.getBoundingClientRect();
    // Judged where the map put it, without an earlier lift.
    const placed = { left, right, top: top + lifted, bottom: bottom + lifted };
    const clear = credit ? clearOfCredit(placed, credit) : 0;
    const lift = clear === "hide" ? 0 : clear;
    marker.style.visibility = clear === "hide" ? "hidden" : "";
    // `translate` adds to the `transform` that MapLibre places the marker with.
    marker.style.translate = lift ? `0 ${-lift}px` : "";
    marker.dataset.lift = String(lift);
  });
}

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
  const root = useRef<ComponentRef<typeof View>>(null);
  const [zoom, setZoom] = useState(13);
  const map = useMemo(() => mapStyle(c, scheme), [c, scheme]);
  const level = Math.floor(zoom * 2) / 2;
  const groups = useMemo(() => cluster(items, level), [items, level]);
  const { open, chooser } = useClusterChooser({ items, selectedId, onSelect });
  // Room around framed places. Phones keep just enough to show a cluster whole clear
  // of the brand pill and the credit: they have little map to spare.
  const wide = useWide();
  const phone = usePhoneFrame();
  const padding = {
    top: insets.top + (wide ? 40 : phone.top),
    right: insets.right + 40,
    bottom: insets.bottom + (wide ? 40 : phone.bottom),
    left: insets.left + 40,
  };

  // On the web a view's ref is its element.
  const clearCredit = useCallback(() => {
    const el = root.current as unknown as HTMLElement | null;
    if (el) keepClearOfCredit(el);
  }, []);
  // After every render (new markers, or the credit moved with the sheet), and on
  // every frame the map draws (below).
  useEffect(clearCredit);
  // The strip grows with the text size and the loaded font, without either.
  useEffect(() => {
    const strip = (
      root.current as unknown as HTMLElement | null
    )?.querySelector('[data-testid="map-credit"]');
    if (!strip) return;
    const watch = new ResizeObserver(clearCredit);
    watch.observe(strip);
    return () => watch.disconnect();
  }, [wide, clearCredit]);

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
      ref={root}
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
        onRender={clearCredit}
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
              // Phones: above the clusters, your position and the credit's tap target.
              style={{
                zIndex: (g.item.id === selectedId ? 2 : 1) + (wide ? 0 : 1),
              }}
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
