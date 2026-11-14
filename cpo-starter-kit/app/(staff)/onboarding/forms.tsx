"use client";

import { useActionState, useId, useState } from "react";
import { EMPTY } from "@/lib/action-state";
import {
  checkBrandColor,
  describeBrandCheck,
  describeDriverColor,
  KIT_COLORS,
  normalizeHex,
} from "@/lib/brand-colors";
import { LOGO_MAX_BYTES, logoFileProblem } from "@/lib/logo-limits";
import { Field, FormActions } from "@/app/ui/field";
import type { ActionState } from "@/lib/action-state";
import { Result } from "../result";
import {
  pushBrandingAction,
  registerReturnDomainAction,
  verifyReturnDomainAction,
  saveBrandAction,
  saveCompanyAction,
} from "./actions";

/**
 * `useActionState` for a save form, plus the time of the last successful save (the
 * visitor's clock), for the Saved state.
 */
function useSave(
  save: (prev: ActionState, form: FormData) => Promise<ActionState>,
) {
  const [state, action, pending] = useActionState(
    async (
      prev: ActionState & { at?: number },
      form: FormData,
    ): Promise<ActionState & { at?: number }> => {
      const next = await save(prev, form);
      return next.ok ? { ...next, at: Date.now() } : next;
    },
    EMPTY as ActionState & { at?: number },
  );
  return { state, action, pending, savedAt: state.ok ? state.at : undefined };
}

export interface CompanyDefaults {
  name: string;
  supportEmail: string;
  supportUrl: string;
  website: string;
  timeZone: string;
  currency: string;
}

