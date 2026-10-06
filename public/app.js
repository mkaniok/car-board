const $ = (s, el = document) => el.querySelector(s);
const board = $("#board");
const tpl = $("#card-tpl");
const msg = $("#msg");
const urlInput = $("#url");

let cars = [];
let filter = "all";
let sort = "custom"; // "custom" = your drag-and-drop order, which is never changed by sorting
let busy = false;
let sortable;

const fmtInt = (n) => (n == null ? "" : Number(n).toLocaleString("cs-CZ"));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw new Error(data.error || `Request failed (${res.status})`);
  return { status: res.status, ...data };
}

function say(text, isError = false) {
  msg.textContent = text;
  msg.classList.toggle("error", isError);
}

function specs(c) {
  const out = [];
  if (c.year) out.push(String(c.year));
  if (c.mileage != null) out.push(`${fmtInt(c.mileage)} km`);
  if (c.fuel) out.push(c.fuel);
  if (c.transmission) out.push(c.transmission);
  if (c.power_kw) out.push(`${c.power_kw} kW (${Math.round(c.power_kw * 1.341)} hp)`);
  if (c.body) out.push(c.body);
  if (c.location) out.push(`📍 ${c.location}`);
  if (c.seller) out.push(c.seller);
  return out;
}

// sauto (sdn.cz) photos only load through our proxy, which adds sauto's resize filter.
function photoSources(url) {
  if (!url) return [];
  let host;
  try { host = new URL(url).hostname; } catch { return [url]; }
  if (!/(^|\.)sdn\.cz$/.test(host)) return [url];
  return [`/api/img?u=${encodeURIComponent(url.split("?")[0])}`];
}

function visible(c) {
  if (filter === "hidden") return c.hidden;
  if (c.hidden) return false;
  return filter === "all" || (filter === "done" ? c.contacted : !c.contacted);
}

const shown = () => cars.filter((c) => !c.hidden);

// Returns the cars to show, in display order, each with its rank in your own order.
function displayList() {
  // Ranks count only cars on the board; hidden cars have none.
  let n = 0;
  const list = cars.map((c) => ({ c, rank: c.hidden ? null : ++n })).filter(({ c }) => visible(c));
  if (sort === "custom") return list;
  const [field, dir] = sort.split("-");
  const sign = dir === "asc" ? 1 : -1;
  // Cars missing the value go last; ties keep your own order.
  return list.sort((a, b) => {
    const x = a.c[field], y = b.c[field];
    if (x == null || y == null) return (x == null) - (y == null) || 0;
    return (x - y) * sign;
  });
}

function render() {
  board.textContent = "";
  const custom = sort === "custom";
  const onBoardCount = shown().length;
  board.classList.toggle("sorted", !custom);
  $("#hint").textContent = custom ? "Drag ☰ or use ▲▼ to reorder" : "Switch to My order to reorder";
  sortable?.option("disabled", !custom);
  displayList().forEach(({ c, rank }) => {
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = c.id;
    el.classList.toggle("is-contacted", c.contacted);
    $(".num", el).textContent = rank ?? "";
    const host = (() => { try { return new URL(c.url).hostname.replace(/^www\./, ""); } catch { return c.url; } })();
    $(".title", el).textContent = c.title || host;
    $(".title", el).href = c.url;
    $(".photo", el).href = c.url;
    const img = $(".photo img", el);
    const sources = photoSources(c.image);
    img.onerror = () => (sources.length ? (img.src = sources.shift()) : img.removeAttribute("src"));
    img.src = sources.shift() || "";
    $(".price", el).textContent = c.price ? `${fmtInt(c.price)} Kč` : "";
    const ul = $(".specs", el);
    for (const s of specs(c)) ul.append(Object.assign(document.createElement("li"), { textContent: s }));
    if (c.parse_error) {
      const w = $(".warn", el);
      w.hidden = false;
      w.textContent = `Couldn't read all details (${c.parse_error}). Use Edit to fill them in, or Refresh to retry.`;
    }
    const cb = $(".contacted input", el);
    cb.checked = c.contacted;
    cb.addEventListener("change", () => save(c, { contacted: cb.checked }));
    const notes = $(".notes", el);
    notes.value = c.notes || "";
    notes.addEventListener("change", () => save(c, { notes: notes.value }));
    $(".edit", el).addEventListener("click", () => openEdit(c));
    $(".refresh", el).addEventListener("click", () => refresh(c, el));
    const up = $(".move.up", el), down = $(".move.down", el);
    if (custom && !c.hidden) {
      up.disabled = rank === 1;
      down.disabled = rank === onBoardCount;
      up.addEventListener("click", () => moveBy(c, -1));
      down.addEventListener("click", () => moveBy(c, 1));
    } else {
      up.disabled = down.disabled = true;
    }
    const hideBtn = $(".hide", el);
    hideBtn.textContent = c.hidden ? "Unhide" : "Hide";
    hideBtn.addEventListener("click", () => setHidden(c, !c.hidden));
    board.append(el);
  });
  const onBoard = shown();
  $("#empty").hidden = board.children.length > 0;
  $("#empty").textContent = filter === "hidden" ? "No hidden cars." : "No cars yet. Paste a sauto.cz link above to start.";
  $("#n-all").textContent = onBoard.length;
  $("#n-todo").textContent = onBoard.filter((c) => !c.contacted).length;
  $("#n-done").textContent = onBoard.filter((c) => c.contacted).length;
  $("#n-hidden").textContent = cars.length - onBoard.length;
}

