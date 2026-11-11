// Tiny behaviour for the mockups: tabs, filter chips, sort heads, segmented
// buttons and the "saved" state. No dependencies; the pages read fine without it.
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark")
  document.documentElement.dataset.theme = theme;

for (const list of document.querySelectorAll('[role="tablist"]')) {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const show = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) tab.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => show(t));
    t.addEventListener("keydown", (e) => {
      const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (d) show(tabs[(i + d + tabs.length) % tabs.length], true);
      if (e.key === "Home") show(tabs[0], true);
      if (e.key === "End") show(tabs[tabs.length - 1], true);
    });
  });
}
for (const b of document.querySelectorAll("[aria-pressed]")) {
  b.addEventListener("click", () => {
    const group = b.closest(".seg");
    if (group)
      for (const o of group.querySelectorAll("[aria-pressed]"))
        o.setAttribute("aria-pressed", String(o === b));
    else b.setAttribute("aria-pressed", String(b.ariaPressed !== "true"));
  });
}
for (const th of document.querySelectorAll("th[aria-sort] button")) {
  th.addEventListener("click", () => {
    const cell = th.closest("th");
    const next =
      cell.getAttribute("aria-sort") === "ascending"
        ? "descending"
        : "ascending";
    for (const o of cell.parentElement.children)
      if (o.hasAttribute("aria-sort")) o.setAttribute("aria-sort", "none");
    cell.setAttribute("aria-sort", next);
  });
}
for (const f of document.querySelectorAll("form[data-mock]")) {
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const s = f.querySelector(".saved");
    if (s) {
      s.hidden = false;
      s.textContent = "✓ Saved just now";
    }
  });
}
