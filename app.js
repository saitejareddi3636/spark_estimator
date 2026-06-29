// app.js — Spark Homes Repair Estimator
// One unified room engine. Every room is {id, type, name}; item state is keyed
// "roomId::itemId". Every calculation walks rooms -> groups -> items with that
// key scheme — no per-type branches anywhere.

import { ITEMS, ROOM_TYPES } from './data.js';

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */
const LS_KEY = 'spark.estimator.v1';
const NON_SINGLETON = ['kitchen', 'bathroom', 'bedroom', 'living'];

/** @type {{projects: Array, activeId: string|null, globalPricing: Object}} */
let db = load();

/** Live repair grand total, refreshed by recalc(); read by the Deal Analyzer. */
let currentGrand = 0;

/** Ephemeral presentation state (NOT persisted; not part of the data model).
 *  `expanded` holds "<roomId>::<groupKey>" for groups the user has opened, so a
 *  re-render (add/delete a line, etc.) keeps them where they were. */
const ui = { tab: 'rooms', openRoomId: null, query: '', expanded: new Set() };

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { console.warn('load failed', e); }
  return { projects: [], activeId: null, globalPricing: {} };
}

let saveTimer = null;
function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(db));
  } catch (e) {
    console.error('save failed', e);
    toast('Storage full — remove some photos.');
  }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 250);
}
/** Flush any pending debounced save before the app is hidden/closed, so a tap
 *  is never lost if the agent backgrounds the app within 250ms. */
function flushSave() { if (saveTimer) writeNow(); }

/* ------------------------------------------------------------------ *
 * Model helpers
 * ------------------------------------------------------------------ */
const uid = (p) => p + Math.random().toString(36).slice(2, 8);
const roomTypeDef = (type) => ROOM_TYPES.find((t) => t.type === type);
const key = (roomId, itemId) => `${roomId}::${itemId}`;
const nanKey = (roomId, groupKey) => `${roomId}::g:${groupKey}::nan`;

function activeProject() {
  return db.projects.find((p) => p.id === db.activeId) || null;
}

/** Equipment items that carry a serial / data plate worth OCR-scanning. */
const EQUIP_RE = /furnace|condens|package unit|a-coil|window unit|water heater|microwave|hood|\brange\b|\boven\b|cooktop|dishwasher|fridge|refriger|disposal|tankless|boiler/i;
function isEquipment(project, itemId) {
  return EQUIP_RE.test(itemDef(project, itemId).name);
}

/** Resolve an item's definition — built-in or this project's custom line. */
function itemDef(project, itemId) {
  return ITEMS[itemId] ||
    (project.customItems && project.customItems[itemId]) ||
    { name: '(removed item)', unit: '', cost: 0 };
}

/** Pricing precedence: per-project override -> custom def -> global override -> base cost. */
function getCost(project, itemId) {
  if (project.priceOverrides && project.priceOverrides[itemId] != null) return project.priceOverrides[itemId];
  const custom = project.customItems && project.customItems[itemId];
  if (custom) return custom.cost;
  if (db.globalPricing && db.globalPricing[itemId] != null) return db.globalPricing[itemId];
  return ITEMS[itemId].cost;
}

/** Custom line ids the user added to a specific group of a specific room. */
function customIdsFor(project, roomId, groupKey) {
  const out = [], cm = project.customItems || {};
  for (const id in cm) if (cm[id].roomId === roomId && cm[id].group === groupKey) out.push(id);
  return out;
}

/** The visible items of a group for a room: built-in + custom, minus hidden.
 *  Single source of truth used by render, recalc, and export alike. */
function groupItemIds(project, room, group) {
  const hidden = project.hidden || {};
  return [...group.items, ...customIdsFor(project, room.id, group.key)]
    .filter((id) => !hidden[key(room.id, id)]);
}

/** Items hidden/deleted from a group (offered for one-tap restore). */
function hiddenItemIds(project, room, group) {
  const hidden = project.hidden || {};
  return [...group.items, ...customIdsFor(project, room.id, group.key)]
    .filter((id) => hidden[key(room.id, id)]);
}

/** Add a custom line item to a group; checked by default so it counts immediately. */
function addCustomItem(project, room, group) {
  const name = prompt('Custom line item — name');
  if (name === null) return;
  if (!name.trim()) { toast('Name is required'); return; }
  const unit = (prompt('Unit (e.g. ea., sqft, flat)', 'ea.') || 'ea.').trim() || 'ea.';
  const costStr = prompt('Unit cost ($)', '0');
  if (costStr === null) return;
  const cost = parsePrice(costStr);
  if (cost == null || cost < 0) { toast('Enter a valid cost'); return; }
  if (!project.customItems) project.customItems = {};
  const id = uid('c_');
  project.customItems[id] = { name: name.trim(), unit, cost, roomId: room.id, group: group.key };
  ensureItemState(project, room.id, id).checked = true;
  save();
  render();
  toast('Custom line added');
}

/** Delete an item from a group (reversible: it moves to the group's restore strip). */
function deleteItem(project, roomId, itemId) {
  if (!project.hidden) project.hidden = {};
  project.hidden[key(roomId, itemId)] = true;
  save();
  render();
  toast('Item removed');
}

/** Per-project price override: prompt to set or clear a custom unit cost. */
function editPrice(project, itemId, refresh) {
  if (!project.priceOverrides) project.priceOverrides = {};
  const base = ITEMS[itemId].cost;
  const cur = project.priceOverrides[itemId];
  const msg = `Unit price — ${ITEMS[itemId].name}\n` +
    `Standard: ${money(base)} / ${ITEMS[itemId].unit}` +
    (cur != null ? `\nThis project: ${money(cur)}` : '') +
    `\n\nEnter a price for THIS project, or leave blank to reset to standard.`;
  const input = prompt(msg, cur != null ? String(cur) : String(base));
  if (input === null) return; // cancelled
  const trimmed = input.trim();
  if (trimmed === '') {
    delete project.priceOverrides[itemId];
    toast('Price reset to standard');
  } else {
    const v = parsePrice(trimmed);
    if (v == null || v < 0) { toast('Enter a valid price'); return; }
    project.priceOverrides[itemId] = v;
    toast('Price override saved');
  }
  save();
  if (refresh) refresh();
  recalc();
}

