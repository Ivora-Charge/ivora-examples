import type { I18n, Key } from "../i18n/core";
import { hoursRows, isOpenAt } from "./hours";
import { placeKind, type StatusKind } from "./status";
import type {
  DisplayComponent,
  DisplayPrice,
  LeadPrice,
  LocationSummary,
  OpeningTimes,
} from "./types";

/**
 * API data in the driver's words and formats. Takes the i18n instance so tests can try
 * other locales.
 */
export function present(i: I18n) {
  const { t } = i;

  const has = (key: string): key is Key => t(key as Key) !== key;

  const status = (kind: StatusKind) => t(`status.${kind}`);

  const connector = (standard: string) => {
    const key = `connector.${standard}`;
    return has(key) ? t(key) : t("connector.other");
  };

  const parking = (type: string | undefined) => {
    const key = `parking.${type}`;
    return type && has(key) ? t(key) : undefined;
  };

  const unit = (p: Pick<LeadPrice, "type" | "unit">) =>
    p.type === "PARKING_TIME"
      ? t("price.per.parking")
      : t(`price.per.${p.unit}`);

  /** The list's price: big amount and its unit, "No fee", or "Price not shared". */
  const lead = (
    price: LocationSummary["price"],
  ): { amount: string; unit: string } => {
    if (!price) return { amount: t("price.unknown"), unit: "" };
    if (price.free) return { amount: t("price.noFee"), unit: "" };
    if (price.lead && price.currency)
      return {
        amount: i.money(price.lead.priceE4, price.currency),
        unit: unit(price.lead),
      };
    // An older server without `lead`: its own one-line summary.
    return { amount: price.summary, unit: "" };
  };

  /** One price line of the detail, for example "€7.26 per hour (after 45 min)". */
  const line = (c: DisplayComponent, currency: string) => {
    const vars = { price: i.money(c.priceE4, currency), unit: unit(c) };
    return c.conditions.length
      ? t("price.when", { ...vars, conditions: c.conditions.join(", ") })
      : t("price.line", vars);
  };

  /**
   * The detail's price: the lead component big, the rest as lines. The CPO's own
   * free text (OCPI `tariff_alt_text`) is often without VAT or in another language, so
   * it is shown only when there are no structured prices, and then as the CPO's note.
   */
  const detailPrice = (p: DisplayPrice) => {
    const paid = p.components.filter((c) => c.priceE4 > 0);
    const main = paid.find((c) => c.type === "ENERGY") ?? paid[0];
    const structured = p.free || p.components.length > 0;
    return {
      operatorNote:
        !structured && p.altText
          ? t("price.operatorNote", { text: p.altText })
          : undefined,
      amount: !structured
        ? t("price.unknown")
        : p.free || !main
          ? t("price.noFee")
          : i.money(main.priceE4, p.currency),
      unit: p.free || !main ? "" : unit(main),
      vat: !main
        ? ""
        : main.vatIncluded
          ? t("price.vatIncluded")
          : t("price.vatExcluded"),
      conditions: main?.conditions ?? [],
      more: paid.filter((c) => c !== main).map((c) => line(c, p.currency)),
    };
  };

  /** "2 of 3 free", or the status word when none is free. */
  const availability = (l: LocationSummary) => {
    const kind = placeKind(l);
    return {
      kind,
      text:
        kind === "free"
          ? t("place.free", {
              free: i.number(l.available_count),
              total: i.number(l.evse_count),
            })
          : status(kind),
    };
  };

  /** Opening hours as lines, and whether the place is open now. */
  const hours = (
    opening: OpeningTimes | undefined,
    timeZone: string,
    now = new Date(),
  ) => {
    const open = isOpenAt(opening, timeZone, now);
    if (!opening) return { open, lines: [t("detail.hoursUnknown")] };
    if (opening.twentyfourseven) return { open, lines: [t("detail.open24")] };
    const lines = hoursRows(opening).map((r) => {
      const days =
        r.from === r.to
          ? i.weekday(r.from)
          : t("detail.dayRange", {
              from: i.weekday(r.from),
              to: i.weekday(r.to),
            });
      const periods = r.periods.length
        ? r.periods
            .map((p) =>
              t("detail.period", {
                begin: i.clock(p.begin),
                end: i.clock(p.end),
              }),
            )
            .join(", ")
        : t("detail.closed");
      return `${days}  ${periods}`;
    });
    return { open, lines };
  };

  return { status, connector, parking, lead, detailPrice, availability, hours };
}

export type Present = ReturnType<typeof present>;
