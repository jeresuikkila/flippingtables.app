// Builds an elevator-tour Short (shorts/<name>/index.html) from templates/elevator-tour.html + shorts/<name>/short.json.
//
//   node scripts/build-tour.mjs <short-dir>
//
// Layout: hook (2.6s) -> one beat per recorded clip, each introduced by elevator doors + the game's ding -> end panel -> CTA.
// Beat starts are cumulative; each beat's `dur` must fit inside its clip (checked with ffprobe when clips exist).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_DUR = 2.6, CTA_DUR = 4;
// game sounds (recorded by the `bank` scenario): how long each is, and its Studio lane (display only; overlap is intended)
const SFX = { thump: [0.8, 4], flip: [0.6, 5], doors: [0.9, 2], ding: [2.6, 3], cadence: [1.4, 4], relic: [0.8, 5] };

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r3 = n => Math.round(n * 1000) / 1000;

function clipLength(file) {
  try { return +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim(); }
  catch { return null; }
}

// fonts live once in promo/fonts; each short gets a copy (gitignored) because HyperFrames resolves assets per project
export function copyFonts(dir) {
  fs.mkdirSync(path.join(dir, 'assets/fonts'), { recursive: true });
  for (const f of fs.readdirSync(path.join(PROMO, 'fonts'))) fs.copyFileSync(path.join(PROMO, 'fonts', f), path.join(dir, 'assets/fonts', f));
}

export function buildTour(dir) {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'short.json'), 'utf8'));
  let t = HOOK_DUR;
  const beats = cfg.beats.map(b => {
    const beat = { ...b, id: b.scenario, start: r3(t), mstart: b.mstart ?? 0 };
    const len = clipLength(path.join(dir, 'assets/clips', `${b.scenario}.mp4`));
    if (len != null && beat.mstart + b.dur > len + 0.01) throw new Error(`${b.scenario}: dur ${b.dur}s + mstart ${beat.mstart}s runs past the ${len.toFixed(2)}s clip`);
    t += b.dur;
    return beat;
  });
  const ctaStart = r3(t), total = r3(t + CTA_DUR);
  const doors = [...beats.map(b => ({ t: b.start, floor: b.floor, dept: b.dept })), { t: ctaStart, ...cfg.end }];

  const beatsHtml = beats.map(b => `
        <!-- Floor ${esc(b.floor)}: real gameplay, with the game's own sound -->
        <div class="vw" id="${b.id}-vw">
          <video id="${b.id}" class="clip" src="assets/clips/${b.id}.mp4" data-start="${b.start}" data-duration="${b.dur}" data-media-start="${b.mstart}" data-track-index="1" data-has-audio="true" data-volume="1" playsinline></video>
          <div id="${b.id}-taps"></div>
        </div>
        <section id="${b.id}-ui" class="scene clip" data-start="${b.start}" data-duration="${b.dur}" data-track-index="0">${b.caps.map(([text], k) => `
          <div class="cap" id="${b.id}-cap${k}"><span>${esc(text)}</span></div>`).join('')}
        </section>`).join('\n').trim();

  const panels = doors.map((d, i) => `
      <div class="panel" id="panel${i}"><span class="led">▲ ${esc(d.floor)}</span><span class="dept">${esc(d.dept)}</span></div>`).join('').trim();

  const sfx = [['hook-thump', 'thump', 1.38, 0.9], ['hook-flip', 'flip', 1.45, 0.8]];
  doors.forEach((d, i) => sfx.push([`door${i}`, 'doors', r3(d.t - 0.64), 0.45], [`ding${i}`, 'ding', r3(d.t - 0.36), 0.7]));
  sfx.push(['cta-cadence', 'cadence', r3(ctaStart + 0.95), 1.0], ['cta-relic', 'relic', r3(ctaStart + 2.2), 0.9]);
  const sfxHtml = sfx.map(([id, name, at, vol]) => `
      <audio id="sfx-${id}" src="assets/sfx/${name}.wav" data-start="${at}" data-duration="${SFX[name][0]}" data-track-index="${SFX[name][1]}" data-volume="${vol}"></audio>`).join('').trim();

  const lines = cfg.hook.lines;
  const hookLines = lines.map((l, i) => `
            <span class="line display${i === lines.length - 1 ? ' accent' : ''}">${esc(l)}</span>`).join('');
  // Archivo Black caps run ~0.7em wide: size the hook so its longest line fits the 920px column
  const hookSize = Math.min(140, Math.floor(920 / (0.7 * Math.max(...lines.map(l => l.length)))));

  const beatsJs = beats.map(b => ({ id: b.id, start: b.start, dur: b.dur, mstart: b.mstart, caps: b.caps.map(([, a, z]) => ({ from: r3(b.start + a), to: r3(b.start + z) })) }));

  const vars = {
    TOTAL: total, CTA_START: ctaStart, CTA_DUR, HOOK_SIZE: hookSize, HOOK_KICKER: esc(cfg.hook.kicker), HOOK_LINES: hookLines,
    CTA_SUB: cfg.cta.sub, CTA_FINE: esc(cfg.cta.fine), // sub may carry <b> emphasis
    BEATS: beatsHtml, PANELS: panels, SFX: sfxHtml, BEATS_JSON: JSON.stringify(beatsJs), DOORS_JSON: JSON.stringify(doors.map(d => ({ t: d.t }))),
  };
  const html = fs.readFileSync(path.join(PROMO, 'templates/elevator-tour.html'), 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`template placeholder ${m} has no value`);
    return vars[k];
  });
  fs.writeFileSync(path.join(dir, 'index.html'), html);

  copyFonts(dir);
  console.log(`built ${path.relative(PROMO, dir)}/index.html: ${beats.length} floors, ${total}s`);
  return { total };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) { console.error('usage: node scripts/build-tour.mjs <short-dir>'); process.exit(1); }
  buildTour(path.resolve(process.argv[2]));
}