/* ------------------------------------------------------------------ *
 * Pricing CSV import — updates the GLOBAL standard pricing for every
 * project (project-level overrides still win). Matches rows to items by
 * item id or by normalized item name, so it works whether the new CSV
 * carries our ids or just the official names + prices.
 * ------------------------------------------------------------------ */
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');

function parsePrice(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const v = parseFloat(cleaned);
  return isFinite(v) ? v : null;
}

/** Minimal RFC-4180-ish CSV parser (handles quotes + embedded commas/newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function importPricingCsv(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseCsv(String(reader.result));
      if (!rows.length) { toast('That CSV looks empty'); return; }
      if (!db.globalPricing) db.globalPricing = {};

      // lookup: normalized id and normalized name -> item id
      const byKey = {};
      for (const id in ITEMS) { byKey[norm(id)] = id; byKey[norm(ITEMS[id].name)] = id; }

      // header detection
      const head = rows[0].map(norm);
      const hasHeader = head.some((h) => /(item|name|description|cost|price|amount|rate)/.test(h));
      let idCol = -1, nameCol = -1, costCol = -1;
      if (hasHeader) {
        head.forEach((h, i) => {
          if (idCol < 0 && /(^id$|code|sku)/.test(h)) idCol = i;
          if (nameCol < 0 && /(item|name|description)/.test(h)) nameCol = i;
          if (costCol < 0 && /(cost|price|amount|rate)/.test(h)) costCol = i;
        });
      }
      const start = hasHeader ? 1 : 0;

      let applied = 0, missed = 0;
      for (let r = start; r < rows.length; r++) {
        const cells = rows[r];
        let id = null;
        if (idCol >= 0) id = byKey[norm(cells[idCol])] || null;
        if (!id && nameCol >= 0) id = byKey[norm(cells[nameCol])] || null;
        if (!id) for (const cell of cells) { if (byKey[norm(cell)]) { id = byKey[norm(cell)]; break; } }
        if (!id) { missed++; continue; }

        let cost = costCol >= 0 ? parsePrice(cells[costCol]) : null;
        if (cost == null) for (let k = cells.length - 1; k >= 0; k--) { const v = parsePrice(cells[k]); if (v != null) { cost = v; break; } }
        if (cost == null) { missed++; continue; }

        db.globalPricing[id] = cost;
        applied++;
      }

      save();
      render();
      toast(`Updated ${applied} price${applied === 1 ? '' : 's'}` + (missed ? ` · ${missed} unmatched` : ''));
    } catch (e) {
      console.error(e);
      toast('Could not read that CSV');
    }
  };
  reader.onerror = () => toast('Could not read file');
  reader.readAsText(file);
}

function itemState(project, roomId, itemId) {
  return project.items[key(roomId, itemId)];
}

function ensureItemState(project, roomId, itemId) {
  const k = key(roomId, itemId);
  if (!project.items[k]) project.items[k] = { checked: false, qty: '1', note: '', photos: [] };
  if (!project.items[k].photos) project.items[k].photos = [];
  return project.items[k];
}

function nextRoomName(project, type) {
  const def = roomTypeDef(type);
  if (def.singleton) return def.label;
  const n = project.rooms.filter((r) => r.type === type).length + 1;
  return `${def.label} ${n}`;
}

function addRoom(project, type) {
  const room = { id: uid('r_'), type, name: nextRoomName(project, type) };
  project.rooms.push(room);
  return room;
}

function removeRoom(project, roomId) {
  project.rooms = project.rooms.filter((r) => r.id !== roomId);
  // drop all item + nan state, custom defs, and hidden flags for that room
  for (const k of Object.keys(project.items)) {
    if (k.startsWith(roomId + '::')) delete project.items[k];
  }
  if (project.customItems) for (const id of Object.keys(project.customItems)) {
    if (project.customItems[id].roomId === roomId) delete project.customItems[id];
  }
  if (project.hidden) for (const k of Object.keys(project.hidden)) {
    if (k.startsWith(roomId + '::')) delete project.hidden[k];
  }
}

function newProject(name) {
  const p = {
    id: uid('p_'),
    name: name || `Project ${db.projects.length + 1}`,
    createdAt: Date.now(),
    rooms: [],
    items: {},
    priceOverrides: {},
    customItems: {}, // id -> { name, unit, cost, roomId, group }
    hidden: {},      // "<roomId>::<itemId>" -> true (deleted/hidden from a group)
  };
  // Seed: every singleton once, then 1 kitchen + 1 bathroom.
  for (const t of ROOM_TYPES) if (t.singleton) addRoom(p, t.type);
  addRoom(p, 'kitchen');
  addRoom(p, 'bathroom');
  // Keep a sensible walk order: house, kitchen, bathroom, systems, exterior
  const order = ['house', 'kitchen', 'bathroom', 'systems', 'exterior'];
  p.rooms.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  db.projects.push(p);
  db.activeId = p.id;
  return p;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */
