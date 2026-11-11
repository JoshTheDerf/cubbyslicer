<script setup lang="ts">
/**
 * The sketch card in the Design panel while a sketch is open (Orca's sketch session card and
 * constraint manager): plane, degrees of freedom, profile state (closed regions / open ends),
 * a refused constraint with what it conflicts with (Replace it / Keep both / Dismiss), the
 * selection, and every constraint (click selects it and its entities in the view; the bin
 * deletes it and re-solves; conflicting ones are red). Finish / Cancel.
 */
import { computed, ref } from 'vue';
import { sketchUi } from '../sketch/actions';
import { FONT_FAMILIES } from '../../tools/text/fonts';
import { clearRegions, moveRegions, placeRegions } from '../sketch/session';
import { run } from '../../app/shell/useActions';
import { describeConstraint, dimensionText, CONSTRAINT_BY_TYPE } from '../sketch/constraints';
import { isDimension } from '../sketch/model';
import { deleteConstraints, describeEntity, dofText, resolveConflict, sk } from '../sketch/session';
import { live } from '../sketch/driver';

const loops = computed(() => sk.loops?.closed_loops.filter((l) => l.closed) ?? []);
const profile = computed(() => {
  if (sk.regions) return { kind: 'ok', text: `${sk.regions.label}: ${sk.regions.regions.length} outline region${sk.regions.regions.length === 1 ? '' : 's'} (rigid)` };
  const open = sk.loops?.open_ends.length ?? 0;
  const n = loops.value.length;
  if (!sk.entities.filter((e) => !e.construction).length) return { kind: 'muted', text: 'Nothing drawn yet' };
  if (n && !open && sk.loops?.buildable) return { kind: 'ok', text: `${n} closed profile${n === 1 ? '' : 's'} — ready to extrude or revolve` };
  if (n && sk.loops && !sk.loops.buildable) return { kind: 'warn', text: `${n} closed loop${n === 1 ? '' : 's'}, but the profile doesn’t make one region (overlapping or separate loops?)` };
  if (open) return { kind: 'warn', text: `${open} open end${open === 1 ? '' : 's'} (dashed rings) — close the profile to extrude it` };
  return { kind: 'muted', text: 'Open geometry (paths, construction)' };
});
const rows = computed(() => sk.constraints.map((c, i) => ({
  i, c, label: describeConstraint(c, sk.entities), value: isDimension(c) ? dimensionText(c) : '', icon: CONSTRAINT_BY_TYPE.get(c.type)?.icon ?? 'i-lucide-link',
  bad: sk.bad.includes(i), sel: sk.selCons.includes(i), skipped: sk.skipped.includes(i),
})));
const selText = computed(() => {
  if (!sk.sel.length) return '';
  const names = sk.sel.slice(0, 4).map((s) => `${describeEntity(s.e)}${s.role ? ` (${s.role === 'center' ? 'centre' : s.role === 'p0' ? 'start' : 'end'})` : ''}`);
  return `${names.join(', ')}${sk.sel.length > 4 ? ` +${sk.sel.length - 4}` : ''}`;
});
function pick(i: number, ev: MouseEvent) {
  const add = ev.shiftKey || ev.ctrlKey || ev.metaKey;
  sk.selCons = add ? (sk.selCons.includes(i) ? sk.selCons.filter((x) => x !== i) : [...sk.selCons, i]) : [i];
  if (!add) sk.sel = [];
}
const text = ref('Text'), textSize = ref(10), textFont = ref('noto-sans'), textBold = ref(false), textErr = ref(''), textBusy = ref(false);
const fonts = FONT_FAMILIES.map((f) => ({ label: f.label, value: f.id }));
async function placeText() {
  textErr.value = '';
  if (!text.value.trim()) { textErr.value = 'Type some text'; return; }
  textBusy.value = true;
  try {
    const { textRegions } = await import('../sketch/outline');
    const err = placeRegions(await textRegions(text.value, textSize.value, textFont.value, textBold.value), 'Text', { text: { string: text.value, font: textFont.value, height: textSize.value } });
    if (err) textErr.value = err; else sketchUi.textOpen = false;
  } catch (e) { textErr.value = e instanceof Error ? e.message : String(e); } finally { textBusy.value = false; }
}
const offX = computed({ get: () => sk.regions?.offset[0] ?? 0, set: (v: number) => moveRegions([Number(v) || 0, sk.regions?.offset[1] ?? 0]) });
const offY = computed({ get: () => sk.regions?.offset[1] ?? 0, set: (v: number) => moveRegions([sk.regions?.offset[0] ?? 0, Number(v) || 0]) });
const dofClass = computed(() => (!sk.solveOk ? 'bad' : sk.dof === 0 ? 'fixed' : 'free'));
</script>

