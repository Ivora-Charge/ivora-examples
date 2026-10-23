import { ScrollView, StyleSheet, View } from "react-native";
import { i18n, t } from "../i18n";
import type { Filters } from "../lib/search";
import { space, useTheme } from "../theme";
import { Chip } from "./Controls";
import { Icon, StatusGlyph } from "./Icon";

type Toggle = {
  key: string;
  label: string;
  on: boolean;
  next: Partial<Filters>;
};

/**
 * The filter chips: open now, available, minimum power, connector, step-free, and free
 * or paid. One scrolling row on phones (it scrolls inside itself, never the page);
 * wrapped on wide screens.
 */
export function FilterBar({
  filters,
  onChange,
  wrap,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  wrap: boolean;
}) {
  const { c } = useTheme();
  const f = filters;
  const chips: (Toggle & { leading?: "free" | "bolt" | "step" })[] = [
    {
      key: "open",
      label: t("filters.openNow"),
      on: f.openNow,
      next: { openNow: !f.openNow },
    },
    {
      key: "available",
      label: t("filters.available"),
      on: f.available,
      next: { available: !f.available },
      leading: "free",
    },
    ...([22, 50, 150] as const).map((kw) => ({
      key: `kw${kw}`,
      label: t("filters.power", { power: i18n.kw(kw) }),
      on: f.minPowerKw === kw,
      next: { minPowerKw: f.minPowerKw === kw ? 0 : kw } as Partial<Filters>,
      leading: "bolt" as const,
    })),
    ...(
      [
        ["CCS", "filters.ccs"],
        ["TYPE2", "filters.type2"],
        ["CHADEMO", "filters.chademo"],
      ] as const
    ).map(([k, label]) => ({
      key: k,
      label: t(label),
      on: f.connector === k,
      next: { connector: f.connector === k ? "" : k } as Partial<Filters>,
    })),
    {
      key: "step",
      label: t("filters.stepFree"),
      on: f.stepFree,
      next: { stepFree: !f.stepFree },
      leading: "step",
    },
    {
      key: "free",
      label: t("filters.free"),
      on: f.price === "free",
      next: { price: f.price === "free" ? "" : "free" },
    },
    {
      key: "paid",
      label: t("filters.paid"),
      on: f.price === "paid",
      next: { price: f.price === "paid" ? "" : "paid" },
    },
  ];
  const items = chips.map((chip) => {
    const fg = chip.on ? c.onPrimary : c.text;
    return (
      <Chip
        key={chip.key}
        label={chip.label}
        on={chip.on}
        onPress={() => onChange({ ...f, ...chip.next })}
        leading={
          chip.leading === "free" ? (
            <StatusGlyph
              kind="free"
              color={chip.on ? c.onPrimary : c.free}
              size={11}
            />
          ) : chip.leading === "bolt" ? (
            <Icon name="bolt" color={fg} size={16} />
          ) : chip.leading === "step" ? (
            <Icon name="stepFree" color={fg} size={16} />
          ) : undefined
        }
      />
    );
  });
  if (wrap)
    return (
      <View style={styles.wrap} role="group" aria-label={t("filters.label")}>
        {items}
      </View>
    );
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.scroller}
      role="group"
      aria-label={t("filters.label")}
    >
      {items}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  scroller: { flexGrow: 0, marginHorizontal: -space.md },
  row: { gap: space.sm, paddingHorizontal: space.md },
});
