import { StyleSheet, Text, View } from "react-native";
import { t } from "../i18n";
import { config } from "../lib/config";
import { fontSize, space, type, useScale, useTheme } from "../theme";
import { canAddCard } from "./AddCard";

/**
 * Links to the network's phone apps, each shown only when its address is configured
 * (see `config.iosAppUrl`). With neither, nothing. Only the web build shows them, as
 * real anchors (React Native Web's `href`): they open in a new tab, by click or Enter,
 * and leave this one signed in.
 */
export function PhoneAppLinks() {
  const { c } = useTheme();
  const { fs } = useScale();
  const links = [
    { id: "ios", label: t("phoneApp.ios"), url: config.iosAppUrl },
    { id: "android", label: t("phoneApp.android"), url: config.androidAppUrl },
  ].flatMap(({ url, ...link }) => (url ? [{ ...link, url }] : []));
  if (!links.length) return null;
  return (
    <View style={styles.links}>
      {links.map((link) => (
        <View
          key={link.id}
          role="link"
          {...({
            href: link.url,
            hrefAttrs: { target: "_blank", rel: "noopener noreferrer" },
          } as object)}
          style={styles.link}
          testID={`phone-app-${link.id}`}
        >
          <Text
            style={[
              type.strong,
              styles.underline,
              { color: c.text, fontSize: fs(fontSize.sm + 1) },
            ]}
          >
            {link.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Said beside every "Sign in to charge" where this build cannot save a card (the web
 * build), so a driver knows before signing in that a start needs a card saved in the
 * phone app. The phone apps show nothing.
 */
export function CardBeforeSignIn() {
  const { c } = useTheme();
  const { fs } = useScale();
  if (canAddCard) return null;
  return (
    <View testID="card-before-sign-in">
      <Text
        style={[type.body, { color: c.text, fontSize: fs(fontSize.sm + 1) }]}
      >
        {t("phoneApp.beforeSignIn")}
      </Text>
      <PhoneAppLinks />
    </View>
  );
}

const styles = StyleSheet.create({
  links: { flexDirection: "row", flexWrap: "wrap", columnGap: space.lg },
  link: { minHeight: 44, justifyContent: "center" },
  underline: { textDecorationLine: "underline" },
});