function money(n) {
  return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/* ------------------------------------------------------------------ *
 * DOM refs
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const roomsEl = $('rooms');
const runningTotalEl = $('runningTotal');
const progressFillEl = $('progressFill');
const progressTextEl = $('progressText');
const progressBarEl = $('progressBar');
const projNameEl = $('projName');

/* ------------------------------------------------------------------ *
 * Rendering (full render only on structural change)
 * ------------------------------------------------------------------ */
/** Per-room rollup used by the overview cards and the summary tab. */
function roomStats(p, room) {
  const def = roomTypeDef(room.type);
  let sum = 0, done = 0, total = 0;
  for (const g of def.groups) {
    total++;
    let any = false;
    for (const id of groupItemIds(p, room, g)) {
      const st = p.items[key(room.id, id)];
      if (st && st.checked) { any = true; sum += (parseFloat(st.qty) || 0) * getCost(p, id); }
    }
    const nan = p.items[nanKey(room.id, g.key)];
    if (any || (nan && nan.checked)) done++;
  }
  return { sum, done, total };
}

/* ------------------------------------------------------------------ *
 * Top-level router — three thumb-reachable modes (Rooms / Deal / Summary).
 * Each calc still walks rooms->groups->items; this only controls what mounts.
 * ------------------------------------------------------------------ */
function setActiveTab(tab) {
  const map = { rooms: ['tabRooms', 'panelRooms'], deal: ['tabDeal', 'panelDeal'], summary: ['tabSummary', 'panelSummary'] };
  for (const k in map) {
    const [tabId, panelId] = map[k];
    const on = k === tab;
    $(panelId).classList.toggle('active', on);
    const b = $(tabId);
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
}

function switchTab(tab) { ui.tab = tab; render(); }

function render() {
  const p = activeProject();
  if (!p) return;
  projNameEl.textContent = p.name;
  setActiveTab(ui.tab);
  if (ui.tab === 'rooms') renderRoomsView(p);
  else if (ui.tab === 'deal') renderDealView(p);
  else if (ui.tab === 'summary') renderSummaryView(p);
  recalc();
}

/* ---- Rooms tab: search results / drill-down / overview ---- */
function renderRoomsView(p) {
  roomsEl.innerHTML = '';
  if (ui.query) { renderSearchResults(p); return; }
  if (ui.openRoomId && p.rooms.some((r) => r.id === ui.openRoomId)) {
    renderRoomDetail(p, p.rooms.find((r) => r.id === ui.openRoomId));
  } else {
    ui.openRoomId = null;
    renderOverview(p);
  }
}

function renderOverview(p) {
  const head = document.createElement('div');
  head.className = 'overview-head';
  head.innerHTML = `<h2>Rooms</h2><span class="sub">${p.rooms.length} in this walkthrough</span>`;
  roomsEl.appendChild(head);

  if (!p.rooms.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.innerHTML = `<b>No rooms yet</b>Add the first room to start the walkthrough.`;
    roomsEl.appendChild(e);
  } else {
    const list = document.createElement('div');
    list.className = 'room-cards';
    for (const room of p.rooms) list.appendChild(renderRoomCard(p, room));
    roomsEl.appendChild(list);
  }

  const add = document.createElement('button');
  add.className = 'add-room-btn';
  add.textContent = '＋ Add room';
  add.addEventListener('click', openAddRoom);
  roomsEl.appendChild(add);
}

function renderRoomCard(p, room) {
  const { sum, done, total } = roomStats(p, room);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const card = document.createElement('button');
  card.className = 'room-card' + (sum > 0 ? ' has-cost' : '');
  card.innerHTML =
    `<div class="room-card-top">` +
      `<span class="room-card-name">${escapeHtml(room.name)}</span>` +
      `<span class="room-card-amt num">${money(sum)}</span>` +
    `</div>` +
    `<div class="room-card-meta">` +
      `<span class="room-card-prog">${done} of ${total} groups</span>` +
      `<span class="room-card-bar"><i style="width:${pct}%"></i></span>` +
      `<span class="chev" aria-hidden="true">›</span>` +
    `</div>`;
  card.addEventListener('click', () => { ui.openRoomId = room.id; render(); });
  return card;
}

function renderRoomDetail(p, room) {
  const def = roomTypeDef(room.type);
  const { sum } = roomStats(p, room);

  const head = document.createElement('div');
  head.className = 'detail-head';
  const back = document.createElement('button');
  back.className = 'back-btn';
  back.innerHTML = '‹ Rooms';
  back.addEventListener('click', () => { ui.openRoomId = null; render(); });
  head.appendChild(back);
  const name = document.createElement('span');
  name.className = 'dh-name';
  name.textContent = room.name;
  head.appendChild(name);
  const amt = document.createElement('span');
  amt.className = 'dh-amt num';
  amt.id = 'rt|' + room.id; // recalc keeps this live
  amt.textContent = money(sum);
  head.appendChild(amt);
  if (!def.singleton) {
    const rm = document.createElement('button');
    rm.className = 'room-remove';
    rm.setAttribute('aria-label', 'Remove ' + room.name);
    rm.textContent = '✕';
    rm.addEventListener('click', () => {
      if (confirm(`Remove "${room.name}"? Its selections are deleted.`)) {
        removeRoom(p, room.id);
        ui.openRoomId = null;
        save(); render(); toast('Room removed');
      }
    });
    head.appendChild(rm);
  }
  roomsEl.appendChild(head);

  for (const g of def.groups) roomsEl.appendChild(renderGroup(p, room, g));
}

function renderSearchResults(p) {
  const q = ui.query.toLowerCase();
  let hits = 0;
  for (const room of p.rooms) {
    const def = roomTypeDef(room.type);
    for (const g of def.groups) {
      const matches = groupItemIds(p, room, g).filter((id) => itemDef(p, id).name.toLowerCase().includes(q));
      if (!matches.length) continue;
      const h = document.createElement('div');
      h.className = 'overview-head';
      h.innerHTML = `<h2>${escapeHtml(room.name)}</h2><span class="sub">${escapeHtml(g.label)}</span>`;
      roomsEl.appendChild(h);
      const wrap = document.createElement('div');
      wrap.className = 'group-body open';
      for (const id of matches) { wrap.appendChild(renderItem(p, room, id)); hits++; }
      roomsEl.appendChild(wrap);
    }
  }
  if (!hits) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.innerHTML = `<b>No matches for “${escapeHtml(ui.query)}”</b>Try a shorter word, like “door”.`;
    roomsEl.appendChild(e);
  }
}

function renderGroup(project, room, group) {
  const gk = room.id + '::' + group.key;
  const open = ui.expanded.has(gk);
  const wrap = document.createElement('div');
  wrap.className = 'group' + (open ? '' : ' collapsed'); // collapsed by default — no wall of scroll
  wrap.dataset.groupKey = group.key;

  const count = groupItemIds(project, room, group).length;

  const head = document.createElement('button');
  head.className = 'group-head';
  head.setAttribute('aria-expanded', String(open));
  head.innerHTML = `<span class="group-chevron" aria-hidden="true">▾</span>` +
    `<span class="group-label">${escapeHtml(group.label)}</span>`;

  const meta = document.createElement('div');
  meta.className = 'group-meta';

  const countEl = document.createElement('span');
  countEl.className = 'group-count';
  countEl.textContent = `${count} item${count === 1 ? '' : 's'}`;
  meta.appendChild(countEl);

  const groupSub = document.createElement('span');
  groupSub.className = 'group-sub num';
  groupSub.id = 'gt|' + room.id + '|' + group.key;
  groupSub.textContent = money(0);
  meta.appendChild(groupSub);

  head.appendChild(meta);
  head.addEventListener('click', () => {
    const nowCollapsed = wrap.classList.toggle('collapsed');
    if (nowCollapsed) ui.expanded.delete(gk); else ui.expanded.add(gk);
    head.setAttribute('aria-expanded', String(!nowCollapsed));
  });
  wrap.appendChild(head);

  // "Mark no action" lives just under the header — completes the group for progress
  const nan = document.createElement('button');
  nan.className = 'nan';
  const nk = nanKey(room.id, group.key);
  const nanOn = project.items[nk] && project.items[nk].checked;
  nan.innerHTML = `<span class="dot"></span><span class="nan-txt">${nanOn ? 'Marked: no action' : 'Mark no action'}</span>`;
  if (nanOn) nan.classList.add('on');
  nan.addEventListener('click', (e) => {
    e.stopPropagation();
    const st = project.items[nk] || (project.items[nk] = { checked: false });
    st.checked = !st.checked;
    nan.classList.toggle('on', st.checked);
    nan.querySelector('.nan-txt').textContent = st.checked ? 'Marked: no action' : 'Mark no action';
    save();
    recalc();
  });
  wrap.appendChild(nan);

  const body = document.createElement('div');
  body.className = 'group-body';
  for (const itemId of groupItemIds(project, room, group)) body.appendChild(renderItem(project, room, itemId));

  // restore strip — one-tap undo for anything deleted from this group
  const hid = hiddenItemIds(project, room, group);
  if (hid.length) {
    const strip = document.createElement('div');
    strip.className = 'hidden-strip';
    for (const id of hid) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'restore-chip';
      chip.textContent = '↺ ' + itemDef(project, id).name;
      chip.addEventListener('click', () => {
        delete project.hidden[key(room.id, id)];
        save();
        render();
      });
      strip.appendChild(chip);
    }
    body.appendChild(strip);
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'add-custom';
  addBtn.textContent = '＋ Add custom line';
  addBtn.addEventListener('click', () => addCustomItem(project, room, group));
  body.appendChild(addBtn);

  wrap.appendChild(body);
  return wrap;
}

function renderItem(project, room, itemId) {
  const def = itemDef(project, itemId);
  const k = key(room.id, itemId);
  const st = project.items[k] || { checked: false, qty: '1', note: '', photos: [] };

  const row = document.createElement('div');
  row.className = 'item' + (st.checked ? ' checked' : '');
  row.dataset.k = k;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-pressed', String(!!st.checked));
  row.setAttribute('aria-label', def.name);

  // main line: indicator, name/unit, line total — the whole row is the tap target
  const main = document.createElement('div');
  main.className = 'item-main';

  const chk = document.createElement('span');
  chk.className = 'chk';
  chk.setAttribute('aria-hidden', 'true');
  chk.textContent = st.checked ? '✓' : '';
  main.appendChild(chk);

  const info = document.createElement('div');
  info.className = 'item-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'item-name';
  nameEl.textContent = def.name;
  const unitEl = document.createElement('div');
  unitEl.className = 'item-unit';
  const refreshUnit = () => {
    const overridden = project.priceOverrides && project.priceOverrides[itemId] != null;
    unitEl.innerHTML = `<span class="cost${overridden ? ' over' : ''}">${money(getCost(project, itemId))}</span>` +
      `<span>/ ${escapeHtml(def.unit)}</span>`;
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'price-edit' + (overridden ? ' on' : '');
    edit.textContent = overridden ? '✎ edited' : '✎';
    edit.setAttribute('aria-label', 'Edit unit price for ' + def.name);
    edit.addEventListener('click', (e) => { e.stopPropagation(); editPrice(project, itemId, refreshUnit); });
    unitEl.appendChild(edit);
  };
  refreshUnit();
  info.appendChild(nameEl);
  info.appendChild(unitEl);
  main.appendChild(info);

  const line = document.createElement('div');
  line.className = 'item-line';
  line.id = 'lt|' + k;
  line.textContent = money(0);
  main.appendChild(line);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'item-del';
  del.textContent = '✕';
  del.setAttribute('aria-label', 'Remove ' + def.name);
  del.addEventListener('click', (e) => { e.stopPropagation(); deleteItem(project, room.id, itemId); });
  main.appendChild(del);

  row.appendChild(main);

  // controls (shown when checked): qty, photo button, note
  const controls = document.createElement('div');
  controls.className = 'item-controls';

  const qtyWrap = document.createElement('div');
  qtyWrap.className = 'qty-wrap';
  const qtyId = 'qty|' + k;
  qtyWrap.innerHTML = `<label for="${qtyId}">Qty</label>`;
  const qty = document.createElement('input');
  qty.className = 'qty'; qty.id = qtyId; qty.type = 'number'; qty.inputMode = 'decimal';
  qty.min = '0'; qty.step = 'any'; qty.value = st.qty ?? '1';
  qtyWrap.appendChild(qty);
  const unitLbl = document.createElement('span');
  unitLbl.className = 'unit-cost';
  unitLbl.textContent = def.unit;
  qtyWrap.appendChild(unitLbl);
  controls.appendChild(qtyWrap);

  const photoBtn = document.createElement('button');
  photoBtn.className = 'photo-btn';
  photoBtn.innerHTML = '📷 Photo';
  controls.appendChild(photoBtn);

  let scanBtn = null;
  if (isEquipment(project, itemId)) {
    scanBtn = document.createElement('button');
    scanBtn.type = 'button';
    scanBtn.className = 'photo-btn scan-btn';
    scanBtn.innerHTML = '🔎 Scan serial #';
    controls.appendChild(scanBtn);
  }

  const note = document.createElement('input');
  note.className = 'note-in';
  note.type = 'text';
  note.placeholder = 'Note (optional)';
  note.value = st.note || '';
  controls.appendChild(note);
  row.appendChild(controls);

  const thumbs = document.createElement('div');
  thumbs.className = 'thumbs';
  thumbs.id = 'ph|' + k;
  row.appendChild(thumbs);
  renderThumbs(project, room, itemId, thumbs);

  // --- wiring: the whole row toggles; controls below stopPropagation ---
  const toggle = () => {
    const s = ensureItemState(project, room.id, itemId);
    s.checked = !s.checked;
    row.classList.toggle('checked', s.checked);
    row.setAttribute('aria-pressed', String(s.checked));
    chk.textContent = s.checked ? '✓' : '';
    save();
    recalc();
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  // keep taps on the controls from toggling the row
  for (const el of [qtyWrap, qty, note, photoBtn, scanBtn, del]) {
    if (el) el.addEventListener('click', (e) => e.stopPropagation());
  }

  qty.addEventListener('input', () => {
    const s = ensureItemState(project, room.id, itemId);
    s.qty = qty.value;
    save();
    recalc(); // in-place number updates only, no re-render
  });

  note.addEventListener('input', () => {
    const s = ensureItemState(project, room.id, itemId);
    s.note = note.value;
    save();
  });

  photoBtn.addEventListener('click', () => capturePhoto(project, room, itemId, thumbs));
  if (scanBtn) scanBtn.addEventListener('click', () => scanSerial(project, room, itemId, note));

  return row;
}

function renderThumbs(project, room, itemId, container) {
  const st = project.items[key(room.id, itemId)];
  container.innerHTML = '';
  if (!st || !st.photos || !st.photos.length) return;
  st.photos.forEach((dataUrl, i) => {
    const t = document.createElement('div');
    t.className = 'thumb';
    const img = document.createElement('img');
    img.src = dataUrl; img.alt = 'photo ' + (i + 1); img.loading = 'lazy';
    t.appendChild(img);
    const rm = document.createElement('button');
    rm.className = 'rm'; rm.textContent = '✕'; rm.setAttribute('aria-label', 'Remove photo');
    rm.addEventListener('click', () => {
      st.photos.splice(i, 1);
      save();
      renderThumbs(project, room, itemId, container);
    });
    t.appendChild(rm);
    container.appendChild(t);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------------------------------------------ *
 * Recalc — single loop, in-place updates (no DOM rebuild)
 * ------------------------------------------------------------------ */
function recalc() {
  const p = activeProject();
  if (!p) return;
  let grand = 0, totalGroups = 0, doneGroups = 0;

  for (const room of p.rooms) {
    const def = roomTypeDef(room.type);
    let roomSum = 0;
    for (const g of def.groups) {
      totalGroups++;
      let groupSum = 0, anyChecked = false;
      for (const itemId of groupItemIds(p, room, g)) {
        const st = p.items[key(room.id, itemId)];
        let line = 0;
        if (st && st.checked) {
          anyChecked = true;
          line = (parseFloat(st.qty) || 0) * getCost(p, itemId);
          groupSum += line;
        }
        setText('lt|' + key(room.id, itemId), money(line));
      }
      const nan = p.items[nanKey(room.id, g.key)];
      const complete = anyChecked || (nan && nan.checked);
      if (complete) doneGroups++;
      roomSum += groupSum;
      grand += groupSum;
      const gt = $('gt|' + room.id + '|' + g.key);
      if (gt) {
        gt.textContent = money(groupSum);
        gt.classList.toggle('has', groupSum > 0);
      }
    }
    setText('rt|' + room.id, money(roomSum));
  }

  currentGrand = grand;
  runningTotalEl.textContent = money(grand);
  const pct = totalGroups ? Math.round((doneGroups / totalGroups) * 100) : 0;
  progressFillEl.style.width = pct + '%';
  progressTextEl.textContent = `${pct}% · ${doneGroups}/${totalGroups}`;
  progressBarEl.setAttribute('aria-valuenow', String(pct));
  updateReadout();                       // keep the signature verdict live everywhere
  if (ui.tab === 'deal') computeDeal();   // full analyzer only when the tab is showing
}

/** The signature element: keep the header verdict + max-bid current on every tab. */
function updateReadout() {
  const p = activeProject();
  if (!p) return;
  const m = dealMath(ensureDeal(p), currentGrand);
  const chip = $('readoutChip');
  const bid = $('readoutBid');
  chip.className = 'verdict-chip';
  if (m.verdict === 'GO') { chip.textContent = 'GO'; chip.classList.add('go'); }
  else if (m.verdict === 'TIGHT') { chip.textContent = 'TIGHT'; chip.classList.add('tight'); }
  else if (m.verdict === 'NO-GO') { chip.textContent = 'NO-GO'; chip.classList.add('nogo'); }
  else { chip.textContent = m.arv > 0 ? 'Set price' : 'Set ARV'; }
  bid.innerHTML = m.arv > 0 ? `max bid <b class="num">${money(m.maxBid)}</b>` : `max bid <b class="num">—</b>`;
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

/* ------------------------------------------------------------------ *
 * Photo capture + compression
 * ------------------------------------------------------------------ */
function capturePhoto(project, room, itemId, thumbsEl) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.appendChild(input); // MUST be in DOM before .click() on Android
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (file) {
      try {
        const dataUrl = await compressImage(file);
        const st = ensureItemState(project, room.id, itemId);
        st.photos.push(dataUrl);
        save();
        renderThumbs(project, room, itemId, thumbsEl);
      } catch (e) {
        console.error(e);
        toast('Could not read that photo');
      }
    }
    input.remove();
  });
  input.click();
}

function compressImage(file, maxDim = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ *
 * Serial-number OCR — on-demand Tesseract on an equipment photo.
 * Lazy-loaded (not in the SW precache), so it degrades gracefully offline.
 * ------------------------------------------------------------------ */
let tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoading) return tesseractLoading;
  tesseractLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract missing')));
    s.onerror = () => { tesseractLoading = null; reject(new Error('load failed')); };
    document.head.appendChild(s);
  });
  return tesseractLoading;
}

