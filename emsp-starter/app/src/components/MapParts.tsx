import { Component, type ReactNode } from "react";
import {
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { i18n, t, tn } from "../i18n";
import type { Bounds, LatLng } from "../lib/geo";
import { present } from "../lib/present";
import { placeKind } from "../lib/status";
import type { LocationSummary } from "../lib/types";
import {
  brand,
  elevation,
  fontSize,
  radius,
  space,
  type,
  useScale,
  useTheme,
  useWide,
} from "../theme";
import { Icon } from "./Icon";
import { PowerTile } from "./PowerTile";

const p = present(i18n);

/** What every map implementation (web, iOS, Android) takes. */
export type MapProps = {
  items: LocationSummary[];
  selectedId?: string;
  /** A place was picked: its pin, or its row in a cluster's chooser (`from`). */
  onSelect: (place: LocationSummary, from?: "chooser") => void;
  /** The driver, when they shared their location. */
  you?: LatLng;
  /** Move the camera when `key` changes: fit `bounds`, or centre on `center`. */
  target?: { key: number; bounds?: Bounds; center?: LatLng; zoom?: number };
  /** Space covered by panels over the map (the phone's sheet, the desktop detail card). */
  insets: { top: number; right: number; bottom: number; left: number };
};

export const FALLBACK_CENTER: LatLng = { lat: 52.09074, lng: 5.12142 };

/**
 * A charger on the map: its power tile with a pointer, read out in words. A place that
 * is closed now has the list card's grey tile with a clock badge on its corner.
 */
export function PlaceMarker({
  place,
  selected,
  onPress,
}: {
  place: LocationSummary;
  selected: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const { label, closed } = p.marker(place);
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-current={selected ? "true" : undefined}
      onPress={onPress}
      testID={`marker-${place.name}`}
      style={[
        styles.marker,
        closed && styles.markerClosed,
        selected && styles.markerSelected,
      ]}
    >
      <PowerTile
        kw={place.max_power_kw}
        kind={placeKind(place)}
        size={46}
        selected={selected}
        closed={closed}
        pin
      />
      {closed ? (
        <View
          style={[
            styles.closedBadge,
            { backgroundColor: c.surface, borderColor: c.muted },
          ]}
          aria-hidden
          testID="marker-closed"
        >
          <Icon name="clock" color={c.text} size={14} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** A cluster's disc and the halo around it, before the driver's text size. */
const CLUSTER_DISC = 52;
const CLUSTER_HALO = 7;
/** The phone's map credit strip and its gap above the sheet, before text size. */
const CREDIT_STRIP = 24;

/**
 * Phones: the room, in pixels, to keep between framed places and the map's covered
 * edges (the brand pill above, the credit strip below), so a cluster at the edge of
 * the frame shows whole: half a cluster and a gap, and the credit at the bottom. It
 * grows with the driver's text size, as the markers do.
 */
export function usePhoneFrame(): { top: number; bottom: number } {
  const { fontScale } = useWindowDimensions();
  const scale =
    Platform.OS === "web"
      ? typeof document === "undefined"
        ? 1
        : parseFloat(getComputedStyle(document.documentElement).fontSize) /
            16 || 1
      : Math.max(1, fontScale);
  const clear = (CLUSTER_DISC / 2) * scale + CLUSTER_HALO + space.sm;
  return { top: clear, bottom: clear + CREDIT_STRIP * scale };
}

/**
 * Several places too close to tell apart: a violet disc with the count. A press zooms
 * in, or opens the list of them when zooming cannot separate them (`chooses`).
 */
export function ClusterMarker({
  count,
  chooses,
  onPress,
}: {
  count: number;
  chooses: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const { fs, dim } = useScale();
  return (
    <Pressable
      role="button"
      aria-label={
        chooses
          ? `${tn("map.spot", count)}. ${t("map.spotHint")}`
          : `${tn("map.cluster", count)}. ${t("map.clusterHint")}`
      }
      // Web: tells screen readers the press opens a dialog. React Native's types lack it.
      {...((chooses ? { "aria-haspopup": "dialog" } : {}) as object)}
      onPress={onPress}
      testID="cluster"
      style={[
        styles.halo,
        { backgroundColor: `${c.primary}33`, padding: CLUSTER_HALO },
      ]}
    >
      <View
        style={[
          styles.disc,
          {
            backgroundColor: c.primary,
            minWidth: dim(CLUSTER_DISC),
            minHeight: dim(CLUSTER_DISC),
          },
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

/**
 * Web: React Native Web gives every view a stacking level of its own. On phones the
 * credit's box takes none ("auto"), so its strip is drawn over the markers while the
 * empty part of the link's tap target stays under them, and a marker there can still
 * be pressed. React Native's types allow numbers only.
 */
const NO_LAYER = Platform.OS === "web" ? ({ zIndex: "auto" } as object) : null;

/**
 * The map data credit, always readable, above the sheet and the tab bar. On phones it
 * is a tighter strip drawn above the markers too, on one line where the text fits,
 * and its link keeps a full-height tap target that reaches up from it. The desktop
 * credit is a single box, as before.
 */
export function Attribution({
  text,
  url,
  bottom,
}: {
  text: string;
  /** The map provider's page for it (see `mapStyle`); plain text without one. */
  url?: string;
  bottom: number;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  const compact = !useWide();
  if (!text) return null;
  const words = (
    <Text style={[type.body, { color: c.muted, fontSize: fs(fontSize.xs) }]}>
      {text}
    </Text>
  );
  const place = compact
    ? [
        styles.attribution,
        styles.attributionCompact,
        { bottom: bottom + space.xs },
        NO_LAYER,
      ]
    : [
        styles.attribution,
        styles.creditBox,
        { bottom: bottom + space.xs, backgroundColor: c.surface },
      ];
  const label = compact ? (
    <View
      style={[
        styles.creditBox,
        styles.creditCompact,
        { backgroundColor: c.surface },
      ]}
      testID="map-credit"
    >
      {words}
    </View>
  ) : (
    words
  );
  if (!url)
    return (
      <View style={place} testID="map-attribution">
        {label}
      </View>
    );
  return (
    <Pressable
      role="link"
      aria-label={`${t("map.attribution")}: ${text}`}
      onPress={() => void Linking.openURL(url)}
      style={[place, compact && styles.attributionTarget]}
      testID="map-attribution"
    >
      {label}
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
  // Room for the badge inside the marker's own box, so no map has to draw outside it:
  // clear of the kW, and even on both sides so the pointer stays on the spot.
  markerClosed: { paddingTop: space.xs, paddingHorizontal: space.sm },
  closedBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
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
  attribution: { position: "absolute", right: space.sm, maxWidth: "90%" },
  attributionCompact: { right: space.xs, maxWidth: "98%" },
  attributionTarget: {
    minHeight: brand.minTapTarget,
    justifyContent: "flex-end",
  },
  creditBox: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  // Phones: over the markers (up to 3, see WebStyles), as the tile licence wants it seen.
  creditCompact: {
    zIndex: 4,
    paddingHorizontal: space.xs + 2,
    paddingVertical: 1,
  },
  unavailable: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.lg,
  },
  unavailableText: { textAlign: "center", maxWidth: 320 },
});
