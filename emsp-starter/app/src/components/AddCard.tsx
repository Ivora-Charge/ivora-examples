import {
  Constants as StripeConstants,
  initPaymentSheet,
  initStripe,
  presentPaymentSheet,
} from "@stripe/stripe-react-native";
import * as Linking from "expo-linking";
import { useState } from "react";
import { t } from "../i18n";
import { ApiError, setupCard } from "../lib/api";
import { requestId } from "../lib/charging";
import { brand } from "../theme";
import { Button } from "./Controls";

/**
 * "Add a card" on iOS and Android: Stripe's PaymentSheet saves the card on the
 * network's own Stripe account, from a SetupIntent the server makes. The card number
 * never touches this app's code or the server. The web build says to add cards in the
 * phone app (AddCard.web.tsx). In demo mode there is nothing to save: the demo cards
 * are already there.
 */
export function AddCard({
  token,
  onDone,
  onError,
}: {
  token: string;
  /** `saved` after a new card; `demo` when demo mode saves none. */
  onDone: (outcome: "saved" | "demo") => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const setup = await setupCard(token, {
        requestId: requestId(),
        stripeVersion: StripeConstants.API_VERSIONS.CORE,
      });
      if (
        setup.mode === "demo" ||
        !setup.publishableKey ||
        !setup.customerId ||
        !setup.setupIntentClientSecret ||
        !setup.ephemeralKeySecret
      )
        return onDone("demo");
      await initStripe({ publishableKey: setup.publishableKey });
      const init = await initPaymentSheet({
        merchantDisplayName: brand.name,
        customerId: setup.customerId,
        customerEphemeralKeySecret: setup.ephemeralKeySecret,
        setupIntentClientSecret: setup.setupIntentClientSecret,
        returnURL: Linking.createURL("wallet"),
      });
      if (init.error) return onError(t("wallet.addFailed"));
      const shown = await presentPaymentSheet();
      if (shown.error) {
        // Closing the sheet is not an error.
        if (shown.error.code !== "Canceled") onError(t("wallet.addFailed"));
        return;
      }
      onDone("saved");
    } catch (e) {
      onError(
        e instanceof ApiError && e.code === "unreachable"
          ? t("common.unreachable")
          : t("wallet.addFailed"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      label={t("wallet.add")}
      icon="card"
      variant="secondary"
      busy={busy}
      onPress={() => void add()}
      testID="add-card"
    />
  );
}
