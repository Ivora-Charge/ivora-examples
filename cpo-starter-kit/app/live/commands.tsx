import Link from "next/link";
import type { CommandView } from "@/lib/server/live";
import { RecheckForm } from "./forms";
import { commandTitle, PhasePill, when } from "./status";

/** Recent commands with what Ivora answered and what the view has seen since. */
export function CommandsCard({
  commands,
  canWork,
  showStation = true,
}: {
  commands: CommandView[];
  canWork: boolean;
  showStation?: boolean;
}) {
  return (
    <section className="card" aria-labelledby="commands-heading">
      <h2 id="commands-heading">Recent commands</h2>
      {commands.length === 0 ? (
        <p className="muted">No commands sent from the kit yet.</p>
      ) : (
        <ul className="rows" aria-label="Recent commands">
          {commands.map((c) => (
            <li key={c.id} className="command-row">
              <span className="name">
                {commandTitle(c)}
                {showStation && (
                  <>
                    {" · "}
                    <Link href={`/live/stations/${c.stationId}`}>
                      {c.stationName}
                    </Link>
                  </>
                )}
              </span>
              <span className="muted">{when(c.requestedAt)}</span>
              <PhasePill phase={c.phase} />
              {(c.observed || c.error) && (
                <span className="command-detail">
                  {c.observed}
                  {c.error && <span className="error-text"> {c.error}</span>}
                </span>
              )}
              {canWork && c.phase === "pending" && <RecheckForm id={c.id} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
