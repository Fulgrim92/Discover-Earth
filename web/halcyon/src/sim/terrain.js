// Batched terrain queries for the sim. Callers write x,z pairs into TQ and call query(n); heights land in TG.
// If the world provides heightBatch(xz Float64Array, n, out Float64Array) it is used (allocation-free);
// otherwise world.heightAt(x, z) is called per point (V8 boxes the doubles for each call unless it inlines it).

export const TQ = new Float64Array(64);
export const TG = new Float64Array(32);
let world = null;
export function init(w) { world = w; }

export function query(n) {
  if (world.heightBatch) { world.heightBatch(TQ, n, TG); return; }
  for (let i = 0; i < n; i++) TG[i] = world.heightAt(TQ[2 * i], TQ[2 * i + 1]);
}