export function CompanyForm(p: {
  defaults: CompanyDefaults;
  timeZones: readonly string[];
  currencies: readonly string[];
}) {
  const { state, action, pending, savedAt } = useSave(saveCompanyAction);
  const id = useId();
  const d = p.defaults;
  return (
    <>
      <Result state={state} />
      <form action={action} className="form">
        <Field
          id={`${id}-name`}
          label="Company name"
          help="Drivers see it on the payment pages."
        >
          {(c) => (
            <input
              {...c}
              name="name"
              defaultValue={d.name}
              maxLength={80}
              required
              autoComplete="organization"
            />
          )}
        </Field>
        <Field id={`${id}-email`} label="Support email">
          {(c) => (
            <input
              {...c}
              name="supportEmail"
              type="email"
              defaultValue={d.supportEmail}
              maxLength={254}
              required
            />
          )}
        </Field>
        <Field
          id={`${id}-support-url`}
          label="Support URL (optional)"
          help="An https page where drivers get help."
        >
          {(c) => (
            <input
              {...c}
              name="supportUrl"
              type="url"
              inputMode="url"
              defaultValue={d.supportUrl}
              maxLength={300}
              pattern="https://.*"
              placeholder="https://"
            />
          )}
        </Field>
        <Field id={`${id}-website`} label="Website (optional)">
          {(c) => (
            <input
              {...c}
              name="website"
              type="url"
              inputMode="url"
              defaultValue={d.website}
              maxLength={300}
              pattern="https://.*"
              placeholder="https://"
            />
          )}
        </Field>
        <Field
          id={`${id}-tz`}
          label="Time zone"
          help="Times are stored in UTC and shown in this zone."
        >
          {(c) => (
            <select {...c} name="timeZone" defaultValue={d.timeZone} required>
              <option value="" disabled>
                Choose…
              </option>
              {p.timeZones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={`${id}-currency`} label="Currency">
          {(c) => (
            <select {...c} name="currency" defaultValue={d.currency} required>
              {p.currencies.map((cur) => (
                <option key={cur} value={cur}>
                  {cur}
                </option>
              ))}
            </select>
          )}
        </Field>
        <FormActions saved={Boolean(state.ok)} savedAt={savedAt}>
          <button type="submit" className="button" disabled={pending}>
            {pending ? "Saving…" : "Save company details"}
          </button>
        </FormActions>
      </form>
    </>
  );
}

export function BrandForm(p: {
  color: string | null;
  hasLogo: boolean;
  /** The company name, for the preview of the driver page's header. */
  name: string;
}) {
  const { state, action, pending, savedAt } = useSave(saveBrandAction);
  const [color, setColor] = useState(p.color ?? "");
  const [logoProblem, setLogoProblem] = useState<string | null>(null);
  const id = useId();
  const hex = normalizeHex(color);
  const check = hex ? checkBrandColor(hex) : null;
  return (
    <>
      <Result state={state} />
      <form action={action} className="form">
        <div className="brand-grid">
          <div className="form">
            <div className="field">
              <label htmlFor={`${id}-color`}>Brand colour</label>
              <div className="color-field">
                <input
                  type="color"
                  aria-label="Colour picker"
                  value={hex ?? KIT_COLORS.primary.light}
                  onChange={(e) => setColor(e.currentTarget.value)}
                />
                <input
                  id={`${id}-color`}
                  name="primaryColor"
                  value={color}
                  onChange={(e) => setColor(e.currentTarget.value)}
                  placeholder="#17613a"
                  pattern="#[0-9a-fA-F]{6}"
                  maxLength={7}
                  required
                  spellCheck={false}
                  aria-describedby={`${id}-color-check`}
                />
              </div>
              <p id={`${id}-color-check`} className="hint" aria-live="polite">
                {check
                  ? `${describeDriverColor(check)} In this app: ${describeBrandCheck(check)}`
                  : "Buttons and headings on the driver payment pages use it. This app uses it too where it keeps text readable (WCAG AA)."}
              </p>
              {check && (
                <span
                  className="swatch"
                  // The operator's own colour, previewed with the text colour the check chose.
                  style={{
                    background: check.color,
                    color: check.light.onPrimary,
                  }}
                >
                  Sample button
                </span>
              )}
              {check && check.driverColor !== check.color && (
                <span
                  className="swatch"
                  // The darker shade the driver pages get instead, with white text.
                  style={{ background: check.driverColor, color: "#ffffff" }}
                >
                  Driver pages: {check.driverColor}
                </span>
              )}
            </div>
            <div className="field">
              <label htmlFor={`${id}-logo`}>
                {p.hasLogo ? "Replace the logo (optional)" : "Logo (optional)"}
              </label>
              <input
                id={`${id}-logo`}
                name="logo"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-describedby={`${id}-logo-hint ${id}-logo-problem`}
                aria-invalid={logoProblem ? true : undefined}
                onChange={(e) => {
                  const input = e.currentTarget;
                  const file = input.files?.[0];
                  const problem = file ? logoFileProblem(file) : null;
                  // Blocks the submit until another file is chosen.
                  input.setCustomValidity(problem ?? "");
                  setLogoProblem(problem);
                }}
              />
              <span id={`${id}-logo-hint`} className="hint">
                PNG, JPEG or WebP, at most {LOGO_MAX_BYTES / 1024} KB, 32 to
                2048 px a side. No SVG.
              </span>
              <span
                id={`${id}-logo-problem`}
                className={logoProblem ? "error" : undefined}
                role={logoProblem ? "alert" : undefined}
              >
                {logoProblem}
              </span>
            </div>
          </div>
          <div
            className="brand-preview"
            role="group"
            aria-label="Preview of the driver page header"
          >
            <span className="badge">Preview</span>
            <p className="brand-preview-name">{p.name}</p>
            <span
              className="swatch"
              // The saved or chosen colour with the text colour the check picked.
              style={
                check
                  ? { background: check.driverColor, color: "#ffffff" }
                  : undefined
              }
            >
              Pay and charge
            </span>
          </div>
        </div>
        <FormActions saved={Boolean(state.ok)} savedAt={savedAt}>
          <button type="submit" className="button" disabled={pending}>
            {pending ? "Saving…" : "Save brand"}
          </button>
        </FormActions>
      </form>
    </>
  );
}

export function PushBranding() {
  const [state, action, pending] = useActionState(pushBrandingAction, EMPTY);
  return (
    <>
      <Result state={state} />
      <form action={action}>
        <button type="submit" className="button secondary" disabled={pending}>
          {pending ? "Pushing…" : "Push to Ivora again"}
        </button>
      </form>
    </>
  );
}

/** Registers the hostname, or checks its TXT record: one button per state. */
export function ReturnDomainButton(p: { verify: boolean }) {
  const [state, action, pending] = useActionState(
    p.verify ? verifyReturnDomainAction : registerReturnDomainAction,
    EMPTY,
  );
  return (
    <>
      <Result state={state} />
      <form action={action}>
        <button type="submit" className="button secondary" disabled={pending}>
          {p.verify
            ? pending
              ? "Verifying…"
              : "Verify"
            : pending
              ? "Registering…"
              : "Register hostname"}
        </button>
      </form>
    </>
  );
}
