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

## Map gotchas (learned the hard way)
- **Don't rebuild markers for a single-contact edit.** `syncPerson()` updates one marker in place; `updateMap()` rebuilds everything and collapses any fanned-out cluster. Use `updateMap()` only after filters/imports/bulk edits.
- **markercluster moves fanned-out markers.** While a cluster is spiderfied, `marker.getLatLng()` returns the spiral position, and any `setLatLng` (even to the same spot) makes the group remove and re-add the marker, collapsing the fan. So `syncPerson` compares against `marker.orbitaPos` (the real position) and only calls `setLatLng` when it really changed.
- No `disableClusteringAtZoom`: contacts sharing one coordinate must stay clustered so they can be spiderfied apart (the cluster click handler fans them out; it handles "already centred" and "tiny pan" cases without relying on `moveend`).
- A divIcon element is reused by `setIcon`, so the hover `title` is refreshed by hand.
- Min zoom adapts to the window (`updateMinZoom`) so the map always fills the screen.

## UI notes
- Left toolbar: Pointer and the Table icon (contact list) work; Text/Shapes/Pen are disabled placeholders.
- List drawer: Select mode gives bulk tier / add-remove tag / delete (shift-click selects a range).
- "Place unpinned" walks through contacts with no pin; click the map for each (Skip / Done / Esc).
- Panel: tier buttons, double-click any value to edit, "Move pin", "Find from address".
- Modals trap focus and restore it on close; Escape closes the topmost thing.

## History
Rescued 2026-07-09 from Google Drive (`Work/Business/Orbita/Prototype 1/HTMLS/Orbita_minimal.html`, last edited there 2025-09-10). Major cleanup 2026-10-17 (round 1: import, accuracy, security; round 2: bulk actions, placement queue, duplicates, CSV export, tests, accessibility).
