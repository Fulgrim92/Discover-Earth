// Controller settings / axis-mapping / calibration panel (P key or gamepad start). Built once at attach.
// Works for USB RC transmitters: pick which raw axis is each stick, invert, calibrate ranges, learn switches as
// buttons. Persisted in localStorage by input.save(). The live view runs on its own 10 Hz timer only while open
// (outside the frame loop), so the sim's per-frame path stays allocation-free.

import * as IN from './input.js';

const P = { root: null, timer: 0, rows: null, raw: null, bindTxt: null, calBtn: null, padSel: null, modeSel: null, nums: null };
export const open = new Uint8Array(1);

const STICK_LABEL = ['left stick, horizontal', 'left stick, vertical', 'right stick, horizontal', 'right stick, vertical'];
const CH_NAMES = ['throttle', 'yaw', 'pitch', 'roll'];
const MODEMAP = [[3, 0, 1, 2], [1, 0, 3, 2], [3, 2, 1, 0], [1, 2, 3, 0]]; // physical axis for [thr, yaw, pitch, roll]

function bindText(b) {
  if (b < 0) return 'none';
  if (b < 100) return 'button ' + b;
  if (b < 200) return 'axis ' + (b - 100) + ' +';
  return 'axis ' + (b - 200) + ' -';
}

