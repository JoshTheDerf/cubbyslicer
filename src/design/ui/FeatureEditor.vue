<script setup lang="ts">
/**
 * The selected feature's parameters, generated from what the kernel reports for it
 * (`get_feature` + the `describe_tools` field schema, laid out by fields.ts like Orca's cards).
 * Numbers, integers, booleans and enums are editable; a bindable number can be driven by an
 * expression of the design's variables (fx). Changes are applied together as one edit (one
 * rebuild, one undo step) with Apply or Enter; a refused edit shows the kernel's message here.
 */
import { computed, reactive, ref, watch } from 'vue';
import { getFeature, selectFeature, setFeatureParams, setSuppressed } from '../commands';
import { editorFields, FEATURE_ICONS, refText, type EditorField } from '../fields';
import type { PickKind, PickValue } from '../pick';
import RefField from './RefField.vue';
import type { FeatureJson } from '../kernel/types';
import { design, designKernel, editBlocker } from '../session';
import { beginSketch } from '../sketch/session';
import { editedFeature } from '../state';
import { toast } from '../../ui';

const index = computed(() => editedFeature());
const feature = ref<FeatureJson | null>(null);
const loading = ref(false);
const loadError = ref('');
const draft = reactive<Record<string, unknown>>({});
const exprOn = reactive<Record<string, boolean>>({});
const exprDraft = reactive<Record<string, string>>({});
const applying = ref(false);

const readOnly = computed(() => !!editBlocker());
const busy = computed(() => !!designKernel().status.busy);
const scene = computed(() => (index.value !== null ? design.features[index.value] : undefined));

let token = 0;
/** The design generation the draft (and any ids picked into it) belongs to: sent with the edit. */
let loadedGeneration = design.generation;
async function load() {
  const i = index.value;
  const t = ++token;
  loadedGeneration = design.generation;
  if (i === null || !design.features[i]) { feature.value = null; return; }
  loading.value = true;
  loadError.value = '';
  try {
    const f = await getFeature(i);
    if (t !== token) return;
    feature.value = f;
    for (const k of Object.keys(draft)) delete draft[k];
    for (const k of Object.keys(exprOn)) delete exprOn[k];
    for (const k of Object.keys(exprDraft)) delete exprDraft[k];
    for (const [k, e] of Object.entries(f.expr ?? {})) { exprOn[k] = true; exprDraft[k] = e; }
  } catch (e) {
    if (t === token) { feature.value = null; loadError.value = e instanceof Error ? e.message : String(e); }
  } finally {
    if (t === token) loading.value = false;
  }
}
// Reload when another feature is picked or the document changed under it (edit, undo, reopen).
watch([index, () => design.generation, () => scene.value?.name, () => scene.value?.enabled], () => { void load(); }, { immediate: true });

/** Current values: the feature with the draft applied (drives `when`). */
const values = computed<Record<string, unknown>>(() => (feature.value ? { ...feature.value, ...draft } : {}));
const rows = computed<EditorField[]>(() => {
  const f = feature.value, t = design.tools;
  if (!f || !t) return [];
  return editorFields({ ...f, ...draft } as FeatureJson, t.fields, t.bindable_fields);
});

const fieldChanges = computed(() => {
  const f = feature.value;
  const out: Record<string, unknown> = {};
  if (!f) return out;
  for (const [k, v] of Object.entries(draft)) if (JSON.stringify(v) !== JSON.stringify(f[k]) && !exprOn[k]) out[k] = v;
  return out;
});
const exprMap = computed(() => {
  const out: Record<string, string> = {};
  for (const [k, on] of Object.entries(exprOn)) if (on && exprDraft[k]?.trim()) out[k] = exprDraft[k].trim();
  return out;
});
const exprChanged = computed(() => JSON.stringify(exprMap.value) !== JSON.stringify(feature.value?.expr ?? {}));
const dirty = computed(() => Object.keys(fieldChanges.value).length > 0 || exprChanged.value);

