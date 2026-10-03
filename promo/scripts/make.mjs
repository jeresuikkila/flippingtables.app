// One command per Short: record missing clips -> build (elevator tours) -> render -> loudness-normalize.
//
//   npm run make -- <short> [--rerecord] [--no-render] [--small]
//
//   --rerecord   record every clip again, not just missing ones
//   --no-render  stop after recording/building (e.g. to preview with `npx hyperframes preview` in the short's folder)
//   --small      also write renders/<short>-small.mp4 (under 30 MB, for sharing)
//
// Output: promo/renders/<short>.mp4 (1080x1920, 30fps, audio at YouTube's -14 LUFS).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record } from '../recorder/rec.mjs';
import { buildTour, copyFonts } from './build-tour.mjs';

const PROMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.find(a => !a.startsWith('--'));
const flag = f => args.includes(f);
if (!name) {
  console.error(`usage: npm run make -- <short> [--rerecord] [--no-render] [--small]\nshorts: ${fs.readdirSync(path.join(PROMO, 'shorts')).join(', ')}`);
  process.exit(1);
}
const dir = path.join(PROMO, 'shorts', name);
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'short.json'), 'utf8'));
const tour = cfg.type === 'elevator-tour';

// ---- record
const clipsDir = path.join(dir, 'assets/clips');
const scenarios = tour ? cfg.beats.map(b => b.scenario) : cfg.scenarios;
const todo = scenarios.filter(s => flag('--rerecord') || !fs.existsSync(path.join(clipsDir, `${s}.mp4`)));
if (todo.length) await record(todo, clipsDir);
if (tour && (flag('--rerecord') || !fs.existsSync(path.join(dir, 'assets/sfx/ding.wav')))) await record(['bank'], path.join(dir, 'assets/sfx'));

// ---- build
if (tour) buildTour(dir); else copyFonts(dir);
if (flag('--no-render')) process.exit(0);

// ---- render with the short's pinned HyperFrames, then normalize loudness
const pin = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts?.render || '').match(/hyperframes@[\d.]+/)?.[0] || 'hyperframes';
const out = path.join(PROMO, 'renders');
fs.mkdirSync(out, { recursive: true });
const raw = path.join(out, `${name}.raw.mp4`), final = path.join(out, `${name}.mp4`);
execFileSync('npx', ['--yes', pin, 'render', '-q', 'high', '-f', '30', '-o', raw], { cwd: dir, stdio: 'inherit' });
const hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', raw]).toString().trim() !== '';
if (hasAudio) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', raw, '-c:v', 'copy', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', final]);
  fs.rmSync(raw);
} else fs.renameSync(raw, final);
if (flag('--small')) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', final, '-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', path.join(out, `${name}-small.mp4`)]);
console.log(`\n${path.relative(process.cwd(), final)}${hasAudio ? ' (loudness-normalized)' : ' (silent)'}`);
