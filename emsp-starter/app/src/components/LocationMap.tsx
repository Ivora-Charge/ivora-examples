import {
  Camera,
  Map,
  Marker,
  type CameraRef,
} from "@maplibre/maplibre-react-native";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { StyleSheet, View } from "react-native";
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

/**
 * The map on iOS and Android: MapLibre Native, with the same style JSON as the web.
 * Needs a development build (`npx expo run:ios`, EAS Build); Expo Go has no MapLibre.
 */
function NativeMap({
  items,
  selectedId,
  onSelect,
  you,
  target,
  insets,
}: MapProps) {
  const { c, scheme } = useTheme();
  const camera = useRef<CameraRef>(null);
  const [zoom, setZoom] = useState(13);
  const map = useMemo(() => mapStyle(c, scheme), [c, scheme]);
  const groups = useMemo(
    () => cluster(items, Math.floor(zoom * 2) / 2),
    [items, zoom],
  );
  const padding = {
    top: insets.top + 48,
    right: insets.right + 48,
    bottom: insets.bottom + 48,
    left: insets.left + 48,
  };

  useEffect(() => {
    const cam = camera.current;
    if (!cam || !target) return;
    if (target.bounds) {
      const b = target.bounds;
      cam.fitBounds([b.west, b.south, b.east, b.north], {
        padding,
        duration: 600,
      });
    } else if (target.center)
      cam.flyTo({
        center: [target.center.lng, target.center.lat],
        zoom: target.zoom ?? 14,
        padding,
        duration: 600,
      });
    // Only a new target moves the camera, not new insets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.key]);

  const start = you ?? FALLBACK_CENTER;
  return (
    <View
      style={StyleSheet.absoluteFill}
      aria-label={t("map.region")}
      testID="map"
    >
      <Map
        style={StyleSheet.absoluteFill}
        // The same style JSON; maplibre-gl and MapLibre Native each bundle its type.
        mapStyle={map.style as ComponentProps<typeof Map>["mapStyle"]}
        attribution={false}
        logo={false}
        touchRotate={false}
        touchPitch={false}
        onRegionDidChange={(e) => setZoom(e.nativeEvent.zoom)}
      >
        <Camera
          ref={camera}
          initialViewState={{ center: [start.lng, start.lat], zoom: 13 }}
        />
        {groups.map((g) =>
          g.kind === "point" ? (
            <Marker
              key={g.key}
              id={g.key}
              lngLat={[g.at.lng, g.at.lat]}
              anchor="bottom"
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
              id={g.key}
              lngLat={[g.at.lng, g.at.lat]}
              anchor="center"
            >
              <ClusterMarker
                count={g.count}
                onPress={() =>
                  camera.current?.fitBounds(
                    [
                      g.bounds.west,
                      g.bounds.south,
                      g.bounds.east,
                      g.bounds.north,
                    ],
                    { padding, duration: 500 },
                  )
                }
              />
            </Marker>
          ),
        )}
        {you ? (
          <Marker id="you" lngLat={[you.lng, you.lat]} anchor="center">
            <YouMarker />
          </Marker>
        ) : null}
      </Map>
      <Attribution text={map.attribution} bottom={insets.bottom} />
    </View>
  );
}

export function LocationMap(props: MapProps) {
  return (
    <MapBoundary>
      <NativeMap {...props} />
    </MapBoundary>
  );
}
