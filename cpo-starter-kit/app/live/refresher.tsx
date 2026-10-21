"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** How often an open page asks the kit (not Ivora) whether anything changed. */
export const CHANGES_POLL_MS = 5_000;
/** Fewest milliseconds between two re-reads of the Ivora API by one page. */
export const MIN_REFRESH_MS = 10_000;
/** The slow fallback: a full re-read even when no webhook arrived. */
export const FALLBACK_WITH_WEBHOOKS_MS = 120_000;
export const FALLBACK_WITHOUT_WEBHOOKS_MS = 30_000;
/** While a command waits for its answer, re-read this often (for 2 minutes). */
export const PENDING_REFRESH_MS = 5_000;
const PENDING_FOR_MS = 120_000;

const time = (iso: string) => `${iso.slice(11, 19)} UTC`;

/**
 * Keeps the Live view current. With webhooks, it polls the kit's own /api/live/changes
 * (a database read, no Ivora request) and re-reads the page when a webhook or command
 * moved it, at most every 10 seconds. A slow full re-read covers webhook downtime:
 * every 2 minutes with webhooks, every 30 seconds without. Hidden tabs do nothing.
 */
export function Refresher(p: {
  readAt: string;
  webhooks: boolean;
  pending: boolean;
}) {
  const router = useRouter();
  const last = useRef(Date.now());
  const version = useRef<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    last.current = Date.now();
    setRefreshing(false);
  }, [p.readAt]);

  useEffect(() => {
    const started = Date.now();
    const reread = () => {
      if (Date.now() - last.current < MIN_REFRESH_MS) return;
      last.current = Date.now();
      setRefreshing(true);
      router.refresh();
    };
    const fallback = p.webhooks
      ? FALLBACK_WITH_WEBHOOKS_MS
      : FALLBACK_WITHOUT_WEBHOOKS_MS;
    const tick = async () => {
      if (document.hidden) return;
      const age = Date.now() - last.current;
      if (p.pending && Date.now() - started < PENDING_FOR_MS) {
        if (age >= PENDING_REFRESH_MS) {
          last.current = Date.now();
          router.refresh();
        }
        return;
      }
      if (age >= fallback) return reread();
      if (!p.webhooks) return;
      try {
        const r = await fetch("/api/live/changes", { cache: "no-store" });
        if (!r.ok) return;
        const { version: v } = (await r.json()) as { version?: string };
        if (typeof v !== "string") return;
        if (version.current !== null && v !== version.current) reread();
        version.current = v;
      } catch {
        // Offline for a moment: the fallback still re-reads.
      }
    };
    const timer = setInterval(tick, CHANGES_POLL_MS);
    const visible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [p.webhooks, p.pending, router]);

  return (
    <p className="muted refresher" role="status" aria-live="polite">
      Updated {time(p.readAt)}
      {refreshing ? " · refreshing…" : ""}.{" "}
      {p.webhooks
        ? "Updates when Ivora reports a change, and every 2 minutes."
        : "Updates every 30 seconds."}{" "}
      <button
        type="button"
        className="link-button"
        onClick={() => {
          last.current = Date.now();
          setRefreshing(true);
          router.refresh();
        }}
      >
        Refresh now
      </button>
    </p>
  );
}
