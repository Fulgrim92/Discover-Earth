# HALCYON sim API (src/sim)

Plain ES modules, no dependencies, no GPU imports. One sim per page (module-level state; `createSim` resets it).
Tests: `node --expose-gc tools/simtest.mjs` (from `web/halcyon/`).

## Conventions (read these first)

- **World**: metres, **Y up**, right-handed, sea level `y = 0`. **Yaw 0 looks down -Z**; +X is right at yaw 0.
- **Yaw angles** (heading, `info[6]`, wind direction): radians about world +Y, right-hand rule, so **positive
  yaw turns left** (counter-clockwise seen from above): heading `psi` faces `(-sin psi, 0, -cos psi)`.
- **Body axes** (drone and camera alike): **+X right, +Y up (thrust axis / camera up), -Z forward (nose / view
  direction)**. This is the usual WebGPU/GL camera convention, so `sim.cam`'s quaternion is directly the camera's
  rotation (camera-to-world); the view matrix is its inverse.
- **Quaternions are `[x, y, z, w]`** (w last) and rotate **body -> world**: `v_world = q * v_body * q^-1`.
  They are unit length. Identity = level, nose toward -Z.
- **Sticks** (`setXRSticks`, gamepads, HUD) are *physical* sticks, each -1..1, **right = +, up/forward = +**.
  WebXR and standard gamepads report "up" as **negative** y: negate thumbstick y before passing it in.
  The stick mode (1-4, default 2) maps physical sticks to channels; with mode 2: left Y = throttle (Angle/Acro)
  or climb (GPS), left X = yaw, right Y = pitch (up = nose down / forward), right X = roll (right = roll right).
- Positive yaw *stick* turns the drone **clockwise** (heading decreases). Pitch forward = rotation about body
  -X. Roll right = rotation about body -Z.

## Entry

```js
import { createSim } from './sim/index.js';
const sim = createSim(world, opts);
```

`world`:
- `heightAt(x, z) -> metres` (required). Values < 0 are sea floor; the sim treats the surface as `max(h, 0)` and
  water contact as a crash.
- `CURATED: Float32Array [x, z, realmId] * n` (required for rings, realm wind, compass, number keys).
- `heightBatch(xz: Float64Array, n, out: Float64Array)` (**optional, recommended**): `out[i] = heightAt(xz[2i],
  xz[2i+1])` for `i < n`. If present the sim uses it for every terrain query (about 2-8 points per frame, all
  batched); this keeps sim.step allocation-free even when `heightAt` is too big for V8 to inline (calling a
  non-inlined function with doubles boxes them). Without it the sim calls `heightAt` per point.

`opts` (all optional): `flightMode` (0), `cameraMode` (1 = chase), `spawn: [x, z]` (default: the tour's first
realm, Home), `wind: [m/s, dirRad, gustiness 0..1]` (fixed wind instead of the realm table), `seed` (gust noise),
`hud: false`.

## Per frame

```js
sim.setXRSticks(lx, ly, rx, ry); // optional, before step: XR sticks override gamepad + keyboard for this step
sim.setHeadPose(pose7 | null);   // optional: [px,py,pz,qx,qy,qz,qw] stored in sim.headPose (sim.hasHeadPose)
sim.step(dt);                    // real seconds; clamped to 0.1; fixed 240 Hz substeps; allocation-free
// then read sim.cam, sim.drone, sim.rings ...
```

Pass `dt` from your rAF clock as is. Poses are interpolated between the last two substeps (up to 1/240 s behind
the physics) so frame rates that are not a multiple of 240 Hz do not judder.

## Outputs (all preallocated typed arrays; read them, do not keep copies of their contents' meaning across frames)

`sim.cam` `Float32Array(8)`: `[px, py, pz, qx, qy, qz, qw, fovY]` camera pose for the flat view, fovY in radians
(vertical). In VR use `sim.pilot` / the drone pose with your own head pose instead.

`sim.drone` `Float32Array(16)`: `[px, py, pz, qx, qy, qz, qw, vx, vy, vz, m0, m1, m2, m3, throttle, crashed]`
- position is the body centre (the airframe bottom is ~5 cm below for the camera drone, 3 cm for the 5-inch).
- `m0..m3` motor levels 0..1 (rpm proxy, after motor lag) in Betaflight Quad-X order:
  `m0` rear-right (CW seen from above), `m1` front-right (CCW), `m2` rear-left (CCW), `m3` front-left (CW).
  Motor positions in body axes: right = +X, rear = +Z, at +/-0.070 m (camera drone) or +/-0.078 m (5-inch).
  Use them to spin props (rpm roughly proportional to level; idle 0.05-0.06 when armed in the air).
- `throttle`: mean motor level 0..1 (equals the throttle stick at steady hover in Angle/Acro).
- `crashed`: 1 while tumbling (1.5 s), then the drone respawns at its last safe hover point.

