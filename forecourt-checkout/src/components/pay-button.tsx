"use client";

import { useState } from "react";
import { ErrorBox, type ErrorInfo } from "./error-box";

/** One request ID per tap, reused if the same tap is retried after a timeout. */
function requestId(code: string, connector: number) {
  const key = `fc:pay:${code}:${connector}`;
  const saved = sessionStorage.getItem(key);
  if (saved) {
    const [id, at] = saved.split("|");
    if (Date.now() - Number(at) < 10 * 60 * 1000) return id;
  }
  const id = crypto.randomUUID();
  sessionStorage.setItem(key, `${id}|${Date.now()}`);
  return id;
}

export function PayButton(props: {
  code: string;
  connector: number;
  disabled: boolean;
  demo: boolean;
  holdLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: props.code,
          connector: props.connector,
          requestId: requestId(props.code, props.connector),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw body as ErrorInfo;
      sessionStorage.removeItem(`fc:pay:${props.code}:${props.connector}`);
      window.location.assign(body.url);
    } catch (e) {
      setError(
        (e as ErrorInfo)?.error
          ? (e as ErrorInfo)
          : {
              error: "network_error",
              message: "Check your connection and try again.",
            },
      );
      setBusy(false);
    }
  }

  return (
    <>
      <button className="block" onClick={pay} disabled={busy || props.disabled}>
        {props.disabled
          ? "Connector not available"
          : busy
            ? "Opening payment…"
            : props.demo
              ? `Pay with demo card (${props.holdLabel} hold)`
              : `Pay and start (${props.holdLabel} hold)`}
      </button>
      {error ? <ErrorBox info={error} /> : null}
    </>
  );
}
