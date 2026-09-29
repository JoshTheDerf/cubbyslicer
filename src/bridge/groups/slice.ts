/**
 * Bridge tools: slicing, results, G-code / 3MF export, the Preview view
 * (layer range, colour scheme, options) and viewport screenshots of both
 * Prepare and Preview.
 */
import { argNumber, bytesToBase64, type BridgeTool, type ToolCallContext } from '@cubby/shared/bridge';
import { zipSync } from 'fflate';
import { nextTick } from 'vue';
import { activeView, resolvedConfig } from '../../app/state';
import { plateSliceResult, useSliceController } from '../../app/slice';
import type { SliceResult } from '../../engine/types';
import { activePlate, getMesh, getSliceObjects, objectIssues, objectsOnPlate, plates, projectName, setActivePlate } from '../../project/store';
import { buildOrca3mf } from '../../project/persistence/orca3mfWriter';
import { build3mf } from '../../project/export/threemf';
import { parseGcodeAsync } from '../../preview/parser/client';
import { parseOptionsFrom } from '../../preview/parseOptions';
import type { ParsedGcode } from '../../preview/parser/types';
import { buildFeatureRows, buildSummary, DEFAULT_LEGEND_OPTIONS, type LegendOptions } from '../../preview/summary';
import { FEATURES, FIRST_NON_EXTRUSION } from '../../preview/parser/features';
import { SCHEMES } from '../../preview/render/colors';
import {
  colorScheme, featureVisible, getPreviewHandle, layerCount, layerHi, layerLo, legendCollapsed, previewData, previewOptions, setSingleLayer,
  setTopLayer, showGcodeViewer, singleLayer,
} from '../../preview/store';
import { captureViewport, type ViewPreset } from '../../viewport/controller';
import { presetsSettled } from '../../presets/store';
import { oneOf } from '../logic';
import { presetSummary } from './core';
import { bool, fmtTime, num, obj, oneOfS, plateArg, round, str, sum } from './util';

const PRESETS = ['iso', 'top', 'bottom', 'front', 'back', 'left', 'right'] as const;
const OPTION_KEYS = Object.keys(DEFAULT_LEGEND_OPTIONS) as Array<keyof LegendOptions>;
const EXTRUSION = FEATURES.filter((f) => f.id < FIRST_NON_EXTRUSION);

/** Forward slice progress to the bridge while a slice runs. */
function watchProgress(slicer: ReturnType<typeof useSliceController>, report: ToolCallContext['progress']): () => void {
  let last = -1;
  const t = setInterval(() => {
    const p = slicer.progress.value;
    if (p !== last) { last = p; report(p, 100, slicer.message.value); }
  }, 500);
  return () => clearInterval(t);
}

// Per-feature rows need the parsed G-code: cache them per result (the preview's parse is reused when it shows it).
const breakdowns = new WeakMap<SliceResult, Promise<ReturnType<typeof breakdownOf>>>();
function breakdownOf(p: ParsedGcode, r: SliceResult) {
  const s = buildSummary(p, r.report);
  const rows = buildFeatureRows(p, s.timeSec, { mm: s.totalMm, g: s.totalG });
  return {
    layers: s.layers, maxZ: round(s.maxZ), timeSource: s.timeSource,
    features: rows.map((f) => ({ feature: f.label, time: fmtTime(f.time), timeSec: Math.round(f.time), percent: round(f.percent, 1), filamentG: f.filamentG === null ? undefined : round(f.filamentG), filamentM: f.filamentMm === null ? undefined : round(f.filamentMm / 1000, 2) })),
    perFilament: s.tools.map((t) => ({ filament: t.index + 1, filamentM: round(t.mm / 1000, 2), filamentG: t.g === null ? undefined : round(t.g), cost: t.cost === null ? undefined : round(t.cost) })),
    layerTimes: { min: round(Math.min(...p.layerTime), 1), max: round(Math.max(...p.layerTime), 1) },
  };
}
function breakdown(r: SliceResult, plate: number) {
  let b = breakdowns.get(r);
  if (!b) {
    const shown = plate === activePlate.value && previewData.value && getPreviewHandle()?.status().current ? previewData.value : null;
    b = (shown ? Promise.resolve(shown) : parseGcodeAsync(r.gcode, parseOptionsFrom(resolvedConfig.value)).promise).then((p) => breakdownOf(p, r));
    breakdowns.set(r, b);
    b.catch(() => breakdowns.delete(r));
  }
  return b;
}

