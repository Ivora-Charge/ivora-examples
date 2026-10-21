import "server-only";
import { z } from "zod";

const optional = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? null : v;

const plain = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Use at most ${max} characters for the ${what}.` })
    .refine((v) => !/[<>\p{Cc}]/u.test(v), {
      error: `The ${what} can't contain < > or control characters.`,
    });

const id = z.coerce
  .number({ error: "Choose a site." })
  .int()
  .positive({ error: "Choose a site." });

/** The OCPP connection name: what the charger is configured with. */
export const connectionName = z
  .string({ error: "Enter a connection name." })
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,35}$/, {
    error:
      "Use 3 to 36 letters, digits, - or _ for the connection name, starting with a letter or digit.",
  });

export const newSiteInput = z.object({
  name: plain(80, "site name").pipe(
    z.string().min(2, { error: "Enter a site name (at least 2 characters)." }),
  ),
  address: plain(120, "address").default(""),
  city: plain(120, "city").default(""),
  postalCode: plain(20, "postal code").default(""),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, {
      error: "Use a three-letter country code, for example USA.",
    })
    .default("USA"),
});

export const addChargerInput = z
  .object({
    name: connectionName,
    label: z.preprocess(optional, plain(80, "display name").nullable()),
    connectors: z.coerce
      .number({ error: "Choose 1 to 8 connectors." })
      .int()
      .min(1, { error: "Choose 1 to 8 connectors." })
      .max(8, { error: "Choose 1 to 8 connectors." }),
    /** An Ivora location ID, or "new" with the new site's fields. */
    site: z.string({ error: "Choose a site." }),
    newSite: z.unknown(),
  })
  .transform((v, ctx) => {
    if (v.site === "new") {
      const site = newSiteInput.safeParse(v.newSite);
      if (!site.success) {
        ctx.addIssue({
          code: "custom",
          message: site.error.issues[0]?.message ?? "Check the new site.",
        });
        return z.NEVER;
      }
      return { ...v, locationId: null, newSite: site.data };
    }
    const location = id.safeParse(v.site);
    if (!location.success) {
      ctx.addIssue({ code: "custom", message: "Choose a site." });
      return z.NEVER;
    }
    return { ...v, locationId: location.data, newSite: null };
  });

export const editChargerInput = z.object({
  label: z.preprocess(optional, plain(80, "display name").nullable()),
  locationId: id,
});

export const connectorNumber = z.coerce
  .number({ error: "Choose a connector." })
  .int()
  .min(1, { error: "Choose a connector." })
  .max(99, { error: "Choose a connector." });
