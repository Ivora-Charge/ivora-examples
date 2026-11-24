// Mockup behaviour only: which state of a screen is showing (the URL hash), the theme
// (?theme=light|dark), copy buttons and a countdown. Nothing is sent anywhere.
(() => {
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const states = (document.body.dataset.states || "").split(" ");

  const theme = params.get("theme");
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  if (params.has("shot")) document.body.classList.add("shot");

  function show() {
    const wanted = location.hash.slice(1);
    const state = states.includes(wanted) ? wanted : states[0];
    document.body.dataset.state = state;
    for (const el of document.querySelectorAll("[data-show]"))
      el.hidden = !el.dataset.show.split(" ").includes(state);
    for (const el of document.querySelectorAll("[data-hide]"))
      el.hidden = el.dataset.hide.split(" ").includes(state);
    for (const el of document.querySelectorAll(".mock [data-state]"))
      el.setAttribute("aria-current", String(el.dataset.state === state));
  }
  addEventListener("hashchange", () => {
    show();
    scrollTo(0, 0);
  });
  show();

  // Keep the chosen theme (and the screenshot flag) from screen to screen.
  const keep = ["theme", "shot"].filter((k) => params.has(k));
  if (keep.length)
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (/^(#|[a-z]+:)/i.test(href)) continue;
      const [path, hash] = href.split("#");
      const q = keep.map((k) => `${k}=${params.get(k) ?? ""}`).join("&");
      a.setAttribute("href", `${path}?${q}${hash ? `#${hash}` : ""}`);
    }

  for (const b of document.querySelectorAll("[data-theme-set]")) {
    const value = b.dataset.themeSet;
    b.setAttribute("aria-pressed", String((theme ?? "auto") === value));
    b.addEventListener("click", () => {
      if (value === "auto") params.delete("theme");
      else params.set("theme", value);
      const q = params.toString();
      location.replace(
        `${location.pathname}${q ? `?${q}` : ""}${location.hash}`,
      );
    });
  }

  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    // Only a button or a link moves to another state. A form says where its submit
    // leads with data-submit-go, so a click or tap in one of its fields changes nothing.
    const go = t.closest("a[data-go], button[data-go]");
    if (go) {
      e.preventDefault();
      location.hash = go.dataset.go;
      return;
    }
    const copy = t.closest("[data-copy]");
    if (copy) {
      const text = copy.parentElement.querySelector("pre, .v").textContent;
      navigator.clipboard?.writeText(text.trim()).catch(() => {});
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1600);
      return;
    }
    const chip = t.closest(".chip[aria-pressed]");
    if (chip) {
      for (const c of chip.parentElement.querySelectorAll(".chip"))
        c.setAttribute("aria-pressed", String(c === chip));
      return;
    }
    if (t.closest('[aria-disabled="true"]')) e.preventDefault();
  });
  for (const f of document.querySelectorAll("form"))
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      if (f.dataset.submitGo) location.hash = f.dataset.submitGo;
    });

  // A fix that waits behind "Show the fix" on a phone is open where there is room.
  if (matchMedia("(min-width: 60rem)").matches)
    for (const d of document.querySelectorAll("details.later")) d.open = true;

  // A wait that counts down, as the real page would from the server's Retry-After.
  for (const el of document.querySelectorAll("[data-countdown]")) {
    let left = Number(el.dataset.countdown);
    const draw = () => {
      const m = Math.floor(left / 60);
      const s = String(left % 60).padStart(2, "0");
      el.textContent = `${m}:${s}`;
    };
    draw();
    if (!params.has("shot"))
      setInterval(() => {
        if (left > 0) left -= 1;
        draw();
      }, 1000);
  }

  // The handshake takes a moment, then lands on its result.
  addEventListener("hashchange", auto);
  function auto() {
    const el = document.querySelector("[data-auto]:not([hidden])");
    if (el && !params.has("shot"))
      setTimeout(() => {
        if (!el.hidden) location.hash = el.dataset.auto;
      }, 2600);
  }
  auto();
})();
