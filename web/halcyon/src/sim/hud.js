// Minimal flight HUD: system font, small caps, 70% white, no boxes. Text changes at most 4x per second and only
// when the value changed, using string tables built at attach (no per-frame strings). Sticks and the compass tick
// are drawn on small 2D canvases with no per-frame allocations. Optional: ?hud=0, H key.

const FLIGHT = ['gps', 'angle', 'acro'];
const CAMS = ['fpv', 'chase', 'line of sight'];
const REALMS = ['home fjords', 'painted range', 'mirror salt', 'stone forest', 'aurora ice', 'lumen deep'];
// the compass names the next destination, not where the drone is: "to <realm>" (built once, no per-frame strings)
const DEST = REALMS.map((n) => 'to ' + n);
const STATUS = ['', 'crashed', 'transit', 'landed', 'all realms visited'];

const H = {
  root: null, mode: null, tele: null, spd: null, agl: null, compName: null, compDist: null, comp: null, compText: null, status: null, rings: null, help: null,
  sl: null, sr: null, cl: null, cr: null, cc: null, ccx: null,
  modeStr: null, speedStr: null, aglStr: null, distStr: null, ringStr: null,
};
const last = new Int32Array(16).fill(-999);
const T = new Float64Array(4); // timer, visible, dpr, helpShown
export const visible = new Uint8Array(1);

const SZ = 76; // stick box CSS px

// help: false skips the centred key help (the page shows its own start overlay)
export function attach(canvas, show, help) {
  if (typeof document === 'undefined') return;
  const parent = canvas && canvas.parentElement ? canvas.parentElement : document.body;
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:10;font:500 13px system-ui,-apple-system,"Segoe UI",sans-serif;' +
    'font-variant:all-small-caps;letter-spacing:0.08em;color:rgba(255,255,255,0.7);text-shadow:0 0 3px rgba(0,0,0,0.45);user-select:none';
  const el = (css) => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;white-space:pre;' + css; root.appendChild(d); return d; };
  H.mode = el('left:18px;top:14px');
  H.status = el('left:0;right:0;top:44px;text-align:center;font-size:15px');
  H.rings = el('right:18px;top:14px');
  H.tele = el('left:50%;bottom:18px;transform:translateX(-50%);text-align:center;font-size:15px');
  H.compText = el('left:0;right:0;top:30px;text-align:center;font-size:11px');
  const span = (p, css) => { const d = document.createElement('span'); d.style.cssText = css; p.appendChild(d); return d; };
  H.spd = span(H.tele, ''); H.agl = span(H.tele, 'margin-left:2.2em');
  H.compName = span(H.compText, ''); H.compDist = span(H.compText, 'margin-left:1em');
  const dpr = Math.min(2, (globalThis.devicePixelRatio || 1));
  T[2] = dpr;
  const cv = (css, w, h) => {
    const c = document.createElement('canvas'); c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.cssText = 'position:absolute;width:' + w + 'px;height:' + h + 'px;' + css; root.appendChild(c);
    const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); return x;
  };
  H.cl = cv('left:18px;bottom:16px', SZ, SZ);
  H.cr = cv('right:18px;bottom:16px', SZ, SZ);
  H.ccx = cv('left:50%;top:12px;margin-left:-90px', 180, 16);
  H.help = el('left:50%;top:50%;transform:translate(-50%,-50%);text-align:left;font-size:14px;line-height:1.7;' +
    'transition:opacity 1.5s ease;opacity:' + (help === false ? '0' : '1'));
  H.help.textContent =
    'wasd  left stick (throttle / climb, yaw)      arrows  right stick (pitch, roll)\n' +
    'f  flight mode (gps / angle / acro)      x  normal / sport      space or shift  boost (gps)\n' +
    'c  camera (fpv / chase / line of sight)      q e  gimbal tilt      r  reset\n' +
    '1-6  jump to a realm      n  next realm      h  hud      m  mute      p  controller settings\n' +
    'gamepads and usb rc transmitters work; map them in settings (p). mode 2 by default.';
  parent.appendChild(root);
  H.root = root;
  setTimeout(() => { if (H.help) H.help.style.opacity = '0'; }, 12000);

  // string tables
  H.modeStr = [];
  for (let f = 0; f < 3; f++) for (let s = 0; s < 2; s++) for (let c = 0; c < 3; c++) {
    const sub = f === 0 ? (s ? ' sport' : ' normal') : '';
    H.modeStr.push(FLIGHT[f] + sub + '   ' + CAMS[c]);
  }
  H.speedStr = []; H.aglStr = [];
  for (let i = 0; i <= 999; i++) { H.speedStr.push(i + ' m/s'); H.aglStr.push(i + ' m'); }
  H.distStr = [];
  for (let i = 0; i <= 300; i++) H.distStr.push((i / 10).toFixed(1) + ' km');
  H.ringStr = [];
  for (let i = 0; i <= 999; i++) H.ringStr.push('rings ' + i);
  visible[0] = show ? 1 : 0;
  last.fill(-999);
  root.style.display = show ? 'block' : 'none';
}

