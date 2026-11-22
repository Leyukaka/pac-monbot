# pac: live dashboard for NIBE heat pumps (myUplink)

A self-hosted, real-time dashboard for **NIBE heat pumps** connected to **myUplink**.

![Dashboard](docs/dashboard.png)

It shows:
- an installation schematic (outdoor unit, indoor module, water circuits). It is animated in proportion to the compressor frequency and switches to a reversed cycle during defrost;
- the refrigerant cycle: suction and discharge temperatures, superheat and subcooling;
- flow and return temperatures against the heating curve, degree-minutes and the electric backup heater;
- electrical power, heat produced, COP and a 14-day energy balance from the NIBE energy log;
- charts with a draggable time brush (6 h, 24 h, 7 d, 30 d, all), plus a 30-day outdoor temperature band.

| Schematic while running (`?demo=64`) | Phone, defrost (`?demo=defrost`) |
|---|---|
| ![Schematic](docs/schematic.png) | ![Phone](docs/mobile.png) |

The page has no front-end dependencies: plain HTML, CSS and hand-drawn SVG, with local fonts and a strict CSP. The **free myUplink plan is enough**, because the history is built by the collector itself.

You can run it in two ways, both using the same `src/worker.js`:
- on **Cloudflare** (Workers + D1 + cron trigger), see option A;
- on **any VM or server** (Node ≥ 22.5 with built-in SQLite, or Docker / Podman), see option B.

> **Compatibility.** The point IDs (`TRACKED` in `src/worker.js`, `ID` at the top of `site/app.js`) were checked on a **NIBE VVM 500 indoor module with an EB101 outdoor unit** (F2120). Other NIBE models (S-series, F-series, SMO) expose most of the same points, but some numbers may differ. The `points` table stores every point your system reports, so compare against it and adjust the two lists if a value stays empty.
>
> The user interface is in French for now. Labels are in `site/index.html` and `site/app.js`.

## 1. myUplink access (both options)

1. Create an application at https://dev.myuplink.com/apps (client credentials). The callback URL can stay empty.
2. Keep the **Client ID** and **Client Secret** out of git:
   - on Cloudflare, store them as Wrangler secrets;
   - on a VM, put them in a `.env` file, which is already git-ignored.

The collector only uses the `READSYSTEM` scope, which is read-only. It makes about 3 requests every 5 minutes, well under the myUplink quota of 25 requests per minute.

## A. Deploy on Cloudflare

```sh
cp wrangler.example.jsonc wrangler.jsonc        # then set your hostname
npx wrangler d1 create pac                      # paste the database ID into wrangler.jsonc
npx wrangler d1 migrations apply pac --remote
npx wrangler secret put MYUPLINK_CLIENT_ID
npx wrangler secret put MYUPLINK_CLIENT_SECRET
npx wrangler deploy
```

The first data point arrives within 5 minutes.

### Protect it with Cloudflare Access (recommended)

In the Cloudflare dashboard, go to **Zero Trust → Access controls → Applications → Create new application → Self-hosted**:
- **Destination:** your hostname. Leave the path empty so `/api/*` is covered too.
- **Policy:** Allow, `Emails` equal to your address.
- **Login method:** One-time PIN, a code sent by email. It is built in, so there is no OAuth app to create. Google or GitHub also work.

Keep `workers_dev: false`, otherwise the `*.workers.dev` URL would bypass Access. Once the site is protected, you can add `"vars": { "SHOW_HOUSE": "1" }` to show the house phase currents (BE1 to BE3).

## B. Run on a VM or server

With Node ≥ 22.5 (no `npm install` needed):

```sh
cp .env.example .env      # fill in MYUPLINK_CLIENT_ID / SECRET
npm start                 # http://127.0.0.1:8787, data in ./data/pac.db
```

With Docker or Podman:

```sh
cp .env.example .env
docker compose up -d      # or: podman compose up -d
```

`server/node.mjs` provides what Cloudflare would:
- it applies the migrations at startup;
- it collects every 5 minutes (`POLL_MINUTES`; `0` disables collection);
- it serves `site/` with the headers from `site/_headers`;
- it caches API responses for 60 seconds.

There is **no built-in login**, and the server listens on `127.0.0.1` only. To reach it from outside, use one of:
- `cloudflared tunnel` with Cloudflare Access;
- a reverse proxy with authentication (Caddy, nginx);
- your VPN or Tailscale only.

## API (GET only)

| Route | Returns |
|---|---|
| `/api/now` | Latest values, 7-day counters, active alarms (severity and title), collector status |
| `/api/series?range=24h\|7d\|30d\|30dd\|365d\|all&pids=…`, or `from=&to=` (UTC seconds) | Aggregated series, about 400 points per series at most, 12 series at most |
| `/api/health` | Last 12 collections, myUplink history-route probe |

## Security

- No secrets live in the code. The myUplink token is cached in the database and never returned by the API.
- The API does not expose the full point list or the system and device IDs. House phase currents stay hidden unless `SHOW_HOUSE=1`, because they reveal when people are home.
- On Cloudflare, each IP is limited to 60 requests per minute. A myUplink 429 pauses collection according to `RateLimit-Reset`.
- The page uses a strict CSP (`site/_headers`), with no third-party scripts, fonts or CDNs.
- Long ranges read hourly aggregates from `readings_h` instead of the raw readings.

## Notes

- Add `?demo=30|64|110|defrost` to the URL to preview the animated schematic when the compressor is idle. It changes the display only.
- Energy figures come from the NIBE energy log: point 32486 for instantaneous power, 3249x for last-hour totals. Without them, the fallback estimate is 40 W per Hz.
- On the free myUplink plan, the history route returns 403, so past data cannot be imported without Premium.
- This project is not affiliated with NIBE or myUplink.

MIT licence.
