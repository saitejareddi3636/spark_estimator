// tests/gate.mjs — automated gate suite for the Spark Homes estimator.
//
// No Playwright: drives real Chrome over the DevTools Protocol using only Node
// built-ins (http, child_process, global WebSocket + fetch). Serves the app,
// launches headless Chrome at a 390px phone viewport, exercises the real UI
// (clicks, typing, tab switches) and asserts on the DOM / live state.
//
//   node tests/gate.mjs            # run the 15 automated gates
//   SHOTS=1 node tests/gate.mjs    # also write phone-width screenshots to tests/shots/
//
// The 3 hardware gates (camera, add-to-home-screen, offline-from-icon) cannot be
// covered headlessly — see tests/MANUAL-GATES.md.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 8129;
const CDP_PORT = 9333;
const SHOTS = process.env.SHOTS === '1';

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/opt/homebrew/bin/chromium',
].find((p) => existsSync(p));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

/* ---------------- static server ---------------- */
function serve() {
  const srv = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = join(ROOT, p);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise((ok) => srv.listen(PORT, () => ok(srv)));
}

/* ---------------- minimal CDP client ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.evs = new Map();
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, bad } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? bad(new Error(msg.error.message)) : ok(msg.result);
      } else if (msg.method) { (this.evs.get(msg.method) || []).forEach((cb) => cb(msg.params)); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok, bad) => { this.pending.set(id, { ok, bad }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, cb) { if (!this.evs.has(method)) this.evs.set(method, []); this.evs.get(method).push(cb); }
}

async function connectCDP() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, bad) => { ws.addEventListener('open', ok); ws.addEventListener('error', bad); });
        return new CDP(ws);
      }
    } catch {}
    await sleep(150);
  }
  throw new Error('Could not connect to Chrome CDP');
}

/* ---------------- harness ---------------- */
let cdp, pageErrors = [];
const evalJS = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: `(()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result.value;
};
const waitFor = async (expr, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await evalJS(`return !!(${expr});`)) return true; await sleep(80); }
  throw new Error('waitFor timed out: ' + expr);
};
async function reload(clear = true) {
  if (clear) {
    // Drop the old page first (its pagehide flush fires here), THEN wipe storage
    // at the browser level so nothing re-populates it. Also clears any SW cache.
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(150);
    await cdp.send('Storage.clearDataForOrigin', {
      origin: `http://localhost:${PORT}`,
      storageTypes: 'local_storage,cache_storage,service_workers',
    });
  }
  await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/index.html` });
  await waitFor("document.querySelector('.room-card')");
}
async function shot(name) {
  if (!SHOTS) return;
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await mkdir(join(ROOT, 'tests/shots'), { recursive: true });
  await writeFile(join(ROOT, 'tests/shots', name + '.png'), Buffer.from(data, 'base64'));
}

const results = [];
async function gate(name, fn) {
  try { const detail = await fn(); results.push({ name, pass: true, detail: detail || '' }); }
  catch (e) { results.push({ name, pass: false, detail: e.message }); }
}

/* ---------------- gates ---------------- */
async function run() {
  // canned dialogs so prompt()/confirm()-driven flows are testable
  const armDialogs = (prompts = []) => evalJS(`window.__p=${JSON.stringify(prompts)};window.prompt=()=>window.__p.length?window.__p.shift():'';window.confirm=()=>true;return 1;`);

  await reload();
  await armDialogs();

  await gate('1. Cold load renders 5 room cards, $0 total, no JS error', async () => {
    const n = await evalJS("return document.querySelectorAll('.room-card').length;");
    if (n !== 5) throw new Error('room cards = ' + n);
    const total = await evalJS("return document.getElementById('runningTotal').textContent;");
    if (total.replace(/\\s/g, '') !== '$0') throw new Error('total = ' + total);
    if (pageErrors.length) throw new Error('console errors: ' + pageErrors.join('; '));
    await shot('1-overview');
    return `${n} rooms, total ${total}`;
  });

  await gate('2. Drill-down: tapping a room shows its groups + Back', async () => {
    await evalJS("document.querySelectorAll('.room-card')[1].click(); return 1;"); // Kitchen
    await waitFor("document.querySelector('.detail-head .back-btn')");
    const groups = await evalJS("return document.querySelectorAll('#rooms .group').length;");
    if (groups < 1) throw new Error('no groups in detail');
    await shot('2-room-detail');
    return groups + ' groups';
  });

  await gate('3. Groups collapsed by default (no wall of scroll)', async () => {
    const all = await evalJS("return document.querySelectorAll('#rooms .group').length;");
    const collapsed = await evalJS("return document.querySelectorAll('#rooms .group.collapsed').length;");
    if (all !== collapsed) throw new Error(`${collapsed}/${all} collapsed`);
    const visibleBodies = await evalJS("return [...document.querySelectorAll('.group-body')].filter(b=>b.offsetParent!==null).length;");
    if (visibleBodies !== 0) throw new Error(visibleBodies + ' bodies visible while collapsed');
    return `${collapsed}/${all} collapsed`;
  });

  await gate('4. Expanding a group reveals its item rows', async () => {
    await evalJS("document.querySelector('#rooms .group .group-head').click(); return 1;");
    await waitFor("document.querySelector('#rooms .group:not(.collapsed) .item')");
    const items = await evalJS("return document.querySelectorAll('#rooms .group:not(.collapsed) .item').length;");
    if (items < 1) throw new Error('no items after expand');
    return items + ' items shown';
  });

  await gate('5. Whole-row tap toggles the item + raises the total', async () => {
    await evalJS("document.querySelector('#rooms .group:not(.collapsed) .item').click(); return 1;");
    const checked = await evalJS("const r=document.querySelector('#rooms .group:not(.collapsed) .item'); return r.classList.contains('checked')&&r.getAttribute('aria-pressed')==='true';");
    if (!checked) throw new Error('row did not check');
    const total = await evalJS("return document.getElementById('runningTotal').textContent;");
    if (total.replace(/\\s/g, '') === '$0') throw new Error('total still $0');
    return 'total ' + total;
  });

  await gate('6. Editing qty does NOT toggle the row (stopPropagation)', async () => {
    const before = await evalJS("return document.querySelector('#rooms .group:not(.collapsed) .item').classList.contains('checked');");
    await evalJS("const q=document.querySelector('#rooms .group:not(.collapsed) .item .qty'); q.click(); return 1;");
    const after = await evalJS("return document.querySelector('#rooms .group:not(.collapsed) .item').classList.contains('checked');");
    if (before !== after) throw new Error('qty click toggled the row');
    return 'row stayed ' + (after ? 'checked' : 'unchecked');
  });

  await gate('7. Search filters across all items + empty state', async () => {
    await evalJS("const s=document.getElementById('searchInput'); s.value='window'; s.dispatchEvent(new Event('input',{bubbles:true})); return 1;");
    await waitFor("document.querySelectorAll('#rooms .item').length>0");
    const names = await evalJS("return [...document.querySelectorAll('#rooms .item .item-name')].map(n=>n.textContent.toLowerCase());");
    if (!names.length || !names.every((n) => n.includes('window'))) throw new Error('non-matching results: ' + names.join(','));
    await shot('7-search');
    await evalJS("const s=document.getElementById('searchInput'); s.value='zzzzzz'; s.dispatchEvent(new Event('input',{bubbles:true})); return 1;");
    await waitFor("document.querySelector('#rooms .empty')");
    // clear
    await evalJS("const s=document.getElementById('searchInput'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); return 1;");
    return names.length + ' matches for "window"';
  });

  await gate('8. "Mark no action" completes a group for progress', async () => {
    await reload(); await armDialogs();
    await evalJS("document.querySelectorAll('.room-card')[1].click(); return 1;");
    await waitFor("document.querySelector('#rooms .group .nan')");
    const before = await evalJS("return document.getElementById('progressText').textContent;");
    await evalJS("document.querySelector('#rooms .group .nan').click(); return 1;");
    const after = await evalJS("return document.getElementById('progressText').textContent;");
    if (before === after) throw new Error(`progress unchanged (${before})`);
    return `${before} -> ${after}`;
  });

  await gate('9. Add custom line item appears + counts', async () => {
    await reload();
    await armDialogs(['Permit fee', 'flat', '350']);
    await evalJS("document.querySelectorAll('.room-card')[1].click(); return 1;");
    await evalJS("document.querySelector('#rooms .group .group-head').click(); return 1;");
    await waitFor("document.querySelector('#rooms .group:not(.collapsed) .add-custom')");
    const before = await evalJS("return document.querySelectorAll('#rooms .group:not(.collapsed) .item').length;");
    await evalJS("document.querySelector('#rooms .group:not(.collapsed) .add-custom').click(); return 1;");
    await waitFor(`document.querySelectorAll('#rooms .group:not(.collapsed) .item').length===${before + 1}`);
    const found = await evalJS("return [...document.querySelectorAll('.item-name')].some(n=>n.textContent==='Permit fee');");
    if (!found) throw new Error('custom item not found');
    return 'added "Permit fee"';
  });

  await gate('10. Delete an item, then restore it', async () => {
    const before = await evalJS("return document.querySelectorAll('#rooms .group:not(.collapsed) .item').length;");
    await evalJS("document.querySelector('#rooms .group:not(.collapsed) .item .item-del').click(); return 1;");
    await waitFor("document.querySelector('#rooms .group .restore-chip')");
    const afterDel = await evalJS("return document.querySelectorAll('#rooms .group:not(.collapsed) .item').length;");
    if (afterDel !== before - 1) throw new Error('delete did not remove a row');
    await evalJS("document.querySelector('#rooms .group .restore-chip').click(); return 1;");
    await waitFor(`document.querySelectorAll('#rooms .group:not(.collapsed) .item').length===${before}`);
    return 'delete + restore ok';
  });

  await gate('11. Projects isolate their own selections', async () => {
    await reload();
    // Project A: check first item of Kitchen
    await evalJS("document.querySelectorAll('.room-card')[1].click(); return 1;");
    await evalJS("document.querySelector('#rooms .group .group-head').click(); return 1;");
    await waitFor("document.querySelector('#rooms .group:not(.collapsed) .item')");
    await evalJS("document.querySelector('#rooms .group:not(.collapsed) .item').click(); return 1;");
    const totalA = await evalJS("return document.getElementById('runningTotal').textContent;");
    // New project B
    await armDialogs(['Project B']);
    await evalJS("document.getElementById('newProjBtn').click(); return 1;");
    await waitFor("document.querySelector('.room-card')");
    const totalB = await evalJS("return document.getElementById('runningTotal').textContent;");
    if (totalB.replace(/\\s/g, '') !== '$0') throw new Error('new project not blank: ' + totalB);
    // Switch back to A
    await evalJS("document.getElementById('projBtn').click(); return 1;");
    await waitFor("document.querySelector('#projList .pick')");
    await evalJS("[...document.querySelectorAll('#projList .pick')].find(b=>/Walkthrough/.test(b.textContent)).click(); return 1;");
    await waitFor("document.querySelector('.room-card')");
    const backA = await evalJS("return document.getElementById('runningTotal').textContent;");
    if (backA !== totalA) throw new Error(`A not restored: ${totalA} -> ${backA}`);
    return `A=${totalA}, B=${totalB}, back=${backA}`;
  });

  await gate('12. Per-project price override changes the line cost', async () => {
    await reload();
    await evalJS("document.querySelectorAll('.room-card')[1].click(); return 1;");
    await evalJS("document.querySelector('#rooms .group .group-head').click(); return 1;");
    await waitFor("document.querySelector('#rooms .group:not(.collapsed) .price-edit')");
    await armDialogs(['9999']);
    await evalJS("document.querySelector('#rooms .group:not(.collapsed) .price-edit').click(); return 1;");
    await waitFor("/9,?999/.test(document.querySelector('#rooms .group:not(.collapsed) .item .item-unit .cost').textContent)");
    return 'override applied';
  });

  await gate('13. Deal tab: verdict + header readout react to inputs', async () => {
    await reload();
    await evalJS("document.getElementById('tabDeal').click(); return 1;");
    await waitFor("document.getElementById('panelDeal').classList.contains('active')");
    await evalJS("const set=(id,v)=>{const e=document.getElementById(id);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}; set('dealArv','250000'); set('dealPurchase','130000'); return 1;");
    await waitFor("document.getElementById('dealChip').textContent==='GO'");
    const headerChip = await evalJS("return document.getElementById('readoutChip').textContent;");
    if (headerChip !== 'GO') throw new Error('header chip = ' + headerChip);
    await shot('13-deal');
    // NO-GO when overpaying
    await evalJS("const e=document.getElementById('dealPurchase');e.value='240000';e.dispatchEvent(new Event('input',{bubbles:true})); return 1;");
    await waitFor("document.getElementById('dealChip').textContent==='NO-GO'");
    return 'GO -> NO-GO transitions ok';
  });

  await gate('14. Summary tab exports a ZIP (Excel incl. Deal Summary)', async () => {
    await reload();
    // check an item so the export has content
    await evalJS("document.querySelectorAll('.room-card')[1].click(); return 1;");
    await evalJS("document.querySelector('#rooms .group .group-head').click(); return 1;");
    await waitFor("document.querySelector('#rooms .group:not(.collapsed) .item')");
    await evalJS("document.querySelector('#rooms .group:not(.collapsed) .item').click(); return 1;");
    await evalJS("document.getElementById('tabSummary').click(); return 1;");
    await waitFor("document.querySelector('#summaryBody .export-cta')");
    await shot('14-summary');
    await evalJS("document.querySelector('#summaryBody .export-cta').click(); return 1;");
    await waitFor("/^Exported/.test(document.getElementById('toast').textContent)", 8000);
    return await evalJS("return document.getElementById('toast').textContent;");
  });

  await gate('15. State persists across a reload (offline-grade storage)', async () => {
    // continues from gate 14's checked item — reload WITHOUT clearing storage
    const before = await evalJS("return document.getElementById('runningTotal').textContent;");
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/index.html` });
    await waitFor("document.querySelector('.room-card')");
    const after = await evalJS("return document.getElementById('runningTotal').textContent;");
    if (before !== after || before.replace(/\\s/g, '') === '$0') throw new Error(`persistence: ${before} -> ${after}`);
    return `persisted ${after}`;
  });

  // narrow-width screenshot for the 360px floor
  if (SHOTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 760, deviceScaleFactor: 2, mobile: true });
    await reload();
    await shot('16-narrow-360');
  }
}

/* ---------------- main ---------------- */
let srv, chrome;
try {
  if (!CHROME) throw new Error('No Chrome/Chromium found');
  srv = await serve();
  const userDir = join(ROOT, 'tests/.chrome-profile');
  await rm(userDir, { recursive: true, force: true }); // fresh profile: no stale SW cache of app.js
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check',
    `http://localhost:${PORT}/index.html`,
  ], { stdio: 'ignore' });

  cdp = await connectCDP();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(p.exceptionDetails?.exception?.description || 'exception'));
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') pageErrors.push(p.args?.map((a) => a.value).join(' ')); });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  await run();
} catch (e) {
  results.push({ name: 'HARNESS', pass: false, detail: e.stack || e.message });
} finally {
  const pass = results.filter((r) => r.pass).length;
  console.log('\\n──────── GATE SUITE ────────');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  ·  ' + r.detail : ''}`);
  console.log(`────────────────────────────\\n${pass}/${results.length} passed${SHOTS ? '  (screenshots in tests/shots/)' : ''}\\n`);
  try { chrome && chrome.kill(); } catch {}
  try { srv && srv.close(); } catch {}
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
