/**
 * Values typed into the sketcher's inline editor: a number ("12,5" → 12.5, Orca's
 * parse_value), or an expression over the design's variables — `+ - * / ^`, parentheses,
 * `pi`, `sqrt / sin / cos / tan / abs / min / max / round` (trig in degrees). The result is
 * a number: sketch constraint values have no expression binding in the kernel (only feature
 * fields do), so the value is evaluated when it is entered.
 */
export type Vars = Readonly<Record<string, number>>;

const FNS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: (d) => Math.sin((d * Math.PI) / 180), cos: (d) => Math.cos((d * Math.PI) / 180), tan: (d) => Math.tan((d * Math.PI) / 180),
};

export function evalValue(src: string, vars: Vars = {}): { value: number } | { error: string } {
  const s = src.trim().replace(/(\d),(\d)/g, '$1.$2').replace(/\s*(mm|°|deg)\s*$/i, '');
  if (!s) return { error: 'Enter a number' };
  let i = 0;
  const peek = () => s[i];
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = (m: string): never => { throw new Error(m); };
  function primary(): number {
    ws();
    const c = peek();
    if (c === '(') { i++; const v = sum(); ws(); if (peek() !== ')') fail('Missing )'); i++; return v; }
    if (c === '-') { i++; return -power(); }
    if (c === '+') { i++; return power(); }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) { i += num[0].length; return Number(num[0]); }
    const id = /^[A-Za-z_]\w*/.exec(s.slice(i));
    if (id) {
      i += id[0].length;
      const name = id[0];
      ws();
      if (peek() === '(') {
        const fn = FNS[name.toLowerCase()];
        if (!fn) fail(`Unknown function ${name}`);
        i++;
        const args = [sum()];
        ws();
        while (peek() === ',') { i++; args.push(sum()); ws(); }
        if (peek() !== ')') fail('Missing )');
        i++;
        return fn(...args);
      }
      if (name.toLowerCase() === 'pi') return Math.PI;
      if (name in vars) return vars[name];
      return fail(`Unknown variable ${name}`);
    }
    return fail(i >= s.length ? 'Incomplete expression' : 'Not a number');
  }
  function power(): number { const b = primary(); ws(); if (peek() === '^') { i++; return b ** power(); } return b; }
  function product(): number {
    let v = power();
    for (;;) { ws(); const c = peek(); if (c === '*') { i++; v *= power(); } else if (c === '/') { i++; const d = power(); if (d === 0) fail('Division by zero'); v /= d; } else return v; }
  }
  function sum(): number {
    let v = product();
    for (;;) { ws(); const c = peek(); if (c === '+') { i++; v += product(); } else if (c === '-') { i++; v -= product(); } else return v; }
  }
  try {
    const v = sum();
    ws();
    if (i < s.length) fail('Not a number');
    if (!Number.isFinite(v)) fail('Not a number');
    return { value: v };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
