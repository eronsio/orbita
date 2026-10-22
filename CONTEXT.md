# Orbita — Project Context

## What this is
A personal contacts/relationship "people map": a Leaflet map of pinned contacts with tiers, tags, search, heatmap, analytics, a contact list with bulk actions, duplicate finder, and CSV / vCard / JSON import and export. Single page, no backend.

**Live:** https://orbita.aaronsiebertsio.workers.dev/ (Cloudflare, auto-deploys on push to `main` of github.com/eronsio/orbita)

## Stack
- One file: `index.html` (inline CSS + JS). No build step.
- Leaflet + markercluster + leaflet.heat, PapaParse (all CDN)
- Contacts live in the browser's `localStorage` (key `orbita-contacts`). **Nothing is stored server-side**, so each browser/profile has its own data. Tools -> Export JSON / Export CSV are the backups (or turn on accounts, see below) (the status pill warns when the last one is old).

## PRIVACY RULE
The repo and site are **public**. Never commit contact data, and never use real names/emails/phone numbers from Aaron's contacts in tests or comments either (use `@example.com`, `555` numbers, invented names). `.gitignore` blocks `*.csv`, `*.vcf`, `orbita-contacts*.json`, `people-export*.json`, `_test*`. To test an import in the browser, copy a file in as `_test_*`, then delete it. Before committing, grep tracked files for real names/emails.

## Tests
`node tests/unit.test.js` — pure-logic tests (parsing, location inference, merging, duplicates, CSV safety). It extracts the inline script from `index.html`, so it needs the `class Orbita {...}` block to stay followed by the `document.addEventListener('DOMContentLoaded'` block. UI behaviour is verified by hand in the browser (`preview_start orbita-server`, then real clicks). **Check coordinates, not just labels, in tests: a label-only test once hid a merge bug.**

## How the data model works (all in the inline script)
- `normalizePerson()` is the single place contacts get cleaned (legacy `identifiers`/`profession`/`latitude` shapes are migrated, tags become arrays, tier is 1-3 or null, alternates never repeat the primary).
- **Pins carry a `geoSource`** saying how exact they are, ranked in `GEO_RANK`:
  `country`/`phone`/`email-domain` (1) < `region` (2) < `area-code` (3) < `imported` (4) < `geocoded` (5) < `manual` (6).
  Merging only replaces a pin with a strictly more exact one. Approximate sources (`APPROX_SOURCES`) get a dashed marker ring and an "approximate" note in the panel. Old exports have no source: a pin exactly on a country centre is labelled `country`, any other `imported`.
