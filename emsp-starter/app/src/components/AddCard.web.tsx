import { Text } from "react-native";
import { t } from "../i18n";
import { fontSize, type, useScale, useTheme } from "../theme";

/**
 * The web build saves no cards: Stripe's PaymentSheet is for the phone apps (see
 * AddCard.tsx). Drivers add a card there; here they see, choose and remove cards.
 */
export function AddCard(_props: {
  token: string;
  onDone: (outcome: "saved" | "demo") => void;
  onError: (message: string) => void;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  return (
    <Text
      style={[type.body, { color: c.muted, fontSize: fs(fontSize.sm + 1) }]}
      testID="add-card-web"
    >
      {t("wallet.addOnPhone")}
    </Text>
  );
}
