"use client";

import "leaflet/dist/leaflet.css";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

export interface MapSite {
  id: number;
  name: string;
  lat: number;
  lng: number;
  state: "online" | "offline" | "faulted";
  online: number;
  offline: number;
  faulted: number;
  /** Where a click on the marker goes: the charger table, narrowed to this site. */
  href: string;
}

export interface MapTiles {
  url: string;
  attribution: string;
  link: string;
}

const STATE_LABEL = {
  online: "Online",
  offline: "Offline",
  faulted: "Faulted",
} as const;

/** The marker shape per state, so status never rests on colour alone. */
const SHAPE = {
  online: '<circle class="shape" cx="12" cy="12" r="8"/>',
  faulted: '<path class="shape" d="M12 3 L21.5 20 H2.5 Z"/>',
  offline: '<rect class="shape" x="4.5" y="4.5" width="15" height="15"/>',
} as const;

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/**
 * Sites on a map, with Leaflet (BSD-2-Clause) and a tile source that needs no API key
 * (OpenStreetMap by default, with its attribution). Each marker shows its worst state
 * in words and shape (circle online, triangle faulted, square offline) as well as
 * colour. A marker is a button: clicking it, or Enter or Space on it, narrows the
 * charger table to that site. The table has everything the map shows, so the page
 * works without it (and without scripts).
 */
export default function LiveMap(p: {
  sites: MapSite[];
  tiles: MapTiles | null;
  /** Demo mode: a static sample map image stands in for the tiles. */
  sample?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const router = useRouter();
  // The links change with the table's filter; read them at click time so a new
  // filter doesn't redraw the map.
  const hrefs = useRef(new Map<number, string>());
  useEffect(() => {
    hrefs.current = new Map(p.sites.map((s) => [s.id, s.href]));
  });
  // A refresh with the same sites keeps the map as it is (zoom and position).
  const key = JSON.stringify([
    p.sites.map(({ href: _href, ...s }) => s),
    p.tiles,
  ]);
  useEffect(() => {
    const [sites, tiles] = JSON.parse(key) as [
      Omit<MapSite, "href">[],
      MapTiles | null,
    ];
    let map: import("leaflet").Map | null = null;
    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      if (cancelled || !el.current) return;
      map = L.map(el.current, { scrollWheelZoom: false, keyboard: true });
      map.attributionControl.setPrefix(
        '<a href="https://leafletjs.com">Leaflet</a>',
      );
      if (tiles)
        L.tileLayer(tiles.url, {
          maxZoom: 19,
          attribution: tiles.link
            ? `<a href="${escape(tiles.link)}">${escape(tiles.attribution)}</a>`
            : escape(tiles.attribution),
        }).addTo(map);
      const bounds = L.latLngBounds([]);
      for (const s of sites) {
        const label = `${s.name}: ${STATE_LABEL[s.state]} (${s.online} online, ${s.offline} offline, ${s.faulted} faulted)`;
        const size = s.state === "online" ? 22 : 26;
        // The marker is a button: its box is a 44 px tap target around the shape.
        const box = 44;
        const go = () => {
          const href = hrefs.current.get(s.id);
          if (href) router.push(href);
        };
        const marker = L.marker([s.lat, s.lng], {
          keyboard: true,
          icon: L.divIcon({
            className: `map-marker ${s.state}`,
            html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${SHAPE[s.state]}</svg>`,
            iconSize: [box, box],
            iconAnchor: [box / 2, box / 2],
          }),
        })
          .bindTooltip(escape(label))
          .on("click", go)
          // The icon exists once the map has a view, so label it when it is added.
          .on("add", () => {
            const icon = marker.getElement();
            if (!icon) return;
            icon.setAttribute("aria-label", `${label}. Show its chargers.`);
            icon.setAttribute("data-site", String(s.id));
            icon.addEventListener("keydown", (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              go();
            });
          })
          .addTo(map);
        bounds.extend([s.lat, s.lng]);
      }
      if (sites.length === 1) map.setView(bounds.getCenter(), 15);
      else map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
    })();
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [key, router]);
  return (
    <div
      ref={el}
      className={
        p.tiles
          ? "live-map"
          : p.sample
            ? "live-map sample-map"
            : "live-map no-tiles"
      }
      role="application"
      aria-label={`${p.sample ? "Sample map of sites" : "Map of sites"}. Select a site to show its chargers in the table, which has the same information.`}
    />
  );
}
