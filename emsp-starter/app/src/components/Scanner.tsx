import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { t } from "../i18n";
import { fontSize, radius, space, type, useScale, useTheme } from "../theme";
import { Button } from "./Controls";

/**
 * The charger's QR code, through the camera (iOS and Android). The camera is asked for
 * only when the driver taps; without it, they type the ID instead. The web build has
 * no scanner (Scanner.web.tsx).
 */
export const scannerAvailable = true;

export function Scanner({ onCode }: { onCode: (text: string) => void }) {
  const { c } = useTheme();
  const { fs } = useScale();
  const [permission, ask] = useCameraPermissions();
  // One code per scan: the camera keeps reporting it while it is in view.
  const done = useRef(false);

  if (!permission?.granted)
    return (
      <View style={styles.gap}>
        {permission && !permission.canAskAgain && (
          <Text
            role="alert"
            style={[
              type.body,
              { color: c.text, fontSize: fs(fontSize.sm + 1) },
            ]}
          >
            {t("start.cameraDenied")}
          </Text>
        )}
        <Button
          label={t("start.scan")}
          icon="camera"
          onPress={() => void ask()}
          testID="scan-start"
        />
      </View>
    );
  return (
    <View
      style={[styles.frame, { borderColor: c.primary }]}
      aria-label={t("start.cameraLabel")}
    >
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          done.current = true;
          onCode(data);
          setTimeout(() => (done.current = false), 2000);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: space.sm },
  frame: {
    width: "100%",
    aspectRatio: 1,
    maxHeight: 360,
    borderRadius: radius.lg,
    borderWidth: 3,
    overflow: "hidden",
  },
});