export function attach() {
  if (typeof document === 'undefined') return;
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;right:16px;top:16px;bottom:16px;width:400px;overflow:auto;z-index:20;display:none;' +
    'background:rgba(12,14,20,0.86);color:rgba(255,255,255,0.86);font:13px system-ui,-apple-system,"Segoe UI",sans-serif;' +
    'padding:14px 16px;border-radius:10px;pointer-events:auto;line-height:1.5';
  const h = (tag, text, css, parent) => {
    const e = document.createElement(tag); if (text) e.textContent = text; if (css) e.style.cssText = css;
    (parent || root).appendChild(e); return e;
  };
  h('div', 'Controller', 'font-size:16px;font-variant:all-small-caps;letter-spacing:0.08em;margin-bottom:6px');
  const line = (label) => { const d = h('div', '', 'display:flex;align-items:center;gap:8px;margin:4px 0'); h('span', label, 'flex:0 0 150px;opacity:0.75', d); return d; };

  // device
  let d = line('device');
  P.padSel = h('select', '', '', d);
  P.padSel.onchange = () => { IN.cfgI[IN.C_PADINDEX] = +P.padSel.value; IN.save(); };
  P.padName = h('div', '', 'font-size:11px;opacity:0.6;margin:0 0 6px 0;word-break:break-all');

  // stick mode
  d = line('stick mode');
  P.modeSel = h('select', '', '', d);
  for (let m = 1; m <= 4; m++) { const o = h('option', 'mode ' + m + (m === 2 ? ' (default)' : ''), '', P.modeSel); o.value = m; }
  P.modeSel.onchange = () => { IN.setStickMode(+P.modeSel.value); IN.save(); relabel(); };

  // stick axes
  h('div', 'Sticks: move each stick and pick the axis whose bar moves. Up and right must read +.', 'margin-top:10px;opacity:0.75');
  P.rows = [];
  for (let s = 0; s < 4; s++) {
    const r = h('div', '', 'display:flex;align-items:center;gap:6px;margin:4px 0');
    const lab = h('span', '', 'flex:0 0 150px;opacity:0.75', r);
    const sel = h('select', '', '', r);
    for (let a = 0; a < IN.MAX_AXES; a++) { const o = h('option', 'axis ' + a, '', sel); o.value = a; }
    sel.onchange = () => { IN.cfgI[IN.C_MAP + s] = +sel.value; IN.save(); };
    const invL = h('label', '', 'display:flex;align-items:center;gap:3px', r);
    const inv = h('input', '', '', invL); inv.type = 'checkbox';
    h('span', 'invert', '', invL);
    inv.onchange = () => { IN.cfgI[IN.C_INV + s] = inv.checked ? 1 : 0; IN.save(); };
    const bar = h('canvas', '', 'width:70px;height:10px', r); bar.width = 70; bar.height = 10;
    P.rows.push({ lab, sel, inv, bar: bar.getContext('2d') });
  }

  // raw axes + calibration
  h('div', 'Raw axes', 'margin-top:10px;opacity:0.75');
  const raw = h('canvas', '', 'width:368px;height:84px;display:block'); raw.width = 368; raw.height = 84;
  P.raw = raw.getContext('2d');
  d = h('div', '', 'display:flex;gap:8px;margin:6px 0');
  P.calBtn = h('button', 'calibrate', '', d);
  P.calBtn.onclick = () => {
    if (!IN.calib.on) {
      for (let i = 0; i < IN.MAX_AXES; i++) { IN.calMin[i] = IN.axes[i]; IN.calMax[i] = IN.axes[i]; }
      IN.calib.on = 1; P.calBtn.textContent = 'done (move every stick to all corners first)';
    } else {
      IN.calib.on = 0; P.calBtn.textContent = 'calibrate';
      for (let i = 0; i < IN.MAX_AXES; i++) {
        if (IN.calMax[i] - IN.calMin[i] > 0.3) { IN.cfgF[IN.F_AMIN + i] = IN.calMin[i]; IN.cfgF[IN.F_AMAX + i] = IN.calMax[i]; }
      }
      IN.save();
    }
  };
  const rc = h('button', 'reset ranges', '', d);
  rc.onclick = () => { for (let i = 0; i < IN.MAX_AXES; i++) { IN.cfgF[IN.F_AMIN + i] = -1; IN.cfgF[IN.F_AMAX + i] = 1; } IN.save(); };

  // feel
  h('div', 'Feel', 'margin-top:10px;opacity:0.75');
  P.nums = [];
  const num = (label, idx, step, min, max) => {
    const r = line(label);
    const i = h('input', '', 'width:70px', r); i.type = 'number'; i.step = step; i.min = min; i.max = max;
    i.onchange = () => { const v = +i.value; if (isFinite(v)) { IN.cfgF[idx] = Math.min(max, Math.max(min, v)); IN.save(); } };
    P.nums.push({ i, idx });
  };
  num('deadband', IN.F_DEADBAND, 0.01, 0, 0.3);
  num('expo (gps, angle)', IN.F_EXPO, 0.05, 0, 1);
  num('acro centre deg/s', IN.F_ACRO_C, 5, 10, 400);
  num('acro max deg/s', IN.F_ACRO_M, 10, 100, 1800);
  num('acro expo', IN.F_ACRO_E, 0.05, 0, 1);

  // bindings
  h('div', 'Buttons and switches: press learn, then the button or flick the switch.', 'margin-top:10px;opacity:0.75');
  P.bindTxt = [];
  for (let a = 0; a < IN.N_ACT; a++) {
    const r = line(IN.ACT_NAMES[a]);
    const t = h('span', '', 'flex:1', r);
    const b = h('button', 'learn', '', r);
    b.onclick = () => { IN.learn.action = a; t.textContent = 'press...'; };
    const c = h('button', 'clear', '', r);
    c.onclick = () => { IN.cfgI[IN.C_BIND + a] = -1; IN.save(); };
    P.bindTxt.push(t);
  }

  d = h('div', '', 'display:flex;gap:8px;margin-top:12px');
  const def = h('button', 'defaults', '', d);
  def.onclick = () => { IN.defaults(); IN.save(); sync(); };
  const cl = h('button', 'close (p)', '', d);
  cl.onclick = () => toggle();
  h('div', 'Keyboard: WASD left stick, arrows right stick. In Angle/Acro the throttle key ratchets (stays where you leave it).',
    'margin-top:10px;font-size:11px;opacity:0.6');

  // keep keys typed into the panel from flying the drone
  root.addEventListener('keydown', (e) => { if (e.code !== 'KeyP' && e.code !== 'Escape') e.stopPropagation(); });
  document.body.appendChild(root);
  P.root = root;
  window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && open[0]) toggle(); });
}

