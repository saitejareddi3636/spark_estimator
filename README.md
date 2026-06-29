# Spark Homes — Repair Estimator

A mobile-first, offline-capable PWA for acquisition agents to estimate repair costs
room-by-room during a property walkthrough — on a phone, in an empty house, on bad signal.

## What it does

- **Three thumb-reachable modes** (bottom tab bar): **Rooms** (the walkthrough), **Deal** (the
  verdict), **Summary** (review + export). A persistent header shows the live repair total and the
  GO/TIGHT/NO-GO deal verdict on every screen — "do the numbers work?" is always in view.
- **Walk the house room-by-room.** Rooms mode is a short list of the rooms in this project, each
  with its subtotal + progress; tap one to drill into just that room's groups. Interior/General,
  Systems, and Exterior are auto-created house singletons; Kitchen, Bathroom, Bedroom, and Living
  Area can be added and removed freely (seeded with one kitchen + one bathroom).
- **Groups collapsed by default; search across all 100+ items.** Each group header shows its item
  count + subtotal; tap to expand. The search box jumps to any item by name across every room.
- **Check items, set quantities, add notes and photos.** The whole item row is the tap target
  (≥44px); every line shows its unit cost and a live line total. The running repair total is
  always visible, and a per-group progress bar tracks how much of the walkthrough is done.
- **"No Action Needed" per group** — marks a group complete for progress without adding cost.
- **Per-photo capture & compression** — uses the device camera, compresses to JPEG before
  storing so localStorage doesn't blow its quota. Thumbnails with individual delete.
- **Custom line items & deletes** — add a line to any group; delete any item (reversible — it
  drops into a one-tap restore strip on the group).
- **Pricing overrides** — tap the ✎ on any item to set a project-specific unit price. Or import
  an updated CSV to change the *standard* pricing across every project (project overrides win).
- **Deal Analyzer** — enter ARV, target margin %, and holding/closing %; get the **max
  allowable bid**, and (with a purchase price) projected **profit**, **ROI**, and a
  **GO / TIGHT / NO-GO** verdict computed off the live repair total.
- **Serial-number OCR** — on HVAC / water-heater / appliance items, "Scan serial #" lazy-loads
  Tesseract.js, reads the data plate from the last photo, lets you confirm/edit, and saves it to
  the item note (and the export).
- **Export** — one tap produces a ZIP containing a styled Excel workbook (Cost Breakdown +
  Deal Summary tabs) and every photo, auto-downloaded.
- **Installable & offline** — manifest + icons are inlined; a service worker precaches the shell,
  data, and the two heavy libraries, so the whole app works with the network off after first load.

## Architecture (one model, zero special cases)

- A project holds `rooms: [{ id, type, name }]`. Item state is keyed `"<roomId>::<itemId>"`.
- `ROOM_TYPES` (in `data.js`) defines each room type's groups and each group's item IDs.
- **Every calculation — line, group, room, running total, progress — is one loop:**
  `rooms → groups → items`. No per-room-type branching anywhere. `groupItemIds()` is the single
  accessor for "which items are in this group of this room" (built-in + custom − deleted), and it
  is used identically by render, recalc, and export.
- Pricing flows through one accessor, `getCost()`: per-project override → custom line cost →
  global CSV override → `ITEMS[id].cost`.
- `data.js` is the single source of truth for prices and is never hand-edited; a runtime CSV
  import overrides it instead.

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell + hand-written CSS + all UI markup |
| `app.js` | The room engine: state, render, recalc, photos, deal analyzer, OCR, export |
| `data.js` | `ITEMS` + `ROOM_TYPES` — verified pricing data (single source of truth) |
| `sw.js` | ~50-line cache-first service worker (precache shell + data + 2 CDN libs) |

## Libraries

All via CDN, cached by the service worker for offline use:

- **[jszip](https://stuk.github.io/jszip/)** — bundles the Excel file + photos into the export ZIP.
- **[xlsx-js-style](https://github.com/gitbrent/xlsx-js-style)** — writes the styled `.xlsx`
  (brand-colored header, currency formats, the Deal Summary tab).
- **[tesseract.js](https://tesseract.projectnaptha.com/)** — loaded *on demand only* (not
  precached) for serial-number OCR, so the rest of the app stays small and works offline.

No build step, no framework, no CSS framework. Plain ES modules + hand-written CSS.

## Run it locally

ES modules and the service worker both require `http://` (they will not work from a `file://`
URL), so serve the folder over a local web server:

```bash
# any one of these, from the project root:
python3 -m http.server 8000
# or
npx serve .
```

Then open <http://localhost:8000> on your computer, or on your phone over the same network
(`http://<your-computer-ip>:8000`).

## Install on a phone (PWA)

- **Android (Chrome):** open the URL → menu → *Add to Home screen* (you may get an install prompt).
- **iOS (Safari):** open the URL → Share → *Add to Home Screen*. iOS installs are manual; once
  added it launches standalone (no browser chrome).

After the first load the app is fully usable offline. The serial-number OCR is the one feature
that needs a connection the first time it's used (it lazy-loads the OCR engine).

## Tests

A headless gate suite drives real Chrome over the DevTools Protocol (no Playwright install
needed) at a 390px phone viewport:

```bash
node tests/gate.mjs          # 15 automated gates
SHOTS=1 node tests/gate.mjs  # also write phone-width screenshots to tests/shots/
```

It covers the Stage-1 triage behaviors plus the room-first navigation (drill-down, collapsed
groups, search, whole-row toggle, project isolation, deal verdict, export). Three hardware gates
(camera, add-to-home-screen, offline-from-icon) are a manual checklist — see
[tests/MANUAL-GATES.md](tests/MANUAL-GATES.md).

## A note on tooling

This project was built with the help of Claude and Claude Code, which the contest explicitly
allows. Every architectural decision — the unified room engine, the `roomId::itemId` keying, the
`getCost()` precedence, and the Deal Analyzer math — is mine to explain and defend.
