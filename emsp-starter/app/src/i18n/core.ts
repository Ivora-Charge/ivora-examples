import { countryName } from "../lib/country";
import en from "./en.json";

/**
 * The app's strings and formats. Every string a driver sees is in a locale file
 * (`en.json` first; add a file per language and list it in `index.ts`). Numbers,
 * money, distances and times are formatted for the device's own locale, even when its
 * language has no strings yet.
 *
 * Messages take `{name}` placeholders. A count message has `_one` and `_other` keys
 * (and any other plural category the language needs: `_zero`, `_two`, `_few`, `_many`),
 * picked with Intl.PluralRules.
 */
export type Messages = typeof en;
export type Key = keyof Messages;
type Plural<K> = K extends `${infer B}_other` ? B : never;
export type PluralKey = Plural<Key>;
export type Vars = Record<string, string | number>;

const fill = (s: string, vars: Vars = {}) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

export function createI18n(
  /** BCP 47 tag used for formatting, for example "de-DE". */
  locale: string,
  /** The strings of the best matching language; English fills any gaps. */
  messages: Partial<Record<string, string>> = en,
) {
  const lookup = (key: string): string =>
    messages[key] ?? (en as Record<string, string>)[key] ?? key;
  let plural: Intl.PluralRules;
  try {
    plural = new Intl.PluralRules(locale);
  } catch {
    plural = new Intl.PluralRules("en");
  }
  const nf = (opts: Intl.NumberFormatOptions) => {
    try {
      return new Intl.NumberFormat(locale, opts);
    } catch {
      return new Intl.NumberFormat("en", opts);
    }
  };
  const integer = nf({ maximumFractionDigits: 0 });
  const oneDecimal = nf({ maximumFractionDigits: 1 });

  const t = (key: Key, vars?: Vars) => fill(lookup(key), vars);

  /** A count message: `tn("results.places", 3)` reads `results.places_other`, with `{count}` filled in. */
  const tn = (key: PluralKey, count: number, vars?: Vars) => {
    const category = plural.select(count);
    const k = `${key}_${category}`;
    const msg =
      messages[k] ??
      (en as Record<string, string>)[k] ??
      lookup(`${key}_other`);
    return fill(msg, { count: integer.format(count), ...vars });
  };

  /** A plain number, for example "1,234" or "1.234". */
  const number = (n: number, maxDecimals = 0) =>
    (maxDecimals === 1
      ? oneDecimal
      : nf({ maximumFractionDigits: maxDecimals })
    ).format(n);

  /** Power in kW: whole numbers from 100, one decimal below. */
  const kw = (n: number) => t("unit.kw", { n: number(n, n >= 100 ? 0 : 1) });

  /** "350 m" or "2.4 km". */
  const distance = (m: number) =>
    m < 1000
      ? t("unit.m", { n: integer.format(Math.round(m / 10) * 10) })
      : t("unit.km", { n: number(m / 1000, m < 10_000 ? 1 : 0) });

  const currencyDigits = (currency: string) => {
    try {
      return (
        new Intl.NumberFormat("en", {
          style: "currency",
          currency,
        }).resolvedOptions().maximumFractionDigits ?? 2
      );
    } catch {
      return 2;
    }
  };

  /**
   * Ten-thousandths of the currency's major unit (4235 is €0.4235) as money, with the
   * currency's usual decimals, and more up to `maxDigits` when the figure has them.
   */
  const formatE4 = (priceE4: number, currency: string, maxDigits: number) => {
    const digits = currencyDigits(currency);
    const max = Math.max(digits, maxDigits);
    const value = priceE4 / 10_000;
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: max,
      }).format(value);
    } catch {
      let s = value.toFixed(max);
      while (s.includes(".") && s.length - s.indexOf(".") - 1 > digits)
        if (s.endsWith("0")) s = s.slice(0, -1);
        else break;
      return `${s.replace(/\.$/, "")} ${currency}`;
    }
  };

  /**
   * An amount rounded to the currency's minor unit (€0.42), as totals, holds and
   * receipts are read. In ten-thousandths of the major unit.
   */
  const money = (priceE4: number, currency: string) =>
    formatE4(priceE4, currency, 0);

  /**
   * A price per unit (per kWh, per hour, per minute) as the server sends it, with the
   * tariff's own precision: up to 4 decimals, trailing zeros trimmed to the currency's
   * minor unit (€0.4641, €0.275, €0.50).
   */
  const unitPrice = (priceE4: number, currency: string) =>
    formatE4(priceE4, currency, 4);

  /**
   * An amount in minor units (cents), as the server's payments give it: 2500 EUR is
   * €25.00. Formatted only; the app never computes what a driver pays.
   */
  const minor = (amount: number, currency: string) =>
    money(amount * 10 ** (4 - currencyDigits(currency)), currency);

  /** Energy: "12.35 kWh", at most 2 decimals. */
  const kwh = (n: number) => t("unit.kwh", { n: number(n, 2) });

  /** A duration: "45 min", "1 h 05 min". */
  const duration = (seconds: number) => {
    const total = Math.max(0, Math.floor(seconds / 60));
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (!h && !m && seconds > 0) return t("unit.underMinute");
    return h
      ? t("unit.hoursMinutes", {
          h: integer.format(h),
          m: String(m).padStart(2, "0"),
        })
      : t("unit.minutes", { m: integer.format(m) });
  };

  /** A moment, for example "22 Oct 2026, 09:41", in the device's time zone. */
  const dateTime = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    try {
      return new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(d);
    } catch {
      return d.toISOString();
    }
  };

  /** "07:00" (a local wall-clock time from OCPI) in the locale's own style. */
  const clock = (hhmm: string) => {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
    if (!m) return hhmm;
    try {
      // 24-hour locales write 07:00; 12-hour ones 7:00 AM.
      const h23 = ["h23", "h24"].includes(
        new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions()
          .hourCycle ?? "",
      );
      return new Intl.DateTimeFormat(locale, {
        hour: h23 ? "2-digit" : "numeric",
        minute: "2-digit",
        timeZone: "UTC",
      }).format(Date.UTC(2024, 0, 1, Number(m[1]) % 24, Number(m[2])));
    } catch {
      return hhmm;
    }
  };

  /** Short weekday name; 1 is Monday, as in OCPI. */
  const weekday = (day: number) => {
    try {
      // 1 January 2024 was a Monday.
      return new Intl.DateTimeFormat(locale, {
        weekday: "short",
        timeZone: "UTC",
      }).format(Date.UTC(2024, 0, day));
    } catch {
      return String(day);
    }
  };

  /**
   * A moment's date, time of day and both, as the clock in `timeZone` shows them (the
   * device's clock when the zone is unknown): "24 Dec 2026", "14:00".
   */
  const zoned = (ms: number, timeZone: string) => {
    const format = (opts: Intl.DateTimeFormatOptions) => {
      for (const zone of [timeZone, undefined])
        try {
          return new Intl.DateTimeFormat(locale, {
            ...opts,
            timeZone: zone,
          }).format(ms);
        } catch {}
      return new Date(ms).toISOString();
    };
    return {
      date: format({ dateStyle: "medium" }),
      time: format({ timeStyle: "short" }),
      dateTime: format({ dateStyle: "medium", timeStyle: "short" }),
    };
  };

  /**
   * A time zone's short name at `ms` in the driver's language ("CET", "GMT+1"), or
   * undefined when the device does not know the zone.
   */
  const zoneName = (timeZone: string, ms: number) => {
    try {
      return new Intl.DateTimeFormat(locale, {
        timeZone,
        timeZoneName: "short",
      })
        .formatToParts(ms)
        .find((part) => part.type === "timeZoneName")?.value;
    } catch {
      return undefined;
    }
  };

  /** A time zone's canonical name ("Europe/Berlin"), or undefined when unknown. */
  const canonicalZone = (timeZone: string) => {
    try {
      return new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions()
        .timeZone;
    } catch {
      return undefined;
    }
  };

  /** The device's own time zone. */
  const deviceZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

  /** A country's name from its ISO 3166-1 alpha-3 code: "Germany" for "DEU". */
  const country = (code: string) => countryName(code, locale);

  return {
    locale,
    t,
    tn,
    number,
    kw,
    kwh,
    distance,
    money,
    unitPrice,
    minor,
    duration,
    dateTime,
    clock,
    weekday,
    zoned,
    zoneName,
    canonicalZone,
    deviceZone,
    country,
  };
}

export type I18n = ReturnType<typeof createI18n>;
