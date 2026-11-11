<script setup lang="ts">
/**
 * The Design view's 3D canvas (DesignScene) wired to the session: bodies from the display
 * meshes, highlighting from the selection, Orca's pick cycle (repeated clicks on one spot step
 * whole body → face → edge), the bed and the origin planes. Overlays go in the default slot.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Box3, Color, Vector3 } from 'three';
import { bed } from '../../project/store';
import { DesignScene, type DesignHighlight, type DesignHit, type ScenePickMode } from '../scene/DesignScene';
import { design, displayBodies, readDesign, setStatus } from '../session';
import { designUi, pickEdges, toggleSetEdge, type DesignPick } from '../state';
import { registerDesignViewport } from '../viewport';
import { pickGeneration, pickHit, picking, rollbackBodies, type PickValue } from '../pick';
import { card, ghost, setCardValue } from '../create';
import OfferMenu from './OfferMenu.vue';
import SketchOverlay from './SketchOverlay.vue';
import SketchesLayer from './SketchesLayer.vue';
import { cardSketchRows, hitSketch } from '../sketch/committed';
import { beginSketch, sk } from '../sketch/session';
import { bounds, toWorld } from '../sketch/model';
import type { FaceInfo } from '../kernel/types';

const host = ref<HTMLElement | null>(null);
const scene = shallowRef<DesignScene | null>(null);
const failed = ref('');

/** Faces the selected feature made (faces_made_by), when the design is quick to rebuild. */
const featureFaces = shallowRef<{ key: string; faces: Map<number, Set<number>> } | null>(null);

const bodyColours = computed(() => {
  const m = new Map<number, Color>();
  for (const b of design.bodies) if (b.has_color && b.color) m.set(b.index, new Color(b.color[0], b.color[1], b.color[2]));
  return m;
});

/** Reference values on display: the field being picked, and the open card's other references. */
const refs = computed(() => {
  const bodies = new Set<number>(), faces = new Map<number, Set<number>>(), edges = new Map<number, Set<number>>();
  const add = (m: Map<number, Set<number>>, v: PickValue) => { let s = m.get(v.body); if (!s) { s = new Set(); m.set(v.body, s); } for (const i of v.ids) s.add(i); };
  const put = (v: PickValue, kind: 'face' | 'edge' | 'body') => { if (kind === 'body') bodies.add(v.body); else add(kind === 'face' ? faces : edges, v); };
  const kindOf = (k: string) => (k === 'edge' || k === 'edges' ? 'edge' : k === 'body' ? 'body' : 'face') as 'face' | 'edge' | 'body';
  const gen = pickGeneration();
  if (picking.spec && picking.value && picking.value.generation === gen) put(picking.value, kindOf(picking.spec.kind));
  if (card.tool && !picking.rollback) {
    for (const r of card.tool.rows) {
      if (r.when && !r.when(card.draft)) continue;
      const keys = r.kind === 'pick' ? [r.key] : r.kind === 'plane' && card.draft[r.key] === 'face' ? [`${r.key}Face`] : [];
      for (const k of keys) {
        if (picking.spec?.key === `card:${k}`) continue;
        const v = card.draft[k] as PickValue | null | undefined;
        if (v && Array.isArray(v.ids) && v.generation === design.generation) put(v, kindOf(r.pick ?? 'face'));
      }
    }
  }
  return { bodies, faces, edges };
});

const shownBodies = computed(() => (picking.rollback && rollbackBodies.value ? rollbackBodies.value : displayBodies.value));
const pickMode = computed<ScenePickMode>(() => {
  const k = picking.spec?.kind;
  if (!k) return 'cycle';
  return k === 'edge' || k === 'edges' ? 'edge' : k === 'body' ? 'body' : 'face';
});

const highlight = computed<DesignHighlight>(() => {
  const bodies = new Set<number>(), faces = new Map<number, Set<number>>(), edges = new Map<number, Set<number>>();
  const r = refs.value;
  if (picking.spec || card.tool) return { bodies, faces, edges, refBodies: r.bodies, refFaces: r.faces, refEdges: r.edges };
  const p = designUi.pick;
  if (p?.kind === 'body') bodies.add(p.body);
  else if (p?.kind === 'face') faces.set(p.body, new Set([p.face]));
  else if (p?.kind === 'edge') edges.set(p.body, new Set(pickEdges(p)));
  const sel = new Set(designUi.selected);
  if (sel.size) {
    const ff = featureFaces.value;
    if (ff && ff.key === `${design.generation}:${[...sel].join(',')}`) for (const [b, s] of ff.faces) faces.set(b, new Set([...(faces.get(b) ?? []), ...s]));
    else for (const b of design.bodies) if (sel.has(b.source_feature)) bodies.add(b.index);
  }
  return { bodies, faces, edges };
});

