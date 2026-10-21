"use client";

import Link from "next/link";
import { useActionState, useId, useState, type ReactNode } from "react";
import { EMPTY, type ActionState } from "@/lib/action-state";
import { Result } from "../result";
import { addChargerAction } from "./actions";

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

/** A copyable value, for the charger's connection settings. */
function Copyable({ label, value }: { label: string; value: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="copy-field">
        <input
          id={id}
          readOnly
          value={value}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className="button secondary"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              // No clipboard permission: the field is selected on focus instead.
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** The charger password, shown once with what the charger needs to connect. */
export function SecretBox({ secret }: { secret: ActionState["secret"] }) {
  if (!secret) return null;
  return (
    <section className="secret" aria-labelledby="secret-heading">
      <h3 id="secret-heading">Charger connection settings</h3>
      <p>
        Enter these in the charger&apos;s OCPP settings.{" "}
        <strong>The password is shown only now:</strong> copy it before you
        leave this page. You can set a new one later, but never see this one
        again.
      </p>
      <Copyable label="OCPP connection URL" value={secret.connectionUrl} />
      <Copyable label="Charge point ID (username)" value={secret.username} />
      <Copyable label="Password" value={secret.password} />
    </section>
  );
}

function Outcome({ state }: { state: ActionState }) {
  return (
    <>
      <Result state={{ ...state, path: undefined }} />
      <SecretBox secret={state.secret} />
    </>
  );
}

/** One button (plus optional fields) that runs an action on one charger. */
export function ChargerAction(p: {
  action: Action;
  chargerKey: string;
  label: string;
  pendingLabel: string;
  variant?: "secondary" | "danger";
  children?: ReactNode;
}) {
  const [state, action, pending] = useActionState(p.action, EMPTY);
  return (
    <>
      <Outcome state={state} />
      <form action={action} className="form">
        <input type="hidden" name="key" value={p.chargerKey} />
        {p.children}
        <div>
          <button
            type="submit"
            className={p.variant ? `button ${p.variant}` : "button"}
            disabled={pending}
          >
            {pending ? p.pendingLabel : p.label}
          </button>
        </div>
      </form>
    </>
  );
}

/** A required "I understand" checkbox for actions that reach the charger. */
export function Confirm({ children }: { children: ReactNode }) {
  const id = useId();
  return (
    <div className="confirm">
      <input id={id} type="checkbox" name="confirm" required />
      <label htmlFor={id}>{children}</label>
    </div>
  );
}

export interface SiteOption {
  id: number;
  name: string;
}

export function AddChargerForm({ sites }: { sites: SiteOption[] }) {
  const [state, action, pending] = useActionState(addChargerAction, EMPTY);
  const [site, setSite] = useState(sites.length ? String(sites[0].id) : "new");
  const id = useId();
  const f = (n: string) => `${id}-${n}`;
  return (
    <>
      <Outcome state={state} />
      {state.ok && state.path && (
        <p>
          <Link className="button secondary" href={state.path}>
            Open the charger to test it
          </Link>
        </p>
      )}
      <form action={action} className="form">
        <div className="field">
          <label htmlFor={f("name")}>Connection name (charge point ID)</label>
          <input
            id={f("name")}
            name="name"
            required
            minLength={3}
            maxLength={36}
            pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{2,35}"
            spellCheck={false}
            autoCapitalize="off"
            aria-describedby={f("name-hint")}
          />
          <span id={f("name-hint")} className="hint">
            3 to 36 letters, digits, - or _. Unique across Ivora; the charger
            uses it to connect, and it can&apos;t change once the charger has
            connected.
          </span>
        </div>
        <div className="field">
          <label htmlFor={f("label")}>Display name (optional)</label>
          <input
            id={f("label")}
            name="label"
            maxLength={80}
            aria-describedby={f("label-hint")}
          />
          <span id={f("label-hint")} className="hint">
            Shown in this app and on stickers, for example &quot;Bay 3&quot;.
          </span>
        </div>
        <div className="field">
          <label htmlFor={f("connectors")}>Connectors</label>
          <select id={f("connectors")} name="connectors" defaultValue="1">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={f("site")}>Site</label>
          <select
            id={f("site")}
            name="site"
            value={site}
            onChange={(e) => setSite(e.currentTarget.value)}
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="new">New site…</option>
          </select>
        </div>
        {site === "new" && (
          <fieldset className="form nested">
            <legend>New site</legend>
            <div className="field">
              <label htmlFor={f("site-name")}>Site name</label>
              <input
                id={f("site-name")}
                name="siteName"
                required
                minLength={2}
                maxLength={80}
              />
            </div>
            <div className="field">
              <label htmlFor={f("site-address")}>Street address</label>
              <input
                id={f("site-address")}
                name="siteAddress"
                maxLength={120}
                autoComplete="street-address"
              />
            </div>
            <div className="field">
              <label htmlFor={f("site-city")}>City</label>
              <input
                id={f("site-city")}
                name="siteCity"
                maxLength={120}
                autoComplete="address-level2"
              />
            </div>
            <div className="field">
              <label htmlFor={f("site-postal")}>Postal code</label>
              <input
                id={f("site-postal")}
                name="sitePostalCode"
                maxLength={20}
                autoComplete="postal-code"
              />
            </div>
            <div className="field">
              <label htmlFor={f("site-country")}>Country</label>
              <input
                id={f("site-country")}
                name="siteCountry"
                defaultValue="USA"
                pattern="[A-Za-z]{3}"
                maxLength={3}
                aria-describedby={f("site-country-hint")}
              />
              <span id={f("site-country-hint")} className="hint">
                Three letters, for example USA, GBR or DEU.
              </span>
            </div>
          </fieldset>
        )}
        <p className="hint">
          Adding registers the charger in Ivora and sets a random connection
          password, shown to you once.
        </p>
        <div>
          <button type="submit" className="button" disabled={pending}>
            {pending ? "Adding…" : "Add charger"}
          </button>
        </div>
      </form>
    </>
  );
}
