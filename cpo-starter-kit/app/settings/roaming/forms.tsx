"use client";

import {
  Fragment,
  startTransition,
  useActionState,
  useId,
  type FormEvent,
} from "react";
import { EMPTY, type ActionState } from "@/lib/action-state";
import { TIME_ZONES } from "@/lib/locale-options";
import { Result } from "../../result";
import { demoDecidePartyAction, saveRoamingAction } from "./actions";

// The Roaming form. It always posts every setting: Ivora's PUT replaces the whole
// object, and the server fills in what the form does not edit. It submits in a
// transition (as the tariff editor does) so a refused save keeps what was typed, and
// its fields start again from Ivora's values whenever the settings change.

function Problems({ state }: { state: ActionState }) {
  if (!state.problems?.length) return null;
  return (
    <ul className="error explain" aria-label="Other problems">
      {state.problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

export interface RoamingFormValues {
  revision: string;
  publish: boolean;
  /** Ivora keeps the network private: publishing is refused. */
  private: boolean;
  displayName: string;
  website: string;
  timeZone: string;
  countryCode: string;
  partyId: string;
  sites: { id: number; name: string; published: boolean }[];
}

export function RoamingForm({ v }: { v: RoamingFormValues }) {
  const [state, action, pending] = useActionState(saveRoamingAction, EMPTY);
  const id = useId();
  // The API takes Region/City zones, so plain UTC is not offered.
  const zones = TIME_ZONES.filter((z) => z.includes("/"));
  if (v.timeZone && !zones.includes(v.timeZone)) zones.unshift(v.timeZone);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => action(data));
  };
  return (
    <form onSubmit={submit} className="form">
      <input type="hidden" name="revision" value={v.revision} />
      <Fragment key={v.revision}>
        <div className="confirm">
          <input
            id={`${id}-publish`}
            type="checkbox"
            name="publish"
            defaultChecked={v.publish}
            disabled={v.private}
            aria-describedby={`${id}-publish-hint`}
          />
          <label htmlFor={`${id}-publish`}>
            Publish my sites to roaming partners
          </label>
        </div>
        <p id={`${id}-publish-hint`} className="hint muted">
          Off by default. When on, Ivora shares your sites, chargers, live
          availability and published prices with its OCPI roaming partners
          (maps, navigation apps and other networks&apos; driver apps).
        </p>

        <fieldset className="roaming-group">
          <legend>Operator details partners show</legend>
          <div className="field">
            <label htmlFor={`${id}-name`}>Operator name</label>
            <input
              id={`${id}-name`}
              name="displayName"
              defaultValue={v.displayName}
              maxLength={100}
              autoComplete="organization"
              aria-describedby={`${id}-name-hint`}
            />
            <span id={`${id}-name-hint`} className="hint">
              Needed to publish. Partners show it as the operator of your sites.
            </span>
          </div>
          <div className="field">
            <label htmlFor={`${id}-website`}>Website (optional)</label>
            <input
              id={`${id}-website`}
              name="website"
              type="url"
              inputMode="url"
              defaultValue={v.website}
              placeholder="https://charge.example.com"
              maxLength={255}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-tz`}>Time zone (optional)</label>
            <select
              id={`${id}-tz`}
              name="timeZone"
              defaultValue={v.timeZone}
              aria-describedby={`${id}-tz-hint`}
            >
              <option value="">Not set</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
            <span id={`${id}-tz-hint`} className="hint">
              For sites without their own time zone. A site with neither is not
              published.
            </span>
          </div>
        </fieldset>

        <fieldset className="roaming-group">
          <legend>Sites to publish</legend>
          {v.sites.length === 0 ? (
            <p className="hint muted">
              No sites yet. New sites are published unless you untick them here.
            </p>
          ) : (
            <>
              <p className="hint muted">
                Untick a site to keep it off roaming maps. New sites are
                published until you untick them.
              </p>
              <div className="site-choice">
                {v.sites.map((s) => (
                  <label key={s.id}>
                    <input type="hidden" name="shownLocation" value={s.id} />
                    <input
                      type="checkbox"
                      name="publishLocation"
                      value={s.id}
                      defaultChecked={s.published}
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            </>
          )}
        </fieldset>

        <fieldset className="roaming-group">
          <legend>Your own party ID (optional)</legend>
          <p className="hint muted">
            The country code and party ID a national registry issued to you.
            Ivora checks you hold it before using it. Leave both empty to
            publish under Ivora&apos;s shared party.
          </p>
          <div className="period-times">
            <div className="field">
              <label htmlFor={`${id}-cc`}>Country code</label>
              <input
                id={`${id}-cc`}
                name="countryCode"
                defaultValue={v.countryCode}
                maxLength={2}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                placeholder="US"
                className="party-code"
              />
            </div>
            <div className="field">
              <label htmlFor={`${id}-party`}>Party ID</label>
              <input
                id={`${id}-party`}
                name="partyId"
                defaultValue={v.partyId}
                maxLength={3}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                placeholder="ABC"
                className="party-code"
              />
            </div>
          </div>
        </fieldset>
      </Fragment>
      <Result state={state} />
      <Problems state={state} />
      <div>
        <button type="submit" className="button" disabled={pending}>
          {pending ? "Saving…" : "Save roaming settings"}
        </button>
      </div>
    </form>
  );
}

/** Demo only: plays Ivora staff's decision on the party request. */
export function DemoPartyDecision() {
  const [state, action, pending] = useActionState(demoDecidePartyAction, EMPTY);
  return (
    <form action={action} className="demo-sim">
      <p className="hint muted">
        Demo: in a real deployment Ivora staff decide after checking the
        registry. Play their part here.
      </p>
      <div className="actions">
        <button
          type="submit"
          name="decision"
          value="approve"
          className="button secondary"
          disabled={pending}
        >
          Demo: Ivora approves
        </button>
        <button
          type="submit"
          name="decision"
          value="reject"
          className="button secondary"
          disabled={pending}
        >
          Demo: Ivora rejects
        </button>
      </div>
      <Result state={state} />
    </form>
  );
}