- `inferLocation()` places contacts that only have a phone/email: US area code -> metro, Spanish landline prefix -> city, dial code -> country, ccTLD -> country. Spain's default point is Vigo (that's where most of this network lives).
- Imports go through `mergeContacts()` (dedupes on id / email / last 9 digits of phone / name when there's no email or phone). Always non-destructive, always with an Undo toast. Google Contacts CSV columns are understood directly, and so are our own exports (the `geosource` column round-trips).
- `findDuplicateCandidates()` (same email/phone, same name, or same first name with complementary details and no conflicts). Merging goes through `withUndo()`. Dismissed pairs are remembered in `orbita-dupe-ignore`.
- Geocoding uses Nominatim, serialized to 1 request/second (`geocode()`).
- Everything user-supplied is HTML-escaped via `esc()` before it goes into `innerHTML`; CSV export neutralises spreadsheet formulas (`csvSafe`).

## Accounts + cloud sync (dormant until configured)
Optional Supabase sign-in with the whole contact list saved as one JSON row per user (`supabase/orbita_setup.sql`, row-level security). Setup steps are in `supabase/README.md`. It stays completely off (no UI, no requests) until `CLOUD = { url, anonKey }` near the top of the script is filled in. No SDK: plain `fetch` against GoTrue + PostgREST, like the student portal.
- localStorage stays the working copy; every `saveToStorage()` marks it dirty and a debounced `syncNow()` pushes it. `saveToStorage({ fromCloud: true })` is for writes that came *from* the cloud (so they don't loop).
- Concurrency is optimistic: the row has a `version`; a PATCH only succeeds if the version is unchanged, otherwise we re-fetch and merge. `orbita-sync` holds `{userId, version, at, dirty}`; `orbita-sync-base` holds the list both sides last agreed on.
- `threeWayMerge(base, local, remote)` (pure, unit-tested) keeps whichever side changed a field, this device wins a true tie, tags are unioned, pins move as one unit, deletes win unless the other side edited that contact.
- **Shared-browser safety:** if cached contacts belong to a different account than the one signing in, they are dropped, never uploaded. Sign-out offers to clear the device (only when everything is synced).
- Emailed links (confirm / reset) return as `#access_token=...&type=...`; `handleAuthRedirect()` consumes them (also on `hashchange`) and strips the token from the URL.
- Test locally with `node tests/mock-supabase.js` and `?supabase=http://localhost:54321&key=test` (localhost only; `127.0.0.1` is a second device). `MOCK_CONFIRM=1` requires email confirmation.

## Map behaviour and gotchas
- **The map only zooms when you ask it to.** Clicking a cluster **fans its contacts out around it** (the *bloom*: `openBloom`, `closeBloom`, `positionBloom`, pure helpers `bloomLayout`/`bloomFit` above `sortPeople`); the map doesn't move. Hovering a cluster with a mouse (380 ms) previews the list in the *cluster card* (`peekCluster`, `cardMode` 'hover' vs 'sticky'); the bloom's bar has **List** (card) and **Zoom in here**. Picking a contact only opens its panel and shows a selection ring (`updateSelection`, plus `.sel` on the pin inside an open fan), and `openContact` pans (never zooms) and only if the pin is out of view. "Zoom to pin" in the panel and "Fit to pins" are the other explicit zooms. There is **no spiderfy**: contacts sharing one coordinate (people known only by country) stay clustered, and the bloom/card is how you reach them.
- **Bloom details:** ring layout for up to 8 contacts, a sunflower (Vogel) spiral beyond that, closest friends (tier 1) nearest the hub, capped at `BLOOM.max` (80) or whatever fits the map, with a "+N" slot that opens the list. It is a plain DOM overlay inside the Leaflet container (not markers): the field is translated on every map `move` so it stays glued to its cluster while panning, it slides away from edges/the left toolbar/the open contact panel (the hub stays on the cluster), it folds away on `zoomstart`, `updateMap`, heatmap, Esc or a map click, and on phones picking a contact folds it (the bottom sheet would cover it). Leader lines are always drawn for ring-sized fans, and only for the hovered/selected pin in big ones (64 lines is a starburst). Open it with a forced reflow, not `requestAnimationFrame` (rAF never fires in a hidden tab). `L.DomEvent.disableClickPropagation(root)` stops clicks reaching the map.
- **Smooth zoom:** `L.Map.SmoothWheelZoom` (defined above the `Orbita` class) replaces Leaflet's stepped wheel zoom with a continuous eased zoom that keeps the point under the cursor fixed, via the same internals Leaflet's pinch zoom uses (`_moveStart/_move/_moveEnd`). It needs `zoomSnap: 0` and `scrollWheelZoom: false`. Cluster animations are off (`animate: false`) because they made zooming feel like swimming. Anything that must follow the map during a smooth zoom has to listen to `move`, not `zoomanim` (see the heat canvas).
- **Pins** are `.pin` divIcons: avatar circle, tier-coloured border + digit badge, dashed when the location is approximate, a hover card (`pinTipHtml`, desktop only), a selection ring when open. Clusters are `.cluster-bubble` rings showing the tier mix.
- **Heatmap:** pins are hidden while it's on (they used to cover it). leaflet.heat's `maxZoom` option scales intensity by 2^(maxZoom - zoom), so it must stay at 1; the old `maxZoom: 18` made every contact ~1/4000th as strong at world zoom, which is why the heat used to look like a faint haze over empty sea. Radius follows zoom, `max` follows contact count, approximate pins count half, and `scheduleHeatReset` re-aligns the canvas on every `move`. Verify heat by sampling canvas pixels (alpha > 0 at contacts, 0 over empty ocean).
- **Don't rebuild markers for a single-contact edit.** `syncPerson()` updates one marker in place; `updateMap()` rebuilds everything (and closes the cluster card). Use `updateMap()` only after filters/imports/bulk edits.
- **Basemap:** Esri's World Light Gray canvas (base + `World_Light_Gray_Reference` labels layer, `maxNativeZoom: 16`): English place names, calm look, **no API key**. It is a free legacy service, so `initMap` falls back to OpenStreetMap if the first 4 tiles error with none loaded. Labels layer has class `map-labels` (dimmed in dark mode, where the tile pane is inverted by CSS). Basemaps that need a key (CARTO, MapTiler, Stadia) are not used.
- Min zoom adapts to the window (`updateMinZoom`) so the map always fills the screen.

## Last contacted + catch-up
Each contact has an optional `lastContacted` (`YYYY-MM-DD`). Tiered contacts are "due" after 30 / 90 / 180 days (Close friends / Friends / Acquaintances, `CATCH_UP_DAYS`); a tiered contact you've never logged counts as due; untiered contacts are never due. Surfaces: the "Contacted today" button and "Last contact" row in the panel, the **Needs a catch-up** filter (with a live count), a "catch up" flag in the list, the "Longest since contact" sort, a bulk "Contacted today", the analytics card, and a `lastcontacted` CSV column. The pure helpers (`daysSince`, `needsCatchUp`, `agoLabel`) take a `now` argument so tests can pin the date.

## Theme
Auto / Light / Dark (Tools -> Theme), remembered in `orbita-theme`. A tiny inline script in `<head>` sets `data-theme` before first paint so there's no light flash. Dark is the `:root[data-theme="dark"]` block at the end of the stylesheet: it swaps the colour variables, inverts the OSM tiles with a CSS filter, and overrides the handful of rules that hardcoded white. When adding new CSS, use the variables (`--bg`, `--bg-light`, `--text`, `--border`...) rather than literal colours, or add a dark override.

## UI notes
- Left toolbar: Pointer and the Table icon (contact list) work; Text/Shapes/Pen are disabled placeholders.
- List drawer: Select mode gives bulk tier / add-remove tag / delete (shift-click selects a range).
- "Place unpinned" walks through contacts with no pin; click the map for each (Skip / Done / Esc).
- Panel: tier buttons, double-click any value to edit, "Move pin", "Find from address".
- Modals trap focus and restore it on close; Escape closes the topmost thing.

## History
Rescued 2026-07-09 from Google Drive (`Work/Business/Orbita/Prototype 1/HTMLS/Orbita_minimal.html`, last edited there 2025-09-10). Major cleanup 2026-10-17 (round 1: import, accuracy, security; round 2: bulk actions, placement queue, duplicates, CSV export, tests, accessibility).

## Birthdays
`birthday` is `YYYY-MM-DD`, or `--MM-DD` when the year is unknown (Google exports placeholder years like 0000/1604 for that; `parseBirthday` turns them into no-year). Pure helpers `parseBirthday`, `nextBirthday(p, now)`, `bdaySoon`, `birthdayLabel` take a `now` so tests can pin the date. Surfaces: panel row (click to edit; typed as `1990-05-21` or `05-21`), add/edit form field, Tools -> "Birthdays soon (N)" filter (next 30 days), list sort "Next birthday", a 🎂 flag in the list (next 7 days), a once-a-day toast on load (`orbita-bday-seen`), CSV/vCard import (`Birthday` column, `BDAY`) and a `birthday` CSV export column. It rides along in sync because the three-way merge is field-generic.

## Tour, feedback, help, install
- **Tour:** `TOUR_STEPS` + `startTour/renderTour/endTour`; auto-starts once (`orbita-tour-done`) when there are contacts and no modal/welcome is up (also after loading sample data); replay from Tools -> Help. The highlight is a CSS outline (no layout effect).
- **Feedback:** Tools -> Help -> Send feedback (only shown when cloud is configured). Inserts into `orbita_feedback` (see `supabase/orbita_setup.sql`): anyone can insert, nobody can read through the API; the owner reads rows in the Supabase Table Editor. Contacts are never included.
- **Sample data:** sample contacts carry the tag `Sample`; Tools -> Help -> "Remove sample contacts" deletes just those (undoable).
- **Install / offline (PWA):** `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` (all at the repo root; Cloudflare serves them). `sw.js`: page is network-first (a deploy is never hidden behind a stale copy), libs and tiles are stale-while-revalidate (tiles capped at 500, fetched with CORS so they aren't opaque), and anything on `supabase.co` is never touched. Registered from `initPwa()` on https/localhost. Verified offline by stopping the server and reloading. The Install button uses `beforeinstallprompt` where it exists, else shows instructions (iOS: Share -> Add to Home Screen). Bump the cache names in `sw.js` if you ever change what it caches.
