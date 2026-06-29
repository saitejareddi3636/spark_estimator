# Gate suite — what's automated vs. manual

`node tests/gate.mjs` runs **15 automated gates** that drive real Chrome over the
DevTools Protocol at a 390px phone viewport (no Playwright install). They cover the
Stage-1 triage behaviors plus the room-first navigation:

1. Cold load renders the 5 seeded rooms as cards, $0 total, no JS error
2. Drill-down: tapping a room shows its groups + a Back control
3. Groups are collapsed by default (no 20-group wall of scroll)
4. Expanding a group reveals its item rows
5. Whole-row tap toggles the item and raises the running total
6. Editing qty does NOT toggle the row (stopPropagation)
7. Search filters across all items, with an empty state for no matches
8. "Mark no action" completes a group for progress
9. Add custom line item appears and counts toward the total
10. Delete an item, then restore it
11. Projects isolate their own selections (switching keeps each separate)
12. Per-project price override changes the line cost
13. Deal tab: GO/TIGHT/NO-GO verdict + the persistent header readout react to inputs
14. Summary tab exports a ZIP (the workbook includes the Deal Summary tab)
15. State persists across a reload (localStorage; survives an abrupt close)

Run with screenshots: `SHOTS=1 node tests/gate.mjs` → `tests/shots/`.

## 3 hardware gates — run by hand on a phone

These depend on real device hardware / install flow and can't be exercised headlessly.
Serve the app over http (`python3 -m http.server`) and open it on a phone:

- [ ] **Camera capture** — check an item, tap **📷 Photo**. The OS camera opens, and the
      captured photo appears as a thumbnail (and is removable). On equipment items, **🔎
      Scan serial #** reads the data plate and writes it to the note.
- [ ] **Add to Home Screen** — iOS Safari: Share → *Add to Home Screen*. Android Chrome:
      menu → *Add to Home screen*. The icon installs with the orange theme.
- [ ] **Offline from the icon** — turn the network off, launch from the installed icon. The
      app loads from the service-worker cache and a full walkthrough works offline. (OCR is
      the one feature that needs a connection the first time it's used.)
