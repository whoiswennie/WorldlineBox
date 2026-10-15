# Three-frame sprite registration

Each of the 15 characters keeps 31 independently authored, three-cell action images. The PNG/WebP pixels are not moved, stretched, repainted, or shared between actions. Frame source rectangles remain the exact three equal cells. Per-frame registration metadata attaches those pixels to the actor's physical ground, seat, or bed.

The original renderer used one canvas origin for every grounded frame, although characters were drawn at different horizontal positions inside their cells. Some seated sources also declared the same seat point for all three differently positioned figures. The complete 465-sheet scan estimated horizontal body offsets above 8 pixels in 398 sheets, with a maximum range of 188.414 pixels. These are screening measurements, including deliberate changing poses; they are not a claim that every measured displacement is an error.

`src/shared/companion-world-art-calibration.ts` matches a compact face, neck, and trunk region between frames. A skin-colour connected component supplies the initial search location. Capped RGB differences make changed eyes, mouths, and hands less influential; long hair, tails, an outstretched arm, and alternating running feet do not determine a whole-image centroid. The stored registration translates the source cell's attachment point instead of translating the world actor.

Grounded stationary gestures use the measured floor. Walking, running, following, exercise, and turns use a shared ground plane, so airborne frames and deliberate body motion remain visible. Seat and bed attachment heights preserve semantic contact metadata; sitting down, standing up, lying down, waking, bending, and rolling are not flattened into a stationary standing pose. Scale is constant across the three frames of one action. Mirroring applies to both the UV interval and attachment point in the renderer.

`getCompanionWorldFramePlacement` supplies the renderer with the exact source rectangle, source-image dimensions, registered anchor, semantic pose, and world tiles per source pixel. Pixel analysis runs only when authoring or calibrating assets, never on an animation frame. The renderer also insets UVs by half a source texel to prevent linear filtering from sampling an adjacent cell.

Reproduce the complete scan and before/after galleries with:

```powershell
node scripts/companion-world-art.mjs calibrate artifacts/companions/world-art-calibration
node scripts/companion-world-art.mjs verify
node scripts/run-vitest-with-electron.mjs run tests/unit/companion-world-art-calibration.test.ts
```

`report.json` records all 465 actions, matching regions, translation estimates, residual colour differences, and the 1,395 resulting anchors. Each character gallery includes every action: the upper row uses the former origin (red axes), and the lower row uses the registered anchor (green axes). All 15 complete galleries were inspected. A high residual is expected for strong pose changes such as lying down and exercise; it is a review cue, not proof of faulty art. Tests separately exercise a large arm gesture, unequal transparent framing, retained running/exercise vertical movement, semantic furniture contact, and complete built-in coverage.

Import and registration perform the same calibration before saving the manifest. Manifest replacement uses a temporary file and atomic rename so readers cannot observe a partially written declaration. Verification still checks every image hash, independent source, transparent frame, complete contour, and semantic contact.