watch([() => designUi.selected.slice(), () => design.generation], ([sel, gen]) => {
  featureFaces.value = null;
  if (sel.length !== 1 || !design.ok) return; // faces_made_by is cheap since kernel v1.1 (no replay)
  const key = `${gen}:${sel[0]}`;
  void readDesign(async (c, doc) => (await c.call<{ faces: Array<[number, number]>; generation: number }>('faces_made_by', { doc, index: sel[0] })).result)
    .then((r) => {
      if (r.generation !== design.generation) return;
      const faces = new Map<number, Set<number>>();
      for (const [b, f] of r.faces) { let s = faces.get(b); if (!s) { s = new Set(); faces.set(b, s); } s.add(f); }
      featureFaces.value = { key, faces };
    }).catch(() => {});
});

// ---- picking: Orca's cycle (body → face → edge on repeated clicks) ----
let last: { x: number; y: number; body: number; face: number; level: number } | null = null;
const bodyLabel = (b: number) => `Body ${b + 1}${design.bodies[b]?.name ? ` — ${design.bodies[b].name}` : ''}`;

function onPickClick(hit: DesignHit | null, e: { clientX: number; clientY: number }) {
  const s = scene.value, k = picking.spec?.kind;
  const gen = pickGeneration();
  if (k === 'edge' || k === 'edges') {
    const pe = s?.pickEdgeAt(e.clientX, e.clientY, 14) ?? null;
    void pickHit(pe ? { body: pe.body, edge: pe.edge, generation: gen } : null);
    return;
  }
  void pickHit(hit ? { body: hit.body, face: hit.face, point: [hit.point.x, hit.point.y, hit.point.z], generation: gen } : null);
}

/**
 * A click while a card is open but no row is picking (Orca: clicking an edge with the fillet
 * card open adds it): it feeds the card's first reference row that is showing; cards without
 * one take the body (Boolean: target, then tool, alternating).
 */
let boolSlot: 'target_body' | 'bool_tool_body' = 'target_body';
watch(() => card.tool, () => { boolSlot = 'target_body'; });
function feedCard(hit: DesignHit | null, at: { clientX: number; clientY: number }) {
  const t = card.tool!, d = card.draft, gen = design.generation;
  const row = t.rows.find((r) => r.kind === 'pick' && (!r.when || r.when(d)));
  if (row && (row.pick === 'edge' || row.pick === 'edges')) {
    // Edges: the nearest one on screen, even just off the body's silhouette.
    const pe = scene.value?.pickEdgeAt(at.clientX, at.clientY, 14) ?? null;
    if (!pe) { setStatus('info', 'No edge there — click closer to an edge.'); return; }
    const cur = d[row.key] as PickValue | null | undefined;
    const next: PickValue = row.pick === 'edges' && cur && cur.body === pe.body && cur.generation === gen
      ? { ...cur, ids: cur.ids.includes(pe.edge) ? cur.ids.filter((x) => x !== pe.edge) : [...cur.ids, pe.edge] }
      : { body: pe.body, ids: [pe.edge], generation: gen };
    void setCardValue(row.key, next.ids.length ? next : null);
    setStatus('info', `${row.label}: ${next.ids.length} edge${next.ids.length === 1 ? '' : 's'} of ${bodyLabel(pe.body)}${row.pick === 'edges' ? ' — click another to add it, click it again to remove it' : ''}.`);
    return;
  }
  if (!hit) return;
  if (!row) {
    if (t.id === 'boolean') {
      const other = boolSlot === 'target_body' ? 'bool_tool_body' : 'target_body';
      if (d[other] === hit.body) void setCardValue(other, d[boolSlot]);
      void setCardValue(boolSlot, hit.body);
      setStatus('info', `${boolSlot === 'target_body' ? 'Target' : 'Tool'}: ${bodyLabel(hit.body)}.`);
      boolSlot = other;
      return;
    }
    const br = t.rows.find((r) => r.kind === 'body' && (!r.when || r.when(d)));
    if (br) { void setCardValue(br.key, hit.body); setStatus('info', `${br.label}: ${bodyLabel(hit.body)}.`); }
    return;
  }
  const k = row.pick!;
  const id = k === 'edge' || k === 'edges' ? scene.value?.nearestEdge(hit.body, hit.clientX, hit.clientY, 24) ?? null : hit.face;
  if (id === null) { setStatus('info', 'No edge there — click closer to an edge.'); return; }
  const cur = d[row.key] as PickValue | null | undefined;
  let next: PickValue;
  if ((k === 'edges' || k === 'faces') && cur && cur.body === hit.body && cur.generation === gen) next = { ...cur, ids: cur.ids.includes(id) ? cur.ids.filter((x) => x !== id) : [...cur.ids, id] };
  else next = { body: hit.body, ids: [id], generation: gen, ...(k === 'point' ? { point: [hit.point.x, hit.point.y, hit.point.z] as [number, number, number] } : {}) };
  void setCardValue(row.key, next.ids.length ? next : null);
  setStatus('info', `${row.label}: ${next.ids.length} ${k === 'edges' || k === 'edge' ? 'edge' : 'face'}${next.ids.length === 1 ? '' : 's'} of ${bodyLabel(hit.body)}${k === 'edges' || k === 'faces' ? ' — click another to add it, click it again to remove it' : ''}.`);
}

