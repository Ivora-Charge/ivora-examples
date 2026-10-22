import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AuthProvider } from "../components/AuthProvider";
import { DemoBanner } from "../components/DemoBanner";
import { StatusProvider, useDemo } from "../components/StatusProvider";
import { WebStyles } from "../components/WebStyles";
import { useBrandFonts } from "../fonts";
import { useTheme } from "../theme";

function Shell() {
  const { c, scheme } = useTheme();
  const { demo, offline } = useDemo();
  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <WebStyles />
      <StatusBar style={demo || scheme === "light" ? "dark" : "light"} />
      <SafeAreaView
        edges={["top", "left", "right"]}
        style={{ backgroundColor: demo ? c.demoBackground : c.background }}
      >
        {demo && <DemoBanner offline={offline} />}
      </SafeAreaView>
      <View style={styles.root}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: c.background },
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="location/[id]" />
          <Stack.Screen name="start" />
          <Stack.Screen name="charge/[id]" />
          <Stack.Screen name="receipt/[id]" />
          <Stack.Screen name="report" />
        </Stack>
      </View>
    </View>
  );
}

export default function RootLayout() {
  const ready = useBrandFonts();
  // On the web the system font stands in while the brand fonts load.
  if (!ready && process.env.EXPO_OS !== "web") return null;
  return (
    <SafeAreaProvider>
      <StatusProvider>
        <AuthProvider>
          <Shell />
        </AuthProvider>
      </StatusProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
