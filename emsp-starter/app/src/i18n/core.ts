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
   * A price in ten-thousandths of the currency's major unit (4235 is €0.4235), as the
   * server sends it, rounded to the currency's minor unit (€0.42), as drivers read
   * prices. The server keeps the exact figure for billing.
   */
  const money = (priceE4: number, currency: string) => {
    const digits = currencyDigits(currency);
    const value = priceE4 / 10_000;
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value);
    } catch {
      return `${value.toFixed(digits)} ${currency}`;
    }
  };

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

  return {
    locale,
    t,
    tn,
    number,
    kw,
    kwh,
    distance,
    money,
    minor,
    duration,
    dateTime,
    clock,
    weekday,
  };
}

export type I18n = ReturnType<typeof createI18n>;
