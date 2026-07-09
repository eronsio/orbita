# Orbita — Project Context

## What this is
A personal contacts/relationship "people map" tool: a Leaflet map with pinned contacts, tiers, search/filter, heatmap, and CSV/Google Contacts import. Single-page, no backend.

## Stack
- Pure static HTML — one file: `index.html` (inline CSS + JS)
- Map: Leaflet + Leaflet.markercluster + Leaflet.heat + overlapping-marker-spiderfier (all via CDN)
- CSV parsing: PapaParse (CDN)
- No build step, no server, no secrets — data lives in the browser (localStorage) and is imported/exported via CSV

## Origin
Rescued from Google Drive (`Work/Business/Orbita/Prototype 1/HTMLS/Orbita_minimal.html`, last edited 2025-09-10) on 2026-07-09. That Drive folder had ~15 timestamped iterations plus a `Data/` folder with real contact exports (CSV/VCF) — those were intentionally left out of this repo since they contain personal PII. Ask Aaron if you need sample data to test the import feature.

## Running it
Just open `index.html` in a browser, or serve the folder with any static file server.