async function plateResult(i: number, features: boolean) {
  const ps = plateSliceResult(i);
  if (!ps) return { plate: i + 1, sliced: false, empty: getSliceObjects(i).length === 0 || undefined };
  const s = ps.result.report.stats;
  const issues = objectsOnPlate(i).flatMap((o) => (objectIssues.value.get(o.id) ?? []).map((x) => `${o.name}: ${x}`));
  return {
    plate: i + 1, sliced: true, stale: ps.stale || undefined, gcodeName: ps.name, gcodeBytes: ps.result.gcode.byteLength,
    stats: s ? {
      printTime: fmtTime(s.printTimeSec), printTimeSec: Math.round(s.printTimeSec), layers: s.layers, maxZmm: round(s.maxZ),
      filamentG: round(sum(s.filamentG)), filamentM: round(sum(s.filamentMm) / 1000), filamentCm3: round(sum(s.filamentCm3)), filamentCost: sum(s.filamentCost) ? round(sum(s.filamentCost)) : undefined,
      perFilament: s.filamentMm.map((mm, k) => ({ filament: k + 1, m: round(mm / 1000), g: round(s.filamentG[k] ?? 0), cost: s.filamentCost[k] ? round(s.filamentCost[k]) : undefined })).filter((x) => x.m > 0),
    } : null,
    warnings: ps.result.report.warnings.map((w) => w.message),
    plateIssues: issues.length ? issues : undefined,
    engine: ps.result.engine, threads: ps.result.report.threads,
    breakdown: features ? await breakdown(ps.result, i).catch((e) => ({ error: `Couldn’t read the G-code: ${(e as Error).message}` })) : undefined,
  };
}

