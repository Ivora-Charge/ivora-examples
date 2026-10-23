import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, G, Path } from "react-native-svg";
import { brand, fontSize, space, type, useScale, useTheme } from "../theme";

const PIN =
  "M24 2.5c-9.7 0-17.5 7.6-17.5 17.1 0 12.2 15.1 24.6 16.4 25.6a1.8 1.8 0 0 0 2.2 0c1.3-1 16.4-13.4 16.4-25.6C41.5 10.1 33.7 2.5 24 2.5ZM17.6 12.4a2.4 2.4 0 0 1 2.4 2.4v7.4a2.4 2.4 0 0 1-4.8 0v-7.4a2.4 2.4 0 0 1 2.4-2.4Zm12.8 0a2.4 2.4 0 0 1 2.4 2.4v7.4a2.4 2.4 0 0 1-4.8 0v-7.4a2.4 2.4 0 0 1 2.4-2.4Z";

/**
 * The mark: a map pin tilted 12° (on the move) with a plug's two prongs cut out, and a
 * flare dot at its foot (you, arriving). Same drawing as docs/brief/logo.svg.
 */
export function Mark({
  size = 32,
  dot = true,
}: {
  size?: number;
  dot?: boolean;
}) {
  const { c } = useTheme();
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden
      focusable={false}
    >
      <G transform="rotate(-12 24 24)">
        <Path d={PIN} fill={c.primary} fillRule="evenodd" />
      </G>
      {dot && <Circle cx={40.5} cy={40.5} r={5} fill={c.flare} />}
    </Svg>
  );
}

/** Mark and wordmark, read out as the network's name. */
export function Logo({ size = 30 }: { size?: number }) {
  const { c } = useTheme();
  const { fs } = useScale();
  return (
    <View style={styles.row} role="img" aria-label={brand.name}>
      <Mark size={size} />
      <Text
        style={[
          type.heading,
          styles.word,
          { color: c.text, fontSize: fs(fontSize.lg) },
        ]}
        aria-hidden
      >
        {brand.name.toLowerCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  word: { letterSpacing: -0.5 },
});
