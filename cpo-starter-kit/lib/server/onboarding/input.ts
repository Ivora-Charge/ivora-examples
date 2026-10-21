import "server-only";
import { z } from "zod";
import { normalizeHex } from "@/lib/brand-colors";
import { TIME_ZONES, CURRENCIES } from "@/lib/locale-options";

const optional = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? null : v;

const httpsUrl = (what: string) =>
  z
    .string()
    .trim()
    .max(300, { error: `Use at most 300 characters for the ${what}.` })
    .refine(
      (v) => {
        try {
          const u = new URL(v);
          return u.protocol === "https:" && !u.username && !u.password;
        } catch {
          return false;
        }
      },
      { error: `The ${what} must be a full https:// address.` },
    );

export const companyInput = z.object({
  name: z
    .string({ error: "Enter your company name." })
    .trim()
    .min(1, { error: "Enter your company name." })
    .max(80, { error: "Use at most 80 characters for the name." })
    // Plain text: Ivora shows it as the operator name on the driver pages.
    .refine((v) => !/[<>\p{Cc}]/u.test(v), {
      error: "The name can't contain < > or control characters.",
    }),
  supportEmail: z
    .string({ error: "Enter a support email." })
    .trim()
    .toLowerCase()
    .max(254)
    .pipe(z.email({ error: "Enter a valid support email." })),
  supportUrl: z.preprocess(optional, httpsUrl("support URL").nullable()),
  website: z.preprocess(optional, httpsUrl("website").nullable()),
  timeZone: z
    .string({ error: "Choose a time zone." })
    .refine((v) => TIME_ZONES.includes(v), { error: "Choose a time zone." }),
  currency: z
    .string({ error: "Choose a currency." })
    .refine((v) => CURRENCIES.includes(v), { error: "Choose a currency." }),
});

/** #rrggbb, lower case; an empty value clears the colour. */
export const colorInput = z.preprocess(
  optional,
  z
    .string()
    .transform((v, ctx) => {
      const hex = normalizeHex(v);
      if (!hex) {
        ctx.addIssue({
          code: "custom",
          message: "Enter the colour as #rrggbb, for example #17613a.",
        });
        return z.NEVER;
      }
      return hex;
    })
    .nullable(),
);
