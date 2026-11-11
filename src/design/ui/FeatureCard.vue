<script setup lang="ts">
/**
 * The open feature card (Orca's tool card in the Design sidebar): title with the new feature's
 * name, Orca's hint, the rows of the tool (tools.ts) — numbers, switches, choices, and the
 * reference rows that pick in the viewport — the preview status ("Preview — N triangles" /
 * "Invalid: …") and Cancel / OK. OK adds the feature as one edit (one rebuild, one undo step).
 */
import { computed } from 'vue';
import { bindingTokensOf } from '../../app/shell/useActions';
import { card, cardProblem, confirmCard, cancelCard, defaultName, runPreview, setCardValue } from '../create';
import { designKernel } from '../session';
import type { PickHit, PickValue } from '../pick';
import { acceptFace, acceptPlaneFace, bodyOptions, datumOptions, planeOptions, sketchOptions, type CardRow, type KernelReads, type Option } from '../tools';
import { readDesign } from '../session';
import RefField from './RefField.vue';
import { toast } from '../../ui';

const tool = computed(() => card.tool);
const d = computed(() => card.draft);
const rows = computed(() => (tool.value?.rows ?? []).filter((r) => !r.when || r.when(d.value)));
const name = computed(() => (tool.value ? defaultName(tool.value.type(d.value)) : ''));
const problem = computed(() => (tool.value ? cardProblem() : null));
const busy = computed(() => !!designKernel().status.busy && !card.confirming);

const reads: KernelReads = { call: <T>(method: string, params: Record<string, unknown> = {}) => readDesign(async (c, doc) => (await c.call<T>(method, { doc, ...params })).result) };
const faceFilter = (r: CardRow) => (r.accept ? (hit: PickHit) => acceptFace(hit, reads, r.accept!) : undefined);
const planeFace = (axes: boolean) => (hit: PickHit) => acceptPlaneFace(hit, reads, axes);

function set(key: string, v: unknown) { void setCardValue(key, v); }
function setNum(key: string, s: string | number, int: boolean) {
  const n = Number(s);
  if (String(s).trim() === '' || !Number.isFinite(n)) return;
  set(key, int ? Math.round(n) : n);
}
function setVec(key: string, axis: number, s: string | number) {
  const n = Number(s);
  if (!Number.isFinite(n)) return;
  const cur = [...((d.value[key] as number[] | undefined) ?? [0, 0, 0])];
  cur[axis] = n;
  set(key, cur);
}
const numText = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '');
const items = (opts: readonly Option[]) => opts.map(([value, label]) => ({ value, label }));

function optionsOf(r: CardRow): Array<{ value: string | number; label: string }> {
  const ctx = card.ctx;
  if (!ctx) return [];
  switch (r.kind) {
    case 'enum': return items((d.value[`${r.key}Options`] as Option[] | undefined) ?? r.options ?? []);
    case 'plane': return items(planeOptions(ctx, r.axes));
    case 'body': return items(bodyOptions(ctx));
    case 'sketch': return items(sketchOptions(ctx, r.helix, r.key === 'sweep_path_ref' ? Number(d.value.sketch_ref) : -1));
    case 'datum': return items(datumOptions(ctx));
    case 'axisDir': return items([['X', 'X'], ['Y', 'Y'], ['Z', 'Z']]);
    default: return [];
  }
}
function standardItems(r: CardRow) {
  const ctx = card.ctx;
  if (!ctx) return [];
  const list = r.table === 'thread' ? ctx.threads.map((t) => ({ value: t.name, label: t.name, suffix: `${t.pitch} mm` })) : ctx.holes.map((h) => ({ value: h.designation, label: h.designation, suffix: `Ø${h.clearance}` }));
  return [{ value: '', label: 'Custom', suffix: '' }, ...list];
}
function toggleSketch(i: number, on: boolean) {
  const cur = new Set((d.value.loft_profile_refs as number[] | undefined) ?? []);
  if (on) cur.add(i); else cur.delete(i);
  set('loft_profile_refs', [...cur].sort((a, b) => a - b));
}
function onPicked(key: string, v: PickValue | null) {
  if (key.endsWith('Face') && d.value[key.slice(0, -4)] !== 'face' && v) void setCardValue(key.slice(0, -4), 'face');
  set(key, v);
}
async function ok() {
  const r = await confirmCard();
  if (!r.ok && r.error && !card.tool) toast.error(r.error);
}
const previewIcon = computed(() => ({ ok: 'i-lucide-eye', invalid: 'i-lucide-circle-alert', running: 'i-lucide-loader-circle', manual: 'i-lucide-timer', idle: 'i-lucide-eye-off', off: 'i-lucide-circle-check' }[card.preview.state]));
</script>

