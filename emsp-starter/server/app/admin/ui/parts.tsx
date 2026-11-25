"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useAdmin } from "./admin-context";
import { Icon, Tile } from "./kit";

/**
 * What a page shows in place of its data when nobody is signed in: one prompt with a
 * link to sign-in. Never a secret field.
 */
export function Gate({ what }: { what: string }) {
  const { ended } = useAdmin();
  return (
    <section className="gate" aria-labelledby="gate-h">
      <Tile kind="brand" big={<Icon name="lock" />} />
      <h2 id="gate-h">Sign in as an admin to {what}</h2>
      <p>
        {ended
          ? "Your sign-in has ended, so this page shows nothing. Admin sessions last about an hour, by email and with the admin secret alike."
          : "This page shows nothing until an admin is signed in. Signing in takes an email address and the 6-digit code we send to it."}
      </p>
      <Link className="btn" href="/admin/sign-in">
        Sign in <Icon name="arrow" />
      </Link>
    </section>
  );
}

/** The page's content for a signed-in admin; the sign-in prompt for anyone else. */
export function Gated({
  what,
  children,
}: {
  what: string;
  children: ReactNode;
}) {
  const { signedIn } = useAdmin();
  return signedIn ? <>{children}</> : <Gate what={what} />;
}

/** Something to copy: a statement, a URL, a token. The text wraps inside its box. */
export function Copy({
  text,
  label,
  children,
}: {
  /** What is copied. */
  text: string;
  label: string;
  /** What is shown, when it differs from `text` (a highlighted part, say). */
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="copy">
      <pre aria-label={label} tabIndex={0}>
        {children ?? text}
      </pre>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(text).catch(() => {});
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? "Copied" : "Copy"}
        <span className="sr"> {label}</span>
      </button>
    </div>
  );
}

/**
 * Our OCPI versions URL, to copy. The server sends it with the page only to an admin
 * signed in by email (and with a new one-time token, to whoever created it). Without
 * it, as for an admin-secret sign-in, this says how to put it together by hand.
 */
export function OurVersionsUrl({ url }: { url: string | null }) {
  if (url) return <Copy text={url} label="Our versions URL" />;
  return (
    <p className="small" role="note" aria-label="Our versions URL">
      This server&apos;s public address (<code>PUBLIC_BASE_URL</code>; on
      Vercel, the production domain when that is unset) followed by{" "}
      <code>/ocpi/versions</code>. It is shown here in full only to an admin
      signed in by email.
    </p>
  );
}

/**
 * Our OCPI party (country code and party ID). The server sends it with the page only
 * to an admin signed in by email; without it, this names the public API that answers.
 */
export function OurParty({ party }: { party: string | null }) {
  if (party) return <code>{party}</code>;
  return (
    <>
      Ask <code>GET /api/v1/status</code>
    </>
  );
}

/**
 * A fix that waits behind "Show the fix" on a phone and is open where there is room
 * (from 60rem, where the stylesheet hides the summary).
 */
export function Later({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (matchMedia("(min-width: 60rem)").matches) setOpen(true);
  }, []);
  return (
    <details
      className="later"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Show the fix</summary>
      <div className="in">{children}</div>
    </details>
  );
}

/**
 * A form for one admin action. `onSend` gets the fields, with the pressed button's
 * name and value; the form waits (and says so) until it answers.
 */
export function ActionForm({
  onSend,
  children,
  className = "form",
  clearOnOk,
  ...rest
}: Omit<ComponentProps<"form">, "action" | "onSubmit"> & {
  onSend: (form: FormData) => Promise<unknown>;
  /** Clear the fields once the action answers ok (a form that takes a secret). */
  clearOnOk?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <form
      {...rest}
      className={className}
      aria-busy={busy}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        const form = e.currentTarget;
        const submitter = (e.nativeEvent as SubmitEvent).submitter;
        const data = new FormData(form);
        if (
          (submitter instanceof HTMLButtonElement ||
            submitter instanceof HTMLInputElement) &&
          submitter.name
        )
          data.set(submitter.name, submitter.value);
        setBusy(true);
        try {
          const r = await onSend(data);
          if (clearOnOk && (r as { ok?: boolean } | undefined)?.ok)
            form.reset();
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </form>
  );
}

/**
 * A button for something that cannot be taken back: the first press asks, the second
 * does it. `children` is the button's label; `ask` what the second step says.
 */
export function ConfirmButton({
  children,
  ask,
  yes,
  onConfirm,
  className = "btn danger sm",
}: {
  children: ReactNode;
  ask: ReactNode;
  yes: string;
  onConfirm: () => Promise<unknown>;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking)
    return (
      <button
        type="button"
        className={className}
        onClick={() => setAsking(true)}
      >
        {children}
      </button>
    );
  return (
    <span className="row" role="group" aria-busy={busy}>
      <span className="small">{ask}</span>
      <button
        type="button"
        className="btn danger sm"
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setAsking(false);
          }
        }}
      >
        {yes}
      </button>
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => setAsking(false)}
      >
        Keep
      </button>
    </span>
  );
}

/** "3 min ago", from a UTC timestamp. Client only: it reads the clock. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return iso;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}
