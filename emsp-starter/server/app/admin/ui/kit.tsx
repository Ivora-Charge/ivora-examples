import type { ReactNode } from "react";

/**
 * The small pieces every admin page shares, from the design in
 * ../design/admin-redesign (src/shell.mjs): icons, the power tile, a state as a word
 * with a mark, a message with its code and next step, and the page head.
 */
const PATHS = {
  setup: <path d="M4 6h3M4 12h3M4 18h3M11 6h9M11 12h9M11 18h9" />,
  network: (
    <>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="19" r="2.5" />
      <circle cx="19" cy="19" r="2.5" />
      <path d="M12 7.5v4M12 11.5 6.5 17M12 11.5l5.5 5.5" />
    </>
  ),
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  wallet: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h13v4" />
      <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V11a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2z" />
      <path d="M16.5 14h.01" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  flag: <path d="M5 21V4h13l-2.5 4.5L18 13H5" />,
  scale: (
    <path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z" />
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: (
    <>
      <path d="M12 9v4.5M12 17h.01" />
      <path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  lock: (
    <>
      <rect x="4.5" y="11" width="15" height="9.5" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  hub: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6" />
    </>
  ),
  refresh: (
    <path d="M20 11a8 8 0 0 0-14.5-4L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.5 4L20 15.5M20 20v-4.5h-4.5" />
  ),
  out: (
    <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9" />
  ),
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

/** The Kilolane mark, as in the driver app (app/src/components/Logo.tsx). */
export function Mark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <g transform="rotate(-12 24 24)">
        <path
          fill="var(--color-primary)"
          fillRule="evenodd"
          d="M24 2.5c-9.7 0-17.5 7.6-17.5 17.1 0 12.2 15.1 24.6 16.4 25.6a1.8 1.8 0 0 0 2.2 0c1.3-1 16.4-13.4 16.4-25.6C41.5 10.1 33.7 2.5 24 2.5ZM17.6 12.4a2.4 2.4 0 0 1 2.4 2.4v7.4a2.4 2.4 0 0 1-4.8 0v-7.4a2.4 2.4 0 0 1 2.4-2.4Zm12.8 0a2.4 2.4 0 0 1 2.4 2.4v7.4a2.4 2.4 0 0 1-4.8 0v-7.4a2.4 2.4 0 0 1 2.4-2.4Z"
        />
      </g>
      <circle cx="40.5" cy="40.5" r="5" fill="var(--color-flare)" />
    </svg>
  );
}

export type Kind = "ok" | "todo" | "bad" | "off" | "brand";

/**
 * The power tile: one number or mark, one word. Filled is good, outlined needs you,
 * red is broken, dashed waits. Decoration only: the words beside it say the same.
 */
export function Tile({
  kind,
  big,
  small,
  size,
}: {
  kind: Kind | "";
  big: ReactNode;
  small?: string;
  size?: "sm" | "lg";
}) {
  return (
    <span className={`tile ${kind} ${size ?? ""}`} aria-hidden="true">
      {typeof big === "string" || typeof big === "number" ? <b>{big}</b> : big}
      {small && <small>{small}</small>}
    </span>
  );
}

/** A state is a word with a mark, never colour alone. */
export function State({
  kind,
  children,
}: {
  kind: "ok" | "todo" | "bad" | "off" | "done";
  children: ReactNode;
}) {
  return <span className={`state ${kind}`}>{children}</span>;
}

/** The code and next step of a problem: the lib/admin/errors.ts pattern. */
export function Help({
  code,
  nextStep,
}: {
  code?: string;
  nextStep?: ReactNode;
}) {
  if (!code && !nextStep) return null;
  return (
    <dl className="help">
      {code && (
        <>
          <dt>Code</dt>
          <dd>
            <code>{code}</code>
          </dd>
        </>
      )}
      {nextStep && (
        <>
          <dt>Next step</dt>
          <dd>{nextStep}</dd>
        </>
      )}
    </dl>
  );
}

/** What happened, then (for a problem) its code and next step. */
export function Message({
  kind,
  title,
  code,
  nextStep,
  children,
}: {
  kind: "ok" | "bad" | "wait";
  title: ReactNode;
  code?: string;
  nextStep?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`msg ${kind}`} role={kind === "bad" ? "alert" : "status"}>
      <p className="t">
        <Icon
          name={kind === "ok" ? "check" : kind === "wait" ? "clock" : "alert"}
        />
        <span>{title}</span>
      </p>
      {children}
      <Help code={code} nextStep={nextStep} />
    </div>
  );
}

/** What every admin action answers with (lib/server/admin-action.ts). */
export type ActionResult = {
  ok?: boolean;
  message?: string;
  code?: string;
  nextStep?: string;
};

/** The answer of an admin action: its message, and a failure's code and next step. */
export function Result({
  state,
  children,
}: {
  state: ActionResult;
  children?: ReactNode;
}) {
  if (!state.message) return null;
  return state.ok ? (
    <Message kind="ok" title={state.message}>
      {children}
    </Message>
  ) : (
    <Message
      kind="bad"
      title={state.message}
      code={state.code}
      nextStep={state.nextStep}
    >
      {children}
    </Message>
  );
}

export function Head({
  crumbs,
  title,
  lead,
  action,
}: {
  crumbs: ReactNode[];
  title: ReactNode;
  lead?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="head">
      <div>
        <p className="crumb">
          {crumbs.map((c, i) => (
            <span key={i} style={{ display: "contents" }}>
              {i > 0 && <span aria-hidden="true">/</span>}
              <span>{c}</span>
            </span>
          ))}
        </p>
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {action}
    </div>
  );
}

/** A UTC timestamp as the admin web shows it: "2026-11-24 14:07 UTC". */
export function utc(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
