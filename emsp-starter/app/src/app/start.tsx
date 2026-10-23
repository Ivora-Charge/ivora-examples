import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useAuth } from "../components/AuthProvider";
import { Button } from "../components/Controls";
import { Field } from "../components/Field";
import { Card, Notice, Page } from "../components/Page";
import { Scanner, scannerAvailable } from "../components/Scanner";
import { t } from "../i18n";
import { ApiError, getLocation, searchLocations } from "../lib/api";
import { chargerCode, evseForCode } from "../lib/qr";
import { NO_FILTERS } from "../lib/search";
import type { LocationSummary } from "../lib/types";
import { fontSize, space, type, useScale, useTheme } from "../theme";

/**
 * Start charging without the map: scan the charger's QR code (phones) or type its ID,
 * printed on the charger. The code is looked up like the search box does; one match
 * opens the confirm screen with its connector picked, several let the driver choose.
 */
export default function Start() {
  const { c } = useTheme();
  const { fs } = useScale();
  const auth = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [choices, setChoices] = useState<LocationSummary[]>([]);

  const open = async (locationId: string, id: string) => {
    const location = await getLocation(locationId);
    const evse = evseForCode(location.evses, id);
    router.push({
      pathname: "/charge/[id]",
      params: { id: location.id, ...(evse ? { evse: evse.uid } : {}) },
    });
  };

  const find = async (text: string) => {
    setError("");
    setChoices([]);
    const id = chargerCode(text);
    if (!id) return setError(t("start.badCode"));
    setCode(id);
    setBusy(true);
    try {
      const found = await searchLocations({ text: id, filters: NO_FILTERS });
      if (!found.items.length) setError(t("start.notFound", { code: id }));
      else if (found.items.length === 1) await open(found.items[0].id, id);
      else setChoices(found.items.slice(0, 10));
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "unreachable"
          ? t("common.unreachable")
          : t("start.error"),
      );
    } finally {
      setBusy(false);
    }
  };

  if (auth.state === "signedOut")
    return (
      <Page title={t("start.title")}>
        <Notice kind="info">{t("confirm.signIn")}</Notice>
        <Button
          label={t("detail.signInToCharge")}
          onPress={() => router.push("/account")}
        />
      </Page>
    );

  return (
    <Page title={t("start.title")} testID="start-screen">
      {scannerAvailable && (
        <Card title={t("start.scanTitle")} icon="scan">
          <Text
            style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
          >
            {t("start.scanBody")}
          </Text>
          <Scanner onCode={(text) => void find(text)} />
        </Card>
      )}
      <Card title={t("start.enterTitle")} icon="plug">
        <Field
          id="charger-code"
          label={t("start.codeLabel")}
          hint={t("start.codeHint")}
          value={code}
          onChangeText={setCode}
          onSubmitEditing={() => void find(code)}
          autoCapitalize="characters"
          autoCorrect={false}
          enterKeyHint="search"
          mono
          testID="charger-code"
        />
        <Button
          label={t("start.find")}
          icon="search"
          busy={busy}
          onPress={() => void find(code)}
          testID="charger-find"
        />
        {error ? (
          <Notice kind="error" testID="start-error">
            {error}
          </Notice>
        ) : null}
        {choices.length > 0 && (
          <View style={styles.gap} role="list" aria-label={t("start.choose")}>
            <Text
              style={[
                type.strong,
                { color: c.text, fontSize: fs(fontSize.md) },
              ]}
            >
              {t("start.choose")}
            </Text>
            {choices.map((l) => (
              <View key={l.id} role="listitem">
                <Button
                  label={`${l.name}, ${l.address}`}
                  variant="secondary"
                  onPress={() => void open(l.id, code)}
                />
              </View>
            ))}
          </View>
        )}
      </Card>
    </Page>
  );
}

const styles = StyleSheet.create({
  gap: { gap: space.sm },
});
