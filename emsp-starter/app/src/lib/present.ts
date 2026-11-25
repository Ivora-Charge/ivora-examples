import type { I18n, Key } from "../i18n/core";
import {
  hoursRows,
  openState,
  upcomingExceptions,
  type ExceptionalHours,
  type OpenState,
} from "./hours";
import { placeKind, type StatusKind } from "./status";
import type {
  DisplayComponent,
  DisplayPrice,
  LeadPrice,
  LocationSummary,
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

  /**
   * The list card's note when a place is closed now, also when a charge in progress can
   * continue there: its free count must not read as "come and charge". Else undefined.
   */
  const closedNote = (
    place: Parameters<typeof openState>[0],
    now = new Date(),
  ) => {
    const state = openState(place, now);
    return state === "closed" || state === "closedCanCharge"
      ? t("detail.closedNow")
      : undefined;
  };

  const openLabels: Record<OpenState, Key> = {
    open: "detail.openNow",
    closed: "detail.closedNow",
    closedCanCharge: "detail.closedCanCharge",
  };

  /** "Street 1, 1000 AA City, Netherlands", leaving out what the CPO did not send. */
  const address = (
    place: Pick<
      LocationSummary,
      "address" | "postal_code" | "city" | "country"
    >,
  ) =>
    [
      place.address,
      [place.postal_code, place.city].filter(Boolean).join(" "),
      i.country(place.country),
    ]
      .filter(Boolean)
      .join(", ");

  /** "Closed: 24 Dec 2026, 14:00–18:00", in the place's own time zone. */
  const exception = (x: ExceptionalHours, timeZone: string) => {
    const begin = i.zoned(x.begin, timeZone);
    const end = i.zoned(x.end, timeZone);
    const period =
      begin.date === end.date
        ? t("detail.onDate", {
            date: begin.date,
            period: t("detail.period", { begin: begin.time, end: end.time }),
          })
        : t("detail.dateRange", { begin: begin.dateTime, end: end.dateTime });
    return t(x.open ? "detail.exceptionalOpen" : "detail.exceptionalClosed", {
      period,
    });
  };

  /** The regular hours as lines. */
  const regularLines = (opening: LocationSummary["opening_times"]) => {
    if (!opening) return [t("detail.hoursUnknown")];
    if (opening.twentyfourseven) return [t("detail.open24")];
    return hoursRows(opening).map((r) => {
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
  };

  /**
   * Opening hours as lines, the exceptional openings and closings still to come (or in
   * progress), and what to say about the place right now.
   */
  const hours = (
    place: Parameters<typeof openState>[0],
    now = new Date(),
    deviceZone = i.deviceZone(),
  ) => {
    const state = openState(place, now);
    const opening = place.opening_times;
    const exceptions = [
      ...new Set(
        upcomingExceptions(opening, now).map((x) =>
          exception(x, place.time_zone),
        ),
      ),
    ];
    return {
      current: state && { state, label: t(openLabels[state]) },
      lines: regularLines(opening),
      exceptions,
      zoneNote: zoneNote(
        place.time_zone,
        deviceZone,
        now,
        exceptions.length > 0,
        hoursRows(opening).some((r) => r.periods.length > 0),
      ),
    };
  };

  /**
   * Which clock the times are on, when it is not the device's: the site's zone, or the
   * device's when the device does not know the site's zone (exceptional hours are then
   * shown on the device's clock; regular hours are always the site's wall clock).
   */
  const zoneNote = (
    timeZone: string,
    deviceZone: string,
    now: Date,
    hasExceptions: boolean,
    hasRegularTimes: boolean,
  ) => {
    if (!hasExceptions && !hasRegularTimes) return undefined;
    const site = i.canonicalZone(timeZone);
    if (!site) {
      if (!hasExceptions) return undefined;
      const zone = i.zoneName(deviceZone, now.getTime()) ?? deviceZone;
      return t("detail.zoneUnknown", { zone });
    }
    if (site === i.canonicalZone(deviceZone)) return undefined;
    const zone = i.zoneName(site, now.getTime()) ?? site;
    return t("detail.zoneSite", { zone });
  };

  return {
    status,
    connector,
    parking,
    lead,
    detailPrice,
    availability,
    closedNote,
    address,
    hours,
  };
}

export type Present = ReturnType<typeof present>;