export function toggle() {
  if (!H.root) return;
  visible[0] = visible[0] ? 0 : 1;
  last.fill(-999);
  H.root.style.display = visible[0] ? 'block' : 'none';
}
export function hideHelp() { if (H.help) H.help.style.opacity = '0'; }

// x, y: dot centre in integer pixels (Smis: nothing is boxed for the canvas calls)
function drawStick(c, x, y) {
  c.clearRect(0, 0, SZ, SZ);
  c.strokeStyle = 'rgba(255,255,255,0.45)';
  c.lineWidth = 1;
  c.beginPath(); c.arc(SZ * 0.5, SZ * 0.5, SZ * 0.5 - 2, 0, 6.2832); c.stroke();
  c.beginPath(); c.moveTo(SZ * 0.5, 6); c.lineTo(SZ * 0.5, SZ - 6); c.moveTo(6, SZ * 0.5); c.lineTo(SZ - 6, SZ * 0.5);
  c.strokeStyle = 'rgba(255,255,255,0.18)'; c.stroke();
  c.fillStyle = 'rgba(255,255,255,0.8)';
  c.beginPath(); c.arc(x, y, 4, 0, 6.2832); c.fill();
}

// x: tick position in integer pixels; has: target exists
function drawCompass(x, has) {
  const c = H.ccx;
  c.clearRect(0, 0, 180, 16);
  c.fillStyle = 'rgba(255,255,255,0.35)';
  c.fillRect(10, 8, 160, 1);
  c.fillRect(89.5, 4, 1, 9);
  if (!has) return;
  c.fillStyle = 'rgba(255,255,255,0.85)';
  c.fillRect(x - 1, 2, 2, 12);
}

export const ARG = new Float64Array(6); // [dt, speed m/s, height above ground m, distance km, compass rel rad]

// per frame. phys: physical sticks [LX, LY, RX, RY]
export function update(phys, flight, sport, cam, status, realm, rings) {
  if (!H.root || !visible[0]) return;
  const dt = ARG[0], speed = ARG[1], agl = ARG[2], distKm = ARG[3], rel = ARG[4];
  const r0 = SZ * 0.5 - 7;
  const xl = (SZ * 0.5 + phys[0] * r0) | 0, yl = (SZ * 0.5 - phys[1] * r0) | 0;
  const xr = (SZ * 0.5 + phys[2] * r0) | 0, yr = (SZ * 0.5 - phys[3] * r0) | 0;
  if (xl !== last[6] || yl !== last[7]) { last[6] = xl; last[7] = yl; drawStick(H.cl, xl, yl); }
  if (xr !== last[8] || yr !== last[9]) { last[8] = xr; last[9] = yr; drawStick(H.cr, xr, yr); }
  let cx = 90 - rel / (Math.PI * 0.5) * 80;
  cx = (cx < 10 ? 10 : cx > 170 ? 170 : cx) | 0;
  if (cx !== last[10] || realm !== last[11]) { last[10] = cx; last[11] = realm; drawCompass(cx, realm >= 0); }
  T[0] += dt;
  if (T[0] < 0.25) return;
  T[0] = 0;
  const mi = (flight * 2 + (sport ? 1 : 0)) * 3 + cam;
  if (mi !== last[0]) { last[0] = mi; H.mode.textContent = H.modeStr[mi]; }
  let s = Math.round(speed); if (s > 999) s = 999; if (s < 0) s = 0;
  let a = Math.round(agl); if (a > 999) a = 999; if (a < 0) a = 0;
  if (s !== last[1] || a !== last[2]) {
    last[1] = s; last[2] = a;
    H.spd.textContent = H.speedStr[s];
    H.agl.textContent = H.aglStr[a];
  }
  if (status !== last[3]) { last[3] = status; H.status.textContent = STATUS[status]; }
  let d = Math.round(distKm * 10); if (d > 300) d = 300;
  const ck = realm < 0 ? -1 : realm * 1000 + d;
  if (ck !== last[4]) {
    last[4] = ck;
    H.compName.textContent = realm < 0 ? '' : DEST[realm];
    H.compDist.textContent = realm < 0 ? '' : H.distStr[d];
  }
  let r = rings > 999 ? 999 : rings;
  if (r !== last[5]) { last[5] = r; H.rings.textContent = H.ringStr[r]; }
}
