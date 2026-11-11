/**
 * cubby-mcp takes some top-level arguments of every tab tool for itself and
 * never forwards them to the tab: `tab` (which tab to call), `path` / `url`
 * (a model file it reads for fileInput tools) and `savePath` (where it writes
 * a fileOutput tool's file). See ../cubby-mcp/src/mcp.ts, `CubbyMcp.callTool`
 * (the `const { tab: _t, path, url, savePath, ...rest } = args` line) and
 * `exposedSchema` (which overwrites those properties in the schema the agent
 * sees). A tab tool that declares one of them would silently never get it, so
 * this test fails when any bridge tool does.
 *
 * When ../cubby-mcp is checked out next to this repo the list is read from its
 * source, so the test follows the server; otherwise the list below is used.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { slicerTools } from './tools';

/** What cubby-mcp 0.1.4 strips / reserves (keep in step with ../cubby-mcp/src/mcp.ts). */
const FALLBACK_RESERVED = ['tab', 'path', 'url', 'savePath'];

const SERVER_MCP = fileURLToPath(new URL('../../../cubby-mcp/src/mcp.ts', import.meta.url));

/** Argument names cubby-mcp keeps for itself, read from its source. */
function reservedFromServerSource(src: string): string[] {
  const names = new Set<string>();
  // callTool: `const { tab: _t, path, url, savePath, ...rest } = args;` — everything before `...rest` is stripped.
  const destructure = /const\s*\{([^}]*?)\.\.\.\s*\w+\s*\}\s*=\s*args\b/.exec(src);
  if (destructure) {
    for (const part of destructure[1].split(',')) {
      const key = part.split(':')[0].trim();
      if (/^\w+$/.test(key)) names.add(key);
    }
  }
  // exposedSchema: `props.path = …` — properties the server writes over in the agent's schema.
  const schemaFn = /function\s+exposedSchema\b[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
  for (const m of schemaFn.matchAll(/\bprops\.(\w+)\s*=/g)) names.add(m[1]);
  return [...names];
}

function reservedArgs(): { names: string[]; source: string } {
  if (existsSync(SERVER_MCP)) {
    const names = reservedFromServerSource(readFileSync(SERVER_MCP, 'utf8'));
    if (names.length) return { names, source: SERVER_MCP };
  }
  return { names: FALLBACK_RESERVED, source: 'fallback list' };
}

describe('bridge tool arguments', () => {
  it('the server parser finds the stripped names', () => {
    const src = [
      'export function exposedSchema(app, spec) {',
      '  props.tab = TAB_PROP(app);',
      '  if (spec.fileInput) { props.path = {}; props.url = {}; }',
      '  if (spec.fileOutput) props.savePath = {};',
      '}',
      'const { tab: _t, path, url, savePath, ...rest } = args;',
    ].join('\n');
    expect(reservedFromServerSource(src).sort()).toEqual([...FALLBACK_RESERVED].sort());
  });

  it('the live server source still strips the known names', () => {
    const { names, source } = reservedArgs();
    // If cubby-mcp stops reserving one of these, the bridge could use it again; if it starts
    // reserving more, the next test catches tools that declare them.
    expect(names, `from ${source}`).toEqual(expect.arrayContaining(FALLBACK_RESERVED));
  });

  it('no tool declares an argument cubby-mcp strips', () => {
    const { names, source } = reservedArgs();
    const reserved = new Set(names);
    const tools = slicerTools();
    expect(tools.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const t of tools) {
      const props = Object.keys(t.inputSchema?.properties ?? {});
      const required = Array.isArray(t.inputSchema?.required) ? (t.inputSchema.required as string[]) : [];
      for (const k of new Set([...props, ...required])) if (reserved.has(k)) offenders.push(`${t.name}.${k}`);
    }
    expect(offenders, `cubby-mcp (${source}) strips ${[...reserved].join(', ')} before the tab sees them; rename these`).toEqual([]);
  });
});
