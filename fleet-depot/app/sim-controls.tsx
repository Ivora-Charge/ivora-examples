"use client";
import type { State } from "./types";

type Post = (url: string, body: unknown, ok?: string) => Promise<boolean>;

/** Demo clock: speed, step buttons and reset. The clock is this visitor's own (a cookie). */
export default function SimControls({ s, post }: { s: State; post: Post }) {
  const sim = s.sim;
  if (!sim) return null;
  const speed = (v: number) =>
    post("/api/state", { action: "speed", speed: v });
  const adv = (m: number) =>
    post("/api/state", { action: "advance", minutes: m });
  return (
    <section className="panel simbar" aria-labelledby="clock-h">
      <h2 id="clock-h">Demo clock</h2>
      <div className="actions" role="group" aria-label="Speed">
        {(
          [
            [0, "Pause"],
            [1, "1×"],
            [60, "60×"],
            [300, "Play the night (300×)"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            aria-pressed={sim.speed === v}
            disabled={sim.done && v > 0}
            onClick={() => speed(v)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="actions">
        <button disabled={sim.done} onClick={() => adv(60)}>
          Advance 1 h
        </button>
        <button disabled={sim.done} onClick={() => adv(480)}>
          Advance 8 h
        </button>
        <button onClick={() => post("/api/state", { action: "reset" })}>
          Reset demo
        </button>
      </div>
      <p className="note small" aria-live="polite">
        {sim.done
          ? "The night is over. Reset to run it again."
          : "Play the night runs 16:30 to 08:30 in about 3 minutes; 60× takes about 15."}
      </p>
    </section>
  );
}
