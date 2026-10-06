import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, parseHtml, mapSautoItem } from "../src/parse.js";
import { fetchListing } from "../src/worker.js";

test("sauto URLs dedupe on the listing id regardless of host, query or slug", () => {
  const a = normalizeUrl("https://www.sauto.cz/osobni/detail/skoda/octavia/201234567?goFrom=list");
  const b = normalizeUrl("sauto.cz/osobni/detail/skoda/octavia/201234567/");
  const c = normalizeUrl("https://m.sauto.cz/osobni/detail/skoda/octavia-combi/201234567#foto");
  assert.equal(a.key, "sauto:201234567");
  assert.equal(b.key, a.key);
  assert.equal(c.key, a.key);
  assert.equal(a.url, "https://www.sauto.cz/osobni/detail/skoda/octavia/201234567");
  assert.equal(a.sautoId, "201234567");
});

test("other URLs dedupe on host + path + query", () => {
  const a = normalizeUrl("https://WWW.example.com/car/1/?x=1#top");
  const b = normalizeUrl("http://example.com/car/1?x=1");
  assert.equal(a.key, b.key);
  assert.equal(a.sautoId, null);
  assert.throws(() => normalizeUrl(""));
  assert.throws(() => normalizeUrl("not a url with spaces"));
});

const sautoItem = {
  id: 201234567,
  name: "Škoda Octavia Combi 2.0 TDI Style",
  price: 389000,
  manufacturing_date: "2019-03-01T00:00:00Z",
  tachometer: 142500,
  fuel_cb: { name: "Nafta", value: 2 },
  gearbox_cb: { name: "Automatická", value: 2 },
  engine_power: 110,
  vehicle_body_cb: { name: "Kombi" },
  locality: { municipality: "Brno", district: "Brno-město", region: "Jihomoravský kraj" },
  premise: { name: "AAA Auto Brno" },
  images: [{ url: "//d48-a.sdn.cz/d_48/c_img_abc/xyz.jpeg" }],
};

test("maps a sauto item to board fields", () => {
  assert.deepEqual(mapSautoItem(sautoItem), {
    title: "Škoda Octavia Combi 2.0 TDI Style",
    price: 389000,
    year: 2019,
    mileage: 142500,
    fuel: "Nafta",
    transmission: "Automatická",
    power_kw: 110,
    body: "Kombi",
    location: "Brno, Brno-město",
    seller: "AAA Auto Brno",
    image: "https://d48-a.sdn.cz/d_48/c_img_abc/xyz.jpeg?fl=res,1024,768,1|jpg,80",
  });
});

test("parses embedded __NEXT_DATA__ state", () => {
  const html = `<html><head><title>Škoda Octavia | Sauto.cz</title></head><body>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { dehydratedState: { queries: [{ state: { data: { result: sautoItem } } }] } } } })}</script>
  </body></html>`;
  const r = parseHtml(html, "https://www.sauto.cz/osobni/detail/skoda/octavia/201234567");
  assert.equal(r.title, "Škoda Octavia Combi 2.0 TDI Style");
  assert.equal(r.mileage, 142500);
  assert.equal(r.year, 2019);
});

test("falls back to JSON-LD, meta tags and Czech visible text", () => {
  const html = `<html><head>
    <meta property="og:title" content="Volkswagen Golf 1.5 TSI - Sauto.cz">
    <meta property="og:image" content="https://img.example.com/golf.jpg">
    <script type="application/ld+json">{"@type":"Car","name":"Volkswagen Golf 1.5 TSI","offers":{"price":"299900"}}</script>
    </head><body>
    <div>Tachometr</div><div>98&nbsp;000 km</div>
    <div>Rok výroby</div><div>5/2020</div>
    <div>Palivo</div><div>Benzín</div>
    <div>Převodovka</div><div>Manuální</div>
    <div>Výkon</div><div>96 kW (131 k)</div>
  </body></html>`;
  const r = parseHtml(html, "https://www.sauto.cz/osobni/detail/vw/golf/209999999");
  assert.deepEqual(r, {
    title: "Volkswagen Golf 1.5 TSI",
    price: 299900,
    image: "https://img.example.com/golf.jpg",
    mileage: 98000,
    year: 2020,
    fuel: "Benzín",
    transmission: "Manuální",
    power_kw: 96,
  });
});

test("fetchListing uses the sauto API and falls back to the page", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    if (String(url).includes("/api/v1/items/")) {
      return new Response(JSON.stringify({ result: sautoItem }), { status: 200 });
    }
    return new Response("<html></html>", { status: 200 });
  });
  const { data, error } = await fetchListing(normalizeUrl("https://www.sauto.cz/osobni/detail/skoda/octavia/201234567"));
  assert.equal(error, null);
  assert.equal(data.price, 389000);
  assert.deepEqual(calls, ["https://www.sauto.cz/api/v1/items/201234567"]);

  calls.length = 0;
  t.mock.method(globalThis, "fetch", async () => new Response("blocked", { status: 403 }));
  const failed = await fetchListing(normalizeUrl("https://www.sauto.cz/osobni/detail/skoda/octavia/201234567"));
  assert.match(failed.error, /403/);
});