async function scanSerial(project, room, itemId, noteInput) {
  const st = ensureItemState(project, room.id, itemId);
  const photo = st.photos && st.photos[st.photos.length - 1];
  if (!photo) { toast('Take a photo of the data plate first'); return; }

  let T;
  try { toast('Loading scanner…'); T = await loadTesseract(); }
  catch (e) { console.warn(e); toast('Scanner needs a connection the first time'); return; }

  try {
    toast('Reading serial #…');
    const { data } = await T.recognize(photo, 'eng');
    const text = (data && data.text) || '';
    // digit-heavy tokens: serials are alphanumeric runs with real digits in them
    const guess = (text.match(/[A-Z0-9][A-Z0-9-]{5,}/gi) || [])
      .filter((t) => t.replace(/[^0-9]/g, '').length >= 2)
      .sort((a, b) => b.replace(/[^0-9]/g, '').length - a.replace(/[^0-9]/g, '').length)[0] || '';
    const entered = prompt('Confirm / edit serial number', guess);
    if (entered === null) return;
    const serial = entered.trim();
    if (!serial) { toast('No serial saved'); return; }
    const base = (st.note || '').replace(/\s*\|?\s*S\/N:.*$/i, '').trim();
    st.note = base ? `${base} | S/N: ${serial}` : `S/N: ${serial}`;
    if (noteInput) noteInput.value = st.note;
    save();
    toast('Serial saved to note');
  } catch (e) {
    console.error(e);
    toast('Could not read that image');
  }
}

