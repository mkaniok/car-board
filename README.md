# Car Board

A shared board for used-car listings. Paste a listing URL (mostly sauto.cz), and the board:

- checks whether that car is already on the board (sauto links match on the listing id, so different slugs, `m.` hosts or tracking parameters still count as the same car) and highlights the existing card instead of adding a copy;
- reads the listing and shows the key facts: photo, title, price, year, mileage, fuel, transmission, power, body, location and seller;
- lets you tick **Contacted** per car, keep a short note, and filter by contacted / not contacted;
- lets you **Hide** cars you are done with (they move to the Hidden filter, where you can unhide them); pasting a hidden car's link asks whether to unhide it;
- lets you order cars by preference, by dragging the ☰ handle or with the ▲▼ buttons on each card; the order is saved for everyone;
- lets you temporarily sort by price, km or year; "My order" is the default and sorting never changes it.

There is no login: anyone with the link can view and edit.

## Stack

One Cloudflare Worker (free plan) serves the page from `public/` and a small JSON API from `src/worker.js`. Cars are stored in Cloudflare D1 (SQLite); the table is created automatically on first request. The Worker fetches the listing server-side: for sauto.cz it asks sauto's item API first, then falls back to reading the page (embedded page data, JSON-LD, meta tags and Czech labels such as *Tachometr* or *Výkon*). Other sites get the generic fallback. If something can't be read, the card says so and **Edit** lets you fill it in by hand; **Refresh** re-reads the listing.

## Deploy (one time, about 5 minutes)

You need a free Cloudflare account and Node.js 18+.

```sh
npm install
npx wrangler login                 # opens the browser to sign in to Cloudflare
npx wrangler d1 create car-board   # prints a database_id
```

Paste the printed `database_id` into `wrangler.toml` (keep `binding = "DB"`), then:

```sh
npx wrangler deploy
```

Wrangler prints the public URL, e.g. `https://car-board.<your-subdomain>.workers.dev`. That's the board.

To redeploy after changes, run `npx wrangler deploy` again. (Optionally, connect the GitHub repo under *Workers & Pages → car-board → Settings → Build* in the Cloudflare dashboard so every push to `main` deploys automatically.)

## Develop

```sh
npm install
npm run dev     # http://localhost:8787 with a local D1 database
npm test        # parser and URL-normalisation tests
```

## API

| Method | Path | |
|---|---|---|
| GET | `/api/cars` | all cars in board order |
| POST | `/api/cars` `{url}` | add; `409 {duplicate:true, car}` if already present |
| GET | `/api/check?url=` | `{exists, car}` without adding |
| PATCH | `/api/cars/:id` | update `contacted`, `notes` or any detail field |
| POST | `/api/cars/:id/refresh` | re-read the listing |
| DELETE | `/api/cars/:id` | delete permanently (not used by the page) |
| PUT | `/api/order` `{ids}` | save the board order |
