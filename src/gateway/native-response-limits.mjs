// Whole-text snapshots repeat prior output. Bound transient buffering separately
// from lifetime traffic; never retain the complete wire history in memory.
export const NATIVE_RESPONSE_LIMITS = Object.freeze({
  frames: 4096,
  frameBytes: 1024 * 1024,
  queuedBytes: 8 * 1024 * 1024,
  wireBytes: 256 * 1024 * 1024,
});
