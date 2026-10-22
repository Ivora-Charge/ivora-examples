import { Tabs } from "expo-router/js-tabs";
import { TabBar } from "../../components/TabBar";
import { useTheme, useWide } from "../../theme";

export default function TabsLayout() {
  const wide = useWide();
  const { c } = useTheme();
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} rail={wide} />}
      screenOptions={{
        headerShown: false,
        tabBarPosition: wide ? "left" : "bottom",
        sceneStyle: { backgroundColor: c.background },
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="charging" />
      <Tabs.Screen name="wallet" />
      <Tabs.Screen name="account" />
    </Tabs>
  );
}
