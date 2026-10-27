import "server-only";
import { z } from "zod";
import { TIME_ZONES } from "@/lib/locale-options";
import {
  currencyExponent,
  formatMinor,
  minorToMajorString,
  parseMajor,
} from "@/lib/money";
import type { DayOfWeek } from "../ivora/types";
import {
  DEFAULT_IDLE_GRACE_MINUTES,
  MAX_PERIODS,
  overlappingPeriods,
  PAID_CURRENCY,
  PAID_HOLD_MINOR,
  paidCurrencyNote,
  WEEK,
} from "./tariff";
import type { TariffDefinition } from "./types";

/** The editor's fields as the form sends them (strings; days as a list). */
export interface TariffForm {
  name?: string;
  kind?: string;
  timeZone?: string;
  energy?: string;
  sessionFee?: string;
  idleFee?: string;
  idleGrace?: string;
  driverText?: string;
  /** "on": staff confirmed their own driver text still matches changed prices. */
  driverTextConfirmed?: string;
  /** The tariff's revision the editor was loaded at (an existing tariff only). */
  revision?: string;
  periods?: { start?: string; end?: string; price?: string; days?: string[] }[];
}

/** The preview session: a date and times in the tariff's time zone. */
export interface SimulationForm {
  date?: string;
  start?: string;
  end?: string;
  energyKwh?: string;
  idleMinutes?: string;
}