async function waitFor<T>(fn: () => T | null | undefined, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function previewState() {
  const p = previewData.value;
  return {
    view: activeView.value, layers: layerCount(), shown: p ? [layerLo.value + 1, layerHi.value + 1] : null,
    topZ: p && p.layerCount ? round(p.layerZ[layerHi.value], 3) : null, singleLayer: singleLayer.value,
    colorScheme: colorScheme.value, options: { ...previewOptions.value },
    hiddenFeatures: EXTRUSION.filter((f) => featureVisible.value[f.id] === false).map((f) => f.label),
    legend: !legendCollapsed.value, gcodeViewer: showGcodeViewer.value,
  };
}

export function sliceTools(): BridgeTool[] {
  const slicer = useSliceController();
  return [
    {
      name: 'slice',
      description: 'Slice the active plate, a given `plate`, or every plate with all: true (plates already up to date are skipped). Returns per-plate print time, filament use, layers and warnings (get_slice_results adds the per-feature breakdown). Takes seconds to minutes; switches the app to Preview.',
      timeoutMs: 30 * 60_000,
      inputSchema: obj({ plate: num('Plate number (1-based, default active).'), all: bool('Slice all plates.') }),
      async run(args, ctx) {
        const plate = plateArg(args);
        if (plate !== undefined && args.all === true) throw new Error('Pass plate or all, not both.');
        if (plate !== undefined) setActivePlate(plate);
        await presetsSettled();
        const stop = watchProgress(slicer, ctx.progress);
        const abort = () => slicer.cancel();
        ctx.signal.addEventListener('abort', abort);
        let ok: boolean;
        try { ok = args.all === true ? await slicer.sliceAll() : await slicer.slice(); } finally { stop(); ctx.signal.removeEventListener('abort', abort); }
        if (!ok) {
          const rep = slicer.errorReport.value;
          return { data: { ok: false, error: slicer.error.value ?? 'Slicing was cancelled or failed.', warnings: rep?.warnings.map((w) => w.message) } };
        }
        const list = args.all === true ? plates.value.map((_, i) => i) : [activePlate.value];
        const results = await Promise.all(list.map((i) => plateResult(i, false)));
        const one = results.length === 1 ? results[0] : null;
        return { data: { ok: true, ...presetSummary(), ...(one ? { ...one } : { plates: results }) } };
      },
    },

    {
      name: 'cancel_slice',
      description: 'Stop a running slice.',
      inputSchema: obj({}),
      run() { const was = slicer.status.value === 'slicing'; slicer.cancel(); return { data: { ok: true, wasSlicing: was } }; },
    },

    {
      name: 'get_slice_results',
      description:
        'Results of the last slice per plate: out of date or not, print time, filament per filament slot (m, g, cost), layers, max Z, warnings, placement issues, and (features: true, default) ' +
        'the per-feature breakdown (time, share, filament per line type) and per-layer time range. plate: a number or "all" (default all).',
      timeoutMs: 5 * 60_000,
      inputSchema: obj({ plate: { type: ['number', 'string'], description: 'Plate number or "all".' }, features: bool('Include the per-feature breakdown (default true; parses the G-code).') }),
      async run(args) {
        const list = args.plate === undefined || args.plate === 'all' ? plates.value.map((_, i) => i) : [plateArg(args)!];
        const results = await Promise.all(list.map((i) => plateResult(i, args.features !== false)));
        return { data: { activePlate: activePlate.value + 1, plates: results } };
      },
    },

    {
      name: 'export_gcode',
      description: 'Save sliced G-code (cubby-mcp writes it to savePath and returns the path): the active plate, a `plate`, or plate "all" = a .zip of every sliced plate. Slice first.',
      fileOutput: true,
      timeoutMs: 120_000,
      inputSchema: obj({ plate: { type: ['number', 'string'], description: 'Plate number or "all".' } }),
      run(args) {
        if (args.plate === 'all') {
          const files: Record<string, Uint8Array> = {};
          const stale: number[] = [];
          plates.value.forEach((_, i) => { const r = plateSliceResult(i); if (r) { files[r.name] = r.result.gcode; if (r.stale) stale.push(i + 1); } });
          const names = Object.keys(files);
          if (!names.length) throw new Error('No plate is sliced yet. Call slice with all: true first.');
          const zip = zipSync(Object.fromEntries(names.map((n) => [n, [files[n], { level: 6 }]])) as Parameters<typeof zipSync>[0]);
          const stem = (projectName.value || 'project').replace(/[^\w.-]+/g, '_');
          return { data: { ok: true, files: names, stalePlates: stale.length ? stale : undefined }, file: { name: `${stem}_gcode.zip`, mimeType: 'application/zip', base64: bytesToBase64(zip) } };
        }
        const i = plateArg(args) ?? activePlate.value;
        const r = plateSliceResult(i);
        if (!r) throw new Error(`Plate ${i + 1} is not sliced yet. Call slice first.`);
        return { data: { ok: true, name: r.name, plate: i + 1, stale: r.stale || undefined }, file: { name: r.name, mimeType: 'text/x-gcode', base64: bytesToBase64(r.result.gcode) } };
      },
    },

    {
      name: 'export_3mf',
      description: 'Save a 3MF: "project" (OrcaSlicer-compatible project with every plate, part, paint and setting; default) or "plate" (the active plate’s, or `plate`’s, meshes only).',
      fileOutput: true,
      timeoutMs: 120_000,
      inputSchema: obj({ kind: oneOfS(['project', 'plate'], 'Default project.'), plate: num('For kind plate (1-based).') }),
      run(args) {
        const kind = args.kind === undefined ? 'project' : oneOf(args.kind, ['project', 'plate'] as const, 'kind');
        const stem = (projectName.value || 'project').replace(/[^\w.-]+/g, '_');
        if (kind === 'plate') {
          const i = plateArg(args) ?? activePlate.value;
          const list = objectsOnPlate(i);
          if (!list.length) throw new Error(`Plate ${i + 1} is empty.`);
          return { data: { ok: true, kind }, file: { name: `${stem}_plate${i + 1}.3mf`, mimeType: 'model/3mf', base64: bytesToBase64(build3mf(list, getMesh)) } };
        }
        return { data: { ok: true, kind }, file: { name: `${stem}.3mf`, mimeType: 'model/3mf', base64: bytesToBase64(buildOrca3mf()) } };
      },
    },

    {
      name: 'set_preview',
      description:
        'Preview view options (the active plate’s last slice; `plate` switches plates): layers [from, to] (1-based, inclusive) or layer (show up to it), singleLayer, colorScheme ' +
        `(${SCHEMES.map((s) => s.id).join(', ')}), options { ${OPTION_KEYS.join(', ')}: bool }, features { "<line type>": bool } to hide / show line types (${EXTRUSION.map((f) => f.label).join(', ')}), legend, gcodeViewer. ` +
        'view: "preview" or "prepare" switches the centre view. Returns the preview state.',
      timeoutMs: 120_000,
      inputSchema: obj({
        view: oneOfS(['prepare', 'preview'], 'Switch the view.'), plate: num('Show this plate (1-based; makes it active).'),
        layers: { type: 'array', items: { type: 'number' }, description: '[from, to] 1-based.' }, layer: num('Top layer to show (1-based).'),
        singleLayer: bool('Only the top layer.'), colorScheme: oneOfS(SCHEMES.map((s) => s.id), 'Colour by.'),
        options: { type: 'object', description: 'Toggle map.' }, features: { type: 'object', description: 'Line type → visible.' },
        legend: bool('Show the legend.'), gcodeViewer: bool('Show the G-code text.'),
      }),
      async run(args) {
        const plate = plateArg(args);
        if (plate !== undefined) setActivePlate(plate);
        // Let the plate switch reach lastSlice and the preview's loader before checking readiness.
        await nextTick(); await nextTick();
        if (args.view !== undefined) activeView.value = oneOf(args.view, ['prepare', 'preview'] as const, 'view');
        if (args.colorScheme !== undefined) colorScheme.value = oneOf(args.colorScheme, SCHEMES.map((s) => s.id), 'colorScheme');
        if (args.options !== undefined) {
          const o = args.options as Record<string, unknown>;
          if (!o || typeof o !== 'object') throw new Error('options must be an object.');
          const bad = Object.keys(o).filter((k) => !OPTION_KEYS.includes(k as keyof LegendOptions) || typeof o[k] !== 'boolean');
          if (bad.length) throw new Error(`options must map ${OPTION_KEYS.join(', ')} to true / false (bad: ${bad.join(', ')}).`);
          previewOptions.value = { ...previewOptions.value, ...(o as Partial<LegendOptions>) };
        }
        if (args.features !== undefined) {
          const f = args.features as Record<string, unknown>;
          const next = featureVisible.value.slice();
          for (const [label, v] of Object.entries(f ?? {})) {
            const meta = EXTRUSION.find((x) => x.label.toLowerCase() === label.toLowerCase());
            if (!meta || typeof v !== 'boolean') throw new Error(`features must map line types (${EXTRUSION.map((x) => x.label).join(', ')}) to true / false (bad: ${label}).`);
            next[meta.id] = v;
          }
          featureVisible.value = next;
        }
        if (typeof args.legend === 'boolean') legendCollapsed.value = !args.legend;
        if (typeof args.gcodeViewer === 'boolean') showGcodeViewer.value = args.gcodeViewer;
        if (typeof args.singleLayer === 'boolean') setSingleLayer(args.singleLayer);
        if (args.layers !== undefined || args.layer !== undefined) {
          if (!plateSliceResult(activePlate.value)) throw new Error('The active plate is not sliced: slice it first.');
          activeView.value = 'preview';
          await nextTick(); await nextTick();
          await waitFor(() => (getPreviewHandle()?.status().current ? true : null), 60_000, 'the preview to load');
          const n = layerCount();
          const layer = argNumber(args, 'layer', { optional: true });
          if (args.layers !== undefined) {
            const l = args.layers as unknown[];
            if (!Array.isArray(l) || l.length !== 2 || !l.every((x) => Number.isInteger(x)) || (l[0] as number) < 1 || (l[1] as number) > n || (l[0] as number) > (l[1] as number)) {
              throw new Error(`layers must be [from, to] with 1 ≤ from ≤ to ≤ ${n}.`);
            }
            if (singleLayer.value) setSingleLayer(false);
            layerLo.value = (l[0] as number) - 1;
            setTopLayer((l[1] as number) - 1);
          } else if (layer !== undefined) {
            if (!Number.isInteger(layer) || layer < 1 || layer > n) throw new Error(`layer must be 1-${n}.`);
            setTopLayer(layer - 1);
          }
        }
        return { data: { ok: true, ...previewState() } };
      },
    },

    {
      name: 'capture_viewport',
      description:
        'Screenshot (PNG) of the Prepare view (models on the plate) or the Preview view (sliced toolpaths) to check your work. view: prepare | preview (default: the one showing). ' +
        'preset: iso | top | bottom | front | back | left | right (default: the current camera). fit: prepare selection | objects | plate, preview print | plate. ' +
        'width / height in px (default 1024 × 768, 64-2048). The on-screen camera is not moved.',
      timeoutMs: 180_000,
      inputSchema: obj({
        view: oneOfS(['prepare', 'preview'], 'Which view.'), preset: oneOfS(PRESETS, 'Camera direction.'),
        fit: oneOfS(['selection', 'objects', 'plate', 'print'], 'What to frame.'), width: num('px'), height: num('px'),
        plate: num('Make this plate active first (1-based).'),
      }),
      async run(args) {
        const plate = plateArg(args);
        if (plate !== undefined) setActivePlate(plate);
        // Let the plate switch reach lastSlice and the preview's loader before checking readiness.
        await nextTick(); await nextTick();
        const view = args.view === undefined ? activeView.value : oneOf(args.view, ['prepare', 'preview'] as const, 'view');
        const width = Math.round(argNumber(args, 'width', { optional: true }) ?? 1024);
        const height = Math.round(argNumber(args, 'height', { optional: true }) ?? 768);
        if (!(width >= 64 && width <= 2048 && height >= 64 && height <= 2048)) throw new Error('width and height must be 64-2048 px.');
        const preset = args.preset === undefined ? undefined : oneOf(args.preset, PRESETS, 'preset') as ViewPreset;
        let blob: Blob;
        if (view === 'prepare') {
          const fit = args.fit === undefined ? undefined : oneOf(args.fit, ['selection', 'objects', 'plate'] as const, 'fit (prepare)');
          // Let pending scene syncs (a transform just made) reach the renderer.
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          const p = captureViewport({ width, height, view: preset, fit });
          if (!p) throw new Error('The Prepare view is not ready (WebGL may be unavailable).');
          blob = await p;
        } else {
          const fit = args.fit === undefined ? undefined : oneOf(args.fit, ['print', 'plate'] as const, 'fit (preview)');
          if (!plateSliceResult(activePlate.value)) throw new Error(`Plate ${activePlate.value + 1} is not sliced: call slice first (or capture view "prepare").`);
          activeView.value = 'preview';
          await nextTick(); await nextTick();
          const h = await waitFor(() => {
            const x = getPreviewHandle();
            const s = x?.status();
            if (s?.phase === 'error') throw new Error(`The preview failed: ${s.error ?? 'unknown error'}.`);
            return x && s?.current ? x : null;
          }, 120_000, 'the preview to load');
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          blob = await h.capture({ width, height, preset, fit });
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return {
          data: { ok: true, view, width, height, plate: activePlate.value + 1, ...(view === 'preview' ? { shownLayers: previewState().shown, layers: layerCount() } : {}) },
          images: [{ base64: bytesToBase64(bytes), mimeType: 'image/png' }],
        };
      },
    },

    {
      name: 'read_gcode',
      description: 'Read part of the active plate’s sliced G-code as text: `layer` (1-based, from the preview) or a line range (from, count; default the first 200 lines). For checking start / end G-code and custom codes.',
      timeoutMs: 120_000,
      inputSchema: obj({ from: num('First line (1-based).'), count: num('Lines (max 2000).'), layer: num('Layer (1-based): its lines.'), search: str('Only lines containing this text (max 200 hits).') }),
      async run(args) {
        const r = plateSliceResult(activePlate.value);
        if (!r) throw new Error('The active plate is not sliced.');
        const text = new TextDecoder().decode(r.result.gcode);
        const lines = text.split('\n');
        const q = typeof args.search === 'string' ? args.search : '';
        if (q) {
          const hits: Array<{ line: number; text: string }> = [];
          for (let i = 0; i < lines.length && hits.length < 200; i++) if (lines[i].includes(q)) hits.push({ line: i + 1, text: lines[i] });
          return { data: { totalLines: lines.length, hits } };
        }
        let from = Math.max(1, Math.floor(argNumber(args, 'from', { optional: true }) ?? 1));
        const count = Math.max(1, Math.min(2000, Math.floor(argNumber(args, 'count', { optional: true }) ?? 200)));
        const layer = argNumber(args, 'layer', { optional: true });
        if (layer !== undefined) {
          const marks = lines.map((l, i) => (/^;\s*(LAYER_CHANGE|CHANGE_LAYER)\b/.test(l) ? i : -1)).filter((i) => i >= 0);
          if (!Number.isInteger(layer) || layer < 1 || layer > marks.length) throw new Error(`layer must be 1-${marks.length}.`);
          from = marks[layer - 1] + 1;
        }
        return { data: { totalLines: lines.length, from, text: lines.slice(from - 1, from - 1 + count).join('\n') } };
      },
    },
  ];
}
