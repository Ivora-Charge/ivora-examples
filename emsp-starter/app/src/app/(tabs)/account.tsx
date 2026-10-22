import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../components/AuthProvider";
import { Button } from "../../components/Controls";
import { SignInForm } from "../../components/SignInForm";
import { t } from "../../i18n";
import { fontSize, radius, space, type, useScale, useTheme } from "../../theme";

export default function Account() {
  const { c } = useTheme();
  const { fs } = useScale();
  const auth = useAuth();
  return (
    <ScrollView
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