<template>
  <section v-if="tool" class="fc" aria-label="New feature" data-testid="design-card" :data-tool="tool.id">
    <header class="fc__head">
      <UIcon :name="tool.icon" class="fc__icon" />
      <div class="fc__titles">
        <span class="fc__title">{{ name }}</span>
        <span class="fc__type">New {{ tool.title.toLowerCase() }}</span>
      </div>
      <UIcon v-if="card.resolving" name="i-lucide-loader-circle" class="size-3.5 animate-spin text-muted" />
      <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Cancel" @click="cancelCard()" />
    </header>
    <p v-if="tool.hint" class="fc__hint">{{ tool.hint }}</p>

    <form class="fc__grid" @submit.prevent="ok">
      <template v-for="r in rows" :key="r.key">
        <label class="fc__label" :class="{ 'fc__label--top': r.kind === 'sketches' || r.kind === 'pick' }" :for="`fc-${r.key}`">{{ r.label }}<span v-if="r.unit && r.kind !== 'bool'" class="fc__unit"> ({{ r.unit }})</span></label>
        <div class="fc__ctl" :data-field="r.key">
          <UInput v-if="r.kind === 'number' || r.kind === 'int'" :id="`fc-${r.key}`" :model-value="numText(d[r.key])" type="number" size="sm" class="fc__in"
                  :step="r.kind === 'int' ? 1 : 'any'" :min="r.min" :max="r.max" inputmode="decimal" @update:model-value="setNum(r.key, $event, r.kind === 'int')" @keydown.enter.prevent="ok" />
          <USwitch v-else-if="r.kind === 'bool'" :id="`fc-${r.key}`" :model-value="!!d[r.key]" size="sm" @update:model-value="set(r.key, $event)" />
          <div v-else-if="r.kind === 'vec3'" class="fc__vec">
            <UInput v-for="(ax, k) in ['X', 'Y', 'Z']" :key="ax" :model-value="numText((d[r.key] as number[] | undefined)?.[k])" type="number" step="any" size="sm"
                    :aria-label="`${r.label} ${ax}`" @update:model-value="setVec(r.key, k, $event)" @keydown.enter.prevent="ok" />
          </div>
          <RefField v-else-if="r.kind === 'pick'" :pick-key="`card:${r.key}`" :kind="r.pick!" :label="r.label" :prompt="r.prompt ?? 'Click in the viewport'"
                    :value="(d[r.key] as PickValue | null) ?? null" :accept="faceFilter(r)"
                    :empty-text="tool.id === 'shell' ? '(none — pick the face to leave open)' : tool.id === 'fillet' ? '(no edge picked — group below)' : tool.id === 'hole' ? '(none — uses Hole plane)' : tool.id === 'thread' ? '(none — uses Thread plane)' : undefined"
                    @update="(v) => set(r.key, v)" />
          <div v-else-if="r.kind === 'plane'" class="fc__plane">
            <USelect :id="`fc-${r.key}`" :model-value="d[r.key] as string" :items="optionsOf(r)" value-key="value" label-key="label" size="sm" class="fc__in"
                     @update:model-value="set(r.key, $event)" />
            <RefField v-if="d[r.key] === 'face'" :pick-key="`card:${r.key}Face`" kind="face" :label="`${r.label} face`" :prompt="r.axes ? 'Click a flat face, or a cylinder for its axis' : 'Click a flat face for the plane'"
                      :value="(d[`${r.key}Face`] as PickValue | null) ?? null" :accept="planeFace(!!r.axes)" @update="(v) => onPicked(`${r.key}Face`, v)" />
          </div>
          <div v-else-if="r.kind === 'body'" class="fc__plane fc__plane--row">
            <USelect :id="`fc-${r.key}`" :model-value="d[r.key] as number" :items="optionsOf(r)" value-key="value" label-key="label" size="sm" class="fc__in"
                     @update:model-value="set(r.key, $event)" />
            <RefField :pick-key="`card:${r.key}`" kind="body" :label="r.label" prompt="Click a body in the viewport" class="fc__bodypick" compact
                      :value="typeof d[r.key] === 'number' && (d[r.key] as number) >= 0 ? { body: d[r.key] as number, ids: [], generation: 0 } : null"
                      @update="(v) => v && set(r.key, v.body)" />
          </div>
          <div v-else-if="r.kind === 'sketches'" class="fc__checks">
            <UCheckbox v-for="[i, label] in sketchOptions(card.ctx!)" :key="i" :label="label" :model-value="(d.loft_profile_refs as number[]).includes(i as number)"
                       @update:model-value="toggleSketch(i as number, !!$event)" />
          </div>
          <USelectMenu v-else-if="r.kind === 'standard'" :id="`fc-${r.key}`" :model-value="d[r.key] as string" :items="standardItems(r)" value-key="value" label-key="label"
                       size="sm" class="fc__in" :search-input="{ placeholder: 'M6, 1/4-20…' }" @update:model-value="set(r.key, $event)" />
          <USelect v-else :id="`fc-${r.key}`" :model-value="d[r.key] as string | number" :items="optionsOf(r)" value-key="value" label-key="label" size="sm" class="fc__in"
                   @update:model-value="set(r.key, $event)" />
        </div>
      </template>
    </form>

    <div v-if="card.error" class="fc__error" role="alert" data-testid="design-card-error">
      <UIcon name="i-lucide-circle-x" class="size-4 flex-none" />
      <p>{{ card.error }}</p>
    </div>
    <div class="fc__preview" :class="`fc__preview--${card.preview.state}`" data-testid="design-card-preview">
      <UIcon :name="previewIcon" class="size-3.5 flex-none" :class="{ 'animate-spin': card.preview.state === 'running' }" />
      <span>{{ problem && card.preview.state !== 'off' ? problem : card.preview.text || (tool.noPreview ? `${tool.title} ready` : 'No preview') }}</span>
      <UButton v-if="card.preview.state === 'manual'" size="xs" color="neutral" variant="soft" icon="i-lucide-eye" label="Preview" class="ml-auto" :disabled="!!problem || busy"
               @click="runPreview()" />
    </div>
    <footer class="fc__foot">
      <UButton size="sm" color="neutral" variant="ghost" label="Cancel" :kbds="bindingTokensOf('design.card.cancel')" @click="cancelCard()" />
      <UButton size="sm" color="primary" :label="card.confirming ? 'Rebuilding…' : 'OK'" :loading="card.confirming" icon="i-lucide-check" :disabled="!!problem || card.confirming || card.resolving"
               data-testid="design-card-ok" @click="ok" />
    </footer>
  </section>
