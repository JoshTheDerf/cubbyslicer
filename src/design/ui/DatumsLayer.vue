<script setup lang="ts">
/**
 * Datum planes and coordinate systems over the Design view (datums.ts; Orca's
 * `render_datum_planes` / `render_mate_connectors`): planes as translucent rectangles of their
 * size, coordinate systems as Orca's mate-connector disc (in the frame's XY plane, ~22 px) with
 * its +X / +Y quadrant and a +Z arrow, dashed lines between mated connectors. Projected through
 * the camera every frame; hidden while a sketch is open. `planeAt` serves the Plane card's base
 * pick (DesignViewport).
 */
import { computed, ref, watch } from 'vue';
import type { DesignScene } from '../scene/DesignScene';
import type { Vec3 } from '../../project/math';
import { datumDrawing, type ConnectorDraw } from '../datums';
import { card } from '../create';
import { sk } from '../sketch/session';

const props = defineProps<{ scene: DesignScene | null }>();
const tick = ref(0);
watch(() => props.scene, (s, _o, onCleanup) => { if (s) onCleanup(s.onView(() => { tick.value++; })); }, { immediate: true });
watch(datumDrawing, () => props.scene?.requestRender());

type S2 = [number, number];
const at = (o: Vec3, a: Vec3, s: number, b?: Vec3, t = 0): Vec3 => [o[0] + a[0] * s + (b ? b[0] * t : 0), o[1] + a[1] * s + (b ? b[1] * t : 0), o[2] + a[2] * s + (b ? b[2] * t : 0)];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const pts = (list: S2[]) => list.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L');

/** The open Mate card's A / B (Orca: the live pick wins over the committed mates). */
const live = computed(() => (card.tool?.id === 'mate' ? { a: Number(card.draft.mate_cs_a ?? -1), b: Number(card.draft.mate_cs_b ?? -1) } : null));

const planes = computed(() => {
  void tick.value;
  const s = props.scene;
  if (!s || sk.open) return [];
  const out: Array<{ key: number; ordinal: number; d: string; poly: S2[] }> = [];
  for (const p of datumDrawing.value.planes) {
    const f = p.frame, hu = p.u / 2, hv = p.v / 2;
    const c = [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]].map(([u, v]) => s.project(at(f.origin, f.x_axis, u, f.y_axis, v)));
    if (c.some((q) => q[2] > 1)) continue;
    const poly = c.map((q) => [q[0], q[1]] as S2);
    out.push({ key: p.feature, ordinal: p.ordinal, d: `M${pts(poly)}Z`, poly });
  }
  return out;
});

interface ConnectorPaths { key: number; disc: string; quad: string; arrow: string; head: string; driven: boolean; warn: boolean }
const connectors = computed(() => {
  void tick.value;
  const s = props.scene;
  if (!s || sk.open) return { list: [] as ConnectorPaths[], links: '' };
  const P = (p: Vec3): S2 | null => { const q = s.project(p); return q[2] > 1 ? null : [q[0], q[1]]; };
  const list: ConnectorPaths[] = [];
  const where = new Map<number, S2>();
  for (const g of datumDrawing.value.connectors) {
    const o = P(g.origin);
    if (!o) continue;
    where.set(g.feature, o);
    list.push(glyph(g, o, P, live.value ? live.value.b === g.feature : g.driven));
  }
  // Mated pairs, and the open card's A / B (not yet committed).
  let links = '';
  const pairs = [...datumDrawing.value.mates, ...(live.value && live.value.a !== live.value.b ? [[live.value.a, live.value.b] as [number, number]] : [])];
  for (const [a, b] of pairs) { const pa = where.get(a), pb = where.get(b); if (pa && pb) links += `M${pts([pa, pb])}`; }
  return { list, links };
});