function relabel() {
  const m = IN.stickMode() - 1;
  for (let s = 0; s < 4; s++) {
    let n = '';
    for (let c = 0; c < 4; c++) if (MODEMAP[m][c] === s) n = CH_NAMES[c];
    P.rows[s].lab.textContent = STICK_LABEL[s] + ' (' + n + ')';
  }
}

function sync() {
  P.modeSel.value = IN.stickMode();
  for (let s = 0; s < 4; s++) { P.rows[s].sel.value = IN.cfgI[IN.C_MAP + s]; P.rows[s].inv.checked = !!IN.cfgI[IN.C_INV + s]; }
  for (const n of P.nums) n.i.value = +IN.cfgF[n.idx].toFixed(3);
  // devices
  P.padSel.textContent = '';
  const o = document.createElement('option'); o.value = -1; o.textContent = 'first connected'; P.padSel.appendChild(o);
  const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  for (let i = 0; i < pads.length; i++) if (pads[i]) {
    const e = document.createElement('option'); e.value = i; e.textContent = i + ': ' + pads[i].id.slice(0, 40); P.padSel.appendChild(e);
  }
  P.padSel.value = IN.cfgI[IN.C_PADINDEX];
  relabel();
}

function live() {
  P.padName.textContent = IN.padInfo[0] ? 'reading: ' + (IN.padId() || 'gamepad ' + IN.padInfo[1]) + '  (' + IN.padInfo[2] + ' axes, ' + IN.padInfo[3] + ' buttons)' : 'no gamepad: press a button on it';
  const c = P.raw;
  c.clearRect(0, 0, 368, 84);
  const n = IN.padInfo[0] ? IN.padInfo[2] : 0;
  for (let i = 0; i < IN.MAX_AXES; i++) {
    const col = i % 2, row = i >> 1, x = col * 184, y = row * 10;
    c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(x + 40, y + 2, 130, 6);
    c.fillStyle = 'rgba(255,255,255,0.6)'; c.font = '9px system-ui'; c.fillText(String(i), x + 24, y + 9);
    if (i < n) {
      const v = IN.axes[i];
      c.fillStyle = 'rgba(120,220,255,0.9)';
      c.fillRect(x + 105 + Math.min(0, v) * 65, y + 2, Math.abs(v) * 65 + 1, 6);
      if (IN.calib.on) { c.fillStyle = 'rgba(255,200,80,0.8)'; c.fillRect(x + 105 + IN.calMin[i] * 65, y + 1, 1, 8); c.fillRect(x + 105 + IN.calMax[i] * 65, y + 1, 1, 8); }
    }
  }
  for (let s = 0; s < 4; s++) {
    const b = P.rows[s].bar, v = IN.gp[s];
    b.clearRect(0, 0, 70, 10);
    b.fillStyle = 'rgba(255,255,255,0.15)'; b.fillRect(0, 2, 70, 6);
    b.fillStyle = 'rgba(160,255,190,0.9)'; b.fillRect(35 + Math.min(0, v) * 35, 2, Math.abs(v) * 35 + 1, 6);
  }
  for (let a = 0; a < IN.N_ACT; a++) {
    if (IN.learn.action === a) continue;
    const t = bindText(IN.cfgI[IN.C_BIND + a]) + (IN.held[a] ? '  (on)' : '');
    if (P.bindTxt[a].textContent !== t) P.bindTxt[a].textContent = t;
  }
  if (IN.learn.action < 0 && P.wasLearning) { IN.save(); }
  P.wasLearning = IN.learn.action >= 0;
}

export function toggle() {
  if (!P.root) return;
  open[0] = open[0] ? 0 : 1;
  P.root.style.display = open[0] ? 'block' : 'none';
  if (open[0]) { sync(); P.timer = setInterval(live, 100); }
  else { clearInterval(P.timer); IN.learn.action = -1; if (IN.calib.on) P.calBtn.onclick(); }
}