</template>

<style scoped>
.fc { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid color-mix(in srgb, var(--ui-primary) 45%, var(--line)); border-radius: var(--radius); background: var(--bg-2); }
.fc__head { display: flex; align-items: center; gap: 8px; }
.fc__icon { width: 18px; height: 18px; color: var(--ui-primary); flex: none; }
.fc__titles { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.fc__title { font: 600 var(--fs-md) var(--font); color: var(--fg-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc__type { font-size: var(--fs-xs); color: var(--fg-2); }
.fc__hint { margin: 0; font-size: var(--fs-sm); color: var(--fg-1); line-height: 1.35; }
.fc__grid { display: grid; grid-template-columns: minmax(84px, auto) minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.fc__label { font-size: var(--fs-sm); color: var(--fg-1); }
.fc__label--top { align-self: start; padding-top: 4px; }
.fc__unit { color: var(--fg-2); }
.fc__ctl { display: flex; align-items: center; gap: 4px; min-width: 0; }
.fc__in { flex: 1; min-width: 0; }
.fc__vec { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; flex: 1; min-width: 0; }
.fc__plane { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
.fc__plane--row { flex-direction: row; align-items: center; }
.fc__bodypick { flex: none; }
.fc__checks { display: flex; flex-direction: column; gap: 4px; }
.fc__error { display: flex; gap: 8px; padding: 8px; border-radius: var(--radius-sm); font-size: var(--fs-sm); line-height: 1.35;
  color: var(--fg-0); background: color-mix(in srgb, var(--danger) 14%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); }
.fc__error > :first-child { color: var(--danger); margin-top: 1px; }
.fc__error p { margin: 0; overflow-wrap: anywhere; }
.fc__preview { display: flex; align-items: center; gap: 6px; min-height: 24px; font-size: var(--fs-xs); color: var(--fg-2); }
.fc__preview--ok { color: var(--fg-1); }
.fc__preview--ok > :first-child { color: var(--ui-primary); }
.fc__preview--invalid { color: var(--danger); }
.fc__foot { display: flex; justify-content: flex-end; gap: 6px; }
</style>