<template>
  <section class="skp" aria-label="Sketch" data-testid="sketch-panel">
    <header class="skp__head">
      <UIcon name="i-lucide-pen-tool" class="size-4 text-[var(--vp-sketch-free)]" />
      <div class="min-w-0 flex-1">
        <div class="skp__title">{{ sk.feature >= 0 ? `Editing ${sk.name}` : 'New sketch' }}</div>
        <div class="skp__sub">{{ sk.planeLabel }}</div>
      </div>
      <span class="skp__dof" :class="`skp__dof--${dofClass}`">{{ dofText() }}</span>
    </header>

    <p class="skp__profile" :class="`skp__profile--${profile.kind}`" data-testid="sketch-profile">{{ profile.text }}</p>
    <p v-if="live.prompt && sk.tool !== 'select'" class="skp__prompt">{{ live.prompt }}</p>

    <div v-if="sk.conflict" class="skp__conflict" role="alert" data-testid="sketch-conflict">
      <UIcon name="i-lucide-octagon-alert" class="size-4 flex-none text-[var(--danger)]" />
      <div class="min-w-0">
        <p>{{ sk.conflict.message }}</p>
        <div class="skp__actions">
          <UButton v-if="sk.conflict.offenders.length" size="xs" color="error" variant="soft" icon="i-lucide-replace" :label="`Replace #${sk.conflict.offenders[0] + 1}`" data-testid="sketch-conflict-replace" @click="resolveConflict('replace')" />
          <UButton size="xs" color="neutral" variant="soft" label="Keep both (over-constrained)" data-testid="sketch-conflict-keep" @click="resolveConflict('keep')" />
          <UButton size="xs" color="neutral" variant="ghost" label="Dismiss" @click="resolveConflict('dismiss')" />
        </div>
      </div>
    </div>
    <div v-else-if="!sk.solveOk" class="skp__conflict" role="alert">
      <UIcon name="i-lucide-octagon-alert" class="size-4 flex-none text-[var(--danger)]" />
      <p>Over-constrained: {{ sk.bad.map((i) => sk.constraints[i] ? describeConstraint(sk.constraints[i], sk.entities, i) : `#${i + 1}`).join('; ') || 'the solver can’t satisfy every constraint' }}. Delete one of the red constraints.</p>
    </div>

    <p v-if="selText" class="skp__sel">Selected: {{ selText }}</p>

    <form v-if="sketchUi.textOpen" class="skp__text" data-testid="sketch-text-form" @submit.prevent="placeText">
      <UTextarea v-model="text" :rows="2" autoresize size="sm" placeholder="Text" aria-label="Text" />
      <div class="skp__textrow">
        <USelect v-model="textFont" :items="fonts" size="xs" class="min-w-0 flex-1" aria-label="Font" />
        <UInputNumber v-model="textSize" :min="0.5" :max="500" :step="1" size="xs" class="w-24" aria-label="Height (mm)" />
        <UCheckbox v-model="textBold" label="Bold" size="xs" />
      </div>
      <span v-if="textErr" class="skp__err">{{ textErr }}</span>
      <div class="skp__actions">
        <UButton type="submit" size="xs" color="primary" :loading="textBusy" label="Place text" data-testid="sketch-text-place" />
        <UButton size="xs" color="neutral" variant="ghost" label="Close" @click="sketchUi.textOpen = false" />
      </div>
    </form>
    <div v-if="sk.regions" class="skp__regions" data-testid="sketch-regions">
      <span>{{ sk.regions.label }} outline — drag its centre to move it, a corner to scale it, or type the position</span>
      <div class="skp__textrow">
        <label class="skp__sides">X <UInputNumber v-model="offX" :step="1" size="xs" class="w-24" /></label>
        <label class="skp__sides">Y <UInputNumber v-model="offY" :step="1" size="xs" class="w-24" /></label>
        <UButton icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" aria-label="Remove the outline" @click="clearRegions()" />
      </div>
    </div>

    <div class="skp__opts">
      <UCheckbox v-model="sk.construction" label="Construction" size="sm" />
      <label v-if="sk.tool === 'polygon'" class="skp__sides">Sides <UInputNumber v-model="sk.polygonSides" :min="3" :max="64" size="xs" class="w-20" /></label>
    </div>

    <div class="skp__listhead">
      <span>Constraints</span><span class="skp__count">{{ sk.constraints.length }}</span>
    </div>
    <ul class="skp__list" data-testid="sketch-constraints">
      <li v-for="r in rows" :key="r.i" class="skp__row" :class="{ 'is-bad': r.bad, 'is-sel': r.sel }" :title="r.skipped ? 'Skipped by the solver (an entity it can’t solve)' : undefined">
        <button type="button" class="skp__rowmain" @click="pick(r.i, $event)">
          <UIcon :name="r.icon" class="size-3.5 flex-none" />
          <span class="skp__rowtext">{{ r.label }}</span>
          <span v-if="r.value" class="skp__val">{{ r.value }}</span>
        </button>
        <UButton icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" :aria-label="`Delete ${r.label}`" @click="deleteConstraints([r.i])" />
      </li>
      <li v-if="!rows.length" class="skp__empty">No constraints yet. Snaps add them while you draw; the Constrain menu (K) and Dimension (D) add more.</li>
    </ul>

    <footer class="skp__foot">
      <UButton color="neutral" variant="soft" size="sm" label="Cancel" @click="run('design.sketch.cancel')" />
      <UButton color="primary" size="sm" icon="i-lucide-check" label="Finish sketch" :loading="sk.committing" @click="run('design.sketch.finish')" />
    </footer>
  </section>
