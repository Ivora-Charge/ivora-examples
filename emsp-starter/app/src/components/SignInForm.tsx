import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { t } from "../i18n";
import { ApiError, DEMO_CODE, requestCode } from "../lib/api";
import { fontSize, radius, space, type, useScale, useTheme } from "../theme";
import { useAuth } from "./AuthProvider";
import { Button } from "./Controls";
import { useDemo } from "./StatusProvider";

/** The words for a failed step. Never says whether an address has an account. */
function message(e: unknown, step: "email" | "code"): string {
  if (!(e instanceof ApiError)) return t("signIn.errorOther");
  switch (e.code) {
    case "invalid":
      return step === "email"
        ? t("signIn.errorEmail")
        : t("signIn.errorCodeFormat");
    case "unauthorized":
      return t("signIn.errorCode");
    case "rate_limited":
      return t("signIn.errorRateLimited", {
        minutes: Math.max(1, Math.ceil((e.retryAfter ?? 60) / 60)),
      });
    case "unreachable":
      return t("signIn.errorUnreachable");
    default:
      return t("signIn.errorOther");
  }
}

/**
 * Passwordless sign-in: an email, then the code from it. The first sign-in makes the
 * account. In demo mode no email is sent and the code is DEMO_CODE, and the form says so.
 */
export function SignInForm() {
  const { c } = useTheme();
  const { fs } = useScale();
  const auth = useAuth();
  const { demo } = useDemo();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const send = async () => {
    setBusy(true);
    setError("");
    try {
      await requestCode(email);
      setStep("code");
      setCode("");
    } catch (e) {
      setError(message(e, "email"));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError("");
    try {
      await auth.signIn(email, code);
    } catch (e) {
      setError(message(e, "code"));
      setBusy(false);
    }
  };

  const input = [
    type.body,
    styles.input,
    {
      color: c.text,
      borderColor: c.text,
      backgroundColor: c.surface,
      fontSize: fs(fontSize.md + 1),
    },
  ];
  const label = [type.strong, { color: c.text, fontSize: fs(fontSize.sm + 1) }];

  return (
    <View style={styles.form}>
      <Text
        role="heading"
        aria-level={1}
        style={[type.heading, { color: c.text, fontSize: fs(fontSize.xxl) }]}
      >
        {t("signIn.title")}
      </Text>
      <Text style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}>
        {step === "email"
          ? t("signIn.lead")
          : t("signIn.sent", { email: email.trim() })}
      </Text>
      {demo && (
        <View
          style={[styles.hint, { backgroundColor: c.flare }]}
          testID="demo-code-hint"
        >
          <Text
            style={[
              type.strong,
              { color: c.onFlare, fontSize: fs(fontSize.sm + 1) },
            ]}
          >
            {t("signIn.demoHint", { code: DEMO_CODE })}
          </Text>
        </View>
      )}
      {step === "email" ? (
        <View style={styles.field}>
          <Text style={label} nativeID="email-label">
            {t("signIn.email")}
          </Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            onSubmitEditing={send}
            aria-labelledby="email-label"
            aria-label={t("signIn.email")}
            placeholder={t("signIn.emailPlaceholder")}
            placeholderTextColor={c.muted}
            autoComplete="email"
            textContentType="emailAddress"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect={false}
            enterKeyHint="send"
            testID="email-input"
            style={input}
          />
        </View>
      ) : (
        <View style={styles.field}>
          <Text style={label} nativeID="code-label">
            {t("signIn.code")}
          </Text>
          <TextInput
            value={code}
            onChangeText={(v) => setCode(v.replace(/[^0-9]/g, "").slice(0, 10))}
            onSubmitEditing={verify}
            aria-labelledby="code-label"
            aria-label={t("signIn.code")}
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            inputMode="numeric"
            enterKeyHint="go"
            testID="code-input"
            style={[input, type.mono, styles.code]}
          />
        </View>
      )}
      {error ? (
        <Text
          role="alert"
          style={[
            type.strong,
            { color: c.danger, fontSize: fs(fontSize.sm + 1) },
          ]}
        >
          {error}
        </Text>
      ) : null}
      {step === "email" ? (
        <Button
          label={t("signIn.send")}
          icon="mail"
          onPress={send}
          busy={busy}
          testID="send-code"
        />
      ) : (
        <View style={styles.gap}>
          <Button
            label={t("signIn.verify")}
            onPress={verify}
            busy={busy}
            testID="verify-code"
          />
          <View style={styles.row}>
            <Button
              label={t("signIn.changeEmail")}
              variant="secondary"
              onPress={() => {
                setStep("email");
                setError("");
              }}
              style={styles.flex}
            />
            <Button
              label={t("signIn.resend")}
              variant="secondary"
              onPress={send}
              style={styles.flex}
            />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.md },
  field: { gap: space.xs + 2 },
  input: {
    minHeight: 56,
    paddingHorizontal: space.md,
    borderWidth: 2,
    borderRadius: radius.md,
  },
  code: { letterSpacing: 6 },
  hint: { padding: space.sm + 4, borderRadius: radius.md },
  gap: { gap: space.sm + 4 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm + 4 },
  flex: { flexGrow: 1, flexBasis: 160 },
});
