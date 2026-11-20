// clock.js: the frame clock, shared by the frame loop and the per-frame updaters (fx/drone.js, fx/rings.js,
// script.js, perf.js). Doubles live in this Float64Array instead of being passed as arguments or kept in module
// `let`s: V8 boxes a double (a 16-byte heap object) each time one crosses a non-inlined call or is written to a
// module-level variable, which on the frame path is a steady trickle of garbage (DESIGN section 9).
export const CLK = new Float64Array(4);
export const C_DT = 0, C_TIME = 1, C_FRAME_MS = 2, C_PREV = 3; // dt (s), scene time (s), frame delta (ms), last rAF time
