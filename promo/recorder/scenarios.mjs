// Every recordable clip. A scenario is a save to start from plus a script of taps.
//
//   floor        start on this floor (the save is generated; omit for a brand-new player)
//   hitsPerDesk  Forearm Day is levelled so a normal desk takes about this many taps (uses the game's own formulas)
//   up           upgrade levels to override (an explicit `arms` wins over hitsPerDesk)
//   extra        any other save fields
//   audioOnly    record sound only (no frames)
//   run(g)       the script. g.frames(n) advances n frames at 30fps, g.capture toggles whether frames are kept,
//                g.tapDesk() taps the most-damaged desk in the current room, g.tapSel(css) taps a UI element.
//
// Captured video starts when run() starts. Turn capture off to fast-forward.

// clock in, let the title card fade, then hammer desks room by room
export const floorRun = (taps, gap = 3, tail = 12) => async (g) => {
  await g.tapSel('#startBtn');
  g.capture = false; await g.frames(9); g.capture = true; // the title card's 0.5s fade is mostly done
  await g.frames(10);
  for (let i = 0; i < taps; i++) { await g.tapDesk(); await g.frames(gap); }
  await g.frames(tail);
};

// fast-forward to one desk left, flip it on camera, take the elevator, then fight the next floor's table
export const elevatorRun = ({ bossTaps = 26, settle = 45, ride = 62 } = {}) => async (g) => {
  await g.tapSel('#startBtn');
  g.capture = false;
  for (let guard = 0; guard < 800; guard++) {
    const left = await g.page.evaluate(() => __g.tables.filter(t => !t.dead).length);
    if (left <= 1) break;
    await g.tapDesk(); await g.frames(3);
  }
  await g.frames(settle);
  g.capture = true;
  await g.frames(6);
  // the last desk may be a heavy one: keep at it until the game calls the floor cleared
  for (let i = 0; i < 60 && !(await g.page.evaluate(() => __g.cleared)); i++) { await g.tapDesk(); await g.frames(4); }
  await g.frames(36); // floor-cleared jingle, elevator lamp, then the button appears
  await g.tapSel('#elevBtn');
  await g.frames(ride);
  for (let i = 0; i < bossTaps; i++) { await g.tapDesk(); await g.frames(3); }
  await g.frames(30);
};

export default {
  // ---------------------------------------------------------------- shorts/clicker
  // brand-new player: title screen -> floor 1, three one-tap desks
  fresh: { run: async (g) => {
    await g.frames(18);
    await g.tapSel('#startBtn');
    await g.frames(36);
    for (let i = 0; i < 3; i++) { await g.tapDesk(); await g.frames(14); }
    await g.frames(40);
  } },
  midgame: { floor: 14, up: { arms: 12, interns: 6, spite: 8, shock: 3, chair: 2, retreat: 2 }, run: floorRun(40, 3, 15) },
  elevator: { floor: 9, up: { arms: 14, interns: 0, spite: 4, shock: 0 }, run: elevatorRun({ bossTaps: 10, settle: 60, ride: 75 }) },

  // ---------------------------------------------------------------- shorts/floor-tour
  scranton: { floor: 7, hitsPerDesk: 2, run: floorRun(38) },
  server: { floor: 12, hitsPerDesk: 3, run: floorRun(40) },
  breakroom: { floor: 15, hitsPerDesk: 2, run: floorRun(40) },
  macrodata: { floor: 23, hitsPerDesk: 1.2, up: { shock: 4 }, run: floorRun(44) },
  openplan: { floor: 33, hitsPerDesk: 2.5, run: floorRun(40) },
  boss: { floor: 29, hitsPerDesk: 0.9, up: { interns: 0, shock: 3 }, run: elevatorRun() },

  // ---------------------------------------------------------------- shorts/special-floors
  // floor 2 hides the Red Stapler in its last desk
  accounting: { floor: 2, up: { arms: 0, interns: 0, spite: 0, shock: 0 }, run: floorRun(14, 6, 60) },
  itcrowd: { floor: 3, hitsPerDesk: 2, up: { interns: 1 }, run: floorRun(26, 4) },
  initech: { floor: 5, hitsPerDesk: 2, up: { interns: 2 }, run: floorRun(32, 4) },
  lumon: { floor: 23, hitsPerDesk: 1.2, up: { shock: 4 }, run: floorRun(44) },
  notfound: { floor: 404, hitsPerDesk: 2, run: floorRun(40) },
  csuite: { floor: 99, hitsPerDesk: 0.9, up: { interns: 0, shock: 3 }, run: elevatorRun({ bossTaps: 30 }) },

  // ---------------------------------------------------------------- the game's sound effects, one every 3 seconds
  // sounds: name -> seconds to keep. Written as <out>/<name>.wav.
  bank: { audioOnly: true, sounds: { ding: 2.6, doors: 0.9, thump: 0.8, flip: 0.6, cadence: 1.4, crit: 0.6, buy: 0.4, relic: 0.8 }, run: async (g, sc) => {
    await g.tapSel('#startBtn');
    g.capture = false; await g.frames(30); g.capture = true;
    for (const name of Object.keys(sc.sounds)) {
      await g.page.evaluate(n => n === 'thump' ? __g.sfx.thump(true) : __g.sfx[n](), name);
      await g.frames(90);
    }
  } },
};
