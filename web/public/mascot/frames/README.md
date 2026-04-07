# Mascot Frames

Source frames for the mascot spritesheet. Each animation is a subdirectory containing numbered PNG files. The build script assembles them into `mascot-sheet.png`, which is what the web app loads at runtime.

```
frames/
  README.md          ← this file
  build.mts          ← assembly script (run once per change)
  idle_spin/         ← 8 frames
  idle_jump/         ← 8 frames
  idle_boop/         ← 8 frames
  idle_crouch/       ← 8 frames
  idle_explode/      ← 8 frames (easter egg)
  walk/              ← 8 frames (facing right; renderer flips H for left)
  drag_start_grab/   ← 16 frames
  drag_idle_calm/    ← 16 frames
  drag_idle_swing/   ← 16 frames
  drag_stop_release/ ← 16 frames
  falling/           ← 16 frames
  landing/           ← 16 frames (also used reversed for jump take-off)
../mascot-sheet.png  ← generated output, never hand-edited
```

## Frame Spec

| Property | Value |
|---|---|
| Frame size | 256 × 256 px |
| Format | PNG with alpha (RGBA) |
| Naming | Zero-padded two digits: `00.png`, `01.png`, … |
| Background | Transparent |

The output sheet is **4096 × 3328 px** (16 columns × 13 rows × 256 px).

`flipH` and `reverse` are renderer-only flags. They require no extra row in the sheet — the build script composites only physical frame directories.

## Animation Reference

These match `src/components/Mascot/mascot-manifest.json` exactly. If you add or rename an animation, update both the manifest and this table.

| Directory | Manifest key(s) | Row | Frames | FPS | Loops | Flags | Description |
|---|---|---|---|---|---|---|---|
| `idle_spin` | `idle_spin` | 0 | 8 | 12 | yes | — | 360° rotation in place |
| `idle_jump` | `idle_jump` | 1 | 8 | 10 | no | — | Small hop, lands back |
| `idle_boop` | `idle_boop` | 2 | 8 | 8 | no | — | Hand up, taps nose |
| `idle_crouch` | `idle_crouch` | 3 | 8 | 8 | no | — | Squats down, comes back up |
| `idle_explode` | `idle_explode` | 4 | 8 | 16 | no | — | Easter egg: triggered by 5 quick clicks |
| `walk` | `walk` | 5 | 8 | 10 | yes | — | Walking cycle, facing right |
| _(same row)_ | `walk_flipped` | 5 | 8 | 10 | yes | `flipH` | Walking left — renderer mirrors `walk` horizontally, no extra row |
| `landing` | `jump_start` | 6 | 16 | 14 | no | `reverse` | Jump take-off — renderer plays `landing` frames in reverse |
| `drag_start_grab` | `drag_start_grab` | 7 | 16 | 10 | no | — | Arms reach up, body goes limp |
| `drag_idle_calm` | `drag_idle_calm` | 8 | 16 | 8 | yes | — | Hanging, mild idle sway |
| `drag_idle_swing` | `drag_idle_swing` | 9 | 16 | 10 | yes | — | Hanging, legs actively kicking |
| `drag_stop_release` | `drag_stop_release` | 10 | 16 | 10 | no | — | Releases grip, arms drop |
| `falling` | `falling` | 11 | 16 | 8 | yes | — | Freefall pose |
| `landing` | `landing` | 12 | 16 | 12 | no | — | Hits ground, absorbs impact, settles |

## Editing Workflow

The recommended tool is **[Aseprite](https://www.aseprite.org/)** (~$20). Work in one `.aseprite` file per animation, then export frames as numbered PNGs:

> File → Export Sprite Sheet → check "Layers" or "Frames" → Output: `frames/<animation_name>/` → Filename: `{frame00}.png`

Any tool that exports numbered PNGs works. The build script only cares about the file names and dimensions.

## Building the Spritesheet

`sharp` must be installed:

```bash
cd web
npm install --save-dev sharp
```

Then run the build script from the `web/` directory:

```bash
npx tsx public/mascot/frames/build.mts
```

Or via the package.json script (add this to `web/package.json`):

```json
"mascot:sprites:build": "tsx public/mascot/frames/build.mts"
```

```bash
pnpm run mascot:sprites:build
```

The script will:

1. Validate that every expected frame file exists (fails loudly with a list of missing files if not)
2. Composite all frames onto a transparent canvas at their correct row/column positions
3. Write `public/mascot/mascot-sheet.png`

The output file is consumed by the web app at runtime via `/mascot/mascot-sheet.png`. It is a build artifact — commit it to the repo so the app works without running the script at deploy time, but never edit it by hand.

## Adding or Changing an Animation

1. Draw the frames and export them to `frames/<animation_key>/00.png` … `NN.png`
2. Update `src/components/Mascot/mascot-manifest.json`:
   - Add/modify the entry with the correct `row`, `frames`, `fps`, and `loop` values
   - If adding a new row, increment all subsequent `row` values and update this README's table
3. Update `src/components/Mascot/types.ts` — add the key to the `AnimationKey` union if it's new
4. Run `pnpm run mascot:sprites:build` from the `web/` directory
5. Verify the output visually (open `mascot-sheet.png` and check the new row looks correct)