const numText = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '');
function setNum(k: string, s: string | number, int: boolean) {
  const n = Number(s);
  if (String(s).trim() === '' || !Number.isFinite(n)) return;
  draft[k] = int ? Math.round(n) : n;
}
function setVec(k: string, axis: number, s: string | number) {
  const n = Number(s);
  if (!Number.isFinite(n)) return;
  const cur = (values.value[k] as number[] | undefined) ?? [0, 0, 0];
  const next = [...cur];
  next[axis] = n;
  draft[k] = next;
}
function toggleExpr(r: EditorField) {
  exprOn[r.key] = !exprOn[r.key];
  if (exprOn[r.key] && !exprDraft[r.key]) exprDraft[r.key] = numText(values.value[r.key]);
}

async function apply() {
  const i = index.value;
  if (i === null || !dirty.value || readOnly.value) return;
  applying.value = true;
  try {
    await setFeatureParams(i, fieldChanges.value, exprChanged.value ? exprMap.value : undefined, loadedGeneration);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    applying.value = false;
  }
}
function revert() { void load(); }

const error = computed(() => {
  const i = index.value;
  if (i === null) return '';
  return design.featureErrors[i] || (design.failing?.index === i ? design.failing.error : '') || design.mateConflicts.find((m) => m.feature === i)?.reason || '';
});
const featureName = (k: number) => design.features[k]?.name;

// ---- references: picked on the feature's input (the design before it) ----
const PICK_KINDS: Partial<Record<string, PickKind>> = { face: 'face', edge: 'edge', faces: 'faces', edges: 'edges', body: 'body' };
const pickKind = (r: EditorField) => (r.ref ? PICK_KINDS[r.ref] : undefined);
function refValue(r: EditorField): PickValue | null {
  const v = values.value[r.key];
  const body = r.bodyKey ? Number(values.value[r.bodyKey]) : NaN;
  if (r.ref === 'body') return typeof v === 'number' && v >= 0 ? { body: v, ids: [], generation: 0 } : null;
  const ids = Array.isArray(v) ? (v as number[]) : typeof v === 'number' && v >= 0 ? [v] : [];
  if (!ids.length) return null;
  return { body: Number.isFinite(body) && body >= 0 ? body : Math.max(0, design.bodies.length - 1), ids, generation: 0 };
}
function setRef(r: EditorField, v: PickValue | null) {
  if (r.ref === 'body') { draft[r.key] = v ? v.body : -1; return; }
  const ids = v?.ids ?? [];
  draft[r.key] = r.ref === 'faces' || r.ref === 'edges' ? ids : ids[0] ?? -1;
  if (r.key === 'dressup_edges') draft.dressup_edge = ids[0] ?? -1;
  if (r.bodyKey && v) draft[r.bodyKey] = v.body;
}
const pickPrompt = (r: EditorField) => (r.ref === 'body' ? 'Click a body in the viewport' : r.ref === 'edge' || r.ref === 'edges' ? 'Click a solid EDGE in the viewport' : 'Click a solid FACE in the viewport');
function featureChoices(r: EditorField) {
  const types = r.featureTypes ?? ['Sketch'];
  return design.features.filter((f) => types.includes(f.type) && f.index < (index.value ?? 0)).map((f) => ({ value: f.index, label: f.name }));
}
const datumChoices = computed(() => [
  { value: 0, label: 'XY' }, { value: 1, label: 'XZ' }, { value: 2, label: 'YZ' },
  ...design.features.filter((f) => f.type === 'Plane' && f.enabled && f.index < (index.value ?? 0)).map((f, k) => ({ value: 3 + k, label: f.name })),
]);
const entitiesInfo = computed(() => {
  const f = feature.value;
  if (!f || f.type !== 'Sketch') return '';
  const n = Array.isArray(f.entities) ? f.entities.length : 0, c = Array.isArray(f.entity_constraints) ? f.entity_constraints.length : 0;
  const regions = Array.isArray(f.imported_regions) ? f.imported_regions.length : 0;
  return n ? `${n} entit${n === 1 ? 'y' : 'ies'}, ${c} constraint${c === 1 ? '' : 's'}` : regions ? `${regions} imported region${regions === 1 ? '' : 's'} (text / SVG)` : 'Parametric profile';
});
</script>

