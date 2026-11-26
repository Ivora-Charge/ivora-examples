/** The fields of an error response the wizard uses to suggest a next step. */
export type ErrorCode = { error: string };

/**
 * Next steps for errors with a known cause. These come before the generic
 * rules below: a password change refused by Ivora is not fixed by signing in
 * again or by editing a form value (the kit generates the password).
 */
const KNOWN: Record<string, string> = {
  // A live push to a connected OCPP 1.6 charger needs 32-40 hex characters.
  password_not_hex:
    "This connected charger only accepts a password of 32 to 40 hexadecimal characters (0-9, a-f). Choose “Set a new password” to generate one in that format; if this keeps happening, tell the site operator.",
  password_push_unproven_vendor:
    "This charger model isn't approved for remote password changes yet: set the password on the charger itself, then save it here while the charger is offline.",
  stations_admin_required:
    "Changing the password of a connected charger needs an Ivora API key with the stations:admin scope. Ask the site operator to give this app's key that scope, or set a new password while the charger is offline.",
};

/** What the operator can do about an error, by kind (see docs/conventions.md). */
export function nextStep(e: ErrorCode): string {
  const known = KNOWN[e.error];
  if (known) return known;
  if (e.error === "network_error")
    return "Check your connection, then try again.";
  if (/^(unauthorized|http_401|http_403)/.test(e.error))
    return "Sign in again, then retry.";
  if (/^(http_5|operator_password_missing|configuration)/.test(e.error))
    return "This is not something you can fix on site. Tell the site operator and try again later.";
  return "Check the value you entered, then try again.";
}
