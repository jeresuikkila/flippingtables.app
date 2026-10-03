// Records gameplay clips (1080x1920, 30fps, with the game's own sound) from scenarios.mjs.
//
//   node recorder/rec.mjs --out <dir> <scenario> [<scenario> ...]
//
// Writes <dir>/<scenario>.mp4 per clip and merges each clip's taps into <dir>/taps.js
// (window.__TAPS[scenario] = [{ t, x, y }]: tap times in clip seconds, positions in video pixels).
// The `bank` scenario writes one <dir>/<sound>.wav per game sound effect instead.
//
// How it stays smooth and in sync:
// - A virtual clock replaces performance.now / Date.now / timers / requestAnimationFrame / CSS animations and is
//   stepped one frame at a time, so frames are evenly spaced however slowly headless Chrome renders WebGL.
// - The game's sound is synthesized WebAudio scheduled off AC.currentTime, so AudioContext is swapped for an
//   OfflineAudioContext whose currentTime follows the virtual clock. Rendering it afterwards gives the exact
//   sound track, sample-aligned with the captured frames.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';
import SCENARIOS from './scenarios.mjs';

const FPS = 30, DT = 1000 / FPS, SR = 48000, MAX_SECONDS = 180;
const VIEW = { width: 432, height: 768, deviceScaleFactor: 2.5, isMobile: true, hasTouch: true }; // a phone, captured at 1080x1920
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const SHIM = `(() => {
  let now = 0; const t0 = Date.now();
  const timers = new Map(); let tid = 1; let rafs = [];
  performance.now = () => now;
  Date.now = () => t0 + now;
  const skip = fn => typeof fn === 'function' && fn.name === 'hoursMemo'; // the same "it's 1 AM" memo would land in every clip
  window.setTimeout = (fn, ms = 0, ...a) => { const id = tid++; if (!skip(fn)) timers.set(id, { t: now + Math.max(0, +ms || 0), fn, a }); return id; };
  window.setInterval = (fn, ms = 0, ...a) => { const id = tid++; timers.set(id, { t: now + Math.max(1, +ms || 0), fn, a, every: Math.max(1, +ms || 0) }); return id; };
  window.clearTimeout = window.clearInterval = id => timers.delete(id);
  window.requestAnimationFrame = fn => { const id = tid++; rafs.push({ id, fn }); return id; };
  window.cancelAnimationFrame = id => { rafs = rafs.filter(r => r.id !== id); };
  window.AudioContext = window.webkitAudioContext = function () {
    const ctx = new OfflineAudioContext(2, ${SR} * ${MAX_SECONDS}, ${SR});
    Object.defineProperty(ctx, 'currentTime', { get: () => now / 1000 });
    Object.defineProperty(ctx, 'state', { get: () => 'running' });
    ctx.resume = () => Promise.resolve();
    window.__offline = ctx;
    return ctx;
  };
  window.__step = ms => {
    const target = now + ms;
    for (;;) {
      let best = null;
      for (const [id, r] of timers) if (r.t <= target && (!best || r.t < best[1].t)) best = [id, r];
      if (!best) break;
      const [id, r] = best; now = Math.max(now, r.t);
      if (r.every) r.t += r.every; else timers.delete(id);
      try { typeof r.fn === 'function' ? r.fn(...r.a) : (0, eval)(r.fn); } catch (e) { console.error(e); }
    }
    now = target;
    for (const an of document.getAnimations()) {
      try { if (an.__vt == null) an.__vt = 0; an.pause(); an.__vt += ms; an.currentTime = an.__vt; } catch (e) {}
    }
    const cbs = rafs; rafs = [];
    for (const r of cbs) { try { r.fn(now); } catch (e) { console.error(e); } }
  };
  // render the offline context; return the [start, end) second ranges as one 16-bit stereo WAV (base64)
  window.__renderAudio = async segs => {
    if (!window.__offline) return null;
    const buf = await window.__offline.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    let n = 0; const ranges = segs.map(([a, b]) => { const s = Math.round(a * ${SR}), e = Math.round(b * ${SR}); n += e - s; return [s, e]; });
    const out = new DataView(new ArrayBuffer(44 + n * 4));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true); out.setUint32(24, ${SR}, true);
    out.setUint32(28, ${SR} * 4, true); out.setUint16(32, 4, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * 4, true);
    let o = 44; const q = v => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    for (const [s, e] of ranges) for (let i = s; i < e; i++) { out.setInt16(o, q(L[i] || 0), true); out.setInt16(o + 2, q(R[i] || 0), true); o += 4; }
    const bytes = new Uint8Array(out.buffer); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
})();`;

// A save for `floor`, balanced with the game's own formulas so desks take ~hitsPerDesk taps.
async function makeSave(page, sc) {
  const { arms, reward } = await page.evaluate((f, hits, arms) => {
    if (arms == null) { arms = 0; const target = __g.tableHP(f) / hits; while (__g.dmgAt(arms) < target) arms++; }
    return { arms, reward: __g.tableReward(f) };
  }, sc.floor, sc.hitsPerDesk ?? 2.5, sc.up?.arms ?? null);
  const f = sc.floor;
  return {
    rage: reward * 140, lifetime: reward * 2000, flipped: f * 60, floor: f, best: f, bestEver: f,
    // email stays 0: any Reply-All level triggers a "welcome back" memo on clock-in
    up: { interns: 3, spite: 6, shock: 2, email: 0, chair: 0, retreat: 1, ...sc.up, arms },
    // first-visit memos for desk types would cover the bottom of every clip
    seenStanding: true, seenCorner: true, seenCubicle: true, seenRooms: true,
    ...sc.extra,
  };
}