<template>
  <section v-if="index !== null && scene" class="fe" aria-label="Feature parameters" data-testid="design-feature-editor">
    <header class="fe__head">
      <UIcon :name="FEATURE_ICONS[scene.type] ?? 'i-lucide-box'" class="fe__icon" />
      <div class="fe__titles">
        <span class="fe__title">{{ scene.name }}</span>
        <span class="fe__type">{{ scene.type }} · #{{ index + 1 }}<template v-if="!scene.enabled"> · suppressed</template></span>
      </div>
      <UIcon v-if="loading" name="i-lucide-loader-circle" class="size-3.5 animate-spin text-muted" />
    </header>

    <div v-if="error" class="fe__error" role="alert">
      <UIcon name="i-lucide-circle-x" class="size-4 flex-none" />
      <div class="min-w-0">
        <p>{{ error }}</p>
        <UButton v-if="scene.enabled && !readOnly" size="xs" color="error" variant="soft" icon="i-lucide-eye-off" label="Suppress this feature" class="mt-1.5"
                 @click="setSuppressed([index], true).catch((e) => toast.error(String(e?.message ?? e)))" />
      </div>
    </div>
    <p v-else-if="!scene.enabled" class="fe__note">Suppressed: the design is rebuilt without it. Its parameters apply again once it is unsuppressed.</p>
    <p v-if="loadError" class="fe__note fe__note--err">{{ loadError }}</p>
    <p v-if="entitiesInfo" class="fe__note">{{ entitiesInfo }}</p>
    <UButton v-if="scene.type === 'Sketch'" icon="i-lucide-pen-tool" size="sm" color="primary" variant="soft" label="Edit sketch" class="self-start"
             :disabled="!!editBlocker()" data-testid="design-edit-sketch" @click="beginSketch({ feature: index })" />

    <form v-if="rows.length" class="fe__grid" @submit.prevent="apply">
      <template v-for="r in rows" :key="r.key">
        <label class="fe__label" :for="`fe-${r.key}`">{{ r.label }}<span v-if="r.unit && r.kind !== 'bool'" class="fe__unit"> ({{ r.unit }})</span></label>
        <div class="fe__ctl" :data-field="r.key">
          <RefField v-if="r.kind === 'ref' && pickKind(r)" :pick-key="`editor:${index}:${r.key}`" :kind="pickKind(r)!" :label="r.label" :prompt="pickPrompt(r)"
                    :value="refValue(r)" :disabled="readOnly" :rollback-before="index" :empty-text="r.ref === 'body' ? 'last body' : r.key === 'shell_face' ? '(none — closed hollow, refused by the kernel)' : undefined"
                    @update="(v) => setRef(r, v)" />
          <USelect v-else-if="r.kind === 'ref' && r.ref === 'feature' && !Array.isArray(values[r.key])" :id="`fe-${r.key}`" :model-value="values[r.key] as number"
                   :items="featureChoices(r)" value-key="value" label-key="label" size="sm" class="fe__in" :disabled="readOnly" @update:model-value="draft[r.key] = $event" />
          <USelect v-else-if="r.kind === 'ref' && r.ref === 'datum'" :id="`fe-${r.key}`" :model-value="values[r.key] as number" :items="datumChoices" value-key="value" label-key="label"
                   size="sm" class="fe__in" :disabled="readOnly" @update:model-value="draft[r.key] = $event" />
          <template v-else-if="r.kind === 'ref'">
            <span class="fe__ref">
              <template v-if="r.ref === 'feature' && typeof values[r.key] === 'number' && featureName(values[r.key] as number)">
                <button type="button" class="fe__link" @click="selectFeature(values[r.key] as number)">{{ refText(values[r.key], r.ref!, featureName) }}</button>
              </template>
              <template v-else>{{ refText(values[r.key], r.ref!, featureName) }}</template>
            </span>
          </template>
          <template v-else-if="(r.kind === 'number' || r.kind === 'int') && exprOn[r.key]">
            <UInput :id="`fe-${r.key}`" v-model="exprDraft[r.key]" size="sm" class="fe__in" placeholder="e.g. width / 2" :disabled="readOnly" spellcheck="false"
                    :aria-label="`${r.label} expression`" @keydown.enter.prevent="apply" />
            <span class="fe__eval" :title="`Current value: ${numText(feature?.[r.key])}`">= {{ numText(feature?.[r.key]) }}</span>
          </template>
          <UInput v-else-if="r.kind === 'number' || r.kind === 'int'" :id="`fe-${r.key}`" :model-value="numText(values[r.key])" type="number" size="sm" class="fe__in"
                  :step="r.kind === 'int' ? 1 : 'any'" :min="r.min" :max="r.max" :disabled="readOnly" inputmode="decimal"
                  @update:model-value="setNum(r.key, $event, r.kind === 'int')" @keydown.enter.prevent="apply" />
          <USwitch v-else-if="r.kind === 'bool'" :id="`fe-${r.key}`" :model-value="!!values[r.key]" size="sm" :disabled="readOnly"
                   @update:model-value="draft[r.key] = $event" />
          <USelect v-else-if="r.kind === 'enum'" :id="`fe-${r.key}`" :model-value="values[r.key] as string | number" :items="r.choices" value-key="value" label-key="label"
                   size="sm" class="fe__in" :disabled="readOnly" @update:model-value="draft[r.key] = $event" />
          <div v-else-if="r.kind === 'vec3'" class="fe__vec">
            <UInput v-for="(ax, k) in ['X', 'Y', 'Z']" :key="ax" :model-value="numText((values[r.key] as number[] | undefined)?.[k])" type="number" step="any" size="sm"
                    :aria-label="`${r.label} ${ax}`" :disabled="readOnly" @update:model-value="setVec(r.key, k, $event)" @keydown.enter.prevent="apply" />
          </div>
          <UInput v-else-if="r.kind === 'text'" :id="`fe-${r.key}`" :model-value="String(values[r.key] ?? '')" size="sm" class="fe__in" :disabled="readOnly"
                  @update:model-value="draft[r.key] = $event" />
          <UTooltip v-if="r.bindable" :text="exprOn[r.key] ? 'Use a plain value' : 'Drive it with an expression (variables, + − × ÷, sqrt, sin…)'">
            <UButton size="xs" :variant="exprOn[r.key] ? 'soft' : 'ghost'" :color="exprOn[r.key] ? 'primary' : 'neutral'" icon="i-lucide-square-function"
                     :aria-label="`${r.label}: expression`" :aria-pressed="!!exprOn[r.key]" :disabled="readOnly" class="fe__fx" @click="toggleExpr(r)" />
          </UTooltip>
        </div>
      </template>
      <div v-if="rows.length" class="fe__actions">
        <UButton type="button" size="sm" color="neutral" variant="ghost" label="Revert" :disabled="!dirty || applying" @click="revert" />
        <UButton type="submit" size="sm" :color="dirty ? 'primary' : 'neutral'" :variant="dirty ? 'solid' : 'soft'" :label="applying ? 'Rebuilding…' : 'Apply'" :loading="applying" :disabled="!dirty || readOnly || (busy && !applying)"
                 data-testid="design-apply" />
      </div>
    </form>
    <p v-else-if="feature && !loading && !entitiesInfo" class="fe__note">This feature has no parameters to edit here.</p>
  </section>