// ---- Orca's offer menu (right click) ----
const offer = ref<{ x: number; y: number; pick: DesignPick | null; key: number } | null>(null);
function onContext(hit: DesignHit | null, e: { clientX: number; clientY: number }) {
  if (picking.spec || sk.choosing) return;
  const r = host.value?.getBoundingClientRect();
  if (!r) return;
  // Right-click picks what is under the cursor at the level of the current pick (Orca: the selection).
  let p: DesignPick | null = designUi.pick;
  if (hit && (!p || p.body !== hit.body || (p.kind === 'face' && p.face !== hit.face))) {
    const edge = p?.kind === 'edge' ? scene.value?.nearestEdge(hit.body, e.clientX, e.clientY, 24) ?? null : null;
    p = edge !== null ? { kind: 'edge', body: hit.body, edge, generation: design.generation } : p?.kind === 'body' ? { kind: 'body', body: hit.body } : { kind: 'face', body: hit.body, face: hit.face, generation: design.generation };
    designUi.pick = p;
    designUi.selected = [];
  } else if (!hit) { p = null; designUi.pick = null; }
  offer.value = { x: e.clientX - r.left, y: e.clientY - r.top, pick: p, key: Date.now() };
}

/** Choosing where to sketch: a click on a flat face starts the sketch on it. */
function chooseSketchFace(hit: DesignHit | null) {
  if (!hit) { setStatus('info', 'Click a flat face, or pick a plane above — Esc cancels.'); return; }
  const gen = design.generation;
  void readDesign(async (c, doc) => (await c.call<FaceInfo>('face_info', { doc, body: hit.body, face: hit.face, generation: gen })).result).then((f) => {
    if (!f.plane) { setStatus('info', 'That face is not flat — click a flat face, or pick a plane.'); return; }
    void beginSketch({ face: { body: hit.body, face: hit.face }, generation: gen });
  }).catch((e: unknown) => setStatus('warn', String((e as Error)?.message ?? e)));
}

/** A finished sketch under the cursor (its stroke, or inside its closed profile), if one is shown. */
const layer = ref<{ shown: readonly import('../sketch/committed').CommittedSketch[] } | null>(null);
function sketchAt(x: number, y: number): number | null {
  const s = scene.value, list = layer.value?.shown ?? [];
  if (!s || !list.length) return null;
  const r = host.value!.getBoundingClientRect();
  return hitSketch(list, (p) => { const q = s.project(p); return q[2] > 1 ? null : [q[0], q[1]]; }, x - r.left, y - r.top);
}

/**
 * Orca's edge set (DesignSketchTool::handle_solid_click): with an edge selected, Shift / Ctrl+click
 * on another edge of the same body adds it, on one already in the set removes it (the current one
 * leaving hands over to the previous; the last leaving clears the selection). Only edges, only one
 * body: a dress-up acts on one body. Returns false when the click isn't about the set.
 */
