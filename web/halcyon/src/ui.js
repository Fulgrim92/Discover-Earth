// ui.js: the few DOM pieces outside the HUD: the start overlay, full-page messages (no WebGPU, no adapter,
// device lost, errors) and the bench summary. Nothing here runs per frame.

const FONT = 'font:500 14px system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0.06em;color:rgba(255,255,255,0.78)';

function el(css, parent) {
  const d = document.createElement('div');
  d.style.cssText = css;
  (parent || document.body).appendChild(d);
  return d;
}

// Start overlay: title, one call to action, three lines of controls. Fades out on the first gesture, once the
// pipelines have compiled: until then the call to action is a progress line (progress(done, total) from gpu.js).
export function startOverlay(onStart) {
  const o = el('position:fixed;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'background:radial-gradient(ellipse at 50% 55%,rgba(0,0,0,0.05),rgba(0,0,0,0.45));transition:opacity 1.2s ease;cursor:pointer;' + FONT);
  const t = el('font-size:44px;font-weight:200;letter-spacing:0.55em;margin-left:0.55em;color:rgba(255,255,255,0.92);text-shadow:0 0 18px rgba(0,0,0,0.35)', o);
  t.textContent = 'HALCYON';
  const s = el('margin-top:8px;font-size:12px;letter-spacing:0.32em;font-variant:all-small-caps;opacity:0.7', o);
  s.textContent = 'a drone atlas of earth and beyond';
  const c = el('margin-top:44px;font-size:16px;letter-spacing:0.18em;font-variant:all-small-caps', o);
  const CTA = 'click or press any button to fly';
  c.textContent = 'preparing';
  const bar = el('margin-top:10px;width:180px;height:1px;background:rgba(255,255,255,0.18)', o);
  const fill = el('height:1px;width:0;background:rgba(255,255,255,0.75);transition:width 0.25s ease', bar);
  let ready = false;
  const k = el('margin-top:30px;font-size:13px;line-height:1.9;text-align:center;font-variant:all-small-caps;opacity:0.72;white-space:pre', o);
  k.textContent = 'w a s d  climb and yaw  ·  arrows  fly forward and sideways\n' +
    'f  gps / angle / acro  ·  c  camera  ·  space  boost  ·  r  reset\n' +
    '1-6  realms  ·  h  hud  ·  m  mute  ·  p  gamepad and rc transmitter setup';
  let done = false;
  const go = () => {
    if (done || !ready) return;
    done = true;
    o.style.opacity = '0'; o.style.pointerEvents = 'none';
    setTimeout(() => o.remove(), 1400);
    removeEventListener('pointerdown', go, true); removeEventListener('keydown', go, true);
    if (onStart) onStart();
  };
  addEventListener('pointerdown', go, true);
  addEventListener('keydown', go, true);
  const progress = (k, n) => {
    if (ready) return;
    fill.style.width = (n > 0 ? Math.round((180 * k) / n) : 180) + 'px';
    if (k >= n) { ready = true; c.textContent = CTA; bar.style.transition = 'opacity 0.8s'; bar.style.opacity = '0'; o.style.cursor = 'pointer'; }
    else c.textContent = 'preparing shaders  ' + k + ' / ' + n;
  };
  o.style.cursor = 'progress';
  return { dismiss: go, progress, get done() { return done; } };
}

const MSG = {
  nogpu: ['This browser cannot run HALCYON yet',
    'HALCYON draws everything with WebGPU, which this browser does not offer (or has turned off).\n' +
    'It runs in current desktop Chrome, Edge and Opera, and in Safari 26 or newer.\n' +
    'In Firefox it needs version 141+ on Windows, or dom.webgpu.enabled in about:config elsewhere.'],
  noadapter: ['No graphics adapter available',
    'WebGPU is present but did not offer a graphics adapter. Usually hardware acceleration is off\n' +
    '(Chrome: Settings > System > Use graphics acceleration), the GPU is blocklisted, or the driver needs an update.\n' +
    'chrome://gpu shows what Chrome sees.'],
};

// Full-page message over whatever is drawn (or the black page). kind: 'nogpu' | 'noadapter' | 'lost' | 'error'
export function showMessage(kind, detail) {
  let title, body;
  if (MSG[kind]) [title, body] = MSG[kind];
  else if (kind === 'lost') {
    title = 'The graphics device was lost';
    body = 'The GPU driver reset or another program took the GPU' + (detail ? ' (' + detail + ')' : '') + '.\nReload the page to fly again.';
  } else {
    title = 'Something went wrong';
    body = 'HALCYON hit an error it cannot recover from. Reloading usually helps.';
  }
  const prev = document.getElementById('halcyon-msg');
  if (prev) prev.remove();
  const o = el('position:fixed;inset:0;z-index:30;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'background:#05070c;text-align:center;padding:24px;' + FONT);
  o.id = 'halcyon-msg';
  const t = el('font-size:22px;font-weight:300;letter-spacing:0.12em;color:rgba(255,255,255,0.9)', o);
  t.textContent = title;
  const b = el('margin-top:18px;font-size:14px;line-height:1.8;max-width:760px;white-space:pre-line;opacity:0.8', o);
  b.textContent = body;
  if (kind === 'lost' || kind === 'error') {
    const r = el('margin-top:28px;padding:8px 22px;border:1px solid rgba(255,255,255,0.4);border-radius:3px;cursor:pointer;letter-spacing:0.2em;font-variant:all-small-caps', o);
    r.textContent = 'reload';
    r.onclick = () => location.reload();
  }
  if (kind === 'error' && detail) {
    const d = el('margin-top:22px;font:11px ui-monospace,monospace;max-width:90vw;max-height:30vh;overflow:auto;white-space:pre-wrap;text-align:left;opacity:0.55', o);
    d.textContent = String(detail).slice(0, 4000);
  }
}

// bench summary panel (end of ?bench=1)
export function benchPanel(r) {
  const o = el('position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:25;background:rgba(5,8,14,0.82);' +
    'padding:22px 28px;border-radius:4px;' + FONT + ';font-size:13px');
  const row = (k, s) => (s ? k.padEnd(12) + ['avg', 'p50', 'p99', 'max'].map((x) => s[x].toFixed(2).padStart(8)).join('') : '');
  const lines = ['HALCYON bench  ' + r.frames + ' frames  ' + r.w + 'x' + r.h + '  scale ' + r.scale + '  quality ' + r.quality,
    ''.padEnd(12) + ['avg', 'p50', 'p99', 'max'].map((x) => x.padStart(8)).join(''),
    row('frame ms', r.frameMs), row('cpu ms', r.cpuMs)];
  if (r.gpuMs) {
    lines.push(row('gpu ms', r.gpuMs));
    for (const k in r.gpuPassMs) lines.push(row('  ' + k, r.gpuPassMs[k]));
  } else lines.push('gpu: no timestamp-query on this device (frame delta only)');
  lines.push('', 'JSON: window.__halcyon.bench (also printed to the console)');
  o.style.whiteSpace = 'pre'; o.style.fontFamily = 'ui-monospace,Menlo,Consolas,monospace';
  o.textContent = lines.filter((x) => x !== '').join('\n');
}