/* ------------------------------------------------------------------ *
 * Export — ZIP (styled Excel + all photos)
 * ------------------------------------------------------------------ */
function dataUrlToUint8(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

const safe = (s) => String(s).replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');

async function exportZip() {
  const p = activeProject();
  if (!p) return;
  if (typeof JSZip === 'undefined' || typeof XLSX === 'undefined') {
    toast('Export libs not loaded — reconnect once.');
    return;
  }
  toast('Building export…');

  const header = ['Room', 'Group', 'Item', 'Unit', 'Qty', 'Unit Cost', 'Line Total'];
  const rows = [header];
  let grand = 0;
  const photoEntries = []; // {name, data}

  for (const room of p.rooms) {
    const def = roomTypeDef(room.type);
    for (const g of def.groups) {
      for (const itemId of groupItemIds(p, room, g)) {
        const st = p.items[key(room.id, itemId)];
        if (!st || !st.checked) continue;
        const qty = parseFloat(st.qty) || 0;
        const cost = getCost(p, itemId);
        const line = qty * cost;
        grand += line;
        const def2 = itemDef(p, itemId);
        const itemName = def2.name + (st.note ? `  [${st.note}]` : '');
        rows.push([room.name, g.label, itemName, def2.unit, qty, cost, line]);
        (st.photos || []).forEach((d, i) => {
          photoEntries.push({ name: `${safe(room.name)}_${itemId}_${i + 1}.jpg`, data: dataUrlToUint8(d) });
        });
      }
    }
  }
  rows.push([]);
  rows.push(['', '', '', '', '', 'GRAND TOTAL', grand]);

  // --- worksheet ---
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 16 }, { wch: 20 }, { wch: 42 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 14 }];

  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    if (cell) cell.s = {
      font: { bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: 'D45101' } },
      alignment: { horizontal: 'center' },
    };
  }
  // currency format on cost + line-total columns
  for (let r = 1; r <= range.e.r; r++) {
    for (const c of [5, 6]) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === 'number') cell.z = '$#,##0.00';
    }
  }
  // bold the grand-total row
  const lastRow = range.e.r;
  for (const c of [5, 6]) {
    const cell = ws[XLSX.utils.encode_cell({ r: lastRow, c })];
    if (cell) cell.s = { font: { bold: true }, fill: { fgColor: { rgb: 'F0E6DC' } } };
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Cost Breakdown');

  // --- Deal Summary tab (mirrors the Deal Analyzer) ---
  const m = dealMath(ensureDeal(p), grand);
  const dealRows = [
    ['Deal Summary', ''],
    ['After-Repair Value (ARV)', m.arv],
    ['Repair total', m.repairs],
    ['Holding + closing %', m.holding / 100],
    ['Target margin %', m.margin / 100],
    ['Max allowable bid', m.maxBid],
  ];
  if (m.profit !== null) {
    dealRows.push(['Purchase price', m.purchase]);
    dealRows.push(['Projected profit', m.profit]);
    dealRows.push(['ROI', m.roi]);
    dealRows.push(['Verdict', m.verdict]);
  }
  const dws = XLSX.utils.aoa_to_sheet(dealRows);
  dws['!cols'] = [{ wch: 26 }, { wch: 16 }];
  const title = dws[XLSX.utils.encode_cell({ r: 0, c: 0 })];
  if (title) title.s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: 'D45101' } } };
  // money rows
  for (const r of [1, 2, 5, 6, 7]) {
    const cell = dws[XLSX.utils.encode_cell({ r, c: 1 })];
    if (cell && typeof cell.v === 'number') cell.z = '$#,##0.00';
  }
  // percentage rows (holding, margin, ROI)
  for (const r of [3, 4, 8]) {
    const cell = dws[XLSX.utils.encode_cell({ r, c: 1 })];
    if (cell && typeof cell.v === 'number') cell.z = '0.0%';
  }
  XLSX.utils.book_append_sheet(wb, dws, 'Deal Summary');

  const xlsxArray = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });

  // --- zip ---
  const zip = new JSZip();
  const stamp = new Date().toISOString().slice(0, 10);
  const base = safe(p.name) || 'estimate';
  zip.file(`${base}_cost_breakdown.xlsx`, xlsxArray);
  if (photoEntries.length) {
    const folder = zip.folder('photos');
    photoEntries.forEach((e) => folder.file(e.name, e.data));
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, `${base}_${stamp}.zip`);
  toast(`Exported ${rows.length - 3} items · ${photoEntries.length} photos`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------------------------------------------ *
 * Deal Analyzer — turns the live repair total into a go/no-go verdict.
 *   Max bid = ARV − repairs − ARV×holding% − ARV×margin%
 *   Profit  = ARV − purchase − repairs − ARV×holding%   (if purchase set)
 *   ROI     = profit / (purchase + repairs + holding cost)
 * ------------------------------------------------------------------ */
const DEAL_DEFAULTS = { arv: '', purchase: '', margin: '20', holding: '10' };

function ensureDeal(project) {
  if (!project.deal) project.deal = { ...DEAL_DEFAULTS };
  return project.deal;
}

const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };

/** Pure math — given a deal + repair total, returns every output + verdict. */
function dealMath(deal, repairs) {
  const arv = num(deal.arv);
  const purchase = num(deal.purchase);
  const margin = num(deal.margin);
  const holding = num(deal.holding);
  const holdCost = arv * (holding / 100);
  const marginCost = arv * (margin / 100);
  const maxBid = arv - repairs - holdCost - marginCost;
  let profit = null, roi = null, verdict = null;
  if (purchase > 0 && arv > 0) {
    profit = arv - purchase - repairs - holdCost;
    const basis = purchase + repairs + holdCost;
    roi = basis > 0 ? profit / basis : 0;
    if (purchase <= maxBid) verdict = 'GO';
    else if (purchase <= maxBid + arv * 0.03) verdict = 'TIGHT';
    else verdict = 'NO-GO';
  }
  return { arv, purchase, margin, holding, repairs, holdCost, maxBid, profit, roi, verdict };
}

/** Deal tab: load the saved inputs for this project, then compute. */
function renderDealView(p) {
  const d = ensureDeal(p);
  $('dealArv').value = d.arv;
  $('dealPurchase').value = d.purchase;
  $('dealMargin').value = d.margin;
  $('dealHolding').value = d.holding;
  computeDeal();
}

/** Summary tab: review everything, then export. */
function renderSummaryView(p) {
  const body = $('summaryBody');
  body.innerHTML = '';

  let grand = 0, items = 0, photos = 0;
  const rows = [];
  for (const room of p.rooms) {
    const { sum } = roomStats(p, room);
    grand += sum;
    rows.push([room.name, sum]);
    for (const g of roomTypeDef(room.type).groups) {
      for (const id of groupItemIds(p, room, g)) {
        const st = p.items[key(room.id, id)];
        if (st && st.checked) { items++; photos += (st.photos || []).length; }
      }
    }
  }

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const head = document.createElement('div');
  head.className = 'overview-head';
  head.innerHTML = `<h2>Review</h2><span class="sub">${plural(p.rooms.length, 'room')} · ${plural(items, 'item')} · ${plural(photos, 'photo')}</span>`;
  body.appendChild(head);

  const card = document.createElement('div');
  card.className = 'summary-card';
  for (const [name, sum] of rows) {
    const r = document.createElement('div');
    r.className = 'summary-row';
    r.innerHTML = `<span>${escapeHtml(name)}</span><span class="num">${money(sum)}</span>`;
    card.appendChild(r);
  }
  const tot = document.createElement('div');
  tot.className = 'summary-row total';
  tot.innerHTML = `<span>Repair total</span><span class="num">${money(grand)}</span>`;
  card.appendChild(tot);
  body.appendChild(card);

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn-primary export-cta';
  exportBtn.textContent = '⬇ Export ZIP (Excel + photos)';
  exportBtn.addEventListener('click', exportZip);
  body.appendChild(exportBtn);

  const note = document.createElement('p');
  note.className = 'proj-tools-note';
  note.textContent = items
    ? 'Includes a styled cost breakdown and a deal summary tab.'
    : 'Check some items first — the export will be empty.';
  body.appendChild(note);
}

