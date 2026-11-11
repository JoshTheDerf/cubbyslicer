/**
 * The states a TriangleSelector paint string uses, without the mesh
 * (TriangleSplittingData::update_used_states): the hex string is read from
 * its end, one nibble per character; a node's low two bits are its split
 * count (0 = leaf, else that many sides + 1 children follow), a leaf's state
 * is the high two bits, or behind the "11" prefix the next nibble + 3 (0b1111:
 * the nibble after that + 18).
 */
export function paintStatesUsed(hex: string, into: Set<number> = new Set()): Set<number> {
  let i = hex.length - 1;
  const next = (): number | null => {
    while (i >= 0) {
      const v = parseInt(hex[i--], 16);
      if (Number.isFinite(v)) return v;
    }
    return null;
  };
  while (i >= 0) {
    for (let pending = 1; pending > 0; pending--) {
      const code = next();
      if (code === null) return into;
      const splits = code & 0b11;
      if (splits) { pending += splits + 1; continue; }
      let state = code >> 2;
      if (state === 0b11) {
        const n = next();
        if (n === null) return into;
        state = n + 3;
        if (n === 0b1111) {
          const m = next();
          if (m === null) return into;
          state = m + 18;
        }
      }
      into.add(state);
    }
  }
  return into;
}
