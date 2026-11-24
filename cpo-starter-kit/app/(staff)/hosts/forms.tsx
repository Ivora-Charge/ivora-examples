"use client";

import { useActionState, useId } from "react";
import { EMPTY } from "@/lib/action-state";
import {
  HOST_PERMISSIONS,
  NO_PERMISSIONS,
  PERMISSION_LABELS,
  type HostPermissions,
} from "@/lib/hosts";
import { FormActions } from "@/app/ui/field";
import { Result } from "../result";
import {
  archiveHostAction,
  assignSiteAction,
  saveFeeAction,
  saveHostAction,
} from "./actions";

export interface HostFormValues {
  id: string | null;
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  permissions: HostPermissions;
}

export const NEW_HOST: HostFormValues = {
  id: null,
  name: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  permissions: { ...NO_PERMISSIONS },
};

/** Add a host, or edit one: company, contact and the switches (all off for a new one). */
export function HostForm({ host }: { host: HostFormValues }) {
  const [state, action, pending] = useActionState(saveHostAction, EMPTY);
  const id = useId();
  const v = state.values;
  const text = (k: "name" | "contactName" | "contactEmail" | "contactPhone") =>
    v?.[k] ?? host[k];
  return (
    <form action={action} className="form host-form">
      {host.id && <input type="hidden" name="id" value={host.id} />}
      <Result state={state.ok ? {} : state} />
      <div className="field">
        <label htmlFor={`${id}-name`}>Company name</label>
        <input
          id={`${id}-name`}
          name="name"
          required
          maxLength={80}
          defaultValue={text("name")}
          autoComplete="organization"
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-contact`}>Contact name (optional)</label>
        <input
          id={`${id}-contact`}
          name="contactName"
          maxLength={80}
          defaultValue={text("contactName")}
          autoComplete="off"
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-email`}>Contact email (optional)</label>
        <input
          id={`${id}-email`}
          name="contactEmail"
          type="email"
          maxLength={254}
          defaultValue={text("contactEmail")}
          autoComplete="off"
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-phone`}>Contact phone (optional)</label>
        <input
          id={`${id}-phone`}
          name="contactPhone"
          type="tel"
          maxLength={40}
          defaultValue={text("contactPhone")}
          autoComplete="off"
        />
      </div>
      <fieldset className="form nested">
        <legend>What the host&apos;s users may do</legend>
        <p className="muted">
          They always see their own sites, chargers, live status, sessions and
          reports. Everything else is off until you switch it on.
        </p>
        {HOST_PERMISSIONS.map((p) => (
          <div key={p}>
            <div className="confirm">
              <input
                id={`${id}-${p}`}
                type="checkbox"
                name={p}
                defaultChecked={host.permissions[p]}
                aria-describedby={`${id}-${p}-hint`}
              />
              <label htmlFor={`${id}-${p}`}>{PERMISSION_LABELS[p].label}</label>
            </div>
            <p id={`${id}-${p}-hint`} className="hint muted">
              {PERMISSION_LABELS[p].hint}
            </p>
          </div>
        ))}
      </fieldset>
      <FormActions saved={Boolean(state.ok)} savedAt={state.savedAt}>
        <button type="submit" className="button" disabled={pending}>
          {pending ? "Saving…" : host.id ? "Save host" : "Add host"}
        </button>
      </FormActions>
    </form>
  );
}

export function ArchiveHost({
  hostId,
  name,
}: {
  hostId: string;
  name: string;
}) {
  const [state, action, pending] = useActionState(archiveHostAction, EMPTY);
  const id = useId();
  return (
    <form action={action} className="form">
      <Result state={state} />
      <input type="hidden" name="id" value={hostId} />
      <div className="confirm">
        <input id={`${id}-confirm`} type="checkbox" name="confirm" required />
        <label htmlFor={`${id}-confirm`}>
          Archive {name}: its users lose access at once and its sites go back to
          you
        </label>
      </div>
      <div>
        <button type="submit" className="button danger" disabled={pending}>
          {pending ? "Archiving…" : "Archive host"}
        </button>
      </div>
    </form>
  );
}

type Option = [value: string, label: string];

/** One site's host: a host, or none (the operator's own site). */
export function SiteHostForm(p: {
  siteId: number;
  siteName: string;
  hostId: string | null;
  hosts: Option[];
}) {
  const [state, action, pending] = useActionState(assignSiteAction, EMPTY);
  const id = useId();
  return (
    <form action={action} className="site-host">
      <input type="hidden" name="siteId" value={p.siteId} />
      <label htmlFor={`${id}-host`} className="visually-hidden">
        Host of {p.siteName}
      </label>
      <select id={`${id}-host`} name="hostId" defaultValue={p.hostId ?? ""}>
        <option value="">None (your own site)</option>
        {p.hosts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="button secondary"
        disabled={pending}
        aria-label={`Save the host of ${p.siteName}`}
      >
        Save
      </button>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : (
        <span className="saved" role="status">
          {state.ok ? "Saved" : ""}
        </span>
      )}
    </form>
  );
}

export interface FeeFormValues {
  mode: "percent" | "per_kwh";
  /** As typed: "10" (percent), "0.05" (per kWh), "15.00" (monthly). */
  percent: string;
  perKwh: string;
  monthly: string;
}

/**
 * A host's network fee: a share of each session's amount, or an amount per kWh, plus
 * an optional monthly fee per charger (shown on the statement, never collected). A
 * save is a new version that applies to sessions started after it.
 */
export function FeeForm(p: {
  hostId: string;
  hostName: string;
  currency: string;
  current: FeeFormValues;
}) {
  const [state, action, pending] = useActionState(saveFeeAction, EMPTY);
  const id = useId();
  const v = state.values;
  const mode = (v?.mode as FeeFormValues["mode"]) ?? p.current.mode;
  return (
    <form action={action} className="form fee-form">
      <input type="hidden" name="hostId" value={p.hostId} />
      <Result state={state.ok ? {} : state} />
      <fieldset className="form nested">
        <legend>Network fee for {p.hostName}</legend>
        <div className="confirm">
          <input
            id={`${id}-percent-mode`}
            type="radio"
            name="mode"
            value="percent"
            defaultChecked={mode === "percent"}
          />
          <label htmlFor={`${id}-percent-mode`}>
            A percentage of each session&apos;s amount
          </label>
        </div>
        <div className="field">
          <label htmlFor={`${id}-percent`}>Percentage (0 to 100)</label>
          <input
            id={`${id}-percent`}
            name="percent"
            inputMode="decimal"
            maxLength={7}
            defaultValue={v?.percent ?? p.current.percent}
            aria-describedby={`${id}-percent-hint`}
          />
          <p id={`${id}-percent-hint`} className="hint muted">
            For example 10 or 7.5. Rounded half up to the cent, once per
            session.
          </p>
        </div>
        <div className="confirm">
          <input
            id={`${id}-kwh-mode`}
            type="radio"
            name="mode"
            value="per_kwh"
            defaultChecked={mode === "per_kwh"}
          />
          <label htmlFor={`${id}-kwh-mode`}>A flat amount per kWh</label>
        </div>
        <div className="field">
          <label htmlFor={`${id}-kwh`}>Amount per kWh ({p.currency})</label>
          <input
            id={`${id}-kwh`}
            name="perKwh"
            inputMode="decimal"
            maxLength={10}
            defaultValue={v?.perKwh ?? p.current.perKwh}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-monthly`}>
            Monthly fee per charger ({p.currency}, optional)
          </label>
          <input
            id={`${id}-monthly`}
            name="monthly"
            inputMode="decimal"
            maxLength={12}
            defaultValue={v?.monthly ?? p.current.monthly}
            aria-describedby={`${id}-monthly-hint`}
          />
          <p id={`${id}-monthly-hint`} className="hint muted">
            Shown on the host&apos;s statement; the kit never collects it.
          </p>
        </div>
      </fieldset>
      <FormActions saved={Boolean(state.ok)} savedAt={state.savedAt}>
        <button type="submit" className="button" disabled={pending}>
          {pending ? "Saving…" : "Save network fee"}
        </button>
      </FormActions>
      {state.ok && (
        <p className="muted" role="status">
          {state.ok}
        </p>
      )}
    </form>
  );
}