function computeDeal() {
  const p = activeProject();
  if (!p) return;
  const d = ensureDeal(p);
  d.arv = $('dealArv').value;
  d.purchase = $('dealPurchase').value;
  d.margin = $('dealMargin').value;
  d.holding = $('dealHolding').value;
  save();

  const m = dealMath(d, currentGrand);
  $('dealBigAmt').textContent = money(m.maxBid);

  const chip = $('dealChip');
  chip.className = 'verdict-chip';
  if (m.verdict === 'GO') { chip.textContent = 'GO'; chip.classList.add('go'); }
  else if (m.verdict === 'TIGHT') { chip.textContent = 'TIGHT'; chip.classList.add('tight'); }
  else if (m.verdict === 'NO-GO') { chip.textContent = 'NO-GO'; chip.classList.add('nogo'); }
  else { chip.textContent = m.arv > 0 ? 'Set a price' : 'Enter ARV'; }

  const rows = [
    ['Repair total (live)', money(m.repairs)],
    ['Holding + closing', money(m.holdCost)],
    ['Max allowable bid', money(m.maxBid)],
  ];
  if (m.profit !== null) {
    rows.push(['Projected profit', money(m.profit)]);
    rows.push(['ROI', (m.roi * 100).toFixed(1) + '%']);
  }
  const out = $('dealOut');
  out.innerHTML = '';
  for (const [k, v] of rows) {
    const div = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    div.appendChild(dt); div.appendChild(dd);
    out.appendChild(div);
  }
  updateReadout(); // keep the persistent header verdict in sync while typing
}

