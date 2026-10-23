import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../components/AuthProvider";
import { Button } from "../../components/Controls";
import { SignInForm } from "../../components/SignInForm";
import { t } from "../../i18n";
import {
  pushState,
  pushSupported,
  startPush,
  type PushState,
} from "../../lib/push";
import { fontSize, radius, space, type, useScale, useTheme } from "../../theme";

export default function Account() {
  const { c } = useTheme();
  const { fs } = useScale();
  const auth = useAuth();
  const [push, setPush] = useState<PushState | null>(null);
  const signedIn = auth.state === "signedIn";

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    pushState().then(
      (s) => live && setPush(s),
      () => live && setPush("unavailable"),
    );
    return () => {
      live = false;
    };
  }, [signedIn]);

  const PUSH_TEXT: Record<PushState, string> = {
    on: t("account.notificationsOn"),
    off: t("account.notificationsOff"),
    denied: t("account.notificationsDenied"),
    demo: t("account.notificationsDemo"),
    unavailable: pushSupported
      ? t("account.notificationsUnavailable")
      : t("account.notificationsWeb"),
  };

  return (
    <ScrollView
      role="main"
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.page}
    >
      {auth.state === "loading" ? (
        <Text
          role="status"
          style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
        >
          {t("common.loading")}
        </Text>
      ) : auth.state === "signedOut" ? (
        <View style={[styles.card, { backgroundColor: c.surface }]}>
          <SignInForm />
        </View>
      ) : (
        <View style={styles.gap}>
          <Text
            role="heading"
            aria-level={1}
            style={[
              type.heading,
              { color: c.text, fontSize: fs(fontSize.xxl) },
            ]}
          >
            {t("account.title")}
          </Text>
          <View style={[styles.card, { backgroundColor: c.surface }]}>
            <Text
              style={[type.body, { color: c.muted, fontSize: fs(fontSize.sm) }]}
            >
              {t("account.signedInAs")}
            </Text>
            <Text
              style={[
                type.strong,
                { color: c.text, fontSize: fs(fontSize.lg) },
              ]}
              testID="signed-in-email"
            >
              {auth.driver.email}
            </Text>
            <Text
              style={[type.body, { color: c.muted, fontSize: fs(fontSize.sm) }]}
            >
              {t("account.card")}
            </Text>
            <Text
              style={[
                type.strong,
                { color: c.text, fontSize: fs(fontSize.md) },
              ]}
            >
              {auth.driver.hasCard
                ? t("account.cardSaved")
                : t("account.noCard")}
            </Text>
            {auth.driver.mode === "demo" && (
              <Text
                style={[
                  type.body,
                  { color: c.muted, fontSize: fs(fontSize.sm) },
                ]}
              >
                {t("account.demo")}
              </Text>
            )}
          </View>
          <View
            style={[styles.card, { backgroundColor: c.surface }]}
            testID="notifications"
          >
            <Text
              role="heading"
              aria-level={2}
              style={[
                type.strong,
                { color: c.text, fontSize: fs(fontSize.md + 1) },
              ]}
            >
              {t("account.notifications")}
            </Text>
            {push && (
              <Text
                style={[
                  type.body,
                  { color: c.muted, fontSize: fs(fontSize.sm + 1) },
                ]}
              >
                {PUSH_TEXT[push]}
              </Text>
            )}
            {push === "off" && auth.token && (
              <Button
                label={t("account.notificationsTurnOn")}
                variant="secondary"
                onPress={() =>
                  void startPush(auth.token!, { ask: true }).then(setPush, () =>
                    setPush("unavailable"),
                  )
                }
              />
            )}
          </View>
          <Button
            label={t("account.signOut")}
            variant="secondary"
            onPress={() => void auth.signOut()}
            testID="sign-out"
          />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    padding: space.lg,
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
  },
  gap: { gap: space.md },
  card: { padding: space.lg, borderRadius: radius.lg, gap: space.xs + 2 },
});
