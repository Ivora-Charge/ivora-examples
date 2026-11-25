import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t, tn } from "../i18n";
import type { LocationSummary } from "../lib/types";
import {
  elevation,
  fontSize,
  radius,
  space,
  type,
  useScale,
  useTheme,
  useWide,
} from "../theme";
import { IconButton } from "./Controls";
import type { MapProps } from "./MapParts";
import { PlaceRow } from "./PlaceList";

/**
 * The chooser of a map (web and native): `open` it with a cluster's places, and render
 * `chooser`. It shows them as the current results have them, and a pick goes to the
 * map's `onSelect`.
 */
export function useClusterChooser({
  items,
  selectedId,
  onSelect,
}: Pick<MapProps, "items" | "selectedId" | "onSelect">) {
  const [ids, setIds] = useState<string[]>([]);
  const places = items.filter((i) => ids.includes(i.id));
  // All of them left the results: closed for good, not to reopen when they return.
  if (ids.length && !places.length) setIds([]);
  const close = useCallback(() => setIds([]), []);
  // The dialog covers every screen, so it closes when the map screen is left.
  useFocusEffect(useCallback(() => close, [close]));
  return {
    open: (members: LocationSummary[]) => setIds(members.map((m) => m.id)),
    chooser: places.length ? (
      <ClusterChooser
        places={places}
        selectedId={selectedId}
        onPick={(place) => {
          close();
          onSelect(place, "chooser");
        }}
        onClose={close}
      />
    ) : null,
  };
}

/**
 * The places of a cluster that zooming cannot separate, as list rows with their
 * address: a dialog over the whole screen (so the phone's sheet never covers it), at
 * the bottom on phones and centred on wide screens.
 */
function ClusterChooser({
  places,
  selectedId,
  onPick,
  onClose,
}: {
  places: LocationSummary[];
  selectedId?: string;
  onPick: (place: LocationSummary) => void;
  onClose: () => void;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  const wide = useWide();
  const insets = useSafeAreaInsets();
  const title = tn("map.spot", places.length);
  return (
    // No animation: the web's would never end under "reduce motion" (see WebStyles).
    <Modal
      transparent
      animationType="none"
      onRequestClose={onClose}
      aria-label={title}
    >
      <View style={[styles.frame, wide ? styles.centred : styles.bottom]}>
        {/*
          A press outside closes. Not a button: the web's focus trap would land on it.
          Keyboards and screen readers use the close button, Escape or Android's back.
        */}
        <View
          aria-hidden
          {...outsidePress(onClose)}
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: `${c.shadow}66` },
          ]}
          testID="cluster-chooser-backdrop"
        />
        <View
          style={[
            styles.card,
            wide ? styles.cardWide : styles.cardPhone,
            { backgroundColor: c.background },
            elevation(c, true),
          ]}
          testID="cluster-chooser"
        >
          <View style={styles.head}>
            <Text
              role="heading"
              aria-level={2}
              style={[
                type.heading,
                styles.title,
                { color: c.text, fontSize: fs(fontSize.lg) },
              ]}
            >
              {title}
            </Text>
            <IconButton
              icon="close"
              label={t("detail.close")}
              onPress={onClose}
              testID="cluster-chooser-close"
            />
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[
              styles.list,
              { paddingBottom: space.md + (wide ? 0 : insets.bottom) },
            ]}
          >
            {places.map((place) => (
              <PlaceRow
                key={place.id}
                place={place}
                selected={place.id === selectedId}
                onPress={() => onPick(place)}
                showAddress
              />
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/**
 * On the web a click, which (unlike a touch release) cannot fall through to what is
 * under the closing dialog.
 */
const outsidePress = (onPress: () => void): object =>
  Platform.OS === "web"
    ? { onClick: onPress }
    : { onStartShouldSetResponder: () => true, onResponderRelease: onPress };

const styles = StyleSheet.create({
  frame: { flex: 1 },
  bottom: { justifyContent: "flex-end" },
  centred: {
    justifyContent: "center",
    alignItems: "center",
    padding: space.lg,
  },
  card: { maxHeight: "80%", overflow: "hidden" },
  cardPhone: {
    borderTopLeftRadius: radius.lg + 6,
    borderTopRightRadius: radius.lg + 6,
  },
  cardWide: { width: 480, maxWidth: "100%", borderRadius: radius.lg + 6 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.md,
  },
  title: { flex: 1, minWidth: 0 },
  scroll: { flexGrow: 0 },
  list: { paddingHorizontal: space.md, gap: space.sm + 2 },
});
