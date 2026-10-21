"use client";

import { useActionState, useId, useState } from "react";
import { EMPTY } from "@/lib/action-state";
import {
  checkBrandColor,
  describeBrandCheck,
  KIT_COLORS,
  normalizeHex,
} from "@/lib/brand-colors";
import { Result } from "../result";
import {
  pushBrandingAction,
  saveBrandAction,
  saveCompanyAction,
} from "./actions";

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
  const [state, action, pending] = useActionState(saveCompanyAction, EMPTY);
  const id = useId();
  const d = p.defaults;
  return (
    <>
      <Result state={state} />
      <form action={action} className="form">
        <div className="field">
          <label htmlFor={`${id}-name`}>Company name</label>
          <input
            id={`${id}-name`}
            name="name"
            defaultValue={d.name}
            maxLength={80}
            required
            autoComplete="organization"
            aria-describedby={`${id}-name-hint`}
          />
          <span id={`${id}-name-hint`} className="hint">
            Drivers see it on the payment pages.
          </span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-email`}>Support email</label>
          <input
            id={`${id}-email`}
            name="supportEmail"
            type="email"
            defaultValue={d.supportEmail}
            maxLength={254}
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-support-url`}>Support URL (optional)</label>
          <input
            id={`${id}-support-url`}
            name="supportUrl"
            type="url"
            inputMode="url"
            defaultValue={d.supportUrl}
            maxLength={300}
            pattern="https://.*"
            placeholder="https://"
            aria-describedby={`${id}-support-url-hint`}
          />
          <span id={`${id}-support-url-hint`} className="hint">
            An https page where drivers get help.
          </span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-website`}>Website (optional)</label>
          <input
            id={`${id}-website`}
            name="website"
            type="url"
            inputMode="url"
            defaultValue={d.website}
            maxLength={300}
            pattern="https://.*"
            placeholder="https://"
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-tz`}>Time zone</label>
          <select
            id={`${id}-tz`}
            name="timeZone"
            defaultValue={d.timeZone}
            required
            aria-describedby={`${id}-tz-hint`}
          >
            <option value="" disabled>
              Choose…
            </option>
            {p.timeZones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          <span id={`${id}-tz-hint`} className="hint">
            Times are stored in UTC and shown in this zone.
          </span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-currency`}>Currency</label>
          <select
            id={`${id}-currency`}
            name="currency"
            defaultValue={d.currency}
            required
          >
            {p.currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <button type="submit" className="button" disabled={pending}>
            {pending ? "Saving…" : "Save company details"}
          </button>
        </div>
      </form>
    </>
  );
}

export function BrandForm(p: { color: string | null; hasLogo: boolean }) {
  const [state, action, pending] = useActionState(saveBrandAction, EMPTY);
  const [color, setColor] = useState(p.color ?? "");
  const id = useId();
  const hex = normalizeHex(color);
  const check = hex ? checkBrandColor(hex) : null;
  return (
    <>
      <Result state={state} />
      <form action={action} className="form">
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
              ? `Driver pages: ${check.driverContrast.toFixed(1)}:1 on white${check.driverContrast < 4.5 ? " (below 4.5:1: text on it may be hard to read)" : ""}. In this app: ${describeBrandCheck(check)}`
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
            aria-describedby={`${id}-logo-hint`}
          />
          <span id={`${id}-logo-hint`} className="hint">
            PNG, JPEG or WebP, at most 512 KB, 32 to 2048 px a side. No SVG.
          </span>
        </div>
        <div>
          <button type="submit" className="button" disabled={pending}>
            {pending ? "Saving…" : "Save brand"}
          </button>
        </div>
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
