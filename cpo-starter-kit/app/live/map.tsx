"use client";

import "leaflet/dist/leaflet.css";
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
 * in words and shape as well as colour. The list below the map has everything the map
 * shows, so the page works without it (and without scripts).
 */
export default function LiveMap(p: {
  sites: MapSite[];
  tiles: MapTiles | null;
}) {
  const el = useRef<HTMLDivElement>(null);
  // A refresh with the same sites keeps the map as it is (zoom and position).
  const key = JSON.stringify([p.sites, p.tiles]);
  useEffect(() => {
    const [sites, tiles] = JSON.parse(key) as [MapSite[], MapTiles | null];
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
        const marker = L.circleMarker([s.lat, s.lng], {
          radius: s.state === "online" ? 9 : 11,
          className: `map-marker ${s.state}`,
          weight: s.state === "offline" ? 4 : 2,
          dashArray: s.state === "offline" ? "4 3" : undefined,
        })
          .bindTooltip(escape(label))
          .on("click", () => {
            document
              .getElementById(`site-${s.id}`)
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          })
          .addTo(map);
        marker.getElement()?.setAttribute("aria-label", label);
        bounds.extend([s.lat, s.lng]);
      }
      if (sites.length === 1) map.setView(bounds.getCenter(), 15);
      else map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
    })();
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [key]);
  return (
    <div
      ref={el}
      className={p.tiles ? "live-map" : "live-map no-tiles"}
      role="application"
      aria-label="Map of sites. The list below has the same information."
    />
  );
}