function extendEdgeSet(at: { clientX: number; clientY: number }): boolean {
  const p = designUi.pick;
  if (p?.kind !== 'edge' || p.generation !== design.generation) return false;
  const pe = scene.value?.pickEdgeAt(at.clientX, at.clientY, 14) ?? null;
  if (!pe || pe.body !== p.body) return false;
  const next = toggleSetEdge(p, pe.edge);
  designUi.pick = next;
  last = null;
  if (!next) { setStatus('info', 'Nothing selected'); return true; }
  const n = pickEdges(next).length;
  setStatus('info', n > 1
    ? `${bodyLabel(next.body)}: ${n} edges selected — Shift+click adds or removes one, Fillet/Chamfer dresses them all.`
    : `Edge ${next.edge} of ${bodyLabel(next.body)} selected — Shift+click to add edges, or click again for the whole body.`);
  return true;
}

function onClick(hit: DesignHit | null, mods: { shift: boolean; ctrl: boolean; clientX: number; clientY: number }) {
  if (sk.choosing) { chooseSketchFace(hit); return; }
  if (picking.spec) { onPickClick(hit, mods); return; }
  if ((mods.shift || mods.ctrl) && !card.tool && extendEdgeSet(mods)) return;
  // Orca: a click inside a finished sketch's region (or on its stroke) picks the sketch —
  // into the open card's Sketch row, else as the selected feature.
  const si = sketchAt(mods.clientX, mods.clientY);
  if (si !== null) {
    const rows = cardSketchRows();
    const name = design.features[si]?.name ?? `Sketch ${si + 1}`;
    if (rows.length) {
      const row = rows.find((r) => r.value < 0) ?? rows[0];
      void setCardValue(row.key, si);
      setStatus('info', `${row.label}: ${name}.`);
      return;
    }
    if (!card.tool) {
      designUi.pick = null;
      designUi.selected = mods.shift || mods.ctrl ? [...designUi.selected.filter((i) => i !== si), si] : [si];
      setStatus('info', `${name} — double-click to edit it, Shift+E to extrude it.`);
      return;
    }
  }
  if (card.tool) {
    // A card is open: a click on a face / edge feeds the card's first matching reference row.
    feedCard(hit, mods);
    return;
  }
  if (!hit) {
    last = null;
    designUi.pick = null;
    designUi.selected = [];
    design.status = null;
    return;
  }
  const same = !!last && last.body === hit.body && last.face === hit.face && Math.hypot(last.x - hit.clientX, last.y - hit.clientY) < 8;
  let level = same ? (last!.level + 1) % 3 : 0;
  let edge: number | null = null;
  if (level === 2) {
    edge = scene.value?.nearestEdge(hit.body, hit.clientX, hit.clientY, 24) ?? null;
    if (edge === null) level = 0;
  }
  last = { x: hit.clientX, y: hit.clientY, body: hit.body, face: hit.face, level };
  designUi.selected = [];
  const gen = design.generation;
  if (level === 0) {
    designUi.pick = { kind: 'body', body: hit.body };
    const src = design.bodies[hit.body]?.source_feature;
    setStatus('info', `${bodyLabel(hit.body)}${src !== undefined && design.features[src] ? `, made by ${design.features[src].name}` : ''}. Click again for the face.`);
  } else if (level === 1) {
    designUi.pick = { kind: 'face', body: hit.body, face: hit.face, generation: gen };
    setStatus('info', `Face ${hit.face} of ${bodyLabel(hit.body)}. Click again for the nearest edge.`);
    void readDesign(async (c, doc) => (await c.call<{ surface: string; area: number }>('face_info', { doc, body: hit.body, face: hit.face, generation: gen })).result)
      .then((f) => { if (designUi.pick?.kind === 'face' && designUi.pick.face === hit.face && design.generation === gen) setStatus('info', `Face ${hit.face} of ${bodyLabel(hit.body)}: ${f.surface}, ${f.area.toFixed(1)} mm². Click again for the nearest edge.`); })
      .catch(() => {});
  } else {
    designUi.pick = { kind: 'edge', body: hit.body, edge: edge!, generation: gen };
    setStatus('info', `Edge ${edge} of ${bodyLabel(hit.body)}. Shift+click to add edges, or click again for the whole body.`);
    void readDesign(async (c, doc) => (await c.call<{ curve: string; length: number }>('edge_info', { doc, body: hit.body, edge, generation: gen })).result)
      .then((e) => { if (designUi.pick?.kind === 'edge' && designUi.pick.edge === edge && !designUi.pick.more?.length && design.generation === gen) setStatus('info', `Edge ${edge} of ${bodyLabel(hit.body)}: ${e.curve}, ${e.length.toFixed(2)} mm. Shift+click to add edges, or click again for the whole body.`); })
      .catch(() => {});
  }
}

