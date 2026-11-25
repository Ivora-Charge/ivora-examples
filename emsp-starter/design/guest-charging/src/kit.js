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
    // A button moves to another state of its screen; a link goes where it says.
    const go = t.closest("button[data-go]");
    if (go) {
      location.hash = go.dataset.go;
      return;
    }
    const copy = t.closest("[data-copy]");
    if (copy) {
      navigator.clipboard?.writeText(copy.dataset.copy).catch(() => {});
      const label = copy.querySelector("span");
      label.textContent = "Copied";
      setTimeout(() => (label.textContent = "Copy link"), 1600);
      return;
    }
    const choice = t.closest("[role='radio']");
    if (choice && !choice.disabled) {
      for (const c of choice.parentElement.querySelectorAll("[role='radio']"))
        c.setAttribute("aria-checked", String(c === choice));
      return;
    }
    if (t.closest('[aria-disabled="true"]')) e.preventDefault();
  });

  // The time left on the card step, as the real page would count it down.
  for (const el of document.querySelectorAll("[data-countdown]")) {
    let left = Number(el.dataset.countdown);
    const draw = () => {
      const m = Math.floor(left / 60);
      el.textContent = `${m}:${String(left % 60).padStart(2, "0")}`;
    };
    draw();
    if (!params.has("shot"))
      setInterval(() => {
        if (left > 0) left -= 1;
        draw();
      }, 1000);
  }
})();