/* ------------------------------------------------------------------ *
 * Sheets (project switcher + add room)
 * ------------------------------------------------------------------ */
function openSheet(scrim, sheet) { scrim.classList.add('open'); sheet.classList.add('open'); }
function closeSheet(scrim, sheet) { scrim.classList.remove('open'); sheet.classList.remove('open'); }

function openProjects() {
  const list = $('projList');
  list.innerHTML = '';
  for (const p of db.projects) {
    const li = document.createElement('li');
    const pick = document.createElement('button');
    pick.className = 'pick' + (p.id === db.activeId ? ' active' : '');
    pick.textContent = p.name;
    pick.addEventListener('click', () => {
      db.activeId = p.id; save();
      ui.openRoomId = null; ui.query = ''; $('searchInput').value = '';
      closeSheet($('projScrim'), $('projSheet'));
      render();
    });
    li.appendChild(pick);

    const rename = document.createElement('button');
    rename.className = 'mini'; rename.textContent = '✎'; rename.setAttribute('aria-label', 'Rename');
    rename.addEventListener('click', () => {
      const name = prompt('Rename project', p.name);
      if (name && name.trim()) { p.name = name.trim(); save(); openProjects(); if (p.id === db.activeId) projNameEl.textContent = p.name; }
    });
    li.appendChild(rename);

    if (db.projects.length > 1) {
      const del = document.createElement('button');
      del.className = 'mini'; del.textContent = '🗑'; del.setAttribute('aria-label', 'Delete');
      del.addEventListener('click', () => {
        if (confirm(`Delete project "${p.name}"?`)) {
          db.projects = db.projects.filter((x) => x.id !== p.id);
          if (db.activeId === p.id) db.activeId = db.projects[0].id;
          save(); openProjects(); render();
        }
      });
      li.appendChild(del);
    }
    list.appendChild(li);
  }
  const n = Object.keys(db.globalPricing || {}).length;
  $('globalPriceNote').textContent = n
    ? `${n} item${n === 1 ? '' : 's'} on custom standard pricing (from CSV)`
    : 'Using built-in standard pricing';
  openSheet($('projScrim'), $('projSheet'));
}

function openAddRoom() {
  const grid = $('roomTypeGrid');
  grid.innerHTML = '';
  for (const type of NON_SINGLETON) {
    const def = roomTypeDef(type);
    const b = document.createElement('button');
    b.textContent = def.label;
    b.addEventListener('click', () => {
      const p = activeProject();
      const room = addRoom(p, type);
      save();
      closeSheet($('roomScrim'), $('roomSheet'));
      ui.tab = 'rooms'; ui.query = ''; $('searchInput').value = '';
      ui.openRoomId = room.id; // drill straight into the new room
      render();
      window.scrollTo({ top: 0 });
      toast(`${room.name} added`);
    });
    grid.appendChild(b);
  }
  openSheet($('roomScrim'), $('roomSheet'));
}

/* ------------------------------------------------------------------ *
 * Toast
 * ------------------------------------------------------------------ */
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
function boot() {
  if (!db.projects.length) newProject('My First Walkthrough');
  if (!activeProject()) db.activeId = db.projects[0].id;
  save();

  $('projBtn').addEventListener('click', openProjects);
  $('newProjBtn').addEventListener('click', () => {
    const name = prompt('Project name', `Project ${db.projects.length + 1}`);
    newProject(name && name.trim() ? name.trim() : undefined);
    save();
    closeSheet($('projScrim'), $('projSheet'));
    render();
  });
  $('importCsvBtn').addEventListener('click', () => $('csvInput').click());
  $('csvInput').addEventListener('change', () => {
    const f = $('csvInput').files && $('csvInput').files[0];
    if (f) importPricingCsv(f);
    $('csvInput').value = '';
  });
  $('roomCancel').addEventListener('click', () => closeSheet($('roomScrim'), $('roomSheet')));

  // bottom tab bar
  $('tabRooms').addEventListener('click', () => switchTab('rooms'));
  $('tabDeal').addEventListener('click', () => switchTab('deal'));
  $('tabSummary').addEventListener('click', () => switchTab('summary'));

  // search across all items
  const searchInput = $('searchInput');
  searchInput.addEventListener('input', () => {
    ui.query = searchInput.value.trim();
    $('searchClear').hidden = !ui.query;
    renderRoomsView(activeProject());
    recalc();
  });
  $('searchClear').addEventListener('click', () => {
    searchInput.value = ''; ui.query = ''; $('searchClear').hidden = true;
    searchInput.focus();
    render();
  });

  // deal inputs (live as you type)
  for (const id of ['dealArv', 'dealPurchase', 'dealMargin', 'dealHolding']) {
    $(id).addEventListener('input', computeDeal);
  }

  $('projScrim').addEventListener('click', () => closeSheet($('projScrim'), $('projSheet')));
  $('roomScrim').addEventListener('click', () => closeSheet($('roomScrim'), $('roomSheet')));

  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

  render();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW reg failed', e));
    });
  }
}

boot();
