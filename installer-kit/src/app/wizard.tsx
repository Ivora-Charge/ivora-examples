"use client";
import { useEffect, useRef, useState } from "react";
import { describe } from "@/lib/status";
import { formatCents, quoteCents } from "@/lib/tariff";
import type { Charger } from "@/lib/types";

const DEFAULT_NOTES = `- Open the charger's web UI or app and find the OCPP / backend settings.
- Set protocol to OCPP 1.6J (WebSocket, JSON).
- Enter the connection URL above as the central system URL, and the station ID as the charge point ID.
- Enter the password as the Basic auth password.
- Save and reboot the charger.`;

type Created = { charger: Charger; url: string; password: string; qr: string };

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(
    url,
    body ? { method: "POST", body: JSON.stringify(body) } : undefined,
  );
  const json = await res.json();
  if (!res.ok)
    throw new Error(`${json.error}: ${json.message ?? ""} ${json.docs ?? ""}`);
  return json;
}

export default function Wizard() {
  const [siteId, setSiteId] = useState<string>();
  const [site, setSite] = useState({ name: "", address: "" });
  const [created, setCreated] = useState<Created>();
  const [charger, setCharger] = useState<Charger>();
  const [name, setName] = useState("Charger 1");
  const [notes, setNotes] = useState(DEFAULT_NOTES);
  const [tariff, setTariff] = useState(35);
  const [err, setErr] = useState<string>();
  const waited = useRef(0);
  const [showPw, setShowPw] = useState(true);

  const run = (f: () => Promise<void>) =>
    f().catch((e) => setErr(String(e.message)));

  useEffect(() => {
    if (!created || charger?.state === "booted") return;
    const t = setInterval(() => {
      waited.current += 2;
      run(async () =>
        setCharger(await api<Charger>(`/api/chargers/${created.charger.id}`)),
      );
    }, 2000);
    return () => clearInterval(t);
  }, [created, charger?.state]);

  const status = describe(charger?.state ?? "waiting", waited.current);

  return (
    <>
      {err && <p className="hint">{err}</p>}
      <section>
        <h2>1. Site</h2>
        {siteId ? (
          <p>{site.name}</p>
        ) : (
          <>
            <input
              placeholder="Site name"
              value={site.name}
              onChange={(e) => setSite({ ...site, name: e.target.value })}
            />
            <input
              placeholder="Address"
              value={site.address}
              onChange={(e) => setSite({ ...site, address: e.target.value })}
            />
            <button
              onClick={() =>
                run(async () =>
                  setSiteId((await api<{ id: string }>("/api/sites", site)).id),
                )
              }
            >
              Create site
            </button>
          </>
        )}
      </section>

      {siteId && (
        <section>
          <h2>2. Add charger</h2>
          {!created ? (
            <>
              <input value={name} onChange={(e) => setName(e.target.value)} />
              <button
                onClick={() =>
                  run(async () => {
                    const c = await api<Created>("/api/chargers", {
                      siteId,
                      name,
                    });
                    setCreated(c);
                    setCharger(c.charger);
                  })
                }
              >
                Add charger
              </button>
            </>
          ) : (
            <>
              <p>
                URL: <code>{created.url}</code>{" "}
                <button
                  onClick={() => navigator.clipboard.writeText(created.url)}
                >
                  Copy
                </button>
              </p>
              <p>
                Password:{" "}
                <code>{showPw ? created.password : "••••••••••••"}</code>{" "}
                <button
                  onClick={() =>
                    navigator.clipboard.writeText(created.password)
                  }
                >
                  Copy
                </button>
                <button onClick={() => setShowPw(false)}>Hide</button>
              </p>
              <p>Shown once. It cannot be displayed again.</p>
              <div
                dangerouslySetInnerHTML={{ __html: created.qr }}
                style={{ width: 160 }}
              />
              <h3>Setup notes (editable)</h3>
              <textarea
                rows={7}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </>
          )}
        </section>
      )}

      {created && charger && (
        <section>
          <h2>3. Connection</h2>
          <p>{status.label}</p>
          {status.hint && <p className="hint">{status.hint}</p>}
          {charger.boot && (
            <p>
              {charger.boot.vendor} {charger.boot.model}, firmware{" "}
              {charger.boot.firmware}, {charger.boot.connectors.length}{" "}
              connectors
            </p>
          )}
          {charger.state === "booted" && (
            <>
              <h2>4. Test</h2>
              <button
                onClick={() =>
                  run(async () =>
                    setCharger(
                      await api<Charger>(
                        `/api/chargers/${charger.id}/test`,
                        {},
                      ),
                    ),
                  )
                }
              >
                Run test session
              </button>
              {charger.test && (
                <p>
                  {charger.test.passed ? "Passed" : "Failed"}:{" "}
                  {charger.test.energyKwh.toFixed(2)} kWh delivered. Heartbeat{" "}
                  {charger.test.config.HeartbeatInterval}s, meter interval{" "}
                  {charger.test.config.MeterValueSampleInterval}s.
                </p>
              )}
              <h2>5. Price (optional)</h2>
              <label>
                Cents per kWh
                <input
                  type="number"
                  value={tariff}
                  onChange={(e) => setTariff(Number(e.target.value))}
                />
              </label>
              <p>
                Quote preview for a 20 kWh charge:{" "}
                {formatCents(quoteCents(20, tariff))}
              </p>
              <h2>6. Hand-over</h2>
              {charger.boot?.connectors.map((k) => (
                <a
                  key={k.id}
                  href={`/api/chargers/${charger.id}/sticker?connector=${k.id}`}
                >
                  <button>Sticker PDF: {k.label}</button>
                </a>
              ))}
              <a href={`/api/chargers/${charger.id}/report`}>
                <button>Commissioning report PDF</button>
              </a>
            </>
          )}
        </section>
      )}
    </>
  );
}