/** Orca's disc treatment: R ≈ 22 px in the frame's own plane, the quadrant, a +Z arrow (billboarded). */
function glyph(g: ConnectorDraw, o: S2, P: (p: Vec3) => S2 | null, driven: boolean): ConnectorPaths {
  const X = unit(g.x), Y = unit(g.y), Z = unit(cross(X, Y));
  // px per mm about the origin: the longest projected unit axis (one of them faces the screen).
  const pxmm = Math.max(...[X, Y, Z].map((a) => { const q = P(at(g.origin, a, 1)); return q ? Math.hypot(q[0] - o[0], q[1] - o[1]) : 0; }), 1e-6);
  const R = 22 / pxmm, Rpx = 22;
  const ring = (r: number, a0: number, a1: number, n: number) => { const out: S2[] = []; for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; const q = P(at(g.origin, X, r * Math.cos(a), Y, r * Math.sin(a))); if (q) out.push(q); } return out; };
  const disc = `M${pts(ring(R, 0, 2 * Math.PI, 40))}Z`;
  const qr = R * 0.84;
  const seg = (a: Vec3, b: Vec3) => { const p = P(a), q = P(b); return p && q ? `M${pts([p, q])}` : ''; };
  let quad = `M${pts(ring(qr, 0, Math.PI / 2, 10))}` + seg(g.origin, at(g.origin, X, qr)) + seg(g.origin, at(g.origin, Y, qr));
  if (!g.rollUndefined) {
    for (let i = 1; i < 5; i++) { const a = (Math.PI / 2) * i / 5; quad += seg(g.origin, at(g.origin, X, qr * Math.cos(a), Y, qr * Math.sin(a))); }
    quad += seg(at(g.origin, X, R), at(g.origin, X, R * 1.28)); // the roll tick past the rim
  }
  // +Z only (nothing on -Z): a ring when it points at the viewer.
  const tipW = P(at(g.origin, Z, R * 2.1));
  let arrow = '', head = '';
  const tip: S2 = tipW ?? o, d: S2 = [tip[0] - o[0], tip[1] - o[1]], L = Math.hypot(d[0], d[1]);
  if (L < Rpx * 0.28) {
    const rr = Rpx * 0.3;
    arrow = `M${o[0] + rr} ${o[1]}A${rr} ${rr} 0 1 1 ${o[0] - rr} ${o[1]}A${rr} ${rr} 0 1 1 ${o[0] + rr} ${o[1]}`;
  } else {
    const u: S2 = [d[0] / L, d[1] / L], n: S2 = [-u[1], u[0]], as = Rpx * 0.42;
    const back: S2 = [tip[0] - u[0] * as, tip[1] - u[1] * as];
    const l: S2 = [back[0] + n[0] * as * 0.45, back[1] + n[1] * as * 0.45], r: S2 = [back[0] - n[0] * as * 0.45, back[1] - n[1] * as * 0.45];
    arrow = `M${pts([o, back])}`;
    head = `M${pts([tip, l, r])}Z`;
  }
  return { key: g.feature, disc, quad, arrow, head, driven, warn: g.rollUndefined };
}

/** The datum plane (ordinal among the drawn planes) under a container point, for the Plane card's base pick. */
function planeAt(x: number, y: number): number | null {
  for (const p of [...planes.value].reverse()) {
    let inside = false;
    for (let i = 0, j = p.poly.length - 1; i < p.poly.length; j = i++) {
      const [xi, yi] = p.poly[i], [xj, yj] = p.poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return p.ordinal;
  }
  return null;
}
defineExpose({ planeAt });
</script>

<template>
  <svg v-if="planes.length || connectors.list.length" class="dtl" aria-hidden="true" data-testid="design-datums">
    <path v-for="p in planes" :key="`p${p.key}`" :d="p.d" class="dtl__plane" data-testid="design-datum-plane" :data-feature="p.key" />
    <path v-if="connectors.links" :d="connectors.links" class="dtl__link" data-testid="design-mate-link" />
    <g v-for="c in connectors.list" :key="`c${c.key}`" class="dtl__cs" :class="{ 'is-driven': c.driven, 'is-warn': c.warn }" data-testid="design-coordsys" :data-feature="c.key">
      <path :d="c.disc" class="dtl__disc" />
      <path :d="c.quad" class="dtl__quad" />
      <path :d="c.arrow" class="dtl__arrow" />
      <path v-if="c.head" :d="c.head" class="dtl__head" />
    </g>
  </svg>
</template>

<style scoped>
.dtl { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; overflow: visible; }
.dtl__plane { fill: var(--vp-datum-plane-fill); stroke: var(--vp-datum-plane); stroke-width: 3; stroke-linejoin: round; }
.dtl__link { fill: none; stroke: var(--vp-connector); stroke-width: 1; stroke-dasharray: 6 4; }
.dtl__disc, .dtl__arrow { fill: none; stroke: var(--vp-connector); stroke-width: 1; }
.dtl__quad { fill: none; stroke: var(--vp-connector-roll); stroke-width: 1; }
.dtl__head { fill: none; stroke: var(--vp-connector); stroke-width: 1; stroke-linejoin: round; }
.is-driven .dtl__disc, .is-driven .dtl__arrow { stroke: var(--vp-connector-driven); }
.is-driven .dtl__head { stroke: var(--vp-connector-driven); fill: var(--vp-connector-driven); }
.is-warn .dtl__disc, .is-warn .dtl__quad { stroke: var(--vp-connector-warn); }
</style>