onMounted(() => {
  const el = host.value!;
  try {
    const s = new DesignScene(el, {
      onClick, onContext,
      onDbl: (e) => {
        const si = sketchAt(e.clientX, e.clientY);
        if (si === null || card.tool || picking.spec) return false;
        void beginSketch({ feature: si });
        return true;
      },
    });
    scene.value = s;
    registerDesignViewport({
      fitAll: () => s.fitAll(),
      fitSelection: () => {
        const p = designUi.pick;
        const bodies = p ? [p.body] : design.bodies.filter((b) => designUi.selected.includes(b.source_feature)).map((b) => b.index);
        if (bodies.length) s.fitBodies(bodies); else s.fitAll();
      },
      setView: (p) => s.setView(p),
      sketchView: (plane, entities, around) => {
        if (!plane) { s.endSketchView(); return; }
        const b = bounds(entities);
        let box: Box3 | null = around ? new Box3(new Vector3(around.min[0], around.min[1], around.min[2]), new Vector3(around.max[0], around.max[1], around.max[2])) : null;
        if (b) {
          box = box ?? new Box3();
          const pad = Math.max(10, Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 0.15);
          for (const p of [[b.min[0] - pad, b.min[1] - pad], [b.max[0] + pad, b.min[1] - pad], [b.max[0] + pad, b.max[1] + pad], [b.min[0] - pad, b.max[1] + pad]] as Array<[number, number]>) box.expandByPoint(new Vector3(...toWorld(plane, p)));
        }
        s.sketchView(plane, box);
      },
      zoom: (d) => s.zoom(d),
      modelMidZ: () => s.modelMidZ(),
      screenPoint: (p) => s.screenPoint([p[0], p[1], p[2]]),
      capture: async (w, h) => {
        s.requestRender();
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const out = document.createElement('canvas');
        out.width = w; out.height = h;
        const ctx = out.getContext('2d')!;
        ctx.fillStyle = getComputedStyle(el).getPropertyValue('--bg-0').trim() || '#0d0f12';
        ctx.fillRect(0, 0, w, h);
        s.renderer.render(s.scene, s.camera);
        ctx.drawImage(s.renderer.domElement, 0, 0, w, h);
        return new Promise<Blob>((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('capture failed'))), 'image/png'));
      },
    });
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e);
  }
});
onBeforeUnmount(() => { registerDesignViewport(null); scene.value?.dispose(); scene.value = null; });

watch([scene, shownBodies, bodyColours], ([s, list, cols]) => s?.setBodies(list, cols), { immediate: true });
watch([scene, pickMode], ([s, m]) => s?.setPickMode(m), { immediate: true });
watch([scene, ghost], ([s, g]) => s?.setGhost(g), { immediate: true });
watch([scene, () => designUi.section && { ...designUi.section }], ([s, c]) => s?.setSection(c ?? null), { immediate: true });
watch([scene, () => designUi.hiddenBodies.slice()], ([s, h]) => s?.setHidden(h), { immediate: true });
watch([scene, highlight], ([s, h]) => s?.setHighlight(h), { immediate: true });
watch([scene, bed, () => designUi.showBed], ([s, b, show]) => s?.setBed(b, show), { immediate: true });
watch([scene, () => design.modelingOrigin, () => designUi.showOrigin], ([s, o, show]) => s?.setOrigin(o, show), { immediate: true });
</script>

<template>
  <div ref="host" class="dvp" data-testid="design-viewport">
    <div v-if="failed" class="dvp__fail">
      <strong>3D view unavailable</strong>
      <span>{{ failed }}. Enable hardware acceleration in your browser to use the Design tab.</span>
    </div>
    <SketchesLayer ref="layer" :scene="scene" />
    <SketchOverlay :scene="scene" />
    <slot />
    <OfferMenu v-if="offer" :key="offer.key" :x="offer.x" :y="offer.y" :pick="offer.pick" @close="offer = null" />
  </div>
</template>

<style scoped>
.dvp {
  position: relative; width: 100%; height: 100%; overflow: hidden; user-select: none;
  background: radial-gradient(120% 90% at 50% 0%, var(--vp-bg-top), var(--vp-bg) 70%);
}
.dvp :deep(.vp-canvas) { position: absolute; inset: 0; display: block; outline: none; touch-action: none; }
.dvp__fail { position: absolute; inset: 0; display: grid; place-content: center; gap: 6px; text-align: center; padding: 24px; color: var(--fg-1); font-size: var(--fs-md); }
.dvp__fail strong { color: var(--fg-0); font-size: var(--fs-lg); }
</style>
