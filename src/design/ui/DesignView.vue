<script setup lang="ts">
/**
 * The Design tab (OrcaSlicer 2.5's experimental parametric CAD): the side panel (feature tree,
 * parameters, bodies, variables) and the 3D view with its toolbar (fit, origin, bed, Commit to
 * Plate), the kernel's busy state (with Cancel), Orca's status line and the document states
 * (loading, no design, unreadable, cancelled, failed). Mounted the first time the tab opens;
 * mounting it starts the kernel (session.activateDesign).
 *
 * Phones: the 3D view fills the screen; the panel is a bottom sheet with one section at a time.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { bindingTokensOf, run } from '../../app/shell/useActions';
import { compact, layout, phone } from '../../app/shell/uiState';
import { commitCandidates } from '../commands';
import { preferences } from '../../app/preferences';
import { CREATE_TOOLS, TOOL_GROUPS } from '../tools';
import { card, openCard, toolAvailable } from '../create';
import { toast } from '../../ui';
import PickBanner from './PickBanner.vue';
import ShapePalettePopover from '../../cad/ShapePalettePopover.vue';
import { cadUi } from '../../cad/commands';
import { activateDesign, design, designKernel, projectHasDesign, reopenDesign } from '../session';
import { designUi } from '../state';
import DesignPanel from './DesignPanel.vue';
import DesignViewport from './DesignViewport.vue';
import SketchToolbar from './SketchToolbar.vue';
import { beginSketch, sk, stopChoosing } from '../sketch/session';
import { readDesign } from '../session';
import type { DatumsResult } from '../kernel/types';

onMounted(() => activateDesign());

const kernel = designKernel();
const ks = kernel.status;
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
watch(() => ks.busy, (b) => {
  if (b && !timer) timer = setInterval(() => { now.value = Date.now(); }, 500);
  if (!b && timer) { clearInterval(timer); timer = null; }
}, { immediate: true });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

const elapsed = computed(() => (ks.busy ? Math.max(0, Math.round((now.value - ks.busy.since) / 1000)) : 0));
const mb = (n: number) => (n / 1048576).toFixed(1);
const startText = computed(() => {
  const p = ks.progress;
  if (ks.phase !== 'starting') return '';
  if (!p || p.stage === 'download') return p ? `Downloading the CAD kernel… ${mb(p.loaded)} MB` : 'Loading the CAD kernel…';
  return p.stage === 'compile' ? 'Compiling the CAD kernel…' : 'Starting the CAD kernel…';
});
const startPct = computed(() => {
  const p = ks.progress;
  if (!p) return 0;
  if (p.stage === 'download') return p.total ? Math.min(70, Math.round((p.loaded / p.total) * 70)) : 10;
  return p.stage === 'compile' ? 75 : 88;
});

const empty = computed(() => design.phase === 'open' && !design.features.length && !projectHasDesign() && !sk.open && !sk.choosing && !sk.starting);
const candidates = computed(() => (design.phase === 'open' ? commitCandidates().length : 0));
const canCommit = computed(() => design.phase === 'open' && design.bodies.some((b) => b.face_count > 0));
const commitLabel = computed(() => (candidates.value > 1 ? `Commit ${candidates.value} bodies` : 'Commit to Plate'));
const featureMenu = computed(() => TOOL_GROUPS.map((g) => [
  { type: 'label' as const, label: g.label },
  ...CREATE_TOOLS.filter((t) => t.group === g.id).map((t) => {
    const why = design.phase === 'open' ? toolAvailable(t) : 'No design is open.';
    return { label: why ? `${t.title} — ${why}` : t.title, icon: t.icon, disabled: !!why, kbds: bindingTokensOf(`design.add.${t.id}`),
      onSelect: () => { void openCard(t.id).then((e) => { if (e) toast.warn(e); }); } };
  }),
]));
const commitMenu = computed(() => [[
  { type: 'label' as const, label: 'Commit mode' },
  { label: 'As one assembly object', icon: preferences.designCommitMode === 'assembly' ? 'i-lucide-circle-dot' : 'i-lucide-circle',
    description: 'All bodies become one object with a part per body, keeping their relative positions', onSelect: () => { preferences.designCommitMode = 'assembly'; } },
  { label: 'As separate bodies', icon: preferences.designCommitMode === 'bodies' ? 'i-lucide-circle-dot' : 'i-lucide-circle',
    description: 'Each body becomes its own object, placed on its own', onSelect: () => { preferences.designCommitMode = 'bodies'; } },
]]);
// Choosing a sketch plane: the base planes and the design's datum planes.
const datumPlanes = ref<Array<{ name: string; plane: import('../kernel/types').PlaneFrame }>>([]);
watch(() => sk.choosing, (on) => {
  datumPlanes.value = [];
  if (on) void readDesign(async (c, doc) => (await c.call<DatumsResult>('datums', { doc })).result).then((d) => { datumPlanes.value = d.planes; }).catch(() => {});
});
const planeButtons = computed(() => [
  { label: 'Top (XY)', run: () => beginSketch({ plane: 'XY' }), testid: 'sketch-plane-xy' },
  { label: 'Front (XZ)', run: () => beginSketch({ plane: 'XZ' }), testid: 'sketch-plane-xz' },
  { label: 'Right (YZ)', run: () => beginSketch({ plane: 'YZ' }), testid: 'sketch-plane-yz' },
  ...datumPlanes.value.map((p) => ({ label: p.name, run: () => beginSketch({ plane: p.plane, label: p.name }), testid: `sketch-plane-${p.name}` })),
]);
function extrudeFinished(id: 'extrude' | 'revolve') {
  const f = sk.finished;
  if (!f) return;
  sk.finished = null;
  void openCard(id, { prefill: { sketch_ref: f.index } }).then((e) => { if (e) toast.warn(e); });
}
watch(() => card.tool, (t) => { if (t) sk.finished = null; });

const statusIcon = computed(() => ({ info: 'i-lucide-info', ok: 'i-lucide-circle-check', warn: 'i-lucide-triangle-alert', error: 'i-lucide-circle-x' }[design.status?.kind ?? 'info']));
</script>

<template>
  <div class="dv" :class="{ 'dv--phone': phone, 'dv--compact': compact }" data-testid="design-view">
    <!-- The top bar's sidebar button shows / hides this panel too (desktop). -->
    <aside v-if="!phone" v-show="compact || !layout.sidebarCollapsed" class="dv__side" aria-label="Design">
      <DesignPanel />
    </aside>

    <DesignViewport class="dv__vp">
      <SketchToolbar v-if="sk.open" />
      <!-- toolbar (Prepare's plater toolbar position) -->
      <div v-else class="dv__bar" role="toolbar" aria-label="Design view">
        <UTooltip text="Fit the design" :kbds="bindingTokensOf('design.fit')">
          <UButton icon="i-lucide-scan" color="neutral" variant="ghost" size="sm" aria-label="Fit the design" @click="run('design.fit')" />
        </UTooltip>
        <UTooltip text="Origin planes" :kbds="bindingTokensOf('design.toggle-origin')">
          <UButton icon="i-lucide-axis-3d" color="neutral" :variant="designUi.showOrigin ? 'soft' : 'ghost'" size="sm" aria-label="Origin planes" :aria-pressed="designUi.showOrigin"
                   @click="run('design.toggle-origin')" />
        </UTooltip>
        <UTooltip text="Bed" :kbds="bindingTokensOf('design.toggle-bed')">
          <UButton icon="i-lucide-grid-2x2" color="neutral" :variant="designUi.showBed ? 'soft' : 'ghost'" size="sm" aria-label="Bed" :aria-pressed="designUi.showBed"
                   @click="run('design.toggle-bed')" />
        </UTooltip>
        <!-- Orca's Section View and Flip Section (flip only usable while the section is on). -->
        <UTooltip text="Section View — hide part of the model to see inside. PageUp/PageDown move the plane." :kbds="bindingTokensOf('design.section')">
          <UButton icon="i-lucide-square-split-vertical" :color="designUi.section ? 'primary' : 'neutral'" :variant="designUi.section ? 'soft' : 'ghost'" size="sm" aria-label="Section view"
                   :aria-pressed="!!designUi.section" :disabled="design.phase !== 'open'" data-testid="design-section" @click="run('design.section')" />
        </UTooltip>
        <UTooltip text="Flip Section — show the opposite half" :kbds="bindingTokensOf('design.section.flip')">
          <UButton icon="i-lucide-flip-vertical-2" color="neutral" variant="ghost" size="sm" aria-label="Flip section" :disabled="!designUi.section"
                   data-testid="design-section-flip" @click="run('design.section.flip')" />
        </UTooltip>
        <USeparator orientation="vertical" class="h-5 mx-1" />
        <UTooltip text="New sketch — on the picked flat face, or choose a plane" :kbds="bindingTokensOf('design.sketch.new')">
          <UButton icon="i-lucide-pen-tool" color="neutral" :variant="sk.choosing ? 'soft' : 'ghost'" size="sm" :label="phone ? undefined : 'Sketch'" aria-label="New sketch"
                   :disabled="design.phase !== 'open' || design.readOnly || !!card.tool" data-testid="design-new-sketch" @click="run('design.sketch.new')" />
        </UTooltip>
        <UTooltip text="Add a shape as a body (CubbyCAD primitives: exact B-rep where the kernel has the shape)">
          <UButton icon="i-lucide-shapes" color="neutral" :variant="cadUi.paletteOpen ? 'soft' : 'ghost'" size="sm" :label="phone ? undefined : 'Shape'" aria-label="Add shape"
                   data-action="cad.palette" :disabled="design.phase !== 'open' || design.readOnly" data-testid="design-add-shape" @click="run('cad.palette')" />
        </UTooltip>
        <UDropdownMenu :items="featureMenu" :content="{ align: 'center' }" :ui="{ content: 'min-w-60 max-h-[70vh]' }">
          <UButton icon="i-lucide-square-plus" color="neutral" :variant="card.tool ? 'soft' : 'ghost'" size="sm" :label="phone ? undefined : 'Feature'" aria-label="Add a feature"
                   trailing-icon="i-lucide-chevron-down" :disabled="design.phase !== 'open'" data-testid="design-add-feature" />
        </UDropdownMenu>
        <USeparator orientation="vertical" class="h-5 mx-1" />
        <div class="dv__split">
          <UTooltip :text="canCommit ? (preferences.designCommitMode === 'assembly' ? 'All bodies become one object with a part per body; it follows your design edits' : 'Each body becomes its own object; they follow your design edits') : 'Nothing to commit yet'"
                    :kbds="bindingTokensOf('design.commit')">
            <UButton icon="i-lucide-send-to-back" :color="canCommit ? 'primary' : 'neutral'" :variant="canCommit ? 'solid' : 'soft'" size="sm" :label="phone ? undefined : commitLabel" :aria-label="commitLabel" :disabled="!canCommit"
                     class="dv__split-main" data-testid="design-commit" @click="run('design.commit')" />
          </UTooltip>
          <UDropdownMenu :items="commitMenu" :content="{ align: 'end' }">
            <UButton icon="i-lucide-chevron-down" :color="canCommit ? 'primary' : 'neutral'" :variant="canCommit ? 'solid' : 'soft'" size="sm" aria-label="Commit mode" class="dv__split-more" data-testid="design-commit-mode" />
          </UDropdownMenu>
        </div>
        <UButton v-if="phone" icon="i-lucide-list-tree" color="neutral" variant="soft" size="sm" label="Features" aria-label="Show the feature tree"
                 @click="designUi.panelOpen = true" />
      </div>

      <ShapePalettePopover view="design" class="dv__palette" />

      <!-- where to sketch (Orca: click a reference plane or a flat face) -->
      <div v-if="sk.choosing" class="dv__choose" role="dialog" aria-label="Sketch plane" data-testid="sketch-choose">
        <UIcon name="i-lucide-pen-tool" class="size-4 flex-none text-[var(--vp-sketch-free)]" />
        <span class="dv__choose-text">Sketch on a plane, or click a flat face</span>
        <div class="dv__choose-btns">
          <UButton v-for="b in planeButtons" :key="b.label" size="xs" color="neutral" variant="soft" :label="b.label" :data-testid="b.testid" @click="b.run()" />
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Cancel" @click="stopChoosing()" />
        </div>
      </div>
      <!-- Orca offers Extrude / Revolve on the sketch just finished -->
      <div v-if="sk.finished && !sk.open && !card.tool" class="dv__choose dv__choose--done" role="status" data-testid="sketch-finished">
        <UIcon name="i-lucide-circle-check" class="size-4 flex-none text-[var(--ui-primary)]" />
        <span class="dv__choose-text">{{ sk.finished.name }} finished</span>
        <div class="dv__choose-btns">
          <UButton size="xs" color="primary" variant="soft" icon="i-lucide-arrow-up-from-line" label="Extrude" data-testid="sketch-offer-extrude" @click="extrudeFinished('extrude')" />
          <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-rotate-3d" label="Revolve" data-testid="sketch-offer-revolve" @click="extrudeFinished('revolve')" />
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Dismiss" @click="sk.finished = null" />
        </div>
      </div>
      <PickBanner :class="{ 'pb--low': ks.phase === 'starting' || !!ks.busy }" />

      <!-- kernel busy / start-up -->
      <Transition name="fade">
        <div v-if="ks.phase === 'starting' || ks.busy" class="dv__busy" role="status" data-testid="design-busy">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary flex-none" />
          <div class="dv__busytext">
            <span>{{ ks.phase === 'starting' ? startText : ks.busy?.label }}<template v-if="ks.queued"> (+{{ ks.queued }} queued)</template>…</span>
            <span v-if="ks.phase === 'starting'" class="dv__bar-track"><span class="dv__bar-fill" :style="{ width: `${startPct}%` }" /></span>
            <template v-else-if="ks.rebuild">
              <span class="dv__elapsed" data-testid="design-rebuild-progress">{{ ks.rebuild.index < ks.rebuild.count ? `Feature ${ks.rebuild.index + 1} of ${ks.rebuild.count}${ks.rebuild.name ? ` — ${ks.rebuild.name}` : ''}` : 'Tessellating the bodies' }}<template v-if="elapsed >= 2"> · {{ elapsed }} s</template></span>
              <span class="dv__bar-track"><span class="dv__bar-fill" :style="{ width: `${Math.round((Math.min(ks.rebuild.index, ks.rebuild.count) / Math.max(1, ks.rebuild.count)) * 100)}%` }" /></span>
            </template>
            <span v-else-if="elapsed >= 2" class="dv__elapsed">{{ elapsed }} s — edits replay the history from the first changed feature</span>
          </div>
          <UButton v-if="ks.busy?.cancellable" size="xs" color="neutral" variant="soft" :label="ks.busy.cancelling ? 'Cancelling…' : 'Cancel'" :disabled="ks.busy.cancelling"
                   :kbds="bindingTokensOf('design.cancel')" data-testid="design-cancel" @click="kernel.cancel()" />
        </div>
      </Transition>

      <!-- document states -->
      <div v-if="design.phase !== 'open' && !(design.phase === 'opening' || design.phase === 'idle')" class="dv__state">
        <div class="dv__card">
          <template v-if="design.phase === 'unreadable'">
            <UIcon name="i-lucide-file-warning" class="dv__art text-warning" />
            <h2>This design can’t be opened</h2>
            <p>{{ design.phaseMessage }}</p>
            <p class="dv__dim">It stays in the project unchanged and is saved back as it is.</p>
          </template>
          <template v-else-if="design.phase === 'closed'">
            <UIcon name="i-lucide-circle-pause" class="dv__art" />
            <h2>Opening was cancelled</h2>
            <p>The design is still in the project. Opening it replays its whole history, which can take a while.</p>
            <UButton color="primary" icon="i-lucide-refresh-cw" label="Open the design" class="mt-3" @click="reopenDesign()" />
          </template>
          <template v-else>
            <UIcon name="i-lucide-circle-x" class="dv__art text-error" />
            <h2>The CAD kernel isn’t available</h2>
            <p>{{ design.phaseMessage || ks.error }}</p>
            <UButton color="primary" icon="i-lucide-refresh-cw" label="Try again" class="mt-3" @click="reopenDesign()" />
          </template>
        </div>
      </div>
      <div v-else-if="empty" class="dv__state">
        <div class="dv__card">
          <UIcon name="i-lucide-pencil-ruler" class="dv__art text-primary" />
          <h2>No design in this project</h2>
          <p>Start from a shape or a STEP file, then fillet, shell, drill and pattern it — or open a project made in OrcaSlicer 2.5’s Design tab.</p>
          <div class="dv__startbtns">
            <UButton color="primary" icon="i-lucide-shapes" label="Add a shape" data-testid="design-start-shape" @click="run('cad.palette')" />
            <UButton color="neutral" variant="outline" icon="i-lucide-file-input" label="Import STEP…" @click="run('design.import-step')" />
            <UButton color="neutral" variant="ghost" icon="i-lucide-folder-open" label="Open project…" @click="run('file.open')" />
          </div>
        </div>
      </div>

      <!-- Orca's status line -->
      <div v-if="design.status && design.phase === 'open'" class="dv__status" :class="`dv__status--${design.status.kind}`" role="status" aria-live="polite" data-testid="design-status">
        <UIcon :name="statusIcon" class="size-4 flex-none" />
        <span>{{ design.status.text }}</span>
      </div>
    </DesignViewport>

    <USlideover v-if="phone" v-model:open="designUi.panelOpen" side="bottom" title="Design (experimental)" :ui="{ content: 'h-[min(70vh,560px)]', body: 'p-0 sm:p-0 flex flex-col min-h-0' }">
      <template #body><DesignPanel phone /></template>
    </USlideover>
  </div>
</template>

<style scoped>
.dv { position: absolute; inset: 0; display: flex; min-width: 0; }
.dv__side { flex: none; width: 320px; min-height: 0; border-right: 1px solid var(--line); }
.dv--compact .dv__side { width: 280px; }
.dv__vp { flex: 1; min-width: 0; }
.dv__bar {
  position: absolute; z-index: var(--z-toolbar); top: 10px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 2px; padding: 4px; max-width: calc(100% - 140px);
  background: color-mix(in srgb, var(--bg-1) 92%, transparent); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); backdrop-filter: blur(6px);
}
.dv__split { display: flex; }
.dv__palette { position: absolute; z-index: calc(var(--z-toolbar) + 1); top: 56px; left: 50%; transform: translateX(-50%); }
.dv--phone .dv__palette { top: auto; bottom: calc(60px + env(safe-area-inset-bottom)); }
.dv__choose {
  position: absolute; z-index: var(--z-toolbar); top: 56px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 24px);
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; padding: 6px 8px 6px 12px; font-size: var(--fs-sm); color: var(--fg-0);
  background: color-mix(in srgb, var(--bg-1) 94%, transparent); border: 1px solid color-mix(in srgb, var(--vp-sketch-free) 55%, transparent); border-radius: 10px; box-shadow: var(--shadow);
}
.dv__choose--done { border-color: color-mix(in srgb, var(--ui-primary) 55%, transparent); }
.dv__choose-text { font-weight: 600; }
.dv__choose-btns { display: flex; flex-wrap: wrap; gap: 4px; }
.dv--phone .dv__choose { top: 8px; }
.dv__startbtns { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin-top: 12px; }
.dv__split-main { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.dv__split-more { border-top-left-radius: 0; border-bottom-left-radius: 0; margin-left: 1px; padding-inline: 4px; }
.dv--phone .dv__bar { top: auto; bottom: calc(8px + env(safe-area-inset-bottom)); max-width: calc(100% - 16px); }
.dv__busy {
  position: absolute; z-index: var(--z-toolbar); top: 62px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 12px; max-width: calc(100% - 24px);
  font-size: var(--fs-sm); color: var(--fg-0); background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: 18px; box-shadow: var(--shadow);
}
.dv--phone .dv__busy { top: 8px; }
.dv__busytext { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dv__elapsed { font-size: var(--fs-xs); color: var(--fg-2); }
.dv__bar-track { display: block; width: 200px; max-width: 100%; height: 3px; background: var(--bg-3); border-radius: 2px; overflow: hidden; }
.dv__bar-fill { display: block; height: 100%; background: var(--ui-primary); transition: width 0.3s; }
.dv__state { position: absolute; inset: 0; z-index: 3; display: grid; place-items: center; padding: 24px; pointer-events: none; }
.dv__card {
  pointer-events: auto; width: min(420px, 100%); padding: 22px 24px 20px; text-align: center; font-size: var(--fs-md); color: var(--fg-1); line-height: 1.45;
  background: color-mix(in srgb, var(--bg-1) 90%, transparent); border: 1px dashed var(--line-strong); border-radius: 12px; backdrop-filter: blur(4px);
}
.dv__card h2 { margin: 0 0 6px; font: 600 var(--fs-lg) var(--font); color: var(--fg-0); }
.dv__card p { margin: 0; overflow-wrap: anywhere; }
.dv__card p + p { margin-top: 6px; }
.dv__dim { color: var(--fg-2); font-size: var(--fs-sm); }
.dv__art { width: 36px; height: 36px; margin: 0 auto 10px; display: block; color: var(--fg-2); }
.dv__status {
  position: absolute; z-index: var(--z-toolbar); left: 10px; bottom: 10px; max-width: min(720px, calc(100% - 20px));
  display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; font-size: var(--fs-sm); line-height: 1.4; color: var(--fg-0);
  background: color-mix(in srgb, var(--bg-1) 90%, transparent); border: 1px solid var(--line); border-radius: var(--radius); backdrop-filter: blur(6px);
}
.dv__status > span { overflow-wrap: anywhere; }
.dv__status--info > :first-child { color: var(--info); }
.dv__status--ok > :first-child { color: var(--ui-primary); }
.dv__status--warn > :first-child { color: var(--warn); }
.dv__status--error { border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
.dv__status--error > :first-child { color: var(--danger); }
.dv--phone .dv__status { left: 8px; right: 8px; bottom: calc(60px + env(safe-area-inset-bottom)); max-width: none; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
