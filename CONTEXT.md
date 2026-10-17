# Orbita — Project Context

## What this is
A personal contacts/relationship "people map": a Leaflet map of pinned contacts with tiers, tags, search, heatmap, analytics, a contact list drawer, and CSV / vCard / JSON import. Single page, no backend.

**Live:** https://orbita.aaronsiebertsio.workers.dev/ (Cloudflare, auto-deploys on push to `main` of github.com/eronsio/orbita)

## Stack
- One file: `index.html` (inline CSS + JS). No build step.
- Leaflet + markercluster + leaflet.heat, PapaParse (all CDN)
- Contacts live in the browser's `localStorage` (key `orbita-contacts`). **Nothing is stored server-side**, so each browser/profile has its own data. Use Tools → Export JSON for backups (the status pill warns when the last backup is old).

## PRIVACY RULE
The repo and site are **public**. Never commit contact data. `.gitignore` blocks `*.csv`, `*.vcf`, `orbita-contacts*.json`, `people-export*.json`, `_test*`. Test imports with a temporary `_test_*` file in the folder and delete it afterwards. Don't add a `people-export.json` seed file.

## How the data model works (all in the inline script)
- `normalizePerson()` is the single place contacts get cleaned (legacy `identifiers`/`profession`/`latitude` shapes are migrated, tags become arrays, tier is 1-3 or null).
- **Pins carry a `geoSource`** saying how exact they are, ranked in `GEO_RANK`:
  `country`/`phone`/`email-domain` (1) < `region` (2) < `area-code` (3) < `imported` (4) < `geocoded` (5) < `manual` (6).
  Merging only replaces a pin with a strictly more exact one. Approximate sources (`APPROX_SOURCES`) show a dashed marker ring and an "approximate" note in the panel.
- `inferLocation()` places contacts that only have a phone/email: US area code -> metro, Spanish landline prefix -> city, dial code -> country, ccTLD -> country. Spain's default point is Vigo (that's where most of this network lives).
- Imports go through `mergeContacts()` (dedupes on id / email / last 9 digits of phone / name when there's no email or phone), always non-destructive, with an Undo toast. Google Contacts CSV columns (`First Name`, `E-mail 1 - Value`, `Phone 1 - Value`, `Labels`, ...) are understood directly; generic `name/email/phone/lat/lng/tags` CSVs work too.
- Geocoding uses Nominatim, serialized to 1 request/second (`geocode()`); `locateMissing()` and the per-contact "Find from address" use it.
- Everything user-supplied is HTML-escaped via `esc()` before it goes into `innerHTML`.

## UI notes
- Left toolbar: only the Table icon (contact list) is wired. The other four icons are Miro-style placeholders.
- Map min zoom adapts to the window (`updateMinZoom`) so the map always fills the screen.
- Same-point clusters (many people known only by country) spiderfy into a spiral instead of zooming forever.

## History
Rescued 2026-07-09 from Google Drive (`Work/Business/Orbita/Prototype 1/HTMLS/Orbita_minimal.html`, last edited there 2025-09-10). Major cleanup 2026-10-17.