</template>

<style scoped>
.skp { display: flex; flex-direction: column; gap: 6px; padding: 8px; background: var(--bg-2); border: 1px solid color-mix(in srgb, var(--vp-sketch-free) 35%, var(--line)); border-radius: var(--radius); font-size: var(--fs-sm); color: var(--fg-1); }
.skp__head { display: flex; align-items: center; gap: 8px; }
.skp__title { font: 600 var(--fs-md) var(--font); color: var(--fg-0); }
.skp__sub { font-size: var(--fs-xs); color: var(--fg-2); overflow-wrap: anywhere; }
.skp__dof { flex: none; padding: 2px 7px; font-size: var(--fs-xs); font-weight: 600; border-radius: 10px; }
.skp__dof--free { color: var(--vp-sketch-free); background: color-mix(in srgb, var(--vp-sketch-free) 14%, transparent); }
.skp__dof--fixed { color: var(--vp-sketch-fixed); background: color-mix(in srgb, var(--vp-sketch-fixed) 12%, transparent); }
.skp__dof--bad { color: var(--vp-sketch-bad); background: color-mix(in srgb, var(--vp-sketch-bad) 16%, transparent); }
.skp__profile { margin: 0; }
.skp__profile--ok { color: var(--ui-primary); }
.skp__profile--warn { color: var(--warn); }
.skp__profile--muted { color: var(--fg-2); }
.skp__prompt { margin: 0; color: var(--vp-sketch-preview); }
.skp__conflict { display: flex; gap: 8px; padding: 6px 8px; color: var(--fg-0); background: color-mix(in srgb, var(--danger) 12%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent); border-radius: var(--radius-sm); }
.skp__conflict p { margin: 0; overflow-wrap: anywhere; }
.skp__actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.skp__sel { margin: 0; color: var(--vp-sketch-sel); overflow-wrap: anywhere; }
.skp__opts { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.skp__sides { display: flex; align-items: center; gap: 6px; }
.skp__listhead { display: flex; justify-content: space-between; margin-top: 2px; font: 600 var(--fs-xs) var(--font); letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg-1); }
.skp__count { color: var(--fg-2); }
.skp__list { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow: auto; display: flex; flex-direction: column; gap: 1px; }
.skp__row { display: flex; align-items: center; gap: 2px; border-radius: 4px; }
.skp__row:hover { background: var(--bg-3); }
.skp__row.is-sel { background: color-mix(in srgb, var(--vp-sketch-sel) 16%, transparent); }
.skp__row.is-bad { color: var(--vp-sketch-bad); }
.skp__rowmain { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; min-height: 26px; padding: 0 4px; text-align: left; color: inherit; }
.skp__rowtext { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skp__val { flex: none; font-variant-numeric: tabular-nums; color: var(--vp-sketch-dim); }
.skp__empty { padding: 4px; color: var(--fg-2); }
.skp__text, .skp__regions { display: flex; flex-direction: column; gap: 4px; padding: 6px; background: var(--bg-1); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.skp__textrow { display: flex; align-items: center; gap: 6px; }
.skp__err { font-size: var(--fs-xs); color: var(--danger); }
.skp__foot { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }
</style>
