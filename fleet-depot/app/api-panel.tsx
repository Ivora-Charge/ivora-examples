import type { State } from "./types";
import { API_CALLS, callsFor, collapseEvents } from "@/lib/calls";

const DOCS = "https://www.ivoracharge.com/developers";

/** The calls and webhooks behind what is happening on the board, newest first. */
export default function ApiPanel({ s }: { s: State }) {
  const recent = collapseEvents(s.events)
    .map((e) => ({ e, calls: callsFor(e.type) }))
    .filter((x) => x.calls.length > 0)
    .slice(0, 4);
  return (
    <section className="panel apipanel" aria-labelledby="api-h">
      <h2 id="api-h">Calls behind the story</h2>
      <p className="note">
        Demo: these are the calls the app would make. Nothing is sent.
      </p>
      <div
        className="calls"
        tabIndex={0}
        role="region"
        aria-label="Latest calls"
      >
        {recent.length === 0 ? (
          <p className="empty">Calls appear here as vehicles plug in.</p>
        ) : (
          recent.map(({ e, calls }) => (
            <div key={e.id} className="callgroup">
              <b>{e.detail}</b>
              <ul>
                {calls.map((c, i) => (
                  <li key={i}>
                    <span className="tag">
                      {c.kind === "request" ? "request" : "webhook"}
                    </span>{" "}
                    <code>{c.text}</code>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
      <a href={DOCS} target="_blank" rel="noreferrer">
        Ivora API docs
      </a>
    </section>
  );
}

export function HowItWorks() {
  return (
    <ul className="how">
      {API_CALLS.map((c) => (
        <li key={c.call}>
          <code>{c.call}</code>
          <span>{c.use}</span>
        </li>
      ))}
    </ul>
  );
}
