import { Stack } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useStatus } from "../components/StatusProvider";
import {
  brand,
  color,
  font,
  fontSize,
  fontWeight,
  radius,
  space,
} from "../theme";

const COMING = [
  "Find a charger",
  "Start and stop charging",
  "Pay by card",
  "Charging history and receipts",
];

export default function Home() {
  const s = useStatus();
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Stack.Screen options={{ title: brand.shortName }} />
      <Text role="heading" aria-level={1} style={styles.h1}>
        {brand.name}
      </Text>
      <Text style={styles.lead}>Charge on any network we partner with.</Text>

      <View style={styles.card}>
        <Text role="heading" aria-level={2} style={styles.h2}>
          Connection
        </Text>
        {s.state === "loading" && <Text style={styles.muted}>Connecting…</Text>}
        {s.state === "error" && (
          <Text style={styles.error} role="alert">
            {s.error.message} ({s.error.code})
          </Text>
        )}
        {s.state === "ready" && (
          <View>
            <Text style={styles.body}>
              {s.status.mode === "demo" ? "Demo" : "Live"} · OCPI{" "}
              {s.status.ocpi.version}
            </Text>
            <Text style={styles.muted}>
              {s.status.ocpi.country_code}-{s.status.ocpi.party_id}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.card}>
        <Text role="heading" aria-level={2} style={styles.h2}>
          Coming soon
        </Text>
        {COMING.map((c) => (
          <Text key={c} style={styles.body}>
            • {c}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    padding: space.md,
    gap: space.md,
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
  },
  h1: {
    color: color.text,
    fontFamily: font.heading,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  h2: {
    color: color.text,
    fontFamily: font.heading,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    marginBottom: space.sm,
  },
  lead: { color: color.muted, fontFamily: font.body, fontSize: fontSize.md },
  body: { color: color.text, fontFamily: font.body, fontSize: fontSize.md },
  muted: { color: color.muted, fontFamily: font.body, fontSize: fontSize.sm },
  error: { color: color.danger, fontFamily: font.body, fontSize: fontSize.md },
  card: {
    backgroundColor: color.surface,
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
  },
});
