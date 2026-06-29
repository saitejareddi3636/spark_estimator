# Spark Homes Repair Estimator — Writeup

It's a single-page PWA an agent runs room-by-room on their phone, in an empty house, on bad
signal. No build step, no server, no framework — just `index.html` and a few static files so it
loads fast and works fully offline once it's installed.

## The decision I'm happiest with: one model, no special cases

My first instinct was the obvious one — a bathroom screen, a kitchen screen, a systems screen,
each with its own logic. I started down that road and it got ugly fast. Every new room type meant
new branches, and the totals/progress code had to know about all of them. So I threw it out.

The version that shipped treats a project as a flat list of rooms — `{ id, type, name }` — and
moves all the per-room-type knowledge into data (`ROOM_TYPES`), not code. Item state is keyed by
instance, `"<roomId>::<itemId>"`, so "Bathroom 1" and "Bathroom 2" are just two rooms that happen
to share a type. The payoff: **every number in the app — line total, group subtotal, room
subtotal, the running total, and the progress bar — comes out of the same `rooms → groups → items`
loop.** There's no "if bathroom" anywhere. Pricing goes through one function, `getCost()`, with a
precedence I can recite: per-project override → custom line → global CSV → default. When the brief
mentioned decoupling Living/Common from Interior, that was a few lines of data, not a refactor.

That's the bet the whole thing rests on, and it held up.

## What's fragile (being honest)

- **It's all in localStorage, photos included.** I compress every photo to JPEG before saving and
  you can delete them one at a time, but a big walkthrough with a lot of photos can still crowd the
  ~5MB quota. It hasn't bitten me in testing, but it's the first thing I'd expect to break in the
  field. IndexedDB is the real fix and it's top of my next list.
- **Android photo capture is a known landmine.** The file input has to be in the DOM *before* you
  call `.click()` or Android just drops the photo silently. I handle it, but it's the kind of quirk
  that works until some OEM browser decides it doesn't.
- **OCR needs one online moment.** Serial-number scanning pulls Tesseract from a CDN the first time
  you use it, so on a truly cold offline device that one feature won't run until it's been loaded
  once. Everything else is genuinely offline.

## My creative addition: a Deal Analyzer

A repair total on its own doesn't answer the question the agent is actually standing there asking —
*do we make an offer or not?* So I added a Deal Analyzer: punch in ARV, your target margin, and
holding/closing %, and it works backward from the **live** repair total to a **max allowable bid**,
then shows projected profit, ROI, and a plain **GO / TIGHT / NO-GO** call that rides in the header
on every screen. I picked it because it's the one feature that turns this from a calculator into
something that actually makes the buy decision faster — which is the whole point of doing the
walkthrough. (The serial-number OCR is a smaller bonus on top: snap the data plate on a furnace or
water heater and the model/serial lands in the notes and the export without typing.)

## With two more days

1. **Move photos + state to IndexedDB** so the storage ceiling stops being a worry.
2. **Compare projects side by side** — export a few candidate houses in one shot and see the deals
   next to each other.
3. **Optional cloud sync** so whoever's at the desk sees the estimate the second the agent walks
   out of the house.

## How I used AI

I used Claude Code throughout, mostly as a fast pair — scaffolding the room engine, wiring up the
export, generating the verified pricing data from the CSV, and writing the headless test gates so I
could check the whole walkthrough on every change instead of poking at it by hand. It let me move
much faster and spend my time on the parts that matter: the data model, the `getCost()` precedence,
the Deal Analyzer math, and the mobile UX. Those calls are mine, and I can walk through any of them
in the interview. AI sped up the typing; the engineering decisions are the ones I'd defend.
