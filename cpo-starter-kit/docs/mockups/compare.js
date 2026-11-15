// Screen pages: switch light/dark and desktop/phone for the current (screenshot)
// and proposed (live mock) columns.
const state = { theme: "light", size: "desktop" };
const pick = (name, value) => {
  state[name] = value;
  for (const b of document.querySelectorAll(`[data-set="${name}"]`))
    b.setAttribute("aria-pressed", String(b.dataset.value === value));
  for (const img of document.querySelectorAll("img[data-current]"))
    img.src = img.dataset.current
      .replace("{size}", state.size)
      .replace("{theme}", state.theme);
  for (const f of document.querySelectorAll("iframe[data-proposed]")) {
    const url = new URL(f.dataset.proposed, location.href);
    url.searchParams.set("theme", state.theme);
    f.src = url.href;
    f.dataset.size = state.size;
  }
};
for (const b of document.querySelectorAll("[data-set]"))
  b.addEventListener("click", () => pick(b.dataset.set, b.dataset.value));
document.documentElement.dataset.js = "1";
pick("theme", state.theme);

// Show the proposed mock at its real width (1440 or 390), scaled to fit its column.
const fit = () => {
  for (const f of document.querySelectorAll("iframe[data-proposed]")) {
    const w = f.dataset.size === "phone" ? 390 : 1440;
    const h = f.dataset.size === "phone" ? 844 : 1000;
    const avail = f.parentElement.clientWidth;
    const s = Math.min(1, avail / w);
    f.style.width = `${w}px`;
    f.style.height = `${h}px`;
    f.style.transform = `scale(${s})`;
    f.parentElement.style.height = `${h * s}px`;
  }
};
new ResizeObserver(fit).observe(document.body);
addEventListener("click", () => requestAnimationFrame(fit));