</template>

<style scoped>
.fe { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-2); }
.fe__head { display: flex; align-items: center; gap: 8px; }
.fe__icon { width: 18px; height: 18px; color: var(--ui-primary); flex: none; }
.fe__titles { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.fe__title { font: 600 var(--fs-md) var(--font); color: var(--fg-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fe__type { font-size: var(--fs-xs); color: var(--fg-2); }
.fe__error { display: flex; gap: 8px; padding: 8px; border-radius: var(--radius-sm); font-size: var(--fs-sm); line-height: 1.35;
  color: var(--fg-0); background: color-mix(in srgb, var(--danger) 14%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); }
.fe__error > :first-child { color: var(--danger); margin-top: 1px; }
.fe__error p { margin: 0; overflow-wrap: anywhere; }
.fe__note { margin: 0; font-size: var(--fs-sm); color: var(--fg-1); line-height: 1.35; }
.fe__note--err { color: var(--danger); }
.fe__grid { display: grid; grid-template-columns: minmax(84px, auto) minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.fe__label { font-size: var(--fs-sm); color: var(--fg-1); }
.fe__unit { color: var(--fg-2); }
.fe__ctl { display: flex; align-items: center; gap: 4px; min-width: 0; }
.fe__in { flex: 1; min-width: 0; }
.fe__vec { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; flex: 1; min-width: 0; }
.fe__ref { font-size: var(--fs-sm); color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fe__link { color: var(--ui-primary); background: none; border: 0; padding: 0; font: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.fe__eval { font: var(--fs-xs) var(--mono); color: var(--fg-2); white-space: nowrap; }
.fe__fx { flex: none; }
.fe__actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }
</style>
