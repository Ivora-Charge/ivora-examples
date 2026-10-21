import "server-only";
import { z } from "zod";
import { ROLES } from "@/lib/roles";

export const emailInput = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ error: "Enter a valid email address." }));

/** 12 to 72 bytes: long enough for staff who control chargers, within bcrypt's limit. */
export const passwordInput = z
  .string()
  .min(12, { error: "Use at least 12 characters." })
  .refine((p) => Buffer.byteLength(p, "utf8") <= 72, {
    error: "Use at most 72 bytes.",
  });

export const roleInput = z.enum(ROLES, { error: "Choose a role." });

export const userIdInput = z.uuid({ error: "Unknown staff member." });

export const idInput = z.uuid({ error: "Unknown record." });

/** 32 random bytes, base64url: 43 characters. */
export const inviteTokenInput = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, { error: "This invite link is not valid." });

/** Supabase's hashed sign-in token. */
export const linkTokenInput = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/, {
  error: "This sign-in link is not valid.",
});

export const operatorNameInput = z
  .string()
  .trim()
  .min(1, { error: "Enter your business name." })
  .max(80, { error: "Use at most 80 characters." });

/** The first validation message, for the form. */
export function firstIssue(e: z.ZodError): string {
  return e.issues[0]?.message ?? "Check the form and try again.";
}
