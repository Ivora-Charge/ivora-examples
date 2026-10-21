import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native";
import { DemoBanner } from "../components/DemoBanner";
import { StatusProvider, useDemo } from "../components/StatusProvider";
import { brand, color, font, fontWeight } from "../theme";

function Shell() {
  const { demo, offline } = useDemo();
  return (
    <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
      <StatusBar style="dark" />
      {demo && <DemoBanner offline={offline} />}
      <Stack
        screenOptions={{
          title: brand.shortName,
          headerStyle: { backgroundColor: color.surface },
          headerTintColor: color.text,
          headerTitleStyle: {
            fontFamily: font.heading,
            fontWeight: fontWeight.bold,
          },
          contentStyle: { backgroundColor: color.background },
        }}
      />
    </SafeAreaView>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusProvider>
        <Shell />
      </StatusProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
});