async function recordOne(browser, url, name, outDir) {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error(`unknown scenario "${name}" (see recorder/scenarios.mjs)`);
  const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), `ft-${name}-`));
  const page = await browser.newPage();
  try {
    await page.emulate({ viewport: VIEW, userAgent: UA });
    page.on('pageerror', e => console.error(`[${name}] page error:`, e.message));
    await page.evaluateOnNewDocument(SHIM);
    await page.goto(url, { waitUntil: 'networkidle0' });
    if (sc.floor) { // boot once to read the game's formulas, write the save, then load it for real
      const save = await makeSave(page, sc);
      await page.evaluate(s => localStorage.setItem('flippingtables-v1', JSON.stringify(s)), save);
      await page.reload({ waitUntil: 'networkidle0' });
    }
    await page.evaluate(() => document.fonts.ready);

    let frame = 0, steps = 0;
    const taps = [], segs = [];
    const g = {
      page, capture: false,
      async frames(n) {
        for (let i = 0; i < n; i++) {
          await page.evaluate(ms => __step(ms), DT);
          steps++;
          if (!this.capture) continue;
          // this frame's sound interval: input handled before the step is heard as the frame shows its effect
          const t = (steps - 1) * DT / 1000, last = segs[segs.length - 1];
          if (last && Math.abs(last[1] - t) < 1e-6) last[1] = t + DT / 1000; else segs.push([t, t + DT / 1000]);
          if (!sc.audioOnly) await page.screenshot({ path: path.join(frameDir, `${String(frame).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 94 });
          frame++;
        }
      },
      async tap(x, y) {
        if (this.capture) taps.push({ t: +(frame / FPS).toFixed(3), x: Math.round(x * VIEW.deviceScaleFactor), y: Math.round(y * VIEW.deviceScaleFactor) });
        await page.touchscreen.tap(x, y);
      },
      async tapSel(sel) {
        const b = await page.$eval(sel, el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        await this.tap(b.x, b.y);
      },
      async tapDesk() {
        const p = await page.evaluate(() => {
          const live = __g.tables.filter(t => !t.dead && t.room === __g.activeRoom);
          const pool = live.length ? live : __g.tables.filter(t => !t.dead);
          if (!pool.length) return null;
          pool.sort((a, b) => (a.hp / a.max) - (b.hp / b.max)); // finish what you started
          const v = pool[0].g.position.clone(); v.y += 0.5; v.project(__g.camera);
          return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight };
        });
        // stay clear of the HUD and the shop bar, and skip desks the camera hasn't reached yet
        if (p && p.x > 10 && p.y > 130 && p.x < VIEW.width - 10 && p.y < 640) await this.tap(p.x, p.y);
      },
    };

    await g.frames(20); // let the floor build before anything is captured
    g.capture = true;
    await sc.run(g, sc);

    const wav = await page.evaluate(s => __renderAudio(s), segs);
    const wavPath = path.join(frameDir, 'audio.wav');
    if (wav) fs.writeFileSync(wavPath, Buffer.from(wav, 'base64'));

    if (sc.audioOnly) {
      if (!wav) throw new Error(`[${name}] no audio was produced`);
      Object.entries(sc.sounds).forEach(([sound, len], i) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(i * 3), '-t', String(len), '-i', wavPath, '-c:a', 'pcm_s16le', path.join(outDir, `${sound}.wav`)]));
      console.log(`${name}: ${Object.keys(sc.sounds).length} sounds -> ${outDir}`);
      return;
    }
    const args = ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', path.join(frameDir, '%05d.jpg')];
    if (wav) args.push('-i', wavPath);
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'slow');
    if (wav) args.push('-c:a', 'aac', '-b:a', '192k');
    args.push('-movflags', '+faststart', path.join(outDir, `${name}.mp4`));
    execFileSync('ffmpeg', args);
    mergeTaps(outDir, name, taps);
    console.log(`${name}: ${(frame / FPS).toFixed(2)}s, ${taps.length} taps, ${wav ? 'with' : 'NO'} sound -> ${path.join(outDir, name + '.mp4')}`);
  } finally {
    await page.close();
    fs.rmSync(frameDir, { recursive: true, force: true });
  }
}

function mergeTaps(outDir, name, taps) {
  const file = path.join(outDir, 'taps.js');
  let all = {};
  if (fs.existsSync(file)) all = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^[^{]*/, '').replace(/;\s*$/, ''));
  all[name] = taps;
  fs.writeFileSync(file, `// generated by recorder/rec.mjs\nwindow.__TAPS = ${JSON.stringify(all)};\n`);
}

export async function record(names, outDir, { concurrency = Math.max(1, Math.min(3, os.cpus().length >> 2)) } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const { server, url } = await serve();
  const browser = await puppeteer.launch({
    headless: 'shell', protocolTimeout: 600000,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
  });
  try {
    const queue = [...names];
    const worker = async () => { while (queue.length) await recordOne(browser, url, queue.shift(), outDir); };
    await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  } finally {
    await browser.close();
    server.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const o = argv.indexOf('--out');
  if (o < 0 || !argv[o + 1]) { console.error('usage: node recorder/rec.mjs --out <dir> <scenario> [<scenario> ...]'); process.exit(1); }
  const outDir = argv[o + 1];
  const names = argv.filter((_, i) => i !== o && i !== o + 1);
  if (!names.length) { console.error(`scenarios: ${Object.keys(SCENARIOS).join(', ')}`); process.exit(1); }
  await record(names, outDir);
}
