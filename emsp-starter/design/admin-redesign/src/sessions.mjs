import { gate, head, icon, state, tile } from "./shell.mjs";

const ST = {
  charging: state("ok", "Charging"),
  finished: state("done", "Finished"),
  starting: state("todo", "Starting"),
  look: state("bad", "Needs a look"),
};

// Invented sample rows. A reference is country/party/session ID, as the CPO knows it.
const ROWS = [
  [
    "Station Square",
    "NL/NSC/7f3a91c2",
    "Northside Charging",
    "14:02",
    "charging",
    "11.40",
    null,
    "drv_8K2M",
  ],
  [
    "Canal Street Garage",
    "DE/RVE/20c4e7aa",
    "Riverside EV, via hub",
    "13:51",
    "charging",
    "6.92",
    null,
    "drv_3QTA",
  ],
  [
    "Mill Lane Car Park",
    "NL/HSC/b81d0f36",
    "Harbour Street Charge",
    "13:48",
    "starting",
    "0.00",
    null,
    "drv_W7P9",
  ],
  [
    "Station Square",
    "NL/NSC/5e02b7d9",
    "Northside Charging",
    "12:15",
    "finished",
    "31.75",
    "€18.42",
    "drv_J4NX",
  ],
  [
    "Hilltop Services",
    "AT/HTE/c9a47e10",
    "Hilltop Energy, via hub",
    "11:40",
    "look",
    "44.10",
    "€27.34",
    "drv_8K2M",
  ],
  [
    "Old Quay",
    "NL/HSC/0d6f2b58",
    "Harbour Street Charge",
    "10:57",
    "finished",
    "8.06",
    "€4.11",
    "drv_M2RC",
  ],
  [
    "Canal Street Garage",
    "DE/RVE/71be3c05",
    "Riverside EV, via hub",
    "09:33",
    "finished",
    "22.48",
    "€13.04",
    "drv_3QTA",
  ],
  [
    "Station Square",
    "NL/NSC/e4418a6f",
    "Northside Charging",
    "08:12",
    "finished",
    "17.30",
    "€10.03",
    "drv_T5LD",
  ],
];

const row = ([place, ref, peer, at, st, kwh, cost, driver]) => `
<tr>
  <th scope="row" class="c-main">${place}<span class="sub mono">${ref}</span></th>
  <td class="c-kv" data-l="Peer">${peer}</td>
  <td class="c-kv" data-l="Driver"><span class="mono">${driver}</span></td>
  <td class="c-kv" data-l="Started">${at}</td>
  <td class="c-kv num" data-l="Energy">${kwh} kWh</td>
  <td class="c-big num">${cost ?? '<span class="muted">not yet</span>'}${st === "look" ? '<span class="sub">above the €25.00 hold</span>' : ""}</td>
  <td class="c-state">${ST[st]}</td>
</tr>`;

const chip = (label, n, on = false) =>
  `<button class="chip" type="button" aria-pressed="${on}">${label} <span class="mono">${n}</span></button>`;

export const sessions = {
  file: "sessions",
  nav: "sessions",
  title: "Sessions",
  states: [
    ["list", "Signed in"],
    ["empty", "No sessions yet"],
    ["out", "Not signed in"],
  ],
  signedOut: ["out"],
  body: `
${head(["Charging"], "Sessions", "Every charge from every peer, newest first. The list opens by itself: there is nothing to press first.")}

<div data-show="out">${gate("see sessions")}</div>

<div data-show="empty" class="card flat stack">
  <div class="row">${tile("off", "0", "today")}<div style="flex:1;min-width:0"><h2>No sessions yet</h2><p class="muted">A session appears here the moment a driver starts a charge, or a CPO sends one. Sessions older than the first peer are not fetched.</p></div></div>
  <div><a class="btn ghost" href="peers.html">See peers</a></div>
</div>

<div data-show="list" class="stack">
  <div class="row between">
    <div class="chips" role="group" aria-label="Show">
      ${chip("All", 128, true)}${chip("Charging now", 2)}${chip("Starting", 1)}${chip("Needs a look", 1)}${chip("Finished", 124)}
    </div>
    <div class="field" style="min-width:14rem;flex:1;max-width:20rem">
      <label class="sr" for="q">Find by driver, charger or reference</label>
      <input id="q" type="search" placeholder="Driver, charger or reference">
    </div>
  </div>
  <div class="card tablecard">
    <table class="data sessions">
      <caption class="sr">Sessions, newest first</caption>
      <thead><tr>
        <th scope="col">Charger and reference</th><th scope="col">Peer</th><th scope="col">Driver</th><th scope="col">Started</th><th scope="col" class="num">Energy</th><th scope="col" class="num">Cost incl. VAT</th><th scope="col">State</th>
      </tr></thead>
      <tbody>${ROWS.map(row).join("")}</tbody>
    </table>
    <div class="foot">
      <span>8 of 128 · today, 24 Nov · refreshed 10 seconds ago</span>
      <button class="btn ghost sm" type="button">Show older ${icon("arrow")}</button>
    </div>
  </div>
</div>`,
};
