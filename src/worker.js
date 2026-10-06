import { normalizeUrl, parseHtml, mapSautoItem } from "./parse.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS cars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_key TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  title TEXT,
  price INTEGER,
  year INTEGER,
  mileage INTEGER,
  fuel TEXT,
  transmission TEXT,
  power_kw INTEGER,
  body TEXT,
  location TEXT,
  seller TEXT,
  image TEXT,
  contacted INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL DEFAULT 0,
  parse_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const PARSED_FIELDS = ["title", "price", "year", "mileage", "fuel", "transmission", "power_kw", "body", "location", "seller", "image"];
const EDITABLE_FIELDS = [...PARSED_FIELDS, "contacted", "notes"];
const INT_FIELDS = new Set(["price", "year", "mileage", "power_kw"]);

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
};

const SAUTO_IMG_FILTER = "?fl=exf|res,1024,768,1|wrm,/watermark/sauto.png,10,10|jpg,80,,1";

let schemaReady = false;
async function db(env) {
  if (!schemaReady) {
    await env.DB.prepare(SCHEMA).run();
    schemaReady = true;
  }
  return env.DB;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

const rowToCar = (r) => r && { ...r, contacted: !!r.contacted };

/** Fetches and parses a listing. Never throws: returns { data, error }. */
export async function fetchListing(norm) {
  const data = {};
  const errors = [];
  if (norm.sautoId) {
    try {
      const res = await fetch(`https://www.sauto.cz/api/v1/items/${norm.sautoId}`, {
        headers: { ...BROWSER_HEADERS, Accept: "application/json" },
      });
      if (res.ok) {
        const body = await res.json();
        Object.assign(data, mapSautoItem(body.result ?? body, norm.url));
      } else {
        errors.push(`sauto API ${res.status}`);
      }
    } catch (e) {
      errors.push(`sauto API: ${e.message}`);
    }
  }
  const missing = PARSED_FIELDS.filter((f) => data[f] == null && f !== "seller" && f !== "body");
  if (missing.length) {
    try {
      const res = await fetch(norm.url, { headers: { ...BROWSER_HEADERS, Accept: "text/html" }, redirect: "follow" });
      if (res.ok) {
        const parsed = parseHtml(await res.text(), res.url || norm.url);
        for (const [k, v] of Object.entries(parsed)) if (data[k] == null) data[k] = v;
      } else {
        errors.push(`page ${res.status}`);
      }
    } catch (e) {
      errors.push(`page: ${e.message}`);
    }
  }
  const error = data.title ? null : errors.join("; ") || "Could not read listing details";
  return { data, error };
}

async function addCar(env, body) {
  let norm;
  try {
    norm = normalizeUrl(body.url);
  } catch (e) {
    return json({ error: e.message }, 400);
  }
  const DB = await db(env);
  const existing = await DB.prepare("SELECT * FROM cars WHERE url_key = ?").bind(norm.key).first();
  if (existing) return json({ duplicate: true, car: rowToCar(existing) }, 409);

  const { data, error } = await fetchListing(norm);
  const top = await DB.prepare("SELECT MIN(position) AS p FROM cars").first();
  const position = (top?.p ?? 1) - 1; // new cars land on top of the board
  const cols = ["url_key", "url", "position", "parse_error", ...PARSED_FIELDS];
  const vals = [norm.key, norm.url, position, error, ...PARSED_FIELDS.map((f) => data[f] ?? null)];
  try {
    const row = await DB.prepare(
      `INSERT INTO cars (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")}) RETURNING *`,
    ).bind(...vals).first();
    return json({ car: rowToCar(row) }, 201);
  } catch (e) {
    // Lost a race with a concurrent add of the same URL.
    const row = await DB.prepare("SELECT * FROM cars WHERE url_key = ?").bind(norm.key).first();
    if (row) return json({ duplicate: true, car: rowToCar(row) }, 409);
    throw e;
  }
}

async function updateCar(env, id, body) {
  const sets = [];
  const vals = [];
  for (const f of EDITABLE_FIELDS) {
    if (!(f in body)) continue;
    let v = body[f];
    if (f === "contacted") v = v ? 1 : 0;
    else if (INT_FIELDS.has(f)) v = v === "" || v == null ? null : parseInt(String(v).replace(/[^\d]/g, ""), 10) || null;
    else v = v == null ? (f === "notes" ? "" : null) : String(v).slice(0, 5000);
    sets.push(`${f} = ?`);
    vals.push(v);
  }
  if (!sets.length) return json({ error: "Nothing to update" }, 400);
  // Hand-filled details replace whatever the parser couldn't read.
  if (PARSED_FIELDS.some((f) => f in body)) sets.push("parse_error = NULL");
  const DB = await db(env);
  const row = await DB.prepare(
    `UPDATE cars SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ? RETURNING *`,
  ).bind(...vals, id).first();
  return row ? json({ car: rowToCar(row) }) : json({ error: "Not found" }, 404);
}

async function refreshCar(env, id) {
  const DB = await db(env);
  const car = await DB.prepare("SELECT * FROM cars WHERE id = ?").bind(id).first();
  if (!car) return json({ error: "Not found" }, 404);
  const { data, error } = await fetchListing(normalizeUrl(car.url));
  const fields = PARSED_FIELDS.filter((f) => data[f] != null);
  const row = await DB.prepare(
    `UPDATE cars SET ${[...fields.map((f) => `${f} = ?`), "parse_error = ?", "updated_at = datetime('now')"].join(", ")} WHERE id = ? RETURNING *`,
  ).bind(...fields.map((f) => data[f]), error, id).first();
  return json({ car: rowToCar(row) });
}

async function reorder(env, body) {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : null;
  if (!ids) return json({ error: "ids must be an array" }, 400);
  const DB = await db(env);
  await DB.batch(ids.map((id, i) => DB.prepare("UPDATE cars SET position = ? WHERE id = ?").bind(i, id)));
  return json({ ok: true });
}

// sauto.cz photos live on *.sdn.cz, which refuses requests that don't come
// from sauto itself, so the board loads them through this proxy.
async function proxyImage(request) {
  let target;
  try {
    target = new URL(new URL(request.url).searchParams.get("u"));
  } catch {
    return new Response("Bad image URL", { status: 400 });
  }
  if (target.protocol !== "https:" || !/(^|\.)sdn\.cz$/.test(target.hostname)) {
    return new Response("Host not allowed", { status: 403 });
  }
  // sdn.cz only serves sauto photos resized and watermarked, with the same
  // filter string sauto's own pages use.
  target.search = SAUTO_IMG_FILTER;
  const res = await fetch(target, {
    headers: { ...BROWSER_HEADERS, Accept: "image/avif,image/webp,image/*,*/*;q=0.8", Referer: "https://www.sauto.cz/" },
    cf: { cacheEverything: true, cacheTtl: 86400 },
  });
  const type = res.headers.get("Content-Type") || "";
  if (new URL(request.url).searchParams.has("debug")) {
    // Diagnostics: show what the image host answered instead of the image.
    const body = type.startsWith("image/") ? `<${type} image>` : (await res.text()).slice(0, 500);
    return json({ status: res.status, type, headers: Object.fromEntries(res.headers), body });
  }
  if (!res.ok || !type.startsWith("image/")) {
    return new Response(`Image host answered ${res.status}`, { status: 502 });
  }
  return new Response(res.body, {
    headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400" },
  });
}

async function handleApi(request, env, path) {
  if (path === "/api/img" && request.method === "GET") return proxyImage(request);
  const method = request.method;
  const body = method === "GET" || method === "DELETE" ? {} : await request.json().catch(() => ({}));
  const idMatch = path.match(/^\/api\/cars\/(\d+)(\/refresh)?$/);

  if (path === "/api/cars" && method === "GET") {
    const { results } = await (await db(env)).prepare("SELECT * FROM cars ORDER BY position, id").all();
    return json({ cars: results.map(rowToCar) });
  }
  if (path === "/api/cars" && method === "POST") return addCar(env, body);
  if (path === "/api/check" && method === "GET") {
    try {
      const norm = normalizeUrl(new URL(request.url).searchParams.get("url"));
      const row = await (await db(env)).prepare("SELECT * FROM cars WHERE url_key = ?").bind(norm.key).first();
      return json({ exists: !!row, car: rowToCar(row) });
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  }
  if (path === "/api/order" && method === "PUT") return reorder(env, body);
  if (path === "/api/raw" && method === "GET") {
    // Diagnostics: the raw sauto API answer for a listing, to tune the parser.
    const norm = normalizeUrl(new URL(request.url).searchParams.get("url"));
    if (!norm.sautoId) return json({ error: "Not a sauto.cz listing URL" }, 400);
    if (new URL(request.url).searchParams.has("page")) {
      const page = await fetch(norm.url, { headers: { ...BROWSER_HEADERS, Accept: "text/html" } });
      const html = await page.text();
      const imgs = [...new Set(html.match(/(?:https?:)?\/\/[a-z0-9-]+\.sdn\.cz\/[^"'\s<>)]+/gi) || [])].slice(0, 15);
      return json({ status: page.status, imgs });
    }
    const res = await fetch(`https://www.sauto.cz/api/v1/items/${norm.sautoId}`, {
      headers: { ...BROWSER_HEADERS, Accept: "application/json" },
    });
    return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  if (idMatch) {
    const id = Number(idMatch[1]);
    if (idMatch[2] && method === "POST") return refreshCar(env, id);
    if (!idMatch[2] && method === "PATCH") return updateCar(env, id, body);
    if (!idMatch[2] && method === "DELETE") {
      await (await db(env)).prepare("DELETE FROM cars WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
      try {
        return await handleApi(request, env, path);
      } catch (e) {
        return json({ error: e.message || "Server error" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