`sim.rings` `Float32Array(sim.ringMax * 8)` (ringMax = 64): per slot `[px, py, pz, nx, ny, nz, radius, state]`,
state 0 idle, 1 next, 2 passed. The normal points along the direction of flight (rings count only when crossed
along +n within the radius). `sim.ringCount` slots are valid; slots past it have radius 0. `sim.ringNextSlot`
is the slot of the ring with state 1 (or -1). The window slides as rings are passed (it starts 3 rings before the
next one), so re-read all valid slots each frame, or watch `sim._dbg.R.info[7]` (a version counter) to upload only
on change.

`sim.info` `Float32Array(20)`, named by the `INFO_*` exports of index.js:
0 height above ground (m), 1 airspeed, 2 ground speed (horizontal), 3 vertical speed, 4 transit (boost) active,
5 landed, 6 heading (yaw, rad), 7 gimbal pitch (rad, + up), 8-10 wind at the drone (world m/s), 11 realm id of
the nearest curated cell, 12 rings passed, 13 crashes, 14 hover stick of the current airframe, 15 stick mode,
16 teleports, 17 compass target (curated cell index, -1 when all visited), 18 compass bearing relative to the
camera heading (rad, + = left), 19 its distance (km).

`sim.pilot` `Float32Array(3)`: line-of-sight pilot eye position (on the ground near the take-off spot, 1.7 m up;
re-anchors 40 m behind the drone when it gets 300 m away, and on teleport/respawn). Use it as the VR
line-of-sight origin.

## Controls and state

- `sim.flightMode`: 0 GPS (default), 1 Angle, 2 Acro. Writable; the sim picks up a change at the next step.
  GPS and Angle fly the 249 g camera drone; Acro flies the 650 g 5-inch (the airframe swaps in flight, keeping
  position, velocity and attitude, with motors at the new airframe's hover).
- `sim.cameraMode`: 0 FPV, 1 chase (default), 2 line of sight. Writable.
- `sim.sport`: 0 Normal / 1 Sport (GPS). `sim.boost`: 1 holds boost/transit (ORed with the boost key/button).
- `sim.teleport(x, z)`: safe hover 12 m above the highest surface within 20 m, facing the nearest ring; resets
  the ring line to the nearest ring and re-anchors the line-of-sight pilot.
- `sim.jumpToRealm(realmId)`: teleport to the first curated cell with that realm id and start its rings.
- `sim.press(ACT_*)`: trigger an action (for XR controller buttons): `ACT_MODE, ACT_CAMERA, ACT_RESET, ACT_SPORT,
  ACT_HUD, ACT_SETTINGS, ACT_GIMBAL_UP/DOWN (hold only via keys/pad), ACT_MUTE, ACT_NEXT_REALM`.
- `sim.setStickMode(1..4)`.
- `sim.attach(canvas)`: keyboard + gamepad listeners, the HUD overlay (unless `?hud=0` or `opts.hud === false`),
  the controller settings panel, and audio start on the first pointer/key gesture.
- `sim.startAudio()`: call from a user gesture (also done by attach).

## Bindings

Keyboard: **WASD** left stick (W/S throttle or climb, A/D yaw), **arrows** right stick (pitch, roll). Taps give
small deflections, holding ramps to full in ~0.4 s, release springs back. In Angle/Acro the throttle key
ratchets (stays where you leave it, like a real throttle stick); on a mode switch it starts at hover.
F flight mode, X Normal/Sport, Space or Shift boost (hold, GPS), C camera, Q/E gimbal up/down (GPS FPV),
R reset to last safe hover, 1-6 jump to realm 0-5, N next realm, H HUD, M mute, P controller settings, Esc closes it.

Gamepad (standard mapping, rebindable in the panel): Y mode, X camera, B reset, RT boost (hold), RB Normal/Sport,
Back HUD, Start settings, d-pad up/down gimbal, d-pad right next realm. USB RC transmitters: open the panel (P),
pick the axis for each stick, invert, press calibrate and move every stick to all corners, then bind switches to
actions with "learn" (a switch on an axis is read as on above +0.5 or below -0.5). Saved in localStorage
(`halcyon.input.v1`).

## Zero allocation

`sim.step` allocates nothing once V8 has optimised it (the test proves 0 GCs over 20,000 frames). Platform
exceptions, unavoidable: `navigator.getGamepads()` and its axis/button values, WebAudio `AudioParam` calls
(30 Hz, they take doubles), HUD DOM text (at most 4 Hz, only on change, from prebuilt strings), and
`world.heightAt` boxing if `heightBatch` is not provided. Event paths (mode switch, teleport, crash, respawn)
box a handful of numbers when they happen. The first time a branch is reached V8 may deoptimise and run it a few
frames in its baseline tiers, which box doubles: that is JIT warm-up, not steady state.
