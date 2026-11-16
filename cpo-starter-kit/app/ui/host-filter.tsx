import { hostFilterParam } from "@/lib/hosts";
import type { HostFilterView } from "@/lib/server/hosts/filter";

/**
 * The host filter of Chargers, Live and Reports (operator staff, when there are
 * hosts): a plain GET form, so it works without JavaScript. `keep` carries the page's
 * other query parameters (a report's period, for example).
 */
export function HostFilterForm({
  view,
  action,
  keep = {},
}: {
  view: HostFilterView;
  action: string;
  keep?: Record<string, string>;
}) {
  if (!view.options.length) return null;
  return (
    <form method="get" action={action} className="host-filter">
      {Object.entries(keep).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <div className="field">
        <label htmlFor="host-filter">Host</label>
        <select
          id="host-filter"
          name="host"
          defaultValue={hostFilterParam(view.filter)}
        >
          <option value="">All sites</option>
          {view.options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="button secondary">
        Show
      </button>
    </form>
  );
}
