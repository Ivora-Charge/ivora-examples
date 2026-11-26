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
  PriceNow,
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

  /**
   * A rate's price: a price per unit keeps the tariff's decimals, a fee per session is
   * an amount, rounded to the minor unit.
   */
  const priceOf = (c: Pick<LeadPrice, "type" | "priceE4">, currency: string) =>
    c.type === "FLAT"
      ? i.money(c.priceE4, currency)
      : i.unitPrice(c.priceE4, currency);

  /**
   * A rate's conditions as one phrase: "Mon–Fri 07:00–21:00, after 2 h". The server
   * sends the days first and the time of day next, which read as one.
   */
  const phrase = (conditions: string[]) =>
    conditions.reduce((all, c) =>
      /^(\d\d:\d\d–\d\d:\d\d|(from|until) \d\d:\d\d)$/.test(c)
        ? `${all} ${c}`
        : `${all}, ${c}`,
    );

  /** The list's price: big amount and its unit, "No fee", or "Price not shared". */
  const lead = (
    price: LocationSummary["price"],
  ): { amount: string; unit: string } => {
    if (!price) return { amount: t("price.unknown"), unit: "" };
    if (price.free) return { amount: t("price.noFee"), unit: "" };
    if (price.lead && price.currency)
      return {
        amount: priceOf(price.lead, price.currency),
        unit: unit(price.lead),
      };
    // An older server without `lead`: its own one-line summary.
    return { amount: price.summary, unit: "" };
  };

  /**
   * From a server that does not say what applies now: only a rate without conditions
   * counts as applying, the first of its kind. A rate with conditions placed before it
   * may price that kind instead (first match), so it is shown beside it. When a kind
   * that costs something has no such rate, nothing is shown as applying (a part of the
   * price would read as all of it) and every rate is listed with its conditions.
   */
  const withoutNow = (components: DisplayComponent[]): PriceNow => {
    const order = ["ENERGY", "TIME", "PARKING_TIME", "FLAT"];
    const first = new Map<string, DisplayComponent>();
    for (const c of components)
      if (!c.conditions.length && !first.has(c.type)) first.set(c.type, c);
    const partial = components.some((c) => c.priceE4 > 0 && !first.has(c.type));
    const current = partial
      ? []
      : [...first.values()].sort(
          (a, b) => order.indexOf(a.type) - order.indexOf(b.type),
        );
    const before = (c: DisplayComponent) =>
      !partial &&
      c.conditions.length > 0 &&
      components.indexOf(c) < components.indexOf(first.get(c.type)!);
    return {
      components: current,
      tiers: components.filter(before),
      others: components.filter(
        (c) =>
          !before(c) &&
          (c.conditions.length || (partial && first.get(c.type) === c)),
      ),
      unexplained: components.some(
        (c) => !c.conditions.length && first.get(c.type)!.priceE4 !== c.priceE4,
      ),
    };
  };

  /**
   * The price of a connector, for its detail and for the confirm screen. `amount` is
   * what applies now, every kind with equal weight ("€0.11 per kWh + €0.66 per hour"),
   * and `session` the fee on top of it; a rate that holds only at some times says so
   * there ("€0.11 per kWh, Mon–Fri 07:00–21:00"). `tiers` are rates that apply instead
   * at some charging power or current ("€0.60 per kWh instead, at 50 kW or more"),
   * shown beside `amount` with the same weight. `later` are fees added to it later in
   * the session ("After 45 min: plus €7.26 per hour"). The CPO's own free text (OCPI
   * `tariff_alt_text`) is often without VAT or in another language, so it is shown only
   * when the structured prices do not tell the whole story, and then as the CPO's note.
   */
  const detailPrice = (p: DisplayPrice) => {
    const structured = p.free || p.components.length > 0;
    const now = p.now ?? withoutNow(p.components);
    // A zero rate says something only beside a paid one of its kind ("free for the
    // first 2 h"), or when nothing costs anything and there is still a minimum.
    const paid = new Set(
      p.components.filter((c) => c.priceE4 > 0).map((c) => c.type),
    );
    const shown = (c: DisplayComponent) => !paid.size || paid.has(c.type);
    const current = p.free ? [] : now.components.filter(shown);
    const tiers = p.free ? [] : (now.tiers ?? []).filter(shown);
    const rest = p.free ? [] : now.others.filter(shown);
    const later = rest.filter((c) => c.later?.length);
    const others = rest.filter((c) => !c.later?.length);
    const all = [...current, ...tiers, ...rest];
    const included = all.filter((c) => c.vatIncluded).length;
    const mixed = included > 0 && included < all.length;
    /** "€0.11 per kWh", saying its own VAT state when the rates differ in it. */
    const rate = (c: DisplayComponent) => {
      const text = t("price.line", {
        price: priceOf(c, p.currency),
        unit: unit(c),
      });
      return mixed
        ? t(c.vatIncluded ? "price.withVat" : "price.withoutVat", {
            price: text,
          })
        : text;
    };
    const when = (c: DisplayComponent) =>
      c.conditions.length
        ? t("price.when", {
            price: rate(c),
            conditions: c.conditions.join(", "),
          })
        : rate(c);
    /** A price that applies now, followed by when it does, if it has a condition. */
    const timed = (price: string, conditions: string[]) =>
      conditions.length
        ? t("price.timed", { price, conditions: phrase(conditions) })
        : price;
    const headline = (c: DisplayComponent) => timed(rate(c), c.conditions);
    const used = current.filter((c) => c.type !== "FLAT");
    const fee = current.find((c) => c.type === "FLAT");
    /** The rates used, saying a condition they all share once, after the last. */
    const usedNow = () => {
      const shared =
        new Set(used.map((c) => c.conditions.join("\n"))).size === 1;
      return shared
        ? timed(used.map(rate).join(" + "), used[0].conditions)
        : used.map(headline).join(" + ");
    };
    const amount = !structured
      ? t("price.unknown")
      : p.free
        ? t("price.noFee")
        : used.length
          ? usedNow()
          : fee
            ? headline(fee)
            : t("price.varies");
    const unexplained = !p.free && now.unexplained;
    const price = {
      amount,
      tiers: tiers.map((c) =>
        t("price.tier", {
          price: rate(c),
          conditions: c.conditions.join(", "),
        }),
      ),
      session:
        used.length && fee
          ? t("price.plus", { price: headline(fee) })
          : undefined,
      later: [
        ...new Set(
          later.map((c) => {
            const from = phrase(c.later!);
            return t("price.later", {
              from: from.charAt(0).toUpperCase() + from.slice(1),
              price: rate(c),
            });
          }),
        ),
      ],
      others: [...new Set(others.map(when))],
      min: p.minPrice ? t("price.min", { amount: p.minPrice }) : undefined,
      max: p.maxPrice ? t("price.max", { amount: p.maxPrice }) : undefined,
      vat:
        !all.length || mixed
          ? ""
          : included
            ? t("price.vatIncluded")
            : t("price.vatExcluded"),
      unexplained: unexplained ? t("price.unexplained") : undefined,
      operatorNote:
        (unexplained || !structured) && p.altText
          ? t("price.operatorNote", { text: p.altText })
          : undefined,
    };
    /**
     * The confirm screen's lines: the same price as the page's, with the fees added
     * later in the session. The other rates follow under their own label there, as on
     * the page, so that they are seen before starting.
     */
    const lines = [
      price.amount,
      ...price.tiers,
      price.session,
      ...price.later,
      price.min,
      price.max,
      price.vat,
    ].filter((s): s is string => !!s);
    return { ...price, lines };
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

  /**
   * A place's map pin: what it reads out, and whether it is drawn closed, on the same
   * terms as the list card (see `closedNote`).
   */
  const marker = (place: LocationSummary, now = new Date()) => {
    const closed = closedNote(place, now);
    const vars = {
      name: place.name,
      power: i.kw(place.max_power_kw),
      status: availability(place).text,
    };
    return {
      closed: closed !== undefined,
      label: closed
        ? t("map.markerClosed", { ...vars, closed })
        : t("map.marker", vars),
    };
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
    marker,
    address,
    hours,
  };
}

export type Present = ReturnType<typeof present>;