async function load() {
  if (busy || document.querySelector(".notes:focus") || document.querySelector("dialog[open]")) return;
  try {
    cars = (await api("/api/cars")).cars;
    render();
  } catch (e) {
    say(e.message, true);
  }
}

function flash(id) {
  const el = board.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1800);
}

async function add(url) {
  url = url.trim();
  if (!url || busy) return;
  busy = true;
  $("#add-btn").disabled = true;
  say("Checking and reading the listing…");
  try {
    const res = await api("/api/cars", { method: "POST", body: { url } });
    if (res.duplicate && res.car.hidden) {
      say("");
      askUnhide(res.car);
    } else if (res.duplicate) {
      const idx = shown().findIndex((c) => c.id === res.car.id);
      say(`Already on the board as #${idx + 1}: ${res.car.title || res.car.url}`, true);
      if (!visible(res.car)) { setFilter("all"); }
      flash(res.car.id);
    } else {
      cars.push(res.car);
      if (filter === "done" || filter === "hidden") setFilter("all"); else render();
      say(res.car.parse_error ? "Added, but some details couldn't be read. Use Edit to fill them in." : `Added: ${res.car.title}`, !!res.car.parse_error);
      flash(res.car.id);
    }
    urlInput.value = "";
  } catch (e) {
    say(e.message, true);
  } finally {
    busy = false;
    $("#add-btn").disabled = false;
  }
}

async function save(car, patch) {
  try {
    const { car: updated } = await api(`/api/cars/${car.id}`, { method: "PATCH", body: patch });
    Object.assign(car, updated);
    render();
  } catch (e) {
    say(e.message, true);
  }
}

async function refresh(car, el) {
  const btn = $(".refresh", el);
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const { car: updated } = await api(`/api/cars/${car.id}/refresh`, { method: "POST" });
    Object.assign(car, updated);
    render();
    flash(car.id);
  } catch (e) {
    say(e.message, true);
    btn.disabled = false;
    btn.textContent = "Refresh";
  }
}

async function setHidden(car, hidden) {
  await save(car, { hidden });
  const name = car.title || car.url;
  say(hidden ? `Hidden: ${name}. Find it under Hidden.` : `Back on the board: ${name}`);
}

function askUnhide(dup) {
  const dlg = $("#unhide-dlg");
  $("#unhide-text").textContent =
    `"${dup.title || dup.url}" is already on the board but hidden. Do you want to unhide it?`;
  dlg.returnValue = "";
  dlg.onclose = async () => {
    if (dlg.returnValue !== "unhide") return;
    const car = cars.find((c) => c.id === dup.id) || (cars.push(dup), dup);
    await setHidden(car, false);
    if (!visible(car)) setFilter("all");
    flash(car.id);
  };
  dlg.showModal();
}

function openEdit(car) {
  const dlg = $("#edit-dlg");
  const form = $("#edit-form");
  for (const input of form.querySelectorAll("input")) input.value = car[input.name] ?? "";
  dlg.onclose = () => {
    if (dlg.returnValue !== "save") return;
    const patch = {};
    for (const input of form.querySelectorAll("input")) patch[input.name] = input.value.trim();
    save(car, patch);
  };
  dlg.returnValue = "";
  dlg.showModal();
}

function setFilter(f) {
  filter = f;
  document.querySelectorAll(".filters button").forEach((b) => b.classList.toggle("on", b.dataset.filter === f));
  render();
}

// Reordering: when a filter hides some cars, the visible ones are re-slotted
// into the positions they already occupied, so hidden cars keep their rank.
async function persistOrder() {
  const visibleIds = [...board.children].map((el) => Number(el.dataset.id));
  const byId = new Map(cars.map((c) => [c.id, c]));
  let k = 0;
  cars = cars.map((c) => (visible(c) ? byId.get(visibleIds[k++]) : c));
  render();
  await saveOrder();
}

// Move a car one place up or down among the cars on the board (hidden ones are skipped).
async function moveBy(car, dir) {
  const onBoard = shown();
  const at = onBoard.indexOf(car);
  const other = onBoard[at + dir];
  if (!other) return;
  const i = cars.indexOf(car), j = cars.indexOf(other);
  [cars[i], cars[j]] = [cars[j], cars[i]];
  render();
  flash(car.id);
  await saveOrder();
}

async function saveOrder() {
  try {
    await api("/api/order", { method: "PUT", body: { ids: cars.map((c) => c.id) } });
  } catch (e) {
    say(`Couldn't save the new order: ${e.message}`, true);
  }
}

sortable = new Sortable(board, {
  handle: ".handle",
  animation: 150,
  ghostClass: "ghost",
  onStart: () => { busy = true; },
  onEnd: (e) => { busy = false; if (e.oldIndex !== e.newIndex) persistOrder(); },
});

$("#add-form").addEventListener("submit", (e) => { e.preventDefault(); add(urlInput.value); });
$("#sort").addEventListener("change", (e) => { sort = e.target.value; render(); });
urlInput.addEventListener("paste", () => setTimeout(() => add(urlInput.value), 0));
document.querySelectorAll(".filters button").forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.filter)));
// Pick up changes made on other devices.
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
setInterval(load, 60_000);

load();
