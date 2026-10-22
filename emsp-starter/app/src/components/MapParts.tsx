import { Component, type ReactNode } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { i18n, t, tn } from "../i18n";
import type { Bounds, LatLng } from "../lib/geo";
import { OPENFREEMAP } from "../lib/map-style";
import { present } from "../lib/present";
import { placeKind } from "../lib/status";
import type { LocationSummary } from "../lib/types";
import {
  elevation,
  fontSize,
  radius,
  space,
  type,
  useScale,
  useTheme,
} from "../theme";
import { PowerTile } from "./PowerTile";

const p = present(i18n);

/** What every map implementation (web, iOS, Android) takes. */
export type MapProps = {
  items: LocationSummary[];
  selectedId?: string;
  onSelect: (place: LocationSummary) => void;
  /** The driver, when they shared their location. */
  you?: LatLng;
  /** Move the camera when `key` changes: fit `bounds`, or centre on `center`. */
  target?: { key: number; bounds?: Bounds; center?: LatLng; zoom?: number };
  /** Space covered by panels over the map (the phone's sheet, the desktop detail card). */
  insets: { top: number; right: number; bottom: number; left: number };
};

export const FALLBACK_CENTER: LatLng = { lat: 52.09074, lng: 5.12142 };

/** A charger on the map: its power tile with a pointer, read out in words. */
export function PlaceMarker({
  place,
  selected,
  onPress,
}: {
  place: LocationSummary;
  selected: boolean;
  onPress: () => void;
}) {
  const kind = placeKind(place);
  return (
    <Pressable
      role="button"
      aria-label={t("map.marker", {
        name: place.name,
        power: i18n.kw(place.max_power_kw),
        status: p.availability(place).text,
      })}
      aria-current={selected ? "true" : undefined}
      onPress={onPress}
      testID={`marker-${place.name}`}
      style={[styles.marker, selected && styles.markerSelected]}
    >
      <PowerTile
        kw={place.max_power_kw}
        kind={kind}
        size={46}
        selected={selected}
        pin
      />
    </Pressable>
  );
}

/** Several places too close to tell apart: a violet disc with the count. */
export function ClusterMarker({
  count,
  onPress,
}: {
  count: number;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const { fs, dim } = useScale();
  return (
    <Pressable
      role="button"
      aria-label={`${tn("map.cluster", count)}. ${t("map.clusterHint")}`}
      onPress={onPress}
      style={[styles.halo, { backgroundColor: `${c.primary}33`, padding: 7 }]}
    >
      <View
        style={[
          styles.disc,
          { backgroundColor: c.primary, minWidth: dim(52), minHeight: dim(52) },
          elevation(c),
        ]}
      >
        <Text
          style={[
            type.heading,
            { color: c.onPrimary, fontSize: fs(fontSize.lg) },
          ]}
        >
          {i18n.number(count)}
        </Text>
      </View>
    </Pressable>
  );
}

/** You: a violet dot with a soft ring. */
export function YouMarker() {
  const { c } = useTheme();
  return (
    <View
      style={[styles.you, { backgroundColor: `${c.primary}33` }]}
      aria-hidden
    >
      <View
        style={[
          styles.youDot,
          { backgroundColor: c.primary, borderColor: c.surface },
        ]}
      />
    </View>
  );
}

/** The map data credit, always readable, above the sheet and the tab bar. */
export function Attribution({
  text,
  bottom,
}: {
  text: string;
  bottom: number;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  if (!text) return null;
  return (
    <Pressable
      role="link"
      aria-label={`${t("map.attribution")}: ${text}`}
      onPress={() => void Linking.openURL(OPENFREEMAP.copyrightUrl)}
      style={[
        styles.attribution,
        { bottom: bottom + space.xs, backgroundColor: c.surface },
      ]}
      testID="map-attribution"
    >
      <Text style={[type.body, { color: c.muted, fontSize: fs(fontSize.xs) }]}>
        {text}
      </Text>
    </Pressable>
  );
}

/** Shown instead of the map when a device cannot draw it (no WebGL, say). */
export function MapUnavailable() {
  const { c } = useTheme();
  const { fs } = useScale();
  return (
    <View style={[styles.unavailable, { backgroundColor: c.mapLand }]}>
      <Text
        style={[
          type.body,
          styles.unavailableText,
          { color: c.text, fontSize: fs(fontSize.md) },
        ]}
      >
        {t("map.unavailable")}
      </Text>
    </View>
  );
}

/** Keeps a map failure from taking the list down with it. */
export class MapBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <MapUnavailable /> : this.props.children;
  }
}

const styles = StyleSheet.create({
  marker: { alignItems: "center" },
  markerSelected: { zIndex: 2 },
  halo: { borderRadius: radius.pill },
  disc: {
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.sm,
  },
  you: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  youDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 3 },
  attribution: {
    position: "absolute",
    right: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    maxWidth: "90%",
  },
  unavailable: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.lg,
  },
  unavailableText: { textAlign: "center", maxWidth: 320 },
});