export interface Simulation {
  /** YYYY-MM-DD local date of the start. */
  date: string;
  start: string;
  end: string;
  /** Up to 3 decimals. */
  energyKwh: number;
  idleMinutes: number;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Most per kWh, per session and per idle minute, in major units. */
const MAX_MAJOR = { kwh: 100, session: 1000, idleMinute: 10 } as const;

function money(
  ctx: z.RefinementCtx,
  text: string | undefined,
  currency: string,
  what: string,
  max: number,
  optional: boolean,
): number {
  const t = (text ?? "").trim();
  if (!t && optional) return 0;
  const minor = parseMajor(t, currency);
  const limit = max * 10 ** currencyExponent(currency);
  if (minor === null || minor > limit) {
    ctx.addIssue({
      code: "custom",
      message: `Enter the ${what} in ${currency}, from 0 to ${minorToMajorString(limit, currency)}, with at most ${currencyExponent(currency)} decimals.`,
    });
    return 0;
  }
  return minor;
}

/**
 * The editor's form to a tariff definition in `currency` (the company's currency for
 * a new tariff, the tariff's own for a new version). Money is parsed from the text as
 * integer minor units; nothing is rounded. Saving keeps paid tariffs in PAID_CURRENCY;
 * the preview prices a paid tariff in any currency (it charges nothing).
 */
export function tariffFormSchema(
  currency: string,
  opts: {
    purpose: "preview" | "save";
    /** A new version of an existing tariff, which keeps its own currency. */
    existing?: boolean;
    /** Demo mode: the note's wording for the seeded sample. */
    sample?: boolean;
  } = { purpose: "save" },
) {
  return z
    .object({
      name: z
        .string({ error: "Name the tariff." })
        .trim()
        .min(1, { error: "Name the tariff." })
        .max(60, { error: "Use at most 60 characters for the name." })
        .refine((v) => !/[<>\p{Cc}]/u.test(v), {
          error: "The name can't contain < > or control characters.",
        }),
      kind: z.enum(["paid", "free"], { error: "Choose paid or free." }),
      timeZone: z
        .string({ error: "Choose a time zone." })
        .refine((v) => TIME_ZONES.includes(v), {
          error: "Choose a time zone.",
        }),
      energy: z.string().optional(),
      sessionFee: z.string().optional(),
      idleFee: z.string().optional(),
      idleGrace: z.string().optional(),
      driverTextConfirmed: z.string().optional(),
      revision: z.string().optional(),
      driverText: z
        .string()
        .trim()
        .max(512, { error: "Use at most 512 characters for drivers." })
        .optional(),
      periods: z
        .array(
          z.object({
            start: z.string().optional(),
            end: z.string().optional(),
            price: z.string().optional(),
            days: z.array(z.string()).optional(),
          }),
        )
        .max(MAX_PERIODS, {
          error: `Use at most ${MAX_PERIODS} time-of-use periods.`,
        })
        .optional(),
    })
    .transform((f, ctx): { name: string; definition: TariffDefinition } => {
      const driverText = f.driverText ? f.driverText : null;
      if (f.kind === "free")
        return {
          name: f.name,
          definition: {
            kind: "free",
            currency,
            timeZone: f.timeZone,
            energyMinorPerKwh: 0,
            sessionFeeMinor: 0,
            idleMinorPerMinute: 0,
            idleGraceMinutes: 0,
            periods: [],
            driverText,
          },
        };
      // The preview only prices a simulated session, so it reads any currency.
      if (opts.purpose === "save" && currency !== PAID_CURRENCY) {
        const why = `Ivora Checkout settles card payments in US dollars, and the card hold before charging is ${formatMinor(PAID_HOLD_MINOR, PAID_CURRENCY)}.`;
        ctx.addIssue({
          code: "custom",
          message: opts.existing
            ? `${paidCurrencyNote(currency, Boolean(opts.sample))} ${why}`
            : `Paid tariffs are in ${PAID_CURRENCY} for now, and your company currency is ${currency}: ${why} Set the company currency to ${PAID_CURRENCY} in Settings, or make this tariff free.`,
        });
      }
      const energyMinorPerKwh = money(
        ctx,
        f.energy,
        currency,
        "price per kWh",
        MAX_MAJOR.kwh,
        false,
      );
      const sessionFeeMinor = money(
        ctx,
        f.sessionFee,
        currency,
        "session fee",
        MAX_MAJOR.session,
        true,
      );
      const idleMinorPerMinute = money(
        ctx,
        f.idleFee,
        currency,
        "idle fee per minute",
        MAX_MAJOR.idleMinute,
        true,
      );
      const graceText = (f.idleGrace ?? "").trim();
      const idleGraceMinutes = graceText
        ? Number(graceText)
        : DEFAULT_IDLE_GRACE_MINUTES;
      if (
        !/^\d{0,3}$/.test(graceText) ||
        !Number.isInteger(idleGraceMinutes) ||
        idleGraceMinutes > 240
      )
        ctx.addIssue({
          code: "custom",
          message: "Enter the idle grace period as 0 to 240 whole minutes.",
        });
      const periods = (f.periods ?? [])
        // A row left completely empty is not a period.
        .filter((p) => p.start || p.end || p.price || p.days?.length)
        .map((p, i) => {
          const n = i + 1;
          const days = WEEK.filter((d) => p.days?.includes(d));
          if (!p.start || !HHMM.test(p.start) || !p.end || !HHMM.test(p.end))
            ctx.addIssue({
              code: "custom",
              message: `Period ${n}: enter a start and end time (HH:MM).`,
            });
          else if (p.start === p.end)
            ctx.addIssue({
              code: "custom",
              message: `Period ${n}: the start and end time must differ.`,
            });
          if (!days.length)
            ctx.addIssue({
              code: "custom",
              message: `Period ${n}: choose at least one day.`,
            });
          return {
            days: days as DayOfWeek[],
            start: p.start ?? "",
            end: p.end ?? "",
            energyMinorPerKwh: money(
              ctx,
              p.price,
              currency,
              `period ${n} price per kWh`,
              MAX_MAJOR.kwh,
              false,
            ),
          };
        });
      // Indexes stay those of `periods`: rows with bad times are checked as empty.
      for (const [a, b, day] of overlappingPeriods(
        periods.map((p) =>
          HHMM.test(p.start) && HHMM.test(p.end) ? p : { ...p, days: [] },
        ),
      ))
        ctx.addIssue({
          code: "custom",
          message: `Periods ${a + 1} and ${b + 1} overlap (on ${day.charAt(0)}${day.slice(1).toLowerCase()}s). Each moment needs one price.`,
        });
      return {
        name: f.name,
        definition: {
          kind: "paid",
          currency,
          timeZone: f.timeZone,
          energyMinorPerKwh,
          sessionFeeMinor,
          idleMinorPerMinute,
          idleGraceMinutes: idleMinorPerMinute ? idleGraceMinutes : 0,
          periods,
          driverText,
        },
      };
    });
}

/** The preview session. Times are local to the tariff's time zone. */
export const simulationSchema = z
  .object({
    date: z
      .string({ error: "Choose the session's date." })
      .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Choose the session's date." }),
    start: z
      .string({ error: "Enter the start time." })
      .regex(HHMM, { error: "Enter the start time (HH:MM)." }),
    end: z
      .string({ error: "Enter the end time." })
      .regex(HHMM, { error: "Enter the end time (HH:MM)." }),
    energyKwh: z
      .string({ error: "Enter the energy in kWh." })
      .trim()
      .regex(/^\d{1,4}(\.\d{1,3})?$/, {
        error: "Enter the energy in kWh, for example 30 or 12.5.",
      }),
    idleMinutes: z
      .string()
      .trim()
      .regex(/^\d{0,4}$/, { error: "Enter idle time as whole minutes." })
      .optional(),
  })
  .transform((s): Simulation => ({
    date: s.date,
    start: s.start,
    end: s.end,
    energyKwh: Number(s.energyKwh),
    idleMinutes: Math.min(1440, Number(s.idleMinutes || "0")),
  }))
  .refine((s) => s.start !== s.end, {
    error: "The session's start and end times must differ.",
  })
  .refine((s) => !Number.isNaN(Date.parse(`${s.date}T00:00:00Z`)), {
    error: "Choose the session's date.",
  });
