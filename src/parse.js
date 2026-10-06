// Listing URL normalization and parsing. Pure functions (no Worker APIs) so
// they can be unit-tested under Node.

const SAUTO_ID_RE = /\/detail\/(?:[^/?#]+\/)*?(\d{5,})(?:[/?#]|$)/;

/** Returns { key, url, sautoId } — `key` is what we dedupe on. */
export function normalizeUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) throw new Error("Paste a listing URL");
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("That doesn't look like a URL");
  }
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
  if (host === "sauto.cz" || host.endsWith(".sauto.cz")) {
    const m = u.pathname.match(SAUTO_ID_RE);
    if (m) {
      return {
        key: `sauto:${m[1]}`,
        url: `https://www.sauto.cz${u.pathname.replace(/\/+$/, "")}`,
        sautoId: m[1],
      };
    }
  }
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const clean = `${u.protocol}//${host}${path}${u.search}`;
  return { key: clean.replace(/^https?:\/\//, ""), url: clean, sautoId: null };
}

const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = k.split(".").reduce((o, p) => (o == null ? o : o[p]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
};
const cbName = (v) => (v && typeof v === "object" ? v.name ?? v.value ?? null : v);
const toInt = (v) => {
  if (v == null) return null;
  if (typeof v === "number") return Math.round(v);
  const digits = String(v).replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : null;
};
const toYear = (v) => {
  if (v == null) return null;
  const m = String(v).match(/(19|20)\d{2}/);
  return m ? parseInt(m[0], 10) : null;
};
const absUrl = (src, base) => {
  if (!src) return null;
  if (src.startsWith("//")) src = "https:" + src;
  try {
    return new URL(src, base).toString();
  } catch {
    return null;
  }
};

/** Maps a sauto.cz item object (API or embedded page data) to our car fields. */
export function mapSautoItem(item, baseUrl = "https://www.sauto.cz/") {
  if (!item || typeof item !== "object") return {};
  const images = pick(item, "images", "photos") || [];
  let image = Array.isArray(images) && images.length
    ? typeof images[0] === "string" ? images[0] : pick(images[0], "url", "src")
    : pick(item, "image", "main_image.url");
  image = absUrl(image, baseUrl);
  // sdn.cz image URLs need a size hint, otherwise they return a tiny/blank image.
  if (image && /sdn\.cz/.test(image) && !image.includes("?")) image += "?fl=res,800,600,3|jpg,80";

  const loc = pick(item, "locality") || {};
  const location = typeof loc === "string" ? loc
    : [pick(loc, "municipality", "city", "citypart"), pick(loc, "district", "region")]
        .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ") || null;

  const title = pick(item, "name", "title") ||
    [cbName(pick(item, "manufacturer_cb")), cbName(pick(item, "model_cb")), pick(item, "additional_model_name")]
      .filter(Boolean).join(" ") || null;

  return clean({
    title,
    price: toInt(pick(item, "price", "price_with_vat", "price.value")),
    year: toYear(pick(item, "manufacturing_date", "manufacture_date", "in_operation_date", "manufacture_year", "year")),
    mileage: toInt(pick(item, "tachometer", "mileage")),
    fuel: cbName(pick(item, "fuel_cb", "fuel")),
    transmission: cbName(pick(item, "gearbox_cb", "gearbox", "transmission")),
    power_kw: toInt(pick(item, "engine_power", "power")),
    body: cbName(pick(item, "vehicle_body_cb", "body")),
    location,
    seller: pick(item, "premise.name", "seller.name", "user.name") || null,
    image,
  });
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined && v !== "") out[k] = v;
  return out;
}

/** Depth-first search for the first object that looks like a car listing. */
export function findListingObject(root) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (!Array.isArray(node) && "tachometer" in node && ("price" in node || "name" in node)) return node;
    for (const v of Object.values(node)) if (v && typeof v === "object") stack.push(v);
  }
  return null;
}

const decode = (s) => s
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&");

function metaContent(html, prop) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
  const m = html.match(re);
  return m ? decode(m[1] ?? m[2]) : null;
}

/** Parses any listing page HTML. Layers: embedded app data, JSON-LD, meta tags, visible text. */
export function parseHtml(html, pageUrl) {
  const result = {};
  const merge = (data) => { for (const [k, v] of Object.entries(data)) if (result[k] == null) result[k] = v; };

  // 1. Embedded app state (__NEXT_DATA__ and similar JSON blobs).
  for (const m of html.matchAll(/<script[^>]*(?:id=["']__NEXT_DATA__["']|type=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const obj = findListingObject(JSON.parse(m[1]));
      if (obj) merge(mapSautoItem(obj, pageUrl));
    } catch { /* ignore malformed blobs */ }
  }

  // 2. JSON-LD (schema.org Car / Product / Vehicle).
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const items = [].concat(data["@graph"] || data);
    for (const it of items) {
      const type = [].concat(it["@type"] || []).join(" ");
      if (!/Car|Vehicle|Product|Offer/i.test(type)) continue;
      const offers = [].concat(it.offers || [])[0] || {};
      merge(clean({
        title: it.name,
        price: toInt(offers.price ?? it.price),
        year: toYear(it.vehicleModelDate || it.productionDate || it.modelDate || it.dateVehicleFirstRegistered),
        mileage: toInt(it.mileageFromOdometer?.value ?? it.mileageFromOdometer),
        fuel: it.fuelType || it.vehicleEngine?.fuelType,
        transmission: it.vehicleTransmission,
        body: it.bodyType,
        image: absUrl([].concat(it.image || [])[0]?.url ?? [].concat(it.image || [])[0], pageUrl),
      }));
    }
  }

  // 3. OpenGraph / meta tags.
  merge(clean({
    title: metaContent(html, "og:title") || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] && decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)[1]).trim()),
    image: absUrl(metaContent(html, "og:image"), pageUrl),
  }));

  // 4. Visible text with Czech labels (sauto.cz / bazos / tipcars style).
  const text = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  const grab = (re) => text.match(re)?.[1]?.trim() || null;
  merge(clean({
    mileage: toInt(grab(/Tachometr:?\s*([\d\s.]+)\s*km/i)),
    year: toYear(grab(/(?:Rok výroby|Vyrobeno|V provozu od):?\s*([\d./ ]{4,10})/i)),
    fuel: grab(/Palivo:?\s*(Benzín|Nafta|Diesel|Elektro|Hybridní|Hybrid|LPG(?: \+ benzín)?|CNG(?: \+ benzín)?|Plug-in hybrid)/i),
    transmission: grab(/Převodovka:?\s*(Manuální|Automatická|Automat|Poloautomatická)/i),
    power_kw: toInt(grab(/Výkon:?\s*(\d{2,3})\s*kW/i)),
    price: toInt(grab(/(?:Cena|Kč)\s*:?\s*([\d\s]{4,12})\s*Kč/i)),
  }));

  if (result.title) result.title = result.title.replace(/\s*[|–-]\s*(Sauto\.cz|sauto).*$/i, "").trim();
  return result;
}
