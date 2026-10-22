import * as Location from "expo-location";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ChargerDetail } from "../../components/ChargerDetail";
import { IconButton } from "../../components/Controls";
import { FilterBar } from "../../components/FilterBar";
import { LocationMap } from "../../components/LocationMap";
import { FALLBACK_CENTER, type MapProps } from "../../components/MapParts";
import { Logo } from "../../components/Logo";
import { PlaceList, type ListState } from "../../components/PlaceList";
import { SearchField } from "../../components/SearchField";
import { t } from "../../i18n";
import { searchLocations } from "../../lib/api";
import { isOfflineDemo } from "../../lib/config";
import { boundsOf, type LatLng } from "../../lib/geo";
import { remember } from "../../lib/recent";
import {
  NO_FILTERS,
  openNowFilter,
  SEARCH_RADIUS_M,
  type Filters,
  type Search,
} from "../../lib/search";
import type { LocationSummary } from "../../lib/types";
import {
  elevation,
  fontSize,
  radius,
  space,
  type,
  useScale,
  useTheme,
  useWide,
} from "../../theme";

/**
 * Where the offline demo puts the driver: beside the sample chargers, so "near me"
 * works without asking for the device's location (the demo sends nothing anywhere).
 */
const DEMO_POSITION: LatLng = {
  lat: FALLBACK_CENTER.lat - 0.0012,
  lng: FALLBACK_CENTER.lng + 0.0015,
};

type Sheet = "peek" | "half" | "full";
const SHEETS: Sheet[] = ["peek", "half", "full"];

