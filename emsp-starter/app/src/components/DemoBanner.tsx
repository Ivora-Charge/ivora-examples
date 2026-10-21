import { StyleSheet, Text, View } from "react-native";
import { color, font, fontSize, fontWeight, space } from "../theme";

/** Shown on every screen while the app or its server is in demo mode. */
export function DemoBanner({ offline }: { offline: boolean }) {
  return (
    <View style={styles.banner} role="status" testID="demo-banner">
      <Text style={styles.text}>
        <Text style={styles.badge}>Demo</Text>{" "}
        {offline
          ? "Offline sample data. Nothing is sent anywhere and no card is charged."
          : "The server is in demo mode, with sample data from a mock CPO. No card is charged and no charger is contacted."}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: color.demoBackground,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  text: {
    color: color.demoText,
    fontFamily: font.body,
    fontSize: fontSize.sm,
  },
  badge: {
    fontWeight: fontWeight.bold,
  },
});
