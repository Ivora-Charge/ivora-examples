// Page bodies and review notes for the SQD-80 mockups. Demo data only: invented names,
// ids and figures; sample sites and chargers are labelled as samples.

const chip = (k, t) => `<span class="chip ${k}">${t}</span>`;
const S = {
  charging: chip("live", "Charging"),
  available: chip("ok", "Available"),
  offline: chip("bad", "Offline"),
  faulted: chip("warn", "Faulted"),
  idle: chip("idle", "Idle"),
};

/** A pattern that looks like a QR code and is not one (labelled as such). */
function qr() {
  let cells = "";
  let seed = 7;
  for (let y = 0; y < 21; y++)
    for (let x = 0; x < 21; x++) {
      const finder = (x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12);
      if (finder) continue;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if (seed % 3 === 0)
        cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  const f = (x, y) =>
    `<path d="M${x} ${y}h7v7h-7zM${x + 1} ${y + 1}v5h5v-5z" fill-rule="evenodd"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3"/>`;
  return `<svg class="qr" viewBox="0 0 21 21" role="img" aria-label="Sample sticker pattern, not a working code" fill="currentColor">${cells}${f(0, 0)}${f(14, 0)}${f(0, 14)}</svg>`;
}

function bars(vals, labels, unit) {
  const max = Math.max(...vals);
  const w = 640,
    h = 200,
    bw = w / vals.length;
  return `<svg class="bars" viewBox="0 0 ${w} ${h + 24}" role="img" aria-label="Energy per ${unit}, ${vals.length} bars; the table below has the same figures" width="100%">
<g class="grid">${[0, 0.5, 1].map((t) => `<line x1="0" x2="${w}" y1="${h - t * (h - 10)}" y2="${h - t * (h - 10)}"/>`).join("")}</g>
${vals.map((v, i) => `<rect x="${i * bw + 4}" y="${h - (v / max) * (h - 10)}" width="${bw - 8}" height="${(v / max) * (h - 10)}" rx="3"/><text x="${i * bw + bw / 2}" y="${h + 16}" text-anchor="middle">${labels[i]}</text>`).join("")}
</svg>`;
}

const chargerRows = [
  [
    "DEMO-1001",
    "Bay 1",
    "Sample Site: North Car Park",
    S.charging,
    "1 of 2",
    "Standard",
    "12 s ago",
    "2.4",
    "1 fault open",
  ],
  [
    "DEMO-1002",
    "Bay 2",
    "Sample Site: North Car Park",
    S.available,
    "2 of 2",
    "Standard",
    "8 s ago",
    "0.0",
    "",
  ],
  [
    "DEMO-1003",
    "Bay 3",
    "Sample Site: North Car Park",
    S.faulted,
    "0 of 2",
    "Standard",
    "31 s ago",
    "0.0",
    "",
  ],
  [
    "DEMO-2001",
    "Front door",
    "Sample Site: Harbour Hotel",
    S.charging,
    "1 of 1",
    "Guest rate",
    "5 s ago",
    "11.8",
    "",
  ],
  [
    "DEMO-2002",
    "Rear lot",
    "Sample Site: Harbour Hotel",
    S.available,
    "1 of 1",
    "Guest rate",
    "9 s ago",
    "0.0",
    "",
  ],
  [
    "DEMO-3001",
    "Pump island 1",
    "Sample Site: Retail Park",
    S.offline,
    "0 of 2",
    "Standard",
    "2 h ago",
    "0.0",
    "",
  ],
  [
    "DEMO-3002",
    "Pump island 2",
    "Sample Site: Retail Park",
    S.available,
    "2 of 2",
    "Standard",
    "14 s ago",
    "0.0",
    "",
  ],
  [
    "DEMO-4001",
    "Staff bay",
    "Sample Site: Depot",
    S.idle,
    "1 of 1",
    "Private",
    "20 s ago",
    "0.0",
    "",
  ],
];

const sortHead = (label, sort = "none", num = false) =>
  `<th scope="col"${num ? ' class="num"' : ""} aria-sort="${sort}"><button type="button">${label}</button></th>`;

const filterBar = (extra = "") => `<div class="toolbar" role="search">
<div class="grow"><label class="sr" for="q">Search chargers</label><input id="q" type="search" placeholder="Search name or ID" value=""></div>
<label class="sr" for="site">Site</label><select id="site" style="width:auto"><option>All sites</option><option>Sample Site: North Car Park</option></select>
${extra}</div>`;

const chargerTable = (
  rows,
) => `<div class="scroll"><table class="stack-sm"><caption class="sr">Chargers, sorted by status</caption><thead><tr>
${sortHead("Charger", "ascending")}<th scope="col" class="hide-sm">Site</th>${sortHead("Status")}${sortHead("Connectors free", "none", true)}<th scope="col" class="hide-sm">Tariff</th>${sortHead("kW now", "none", true)}<th scope="col" class="hide-sm">Last seen</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>
${rows.map((r) => `<tr><td><a class="name" href="charger.html">${r[1]}</a><span class="id">${r[0]}</span></td><td class="hide-sm sec">${r[2]}</td><td class="status">${r[3]}</td><td class="num sec" data-l="Free">${r[4]}</td><td class="hide-sm">${r[5]}</td><td class="num sec">${r[7]} kW</td><td class="hide-sm muted">${r[6]}</td><td class="hide-sm"><button class="btn sm" type="button" aria-label="Actions for ${r[1]}">${"…"}</button></td></tr>`).join("")}
</tbody></table></div>`;

export const pages = {
  live: ({ shell, icon }) =>
    shell({
      active: "live",
      crumbs: [
        ["Run", "#"],
        ["Live", "live.html"],
      ],
      title: "Live",
      lead: "Chargers, connectors and faults right now. Updates as they happen.",
      body: `<div class="note bad" role="alert"><span><b>2 faults need attention.</b> Pump island 1 has been offline for 2 hours; Bay 3 reports a connector fault.</span><a class="btn sm" href="charger.html">Open Bay 3</a></div>
<div class="strip" role="group" aria-label="Filter by status">
<a role="button" href="#" aria-pressed="true"><span class="k">Charging now</span><span class="v">2 <small>12.4 kW</small></span></a>
<a role="button" href="#" aria-pressed="false"><span class="k">Available</span><span class="v">3 <small>of 8</small></span></a>
<a role="button" href="#" aria-pressed="false"><span class="k">Faulted</span><span class="v">1</span></a>
<a role="button" href="#" aria-pressed="false"><span class="k">Offline</span><span class="v">1</span></a></div>
<div class="grid g-main">
<div class="card tablecard">${filterBar(`<button class="fchip" type="button" aria-pressed="true">Charging</button><button class="fchip" type="button" aria-pressed="false">Faulted</button><button class="fchip" type="button" aria-pressed="false">Offline</button>`)}
${chargerTable(chargerRows.slice(0, 6))}
<div class="tfoot"><span>Showing 6 of 8 chargers</span><span>Updated 4 s ago · live</span></div></div>
<div class="stack">
<div class="card"><div class="chead"><h2>Map</h2><span class="demo-tag">Placeholder</span></div>
<svg class="map" viewBox="0 0 320 260" role="img" aria-label="Map of three sample sites. Sites with a fault or offline charger are marked with a triangle or square and listed in the table.">
<path class="road" d="M0 190 Q120 150 200 170 T320 120"/><path class="road" d="M90 0 L120 260"/>
<g class="pin"><circle cx="105" cy="105" r="13" fill="var(--color-accent)"/><text class="halo" x="124" y="109">North Car Park</text><text x="124" y="109">North Car Park</text><text x="105" y="109" text-anchor="middle" style="fill:var(--color-on-accent)">2</text></g>
<g class="pin"><circle cx="220" cy="80" r="13" fill="var(--color-ok)"/><text class="halo" x="170" y="60">Harbour Hotel</text><text x="170" y="60">Harbour Hotel</text></g>
<g class="pin"><path d="M215 200h20v20h-20z" fill="var(--color-danger)"/><text class="halo" x="185" y="240">Retail Park · offline</text><text x="185" y="240">Retail Park · offline</text></g></svg>
<p class="muted sm" style="margin-top:var(--space-2)">Marker shape repeats the status: circle online, triangle fault, square offline.</p></div>
<div class="card"><div class="chead"><h2>Bay 3</h2>${S.faulted}</div><p class="muted sm">DEMO-1003 · Sample Site: North Car Park</p>
<dl class="kv" style="margin:var(--space-3) 0"><dt>Fault</dt><dd>Connector 1: ground failure</dd><dt>Since</dt><dd>10:42 (31 min)</dd></dl>
<p class="sm" style="margin-bottom:var(--space-2)"><b>Remote actions</b></p>
<div class="actions"><button class="btn sm" type="button">Reset</button><button class="btn sm" type="button">Unlock connector</button><button class="btn sm" type="button">Start session</button></div>
<p class="help muted sm" style="margin-top:var(--space-2)">Reset restarts the charger and ends any session in progress. You will be asked to confirm.</p></div>
</div></div>`,
    }),

  chargers: ({ shell, icon }) =>
    shell({
      active: "chargers",
      crumbs: [
        ["Run", "#"],
        ["Chargers", "chargers.html"],
      ],
      title: "Chargers",
      lead: "8 chargers at 4 sites.",
      action: `<a class="btn primary" href="charger.html">${icon("plug")}Add charger</a>`,
      body: `<div class="strip"><div><div class="k">Online</div><div class="v">7 <small>of 8</small></div></div><div><div class="k">Connectors</div><div class="v">11</div></div><div><div class="k">Needs attention</div><div class="v">2</div></div><div><div class="k">Without a price</div><div class="v">0</div></div></div>
<div class="card tablecard">${filterBar(`<span class="seg" role="group" aria-label="Status"><button type="button" aria-pressed="true">All</button><button type="button" aria-pressed="false">Online</button><button type="button" aria-pressed="false">Needs attention</button></span>`)}
${chargerTable(chargerRows)}<div class="tfoot"><span>1–8 of 8</span><span class="actions"><button class="btn sm" type="button" disabled>Previous</button><button class="btn sm" type="button" disabled>Next</button></span></div></div>
<h2 style="margin:var(--space-6) 0 var(--space-3)">Empty state (no chargers yet)</h2>
<div class="card empty">${icon("plug")}<h3>No chargers yet</h3><p>Add your first charger to see it here. You need its ID and a connection password; the next screen creates the password for you.</p><a class="btn primary" href="charger.html">Add your first charger</a><a href="#">How to find the charger ID</a></div>`,
    }),

  charger: ({ shell, icon }) =>
    shell({
      active: "chargers",
      crumbs: [
        ["Chargers", "chargers.html"],
        ["Bay 3", "charger.html"],
      ],
      title: "Bay 3",
      lead: "DEMO-1003 · Sample Site: North Car Park",
      action: `<button class="btn primary" type="button">Run test</button>`,
      body: `<dl class="strip"><div><dt>Status</dt><dd>${S.faulted}</dd></div><div><dt>Connectors</dt><dd>0 <small>of 2 free</small></dd></div><div><dt>Today</dt><dd>14.2 <small>kWh</small></dd></div><div><dt>Tariff</dt><dd style="font-size:1.1rem">Standard</dd></div><div><dt>Last seen</dt><dd style="font-size:1.1rem">31 s ago</dd></div></dl>
<div role="tablist" aria-label="Charger sections">
<button role="tab" id="t-over" aria-controls="p-over" aria-selected="false" tabindex="-1">Overview</button>
<button role="tab" id="t-conf" aria-controls="p-conf" aria-selected="true">Configuration</button>
<button role="tab" id="t-qr" aria-controls="p-qr" aria-selected="false" tabindex="-1">QR stickers</button>
<button role="tab" id="t-test" aria-controls="p-test" aria-selected="false" tabindex="-1">Test</button></div>
<section role="tabpanel" id="p-over" aria-labelledby="t-over" hidden><div class="card"><h2>Connectors</h2><table class="stack-sm"><thead><tr><th scope="col">Connector</th><th scope="col">Status</th><th scope="col" class="num">Power</th></tr></thead><tbody><tr><td>1 · Type 2</td><td class="status">${S.faulted}</td><td class="num">0.0 kW</td></tr><tr><td>2 · Type 2</td><td class="status">${S.available}</td><td class="num">0.0 kW</td></tr></tbody></table></div></section>
<section role="tabpanel" id="p-conf" aria-labelledby="t-conf"><div class="grid g-main"><form class="card" data-mock>
<h2>Details</h2>
<div class="field"><label for="n">Name</label><input id="n" value="Bay 3" aria-describedby="n-h"><span class="help" id="n-h">Shown to drivers on the sticker page.</span></div>
<div class="field"><label for="s">Site</label><select id="s"><option>Sample Site: North Car Park</option></select></div>
<div class="field"><label for="pw">Connection password</label><div class="inrow"><input id="pw" value="••••••••••••" readonly aria-describedby="pw-h"><button class="btn sm" type="button">Show</button><button class="btn sm" type="button">Copy</button></div><span class="help" id="pw-h">Enter this in the charger's own settings. Rotating it disconnects the charger until you do.</span></div>
<div class="field"><label for="tid">Charger ID</label><input id="tid" value="DEMO 1003" aria-invalid="true" aria-describedby="tid-e"><span class="err" id="tid-e">${icon("alert").replace('class="i"', 'class="i" style="width:14px;height:14px;vertical-align:-2px"')} Use letters, digits and dashes only: “DEMO-1003”.</span></div>
<div class="formfoot"><button class="btn primary" type="submit">Save changes</button><span class="saved" role="status" hidden></span><span class="muted sm">Last saved 10:31 by demo-owner@example.com</span></div></form>
<div class="card"><h2>Connection</h2><dl class="kv"><dt>Endpoint</dt><dd>wss://example.invalid/ocpp</dd><dt>Protocol</dt><dd>OCPP 1.6J</dd><dt>Firmware</dt><dd>1.4.2</dd></dl></div></div>
<div class="danger-zone"><div><h2>Remove this charger</h2><p class="muted sm">Removes it from Ampleaf. Past sessions and reports stay. This cannot be undone.</p></div><button class="btn danger" type="button">Remove charger…</button></div></section>
<section role="tabpanel" id="p-qr" aria-labelledby="t-qr" hidden><div class="grid g2"><div class="card"><div class="sticker">${qr()}<div><h3>Connector 1</h3><p class="muted sm">Scan to pay and charge</p><p class="muted sm">Sample pattern, not a working code.</p></div></div><div class="actions" style="margin-top:var(--space-3)"><button class="btn sm" type="button">Print</button><button class="btn sm" type="button">Download PNG</button></div></div>
<div class="card"><div class="sticker">${qr()}<div><h3>Connector 2</h3><p class="muted sm">Scan to pay and charge</p></div></div><div class="actions" style="margin-top:var(--space-3)"><button class="btn sm" type="button">Print</button><button class="btn sm" type="button">Download PNG</button></div></div></div>
<p class="muted sm" style="margin-top:var(--space-3)">Stickers use your domain and brand. Print both at A6 or smaller.</p></section>
<section role="tabpanel" id="p-test" aria-labelledby="t-test" hidden><div class="card"><div class="chead"><h2>Connection test</h2><button class="btn sm" type="button">Run again</button></div><ol style="list-style:none;padding:0;margin:0;display:grid;gap:var(--space-2)"><li>${chip("ok", "Passed")} Charger connected</li><li>${chip("ok", "Passed")} Heartbeat received (31 s ago)</li><li>${chip("warn", "Check")} Connector 1 reports a fault: ground failure</li></ol></div>
<div class="card" style="margin-top:var(--space-4)"><h2>Remote start and stop (optional)</h2><p class="muted sm" style="margin-bottom:var(--space-3)">Starts a free test session on connector 2 and stops it. No driver is charged.</p><div class="actions"><button class="btn" type="button">Start test</button><button class="btn" type="button" disabled>Stop test</button></div></div></section>`,
    }),

  pricing: ({ shell, icon }) =>
    shell({
      active: "pricing",
      crumbs: [
        ["Money", "#"],
        ["Pricing", "pricing.html"],
      ],
      title: "Pricing",
      lead: "What drivers pay. A change makes a new price from now on; sessions already running keep theirs.",
      action: `<button class="btn primary" type="button">New price</button>`,
      body: `<div class="card tablecard"><div class="scroll"><table class="stack-sm"><caption class="sr">Prices</caption><thead><tr>${sortHead("Name", "ascending")}<th scope="col">Type</th>${sortHead("Per kWh", "none", true)}${sortHead("Idle fee", "none", true)}${sortHead("Chargers", "none", true)}<th scope="col">State</th></tr></thead><tbody>
<tr><td><a class="name" href="#editor">Standard</a></td><td class="sec">Per kWh + idle fee</td><td class="num">$0.35</td><td class="num">$0.20 / min</td><td class="num">5</td><td class="status">${chip("ok", "In use")}</td></tr>
<tr><td><a class="name" href="#editor">Guest rate</a></td><td class="sec">Time of use</td><td class="num">$0.30–0.45</td><td class="num">none</td><td class="num">2</td><td class="status">${chip("ok", "In use")}</td></tr>
<tr><td><a class="name" href="#editor">Staff</a></td><td class="sec">Private</td><td class="num">n/a</td><td class="num">n/a</td><td class="num">1</td><td class="status">${chip("idle", "Private")}</td></tr>
<tr><td><a class="name" href="#editor">Open day</a></td><td class="sec">Free</td><td class="num">$0.00</td><td class="num">none</td><td class="num">0</td><td class="status">${chip("idle", "Unassigned")}</td></tr></tbody></table></div></div>
<h2 id="editor" style="margin:var(--space-6) 0 var(--space-3)">Edit “Standard”</h2>
<div class="grid g-main"><form class="card" data-mock><div class="field"><span class="lbl" id="type">Type</span><span class="seg" role="group" aria-labelledby="type"><button type="button" aria-pressed="true">Per kWh</button><button type="button" aria-pressed="false">Time of use</button><button type="button" aria-pressed="false">Free</button><button type="button" aria-pressed="false">Private</button></span><span class="help">Free needs no card. Private is for your own cards and staff only.</span></div>
<div class="field"><label for="kwh">Price per kWh</label><div class="inrow"><input id="kwh" inputmode="decimal" value="0.35" aria-describedby="kwh-h"><span class="unit">USD</span></div><span class="help" id="kwh-h">Before tax. Minimum charge $0.50 per session.</span></div>
<div class="field"><label for="idle">Idle fee</label><div class="inrow"><input id="idle" inputmode="decimal" value="0.20"><span class="unit">per minute after</span><input id="grace" style="max-width:5rem" value="10" aria-label="Grace period in minutes"><span class="unit">min</span></div><span class="help">Charged once charging has finished and the car is still plugged in.</span></div>
<div class="field"><label for="sf">Session fee (optional)</label><div class="inrow"><input id="sf" value="0,50" aria-invalid="true" aria-describedby="sf-e"><span class="unit">USD</span></div><span class="err" id="sf-e">Use a number with at most two decimals, for example 0.50 (a dot, not a comma).</span></div>
<h3 style="margin-bottom:var(--space-2)">Time-of-use periods</h3><table class="stack-sm" style="margin-bottom:var(--space-4)"><thead><tr><th scope="col">Days</th><th scope="col">From</th><th scope="col">To</th><th scope="col" class="num">Per kWh</th></tr></thead><tbody><tr><td>Every day</td><td>00:00</td><td>07:00</td><td class="num">$0.30</td></tr><tr><td>Every day</td><td>07:00</td><td>24:00</td><td class="num">$0.45</td></tr></tbody></table>
<div class="formfoot"><button class="btn primary" type="submit">Save new price</button><span class="saved" role="status" hidden></span><a href="#">Cancel</a></div></form>
<div class="stack"><div class="card"><div class="chead"><h2>Preview</h2><span class="demo-tag">Demo figure</span></div><p class="muted sm">A 30 kWh session of 90 minutes, priced by Ivora's simulation in the app.</p><p class="price-big" style="margin:var(--space-3) 0">$10.50</p><dl class="kv"><dt>Energy</dt><dd>30.0 kWh × $0.35</dd><dt>Idle</dt><dd>0 min</dd><dt>Total</dt><dd>$10.50</dd></dl></div>
<div class="card"><h2>Used by</h2><p class="sm">5 chargers: Bay 1, Bay 2, Bay 3, Pump island 1, Pump island 2</p><a class="sm" href="chargers.html">Change which chargers use it</a></div></div></div>`,
    }),

  reports: ({ shell, icon }) =>
    shell({
      active: "reports",
      crumbs: [
        ["Money", "#"],
        ["Reports", "reports.html"],
      ],
      title: "Reports",
      lead: "Sessions, energy and revenue for the period, in your time zone.",
      action: `<button class="btn primary" type="button">Export CSV</button>`,
      body: `<div class="toolbar card" style="border-radius:var(--radius);margin-bottom:var(--space-4)"><span class="seg" role="group" aria-label="Period"><button type="button" aria-pressed="false">7 days</button><button type="button" aria-pressed="true">30 days</button><button type="button" aria-pressed="false">90 days</button></span><span class="seg" role="group" aria-label="Group by"><button type="button" aria-pressed="false">Hour</button><button type="button" aria-pressed="true">Day</button><button type="button" aria-pressed="false">Month</button></span><span class="muted sm">Times in Europe/Berlin</span></div>
<div class="strip"><div><div class="k">Sessions</div><div class="v">412</div></div><div><div class="k">Energy</div><div class="v">3,184 <small>kWh</small></div></div><div><div class="k">Revenue (USD)</div><div class="v">$1,018</div></div><div><div class="k">Success rate</div><div class="v">96.4%</div></div><div><div class="k">Avg. duration</div><div class="v">52 <small>min</small></div></div></div>
<div class="grid g-main"><figure class="card" style="margin:0"><div class="chead"><h2>Energy per day (kWh)</h2><div class="legend"><span>Last 12 days</span></div></div>${bars([88, 102, 95, 120, 76, 61, 134, 118, 109, 142, 97, 125], ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"], "day")}<figcaption class="muted sm">Same figures in the table below.</figcaption></figure>
<div class="card"><h2>Top chargers</h2><table><thead><tr><th scope="col">Charger</th><th scope="col" class="num">kWh</th></tr></thead><tbody><tr><td>Front door</td><td class="num">412</td></tr><tr><td>Bay 1</td><td class="num">377</td></tr><tr><td>Pump island 2</td><td class="num">301</td></tr></tbody></table></div></div>
<div class="card tablecard" style="margin-top:var(--space-4)"><div class="toolbar"><h2 style="margin-right:auto">Sessions</h2><label class="sr" for="rs">Charger</label><select id="rs" style="width:auto"><option>All chargers</option></select><label class="sr" for="rst">Status</label><select id="rst" style="width:auto"><option>Any state</option></select></div>
<div class="scroll"><table class="stack-sm"><caption class="sr">Sessions, newest first</caption><thead><tr>${sortHead("Started", "descending")}<th scope="col">Charger</th><th scope="col">State</th>${sortHead("kWh", "none", true)}${sortHead("Collected", "none", true)}${sortHead("Refunded", "none", true)}</tr></thead><tbody>
<tr><td>11 Nov 09:12</td><td class="sec">Front door</td><td class="status">${chip("ok", "Paid")}</td><td class="num sec" data-l="Energy">24.1 kWh</td><td class="num" data-l="Collected">$8.44</td><td class="num sec" data-l="Refunded">$0.00</td></tr>
<tr><td>11 Nov 08:40</td><td class="sec">Bay 1</td><td class="status">${chip("warn", "Part-refunded")}</td><td class="num sec" data-l="Energy">18.6 kWh</td><td class="num" data-l="Collected">$4.51</td><td class="num sec" data-l="Refunded">$2.00</td></tr>
<tr><td>10 Nov 22:03</td><td class="sec">Bay 2</td><td class="status">${chip("ok", "Paid")}</td><td class="num sec" data-l="Energy">31.0 kWh</td><td class="num" data-l="Collected">$10.85</td><td class="num sec" data-l="Refunded">$0.00</td></tr></tbody></table></div><div class="tfoot"><span>1–3 of 412</span><span>Export respects these filters</span></div></div>
<h2 style="margin:var(--space-6) 0 var(--space-3)">Empty state (period with no sessions)</h2><div class="card empty">${icon("chart")}<h3>No sessions in these 7 days</h3><p>Try a longer period, or check that your chargers are online.</p><div class="actions"><button class="btn" type="button">Show 90 days</button><a href="live.html">Open Live</a></div></div>`,
    }),

  settings: ({ shell, icon }) =>
    shell({
      active: "settings",
      crumbs: [
        ["Workspace", "#"],
        ["Settings", "settings.html"],
        ["Brand", "settings.html"],
      ],
      title: "Settings",
      lead: "Company, brand, payments and team. Each section saves on its own.",
      body: `<div class="note ok" role="status" style="border-left-color:var(--color-primary)"><span><b>2 of 4 setup steps done.</b> Connect payments next, then add a charger.</span><a class="btn sm" href="#pay">Go to Payments</a></div>
<ol class="steps" aria-label="Setup progress"><li><span class="done">${icon("check")}</span>Company</li><li><span class="done">${icon("check")}</span>Brand</li><li aria-current="step">Payments</li><li>First charger</li></ol>
<div class="sub"><nav aria-label="Settings sections"><a href="#co">Company</a><a href="#brand" aria-current="location">Brand</a><a href="#pay">Payments</a><a href="#team">Team</a><a href="#roam">Roaming</a></nav>
<div class="stack">
<form class="card" id="co" data-mock><h2>Company</h2><div class="field"><label for="cn">Business name</label><input id="cn" value="Your charging network" aria-describedby="cn-h"><span class="help" id="cn-h">Shown in the header, page titles and emails.</span></div><div class="field"><label for="tz">Time zone</label><select id="tz"><option>Europe/Berlin</option></select><span class="help">Reports and receipts use this.</span></div><div class="formfoot"><button class="btn primary" type="submit">Save company</button><span class="saved" role="status">✓ Saved 10:02</span></div></form>
<form class="card" id="brand" data-mock><h2>Brand</h2><div class="grid g2"><div><div class="field"><label for="c1">Primary colour</label><div class="inrow"><span class="sw" style="background:var(--color-primary)"></span><input id="c1" value="#17613A"></div><span class="ok">✓ AA: 7.5:1 on white, 9.1:1 on dark</span></div><div class="field"><label for="c2">Accent (fill only)</label><div class="inrow"><span class="sw" style="background:var(--color-accent)"></span><input id="c2" value="#C5F24A" aria-invalid="true" aria-describedby="c2-e"></div><span class="err" id="c2-e">Text on this colour is 2.1:1. Pick a darker text colour or a deeper accent.</span></div></div>
<div class="card" aria-label="Preview of the driver page header" style="background:var(--color-bg)"><span class="demo-tag">Preview</span><div class="dhead" style="font:600 1.25rem var(--font-display);display:flex;gap:8px;align-items:center;margin:var(--space-2) 0"><svg viewBox="0 0 48 48" width="28" height="28" aria-hidden="true"><use href="#mark"/></svg>Your charging network</div><button class="btn primary wide" type="button">Pay and charge</button></div></div>
<div class="formfoot"><button class="btn primary" type="submit">Save brand</button><span class="saved" role="status" hidden></span></div></form>
<section class="card" id="pay"><div class="chead"><h2>Payments</h2>${chip("warn", "Action needed")}</div><p class="muted sm" style="margin-bottom:var(--space-3)">Drivers pay by card into your own Stripe account.</p><ul style="list-style:none;padding:0;margin:0 0 var(--space-4);display:grid;gap:var(--space-2)"><li>${chip("ok", "Done")} Stripe account created</li><li>${chip("warn", "To do")} Bank details for payouts</li><li>${chip("idle", "Waiting")} First test payment</li></ul><a class="btn primary" href="#">Continue in Stripe</a></section>
<section class="card" id="team"><div class="chead"><h2>Team</h2><button class="btn sm" type="button">Invite someone</button></div><table class="stack-sm"><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">State</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody><tr><td>demo-owner@example.com</td><td class="sec">Owner</td><td class="status">${chip("ok", "Active")}</td><td class="hide-sm"></td></tr><tr><td>demo-manager@example.com</td><td class="sec">Manager</td><td class="status">${chip("ok", "Active")}</td><td class="hide-sm"><button class="btn sm" type="button">Change role</button></td></tr><tr><td>demo-staff@example.com</td><td class="sec">Staff</td><td class="status">${chip("idle", "Invited")}</td><td class="hide-sm"><button class="btn sm" type="button">Resend</button></td></tr></tbody></table></section>
</div></div>`,
    }),

  driver: ({ plain, icon }) =>
    plain(
      "Checkout",
      `<div class="driver"><div class="dhead"><svg viewBox="0 0 48 48" aria-hidden="true"><use href="#mark"/></svg>Your charging network</div>
<div class="card"><p class="demo-tag">Sample Site: Harbour Hotel</p><div class="chead"><h1 style="font-size:1.75rem">Front door</h1>${S.available}</div><p class="muted sm">Connector 1 · Type 2 · up to 11 kW</p></div>
<div class="card"><h2>Price</h2><p class="price-big">$0.35 <small style="font:400 1rem var(--font-sans)" class="muted">per kWh</small></p><ul class="sm muted" style="padding-left:1.1rem;margin:var(--space-2) 0 0"><li>Idle fee $0.20 per minute after 10 minutes</li><li>$25.00 is held on your card and released at the end; you pay only for what you use</li></ul></div>
<div class="card"><button class="btn primary wide" type="button">Pay and charge</button><p class="muted sm" style="margin-top:var(--space-3)">Pay by card. No account needed. Payment by Ivora Checkout.</p></div>
<div class="card"><h2>Other states</h2><p class="sm">${S.offline} <b>Front door is offline.</b> Try another charger at this site.</p><p class="sm" style="margin-top:var(--space-2)">${S.charging} <b>In use.</b> Free in about 25 minutes.</p></div></div>`,
    ),

  session: ({ plain }) =>
    plain(
      "Session",
      `<div class="driver"><div class="dhead"><svg viewBox="0 0 48 48" aria-hidden="true"><use href="#mark"/></svg>Your charging network</div>
<div class="card"><div class="chead"><h1 style="font-size:1.75rem">Charging</h1>${S.charging}</div><p class="muted sm">Front door · Sample Site: Harbour Hotel</p><p class="price-big" style="margin:var(--space-4) 0 var(--space-2)">14.6 <small style="font:400 1rem var(--font-sans)" class="muted">kWh</small></p><div class="progress" role="progressbar" aria-label="Charged so far" aria-valuenow="58" aria-valuemin="0" aria-valuemax="100"><i style="width:58%"></i></div>
<dl class="kv" style="margin-top:var(--space-4)"><dt>Time</dt><dd>0:41</dd><dt>Power</dt><dd>10.9 kW</dd><dt>Cost so far</dt><dd>$5.11</dd></dl></div>
<div class="card"><button class="btn wide" type="button">Stop charging</button><p class="muted sm" style="margin-top:var(--space-3)">The $25.00 hold is released when the session ends; you pay for energy used.</p></div>
<div class="card"><h2>When it ends</h2><p class="sm muted">You will see a receipt here and by email if you gave one. Keep this page's address to come back.</p></div></div>`,
    ),

  welcome: ({ plain, icon }) =>
    plain(
      "Welcome",
      `<div class="topbar"><span class="brand" style="padding:0"><svg viewBox="0 0 48 48" width="32" height="32" aria-hidden="true"><use href="#mark"/></svg>ampleaf</span><a class="btn" href="settings.html">Sign in</a></div>
<div class="hero"><div><h1>Run your chargers without a developer.</h1><p class="lead">Chargers, prices, drivers' card payments and reports in one place, on your own domain and in your own brand.</p><div class="actions"><a class="btn primary" href="settings.html">Sign in</a><a class="btn" href="live.html">See the demo</a></div></div>
<div class="card"><h2>Today</h2><div class="strip" style="margin:0"><div><div class="k">Charging</div><div class="v">2</div></div><div><div class="k">Available</div><div class="v">3</div></div></div><p class="muted sm" style="margin-top:var(--space-3)">Sample data</p></div></div>
<div class="topbar"><div class="grid g3" style="width:100%"><div class="card"><h3>Chargers</h3><p class="sm muted">Add, test and print stickers.</p></div><div class="card"><h3>Pricing</h3><p class="sm muted">Per kWh, idle fees, time of use or free.</p></div><div class="card"><h3>Reports</h3><p class="sm muted">Sessions, energy, revenue; export anytime.</p></div></div></div>
<p class="topbar muted sm">Demo mode: sample data only.</p>`,
    ),

  states: ({ plain, icon }) => {
    const block = (
      name,
      empty,
      err,
    ) => `<section class="card" aria-labelledby="s-${name}"><h2 id="s-${name}">${name}</h2><div class="grid g3">
<div class="card empty">${icon("inbox")}<h3>Empty</h3><p>${empty}</p><button class="btn primary" type="button">Next step</button></div>
<div class="card" role="status" aria-label="Loading ${name}"><h3>Loading</h3><div class="skel" style="margin-top:var(--space-3)"><i style="width:60%"></i><i></i><i></i><i style="width:80%"></i></div><p class="muted sm" style="margin-top:var(--space-3)">Same shape as the loaded page, so nothing jumps.</p></div>
<div class="card empty" role="alert">${icon("alert")}<h3>Error</h3><p>${err}</p><div class="actions"><button class="btn" type="button">Try again</button><a href="#">Contact support</a></div></div></div></section>`;
    return `<div class="review"><header><h1>Empty, loading and error states</h1><p>Every list shows an empty state with one next step, a skeleton that matches the loaded layout, and an error that says what happened, whether data is safe, and what to do.</p></header><div class="stack">
${block("Live", "No chargers to show yet. Add a charger and it appears here within a minute.", "Live data is not reaching us. Chargers and sessions are not affected. Last update 10:42.")}
${block("Chargers", "Add your first charger. You need its ID; we create the connection password.", "We could not load your chargers. Nothing was changed.")}
${block("Pricing", "No prices yet. Create one so drivers can pay. A free price needs no card.", "We could not save this price. Your previous price is still active.")}
${block("Reports", "No sessions in this period yet. Try 90 days.", "Reports are unavailable right now. Payments are not affected.")}
</div></div>`;
  },
};

const common = {
  a11y: [
    "Text pairs are palette v2 pairs already checked at 4.5:1 or more in light and dark (tests/contrast.test.ts); no new pair is introduced.",
    "Keyboard order follows the visual order: skip link, navigation, page header, primary action, then content. Tabs use arrow keys; table sort heads are buttons with <code>aria-sort</code>.",
    "Focus: the existing 3 px token ring on every control; tap targets 44 px (36 px on dense table actions, with 44 px on a phone).",
    "Status is a shape, a word and a colour; charts have a text equivalent.",
  ],
};

export const screens = [
  {
    id: "live",
    n: 1,
    title: "Live",
    current: "live",
    files: ["live"],
    size: "M",
    blurb: "Map and list, faults first, remote actions beside the list.",
    summary:
      "The Live screen becomes a monitoring page: a faults banner with a next step, a status summary strip that doubles as filters, a dense table beside the map, and remote actions on the selected charger.",
    changes: [
      "Faults move to the top as one banner with a link to the charger, not a section below the list (an operator with many chargers looks for problems first).",
      "Summary strip counts double as status filters; the table gets search, site filter, sort and a sticky header (the template shows cards only).",
      "Map sits beside the list on desktop and below it on a phone; marker shapes repeat the status.",
      "Remote actions (reset, unlock, start) live in a panel for the selected charger, each with a one-line consequence and a confirmation.",
      "Live is read-only monitoring, so it has no primary action in the header.",
    ],
    follows: [
      "Squid: host dashboard cards (status, one clear next action per property) and its empty and error states.",
      "Adapted for many chargers: a table with filters where Squid has cards. Dense-table look from the hosted Ivora dashboard (by look only).",
    ],
    tokens: [
      "All colours from tokens; chips use <code>ok/warn/danger</code> tints; lime marks charging only.",
      "Map tiles stay configurable through MAP_TILE_URL as today.",
    ],
    sizeNote:
      "Table, chip set and summary strip are shared; the panel and banner are new. No API change.",
    a11y: common.a11y,
  },
  {
    id: "chargers",
    n: 2,
    title: "Chargers: list",
    current: "chargers",
    files: ["chargers", "charger"],
    size: "M",
    blurb:
      "A sortable, filterable table; a charger page with summary, tabs and a separated danger zone.",
    summary:
      "The list becomes a table that scales to dozens of chargers, with one primary action. The detail page leads with a summary strip, tabs below, QR stickers and the test in their own tabs, and removal in a bordered zone.",
    changes: [
      "List: search, site and status filters, sortable columns, right-aligned numbers, sticky header, pagination; rows stack on a phone.",
      "Empty state with a single next step, “Add your first charger”.",
      "Detail: summary strip (status, connectors, today, tariff, last seen) first, then Overview, Configuration, QR stickers, Test.",
      "Forms: label above, help beneath, inline error with text, “Saved” beside the button with the last-saved line.",
      "Remove charger sits apart in a danger zone and asks for confirmation.",
      'Second mock file: <a href="proposed/charger.html">charger detail</a>.',
    ],
    follows: [
      "Squid: the charger setup flow (add-charger steps, QR sticker preview) and host dashboard cards.",
      "Adapted for many chargers: filters, sorting and paging instead of a card per charger.",
    ],
    tokens: [
      "Sticker page uses the operator's brand tokens.",
      "Row density is one spacing token; it can be set once per brand.",
    ],
    sizeNote:
      "List and detail restructure existing pages; no route or API change.",
    a11y: common.a11y,
  },
  {
    id: "pricing",
    n: 3,
    title: "Pricing",
    current: "pricing",
    files: ["pricing"],
    size: "M",
    blurb: "A tariff table and one editor with a live preview.",
    summary:
      "Tariffs read as a table (type, price, idle fee, chargers using it) and one editor handles per-kWh, time of use, free and private, with the preview beside the form.",
    changes: [
      "Price table shows what drivers actually pay and how many chargers use each price.",
      "One editor: a segmented type control swaps the fields; help text says what each type means.",
      "Inline validation on money fields (two decimals), a visible Saved state, and the preview (priced by Ivora's simulation in the app) beside the form.",
      "Time-of-use periods as a plain table of day, from, to, price.",
      "No money logic changes: fees, hold and minimum are shown as today.",
    ],
    follows: [
      "Squid: charger setup flow (stepwise form, inline checks) and guest checkout price card (the same wording for hold and fees).",
      "Adapted: a table where Squid has one price per host.",
    ],
    tokens: [
      "Currency and number formats come from the workspace setting.",
      "Field width uses <code>--form-max</code>.",
    ],
    sizeNote:
      "Layout and validation messages only; the pricing logic is untouched.",
    a11y: common.a11y,
  },
  {
    id: "reports",
    n: 4,
    title: "Reports",
    current: "reports",
    files: ["reports"],
    size: "M",
    blurb:
      "Summary strip, chart with a text equivalent, a filterable session table and export.",
    summary:
      "Reports lead with a summary strip, then the chart, then the sessions table with filters; the single primary action is Export CSV.",
    changes: [
      "Period and grouping controls in one bar; time zone stated.",
      "Summary strip first (sessions, energy, revenue per currency, success rate, duration).",
      "Chart is a figure with a caption and a table of the same figures; bars use one colour and are labelled.",
      "Sessions table: sticky header, aligned money and energy, state chips, filters; export applies the same filters.",
      "Empty period has a next step.",
    ],
    follows: [
      "Squid: host dashboard cards for totals and its empty states.",
      "Adapted: a sessions table with filters and export (Squid shows a short list). Dense tables by look from the hosted Ivora dashboard.",
    ],
    tokens: [
      "Chart colour is <code>--color-primary</code> only; gridlines are the border token.",
    ],
    sizeNote: "Chart stays as today; the table and controls are restyled.",
    a11y: common.a11y,
  },
  {
    id: "settings",
    n: 5,
    title: "Onboarding and Settings",
    current: "onboarding",
    files: ["settings"],
    size: "M",
    blurb:
      "One settings page with sections, a progress strip and clear payments status.",
    summary:
      "Onboarding and Settings share one layout: a progress strip while setup is incomplete, a section list on the left, one card and one save button per section.",
    changes: [
      "Progress strip with the next step instead of a separate wizard once the first step is done.",
      "Sections: Company, Brand (with a contrast check and live preview), Payments (status chip and checklist), Team, Roaming.",
      "Every form shows Saved with a time; errors are inline text.",
      "Payments states are chips with words (Done, To do, Waiting).",
    ],
    follows: [
      "Squid: host setup (connect payments, add property) and its inline status messages.",
      "Adapted: team and brand sections, which Squid does not have.",
    ],
    tokens: [
      "The brand section edits exactly the token set: colours, font choice, logo; preview reads from tokens.",
      "Contrast check uses the same AA rule as tests/contrast.test.ts.",
    ],
    sizeNote: "Reorganises existing forms; contrast check and preview are new.",
    a11y: common.a11y,
  },
  {
    id: "driver",
    n: 6,
    title: "Driver checkout and session",
    current: "driver",
    files: ["driver", "session"],
    size: "S",
    blurb: "A calm single-column page on the operator's domain.",
    summary:
      "The driver sees the charger, status, price and one button, in the operator's brand. The session page shows energy, time and cost so far with one Stop action.",
    changes: [
      "Price card states the hold and idle fee in plain words before the button.",
      "One primary button; offline and busy states say what to do next.",
      "Session page: big energy figure, progress, time, power, cost so far; Stop is secondary.",
      'Second mock file: <a href="proposed/session.html">session page</a>.',
    ],
    follows: [
      "Squid: guest checkout and session pages (single column, price first, live session figures).",
    ],
    tokens: [
      "Header carries the operator name and logo from the brand tokens; nothing says Ampleaf except the default.",
    ],
    sizeNote: "Markup and copy only; payment flow untouched.",
    a11y: common.a11y,
  },
  {
    id: "welcome",
    n: 7,
    title: "Landing and states",
    current: "welcome",
    files: ["welcome", "states"],
    size: "S",
    blurb:
      "A short landing page and the empty, loading and error states of screens 1–4.",
    summary:
      "The landing page says what the app is and has one sign-in action. The states page shows the empty, loading and error pattern for Live, Chargers, Pricing and Reports.",
    changes: [
      "Landing: one headline, one sentence, Sign in primary, three plain cards.",
      "Empty: an icon, a sentence and one next step. Loading: a skeleton that matches the layout. Error: what happened, is data safe, try again.",
      'Second mock file: <a href="proposed/states.html">states</a>.',
    ],
    follows: [
      "Squid: empty and error states (error says what is safe) and its landing page tone.",
    ],
    tokens: [
      "Landing name and hero text come from OPERATOR_NAME and brand tokens.",
    ],
    sizeNote: "Shared state components, used by every list page.",
    a11y: [
      ...common.a11y,
      "Loading uses a status role; errors use an alert role; motion stops under reduced-motion.",
    ],
    noCurrent: "",
  },
];
