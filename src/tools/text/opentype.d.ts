// Minimal typings for the parts of opentype.js 2.x the text tool uses (the package ships none).
declare module 'opentype.js' {
  export interface PathCommand {
    type: 'M' | 'L' | 'Q' | 'C' | 'Z';
    x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number;
  }
  export interface Path { commands: PathCommand[] }
  export interface Glyph {
    index: number;
    advanceWidth?: number;
    getPath(x: number, y: number, fontSize: number, options?: unknown, font?: Font): Path;
  }
  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    names: Record<string, unknown>;
    forEachGlyph(text: string, x: number, y: number, fontSize: number, options: Record<string, unknown> | undefined,
      cb: (glyph: Glyph, x: number, y: number, fontSize: number, options: unknown) => void): number;
  }
  export function parse(buffer: ArrayBuffer, opt?: unknown): Font;
}
