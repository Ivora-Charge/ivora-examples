import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Image, Platform, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../components/AuthProvider";
import { Choice, ChoiceGroup } from "../components/Choice";
import { Button } from "../components/Controls";
import { Field } from "../components/Field";
import { Card, Notice, Page } from "../components/Page";
import { t } from "../i18n";
import { ApiError, getLocation, reportProblem } from "../lib/api";
import { PROBLEM_CATEGORIES, type ProblemCategory } from "../lib/charging";
import type { LocationDetail } from "../lib/types";
import { fontSize, radius, space, type, useScale, useTheme } from "../theme";

/** The photo goes at most this wide, as a JPEG: well under the server's 1 MB. */
const PHOTO_WIDTH = 1280;
const PHOTO_QUALITY = 0.6;
const MESSAGE_MAX = 2000;

const CATEGORY: Record<ProblemCategory, () => string> = {
  not_starting: () => t("report.category.not_starting"),
  stopped_early: () => t("report.category.stopped_early"),
  damaged: () => t("report.category.damaged"),
  blocked: () => t("report.category.blocked"),
  payment: () => t("report.category.payment"),
  other: () => t("report.category.other"),
};

/**
 * Report a problem at a charger: which charger, what went wrong, the driver's words and,
 * if they want, a photo. It goes to the network's admin web (Reported problems), not
 * to the charger's operator directly.
 */
export default function Report() {
  const { c } = useTheme();
  const { fs } = useScale();
  const auth = useAuth();
  const token = auth.token;
  const { location: locationId, evse } = useLocalSearchParams<{
    location: string;
    evse?: string;
  }>();
  const [location, setLocation] = useState<LocationDetail | null>(null);
  const [evseUid, setEvseUid] = useState<string>(evse ?? "");
  const [category, setCategory] = useState<ProblemCategory | null>(null);
  const [message, setMessage] = useState("");
  const [photo, setPhoto] = useState<{ uri: string; base64: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!locationId) return;
    getLocation(locationId).then(setLocation, () => setLocation(null));
  }, [locationId]);

  const pick = async (camera: boolean) => {
    setError("");
    try {
      if (camera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) return setError(t("report.cameraDenied"));
      }
      const options: ImagePicker.ImagePickerOptions = {
        mediaTypes: ["images"],
        quality: 1,
        allowsEditing: false,
        exif: false,
      };
      const res = camera
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
      if (res.canceled || !res.assets[0]) return;
      const asset = res.assets[0];
      // Smaller and without the camera's metadata (no location) before it leaves the phone.
      const context = ImageManipulator.manipulate(asset.uri);
      if ((asset.width ?? PHOTO_WIDTH + 1) > PHOTO_WIDTH)
        context.resize({ width: PHOTO_WIDTH });
      const image = await context.renderAsync();
      const saved = await image.saveAsync({
        format: SaveFormat.JPEG,
        compress: PHOTO_QUALITY,
        base64: true,
      });
      if (!saved.base64) return setError(t("report.photoFailed"));
      setPhoto({ uri: saved.uri, base64: saved.base64 });
    } catch {
      setError(t("report.photoFailed"));
    }
  };

  const send = async () => {
    if (!token || !locationId) return;
    if (!category) return setError(t("report.needCategory"));
    if (!message.trim()) return setError(t("report.needMessage"));
    setBusy(true);
    setError("");
    try {
      await reportProblem(token, {
        locationId,
        ...(evseUid ? { evseUid } : {}),
        category,
        message: message.trim(),
        ...(photo ? { photo: photo.base64 } : {}),
      });
      setSent(true);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "rate_limited"
          ? t("report.limited")
          : e instanceof ApiError && e.code === "http_413"
            ? t("report.photoTooLarge")
            : e instanceof ApiError && e.code === "unreachable"
              ? t("common.unreachable")
              : t("report.failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  if (auth.state !== "signedIn")
    return (
      <Page title={t("report.title")}>
        <Notice kind="info">{t("report.signIn")}</Notice>
        <Button
          label={t("wallet.signInButton")}
          onPress={() => router.push("/account")}
        />
      </Page>
    );

  if (sent)
    return (
      <Page title={t("report.title")}>
        <Notice
          kind="success"
          title={t("report.thanksTitle")}
          testID="report-sent"
        >
          {t("report.thanks")}
        </Notice>
        <Button
          label={t("charge.done")}
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/charging")
          }
          testID="report-done"
        />
      </Page>
    );

  return (
    <Page title={t("report.title")} testID="report-screen">
      <Text style={[type.strong, { color: c.text, fontSize: fs(fontSize.lg) }]}>
        {location?.name ?? t("detail.title")}
      </Text>
      {location && location.evses.length > 1 && (
        <Card title={t("report.which")} icon="plug">
          <ChoiceGroup label={t("report.which")}>
            <Choice
              label={t("report.notSure")}
              selected={!evseUid}
              onPress={() => setEvseUid("")}
            />
            {location.evses.map((e) => (
              <Choice
                key={e.uid}
                label={e.evse_id ?? e.uid}
                detail={
                  e.physical_reference
                    ? t("detail.reference", { reference: e.physical_reference })
                    : undefined
                }
                selected={evseUid === e.uid}
                onPress={() => setEvseUid(e.uid)}
              />
            ))}
          </ChoiceGroup>
        </Card>
      )}
      <Card title={t("report.what")} icon="flag">
        <ChoiceGroup label={t("report.what")}>
          {PROBLEM_CATEGORIES.map((k) => (
            <Choice
              key={k}
              label={CATEGORY[k]()}
              selected={category === k}
              onPress={() => setCategory(k)}
              testID={`category-${k}`}
            />
          ))}
        </ChoiceGroup>
        <Field
          id="report-message"
          label={t("report.message")}
          hint={t("report.messageHint", { max: MESSAGE_MAX })}
          value={message}
          onChangeText={(v) => setMessage(v.slice(0, MESSAGE_MAX))}
          multiline
          maxLength={MESSAGE_MAX}
          testID="report-message"
        />
      </Card>
      <Card title={t("report.photo")} icon="camera">
        <Text
          style={[type.body, { color: c.muted, fontSize: fs(fontSize.sm + 1) }]}
        >
          {t("report.photoHint")}
        </Text>
        {photo ? (
          <View style={styles.gap}>
            <Image
              source={{ uri: photo.uri }}
              style={[styles.photo, { borderColor: c.border }]}
              accessibilityLabel={t("report.photoPreview")}
              resizeMode="cover"
            />
            <Button
              label={t("report.removePhoto")}
              variant="secondary"
              onPress={() => setPhoto(null)}
            />
          </View>
        ) : (
          <View style={styles.actions}>
            {Platform.OS !== "web" && (
              <Button
                label={t("report.takePhoto")}
                icon="camera"
                variant="secondary"
                onPress={() => void pick(true)}
                style={styles.flex}
              />
            )}
            <Button
              label={t("report.choosePhoto")}
              variant="secondary"
              onPress={() => void pick(false)}
              style={styles.flex}
              testID="report-choose-photo"
            />
          </View>
        )}
      </Card>
      {error ? (
        <Notice kind="error" testID="report-error">
          {error}
        </Notice>
      ) : null}
      <Button
        label={t("report.send")}
        icon="flag"
        busy={busy}
        onPress={() => void send()}
        testID="report-send"
      />
    </Page>
  );
}

const styles = StyleSheet.create({
  gap: { gap: space.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm + 4 },
  flex: { flexGrow: 1, flexBasis: 160 },
  photo: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: radius.md,
    borderWidth: 1,
  },
});