/** The main screen: map and list of chargers, search and filters. */
export default function MapScreen() {
  const wide = useWide();
  const { c } = useTheme();
  const { fs } = useScale();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [you, setYou] = useState<LatLng | undefined>(
    isOfflineDemo() ? DEMO_POSITION : undefined,
  );
  const [locateNote, setLocateNote] = useState("");
  const [list, setList] = useState<ListState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<LocationSummary | undefined>();
  const [target, setTarget] = useState<MapProps["target"]>();
  const [sheet, setSheet] = useState<Sheet>("half");
  const [height, setHeight] = useState(0);
  const targetKey = useRef(0);

  // Typing searches after a short pause; the keyboard's search key does so at once.
  useEffect(() => {
    const id = setTimeout(() => setQuery(text), 350);
    return () => clearTimeout(id);
  }, [text]);

  useEffect(() => {
    let live = true;
    const s: Search = {
      text: query,
      filters,
      near: you ? { ...you, radiusM: SEARCH_RADIUS_M } : undefined,
    };
    setList((l) => (l.state === "ready" ? l : { state: "loading" }));
    searchLocations(s).then(
      (r) => {
        if (!live) return;
        const items = openNowFilter(r.items, filters);
        remember(items);
        setList({ state: "ready", items, nearRadiusM: s.near?.radiusM });
        // Near the driver: frame them and the closest few. Otherwise: every result.
        const points = s.near
          ? [s.near, ...items.slice(0, 4).map((i) => i.coordinates)]
          : items.map((i) => i.coordinates);
        const bounds = boundsOf(points);
        if (bounds) setTarget({ key: ++targetKey.current, bounds });
      },
      () => live && setList({ state: "error" }),
    );
    return () => {
      live = false;
    };
  }, [query, filters, you, attempt]);

  const locate = useCallback(async () => {
    setLocateNote("");
    if (isOfflineDemo()) {
      setYou(DEMO_POSITION);
      setTarget({ key: ++targetKey.current, center: DEMO_POSITION, zoom: 14 });
      return;
    }
    try {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (!granted) {
        setLocateNote(t("map.locateDenied"));
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const at = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setYou(at);
      setTarget({ key: ++targetKey.current, center: at, zoom: 14 });
    } catch {
      setLocateNote(t("map.locateDenied"));
    }
  }, []);

  const select = useCallback(
    (place: LocationSummary) => {
      if (wide) {
        setSelected(place);
        setTarget({
          key: ++targetKey.current,
          center: place.coordinates,
          zoom: 15,
        });
      } else
        router.push({ pathname: "/location/[id]", params: { id: place.id } });
    },
    [wide],
  );

  const items = list.state === "ready" ? list.items : [];
  const results = (
    <PlaceList
      list={list}
      selectedId={selected?.id}
      onSelect={select}
      onRetry={() => setAttempt((n) => n + 1)}
      onClearFilters={() => {
        setFilters(NO_FILTERS);
        setText("");
      }}
    />
  );
  const search = (
    <SearchField
      value={text}
      onChange={setText}
      onSubmit={() => setQuery(text)}
    />
  );
  const chips = (
    <FilterBar filters={filters} onChange={setFilters} wrap={wide} />
  );
  const note = locateNote ? (
    <Text
      role="alert"
      style={[type.body, { color: c.danger, fontSize: fs(fontSize.sm) }]}
    >
      {locateNote}
    </Text>
  ) : null;

  const sheetHeight = useMemo(() => {
    if (!height) return 0;
    const peek = Math.min(220, height * 0.4);
    return sheet === "peek"
      ? peek
      : sheet === "half"
        ? Math.max(peek, height * 0.5)
        : height;
  }, [sheet, height]);

  // Frame the results again once the sheet's height is known (the map's padding).
  const measured = height > 0;
  useEffect(() => {
    if (measured)
      setTarget((t) => (t ? { ...t, key: ++targetKey.current } : t));
  }, [measured]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 8,
        onPanResponderRelease: (_, g) =>
          setSheet((s) => {
            const i = SHEETS.indexOf(s);
            if (g.dy < -40) return SHEETS[Math.min(2, i + 1)];
            if (g.dy > 40) return SHEETS[Math.max(0, i - 1)];
            return s;
          }),
      }),
    [],
  );

  if (wide)
    return (
      <View style={styles.row} role="main">
        <View
          style={[
            styles.panel,
            { backgroundColor: c.background, borderRightColor: c.border },
          ]}
        >
          <ScrollView contentContainerStyle={styles.panelContent}>
            <Logo />
            <Text
              role="heading"
              aria-level={1}
              style={[
                type.heading,
                styles.headline,
                { color: c.text, fontSize: fs(fontSize.xxl + 4) },
              ]}
            >
              {t("map.headline.before")}
              <Text style={{ color: c.primary }}>{t("map.headline.em")}</Text>
              {t("map.headline.after")}
            </Text>
            {search}
            {chips}
            {note}
            {results}
          </ScrollView>
        </View>
        <View style={[styles.flex, { backgroundColor: c.mapLand }]}>
          <LocationMap
            items={items}
            selectedId={selected?.id}
            onSelect={select}
            you={you}
            target={target}
            insets={{ top: 0, right: selected ? 460 : 0, bottom: 0, left: 0 }}
          />
          <View style={styles.mapTools}>
            <IconButton
              icon="locate"
              label={t("map.locate")}
              onPress={locate}
              floating
            />
          </View>
          {selected && (
            <View style={[styles.detailCard, elevation(c, true)]}>
              <ChargerDetail
                id={selected.id}
                summary={selected}
                variant="card"
                onClose={() => setSelected(undefined)}
              />
            </View>
          )}
        </View>
      </View>
    );

  return (
    <View
      role="main"
      style={[styles.flex, { backgroundColor: c.mapLand }]}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
    >
      <LocationMap
        items={items}
        onSelect={select}
        you={you}
        target={target}
        insets={{ top: 64, right: 0, bottom: sheetHeight, left: 0 }}
      />
      <View style={styles.topBar} pointerEvents="box-none">
        <View
          style={[
            styles.logoPill,
            { backgroundColor: c.surface },
            elevation(c),
          ]}
        >
          <Logo size={28} />
        </View>
        <IconButton
          icon="locate"
          label={t("map.locate")}
          onPress={locate}
          floating
        />
      </View>
      {sheetHeight > 0 && (
        <View
          style={[
            styles.sheet,
            { height: sheetHeight, backgroundColor: c.background },
            elevation(c, true),
          ]}
          testID="sheet"
        >
          <View {...pan.panHandlers}>
            <Pressable
              role="button"
              aria-label={
                sheet === "full" ? t("sheet.collapse") : t("sheet.expand")
              }
              aria-expanded={sheet === "full"}
              onPress={() =>
                setSheet((s) =>
                  s === "full" ? "half" : s === "half" ? "full" : "half",
                )
              }
              style={styles.handleHit}
            >
              <View style={[styles.handle, { backgroundColor: c.border }]} />
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={styles.sheetContent}
            keyboardShouldPersistTaps="handled"
          >
            {search}
            {chips}
            {note}
            {results}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flex: 1, flexDirection: "row" },
  panel: { width: 440, maxWidth: "45%", borderRightWidth: 1 },
  panelContent: { padding: space.lg, gap: space.md + 2 },
  headline: { letterSpacing: -1.5, marginTop: space.sm },
  mapTools: {
    position: "absolute",
    left: space.lg,
    bottom: space.xl,
    gap: space.sm,
  },
  detailCard: {
    position: "absolute",
    top: space.lg,
    right: space.lg,
    bottom: space.lg,
    width: 420,
    maxWidth: "60%",
    borderRadius: radius.lg + 6,
  },
  topBar: {
    position: "absolute",
    top: space.md,
    left: space.md,
    right: space.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  logoPill: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.lg + 6,
    borderTopRightRadius: radius.lg + 6,
    overflow: "hidden",
  },
  handleHit: { alignItems: "center", justifyContent: "center", minHeight: 44 },
  handle: { width: 48, height: 5, borderRadius: radius.pill },
  sheetContent: {
    paddingHorizontal: space.md,
    paddingBottom: space.lg,
    gap: space.md,
  },
});
