"use client";

import { useRef, useState } from "react";
import type { EmailResult } from "@/lib/server/mailer";
import { ErrorBox, type ErrorInfo } from "./error-box";

/**
 * Email the store receipt to an address the driver gives the cashier. The
 * address is sent once and cleared; the app never stores it. In demo mode the
 * server sends nothing and returns the email that would be sent.
 */
export function EmailReceipt({ sale, demo }: { sale: string; demo: boolean }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [result, setResult] = useState<EmailResult | null>(null);
  // One ID per address: a retry after a timeout never sends twice.
  const request = useRef<{ email: string; id: string } | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const to = email.trim();
    if (request.current?.email !== to)
      request.current = { email: to, id: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/cashier/sales/${sale}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: to, requestId: request.current.id }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok)
        throw (
          body ?? {
            error: "http_error",
            message: `Request failed (${response.status}).`,
          }
        );
      setResult(body as EmailResult);
      setEmail("");
      request.current = null;
    } catch (e) {
      setError(
        (e as ErrorInfo)?.error
          ? (e as ErrorInfo)
          : { error: "network_error", message: "Check the connection." },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card no-print stack" aria-label="Email receipt">
      <h2 style={{ margin: 0 }}>Email receipt</h2>
      {demo ? (
        <p className="muted" style={{ margin: 0 }}>
          Demo: nothing is sent. You&apos;ll see the email instead.
        </p>
      ) : null}
      <form className="row" onSubmit={send}>
        <label style={{ flex: 1 }}>
          Driver&apos;s email (used once, not stored)
          <input
            type="email"
            autoComplete="off"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="driver@example.com"
          />
        </label>
        <button type="submit" disabled={busy || !email.trim()}>
          {busy ? "Sending…" : "Email receipt"}
        </button>
      </form>
      {result?.sent ? <p className="pill ok">Receipt emailed.</p> : null}
      {result?.demo && result.preview ? (
        <div data-testid="email-preview">
          <p style={{ margin: 0 }}>
            <strong>Demo: nothing was sent.</strong> This is the email that
            would go to {result.preview.to}:
          </p>
          <p style={{ margin: "0.5rem 0" }}>
            Subject: {result.preview.subject}
          </p>
          <pre className="email-preview">{result.preview.text}</pre>
        </div>
      ) : null}
      {error ? <ErrorBox info={error} /> : null}
    </section>
  );
}
