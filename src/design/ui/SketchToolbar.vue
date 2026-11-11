<script setup lang="ts">
/**
 * The sketcher's toolbar (Orca's SKETCH and CONSTRAIN ribbon groups while a sketch is open):
 * Finish / Cancel, Select, the drawing families (each a flyout with Orca's variants), Dimension,
 * Constrain (the 20 buttons + the kernel's other types), Modify / Transform, Construction, the
 * normal view and the degrees-of-freedom readout. Every button runs its registry action, so the
 * keys, the palette and the toolbar do the same thing.
 */
import { computed } from 'vue';
import { bindingTokensOf, run } from '../../app/shell/useActions';
import { phone } from '../../app/shell/uiState';
import { DRAW_TOOLS, type DrawTool } from '../sketch/shapes';
import { CONSTRAINTS } from '../sketch/constraints';
import { EDIT_TOOLS, sketchUi } from '../sketch/actions';
import { dofText, sk } from '../sketch/session';
import { designUi } from '../state';

const families: Array<{ id: DrawTool['family']; label: string }> = [
  { id: 'line', label: 'Line' }, { id: 'rect', label: 'Rectangle' }, { id: 'circle', label: 'Circle' }, { id: 'arc', label: 'Arc' },
  { id: 'slot', label: 'Slot' }, { id: 'polygon', label: 'Polygon' }, { id: 'ellipse', label: 'Ellipse' }, { id: 'spline', label: 'Spline' }, { id: 'point', label: 'Point' },
];
const groups = computed(() => families.map((f) => {
  const tools = DRAW_TOOLS.filter((t) => t.family === f.id);
  const active = tools.find((t) => t.id === sk.tool);
  const shown = active ?? tools[0];
  return { ...f, tools, shown, active: !!active };
}));
const toolItems = (tools: DrawTool[]) => [tools.map((t) => ({
  label: t.title, icon: t.icon, kbds: bindingTokensOf(`design.sketch.tool.${t.id}`), description: t.hint,
  type: 'checkbox' as const, checked: sk.tool === t.id, onSelect: () => run(`design.sketch.tool.${t.id}`),
}))];
const polygonItems = computed(() => [
  [{ type: 'label' as const, label: 'Sides' }, ...[3, 4, 5, 6, 8, 12].map((n) => ({
    label: `${n} — ${({ 3: 'triangle', 4: 'square', 5: 'pentagon', 6: 'hexagon', 8: 'octagon', 12: 'dodecagon' } as Record<number, string>)[n]}`,
    type: 'checkbox' as const, checked: sk.polygonSides === n, onSelect: () => { sk.polygonSides = n; run('design.sketch.tool.polygon'); },
  }))],
  [{ label: 'Inscribed (click a corner)', type: 'checkbox' as const, checked: !sk.polygonCircumscribed, onSelect: () => { sk.polygonCircumscribed = false; run('design.sketch.tool.polygon'); } },
    { label: 'Circumscribed (click a side’s middle)', type: 'checkbox' as const, checked: sk.polygonCircumscribed, onSelect: () => { sk.polygonCircumscribed = true; run('design.sketch.tool.polygon'); } }],
]);
const constrainItems = computed(() => [
  CONSTRAINTS.filter((c) => c.button).map((c) => ({ label: c.label, icon: c.icon, description: c.hint, onSelect: () => run(`design.sketch.constrain.${c.type}`) })),
  [{ type: 'label' as const, label: 'More' }, ...CONSTRAINTS.filter((c) => !c.button).map((c) => ({ label: c.label, icon: c.icon, description: c.hint, onSelect: () => run(`design.sketch.constrain.${c.type}`) }))],
]);
const modifyItems = computed(() => [
  EDIT_TOOLS.filter((t) => t.group === 'modify').map((t) => ({ label: t.title, icon: t.icon, description: t.hint, kbds: bindingTokensOf(`design.sketch.tool.${t.id}`), type: 'checkbox' as const, checked: sk.tool === t.id, onSelect: () => run(`design.sketch.tool.${t.id}`) })),
  EDIT_TOOLS.filter((t) => t.group === 'transform').map((t) => ({ label: t.title, icon: t.icon, description: t.hint, type: 'checkbox' as const, checked: sk.tool === t.id, onSelect: () => run(`design.sketch.tool.${t.id}`) })),
  [{ label: 'Text…', icon: 'i-lucide-type', description: 'Text outlines as a profile (a sketch of its own)', onSelect: () => run('design.sketch.text') },
    { label: 'Import SVG…', icon: 'i-lucide-file-image', description: 'An SVG’s fills as a profile (a sketch of its own)', onSelect: () => run('design.sketch.svg') }],
]);
const modifyActive = computed(() => EDIT_TOOLS.find((t) => t.id === sk.tool && t.group !== 'dimension'));
const dofClass = computed(() => (!sk.solveOk ? 'bad' : sk.dof === 0 ? 'fixed' : 'free'));
</script>

<template>
  <div class="skb" :class="{ 'skb--phone': phone }" role="toolbar" aria-label="Sketch" data-testid="sketch-toolbar">
    <UTooltip text="Finish the sketch (one undo step)" :kbds="['enter']">
      <UButton icon="i-lucide-check" color="primary" size="sm" :label="phone ? undefined : 'Finish'" aria-label="Finish sketch" :loading="sk.committing" data-testid="sketch-finish" @click="run('design.sketch.finish')" />
    </UTooltip>
    <UTooltip text="Discard this sketch">
      <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" aria-label="Cancel sketch" data-testid="sketch-cancel" @click="run('design.sketch.cancel')" />
    </UTooltip>
    <USeparator orientation="vertical" class="h-5 mx-0.5" />
    <UTooltip text="Select / drag" :kbds="bindingTokensOf('design.sketch.tool.select')">
      <UButton icon="i-lucide-mouse-pointer-2" color="neutral" :variant="sk.tool === 'select' ? 'soft' : 'ghost'" size="sm" aria-label="Select" :aria-pressed="sk.tool === 'select'" data-testid="sketch-tool-select" @click="run('design.sketch.tool.select')" />
    </UTooltip>
    <template v-for="g in groups" :key="g.id">
      <UTooltip v-if="g.tools.length === 1 && g.id !== 'polygon'" :text="`${g.shown.title} — ${g.shown.hint}`" :kbds="bindingTokensOf(`design.sketch.tool.${g.shown.id}`)">
        <UButton :icon="g.shown.icon" color="neutral" :variant="g.active ? 'soft' : 'ghost'" size="sm" :aria-label="g.shown.title" :aria-pressed="g.active" :data-testid="`sketch-tool-${g.shown.id}`" @click="run(`design.sketch.tool.${g.shown.id}`)" />
      </UTooltip>
      <div v-else class="skb__split">
        <UTooltip :text="`${g.shown.title} — ${g.shown.hint}`" :kbds="bindingTokensOf(`design.sketch.tool.${g.shown.id}`)">
          <UButton :icon="g.shown.icon" color="neutral" :variant="g.active ? 'soft' : 'ghost'" size="sm" :aria-label="g.shown.title" :aria-pressed="g.active" :data-testid="`sketch-tool-${g.shown.id}`" @click="run(`design.sketch.tool.${g.shown.id}`)" />
        </UTooltip>
        <UDropdownMenu :items="g.id === 'polygon' ? polygonItems : toolItems(g.tools)" :content="{ align: 'start' }" :ui="{ content: 'min-w-56' }">
          <UButton icon="i-lucide-chevron-down" color="neutral" variant="ghost" size="xs" class="skb__more" :aria-label="`${g.label} tools`" :data-testid="`sketch-family-${g.id}`" />
        </UDropdownMenu>
      </div>
    </template>
    <USeparator orientation="vertical" class="h-5 mx-0.5" />
    <UTooltip text="Construction geometry — selection, or new entities" :kbds="bindingTokensOf('design.sketch.construction')">
      <UButton icon="i-lucide-square-dashed" color="neutral" :variant="sk.construction ? 'soft' : 'ghost'" size="sm" aria-label="Construction" :aria-pressed="sk.construction" data-testid="sketch-construction" @click="run('design.sketch.construction')" />
    </UTooltip>
    <UTooltip text="Dimension — a line, a circle / arc, or two points" :kbds="bindingTokensOf('design.sketch.tool.dimension')">
      <UButton icon="i-lucide-ruler-dimension-line" color="neutral" :variant="sk.tool === 'dimension' ? 'soft' : 'ghost'" size="sm"  aria-label="Dimension" :aria-pressed="sk.tool === 'dimension'" data-testid="sketch-tool-dimension" @click="run('design.sketch.tool.dimension')" />
    </UTooltip>
    <UDropdownMenu v-model:open="sketchUi.constrainOpen" :items="constrainItems" :content="{ align: 'center' }" :ui="{ content: 'min-w-60 max-h-[70vh]' }">
      <UButton icon="i-lucide-link" color="neutral" variant="ghost" size="sm" :label="phone ? undefined : 'Constrain'" aria-label="Constrain" trailing-icon="i-lucide-chevron-down" data-testid="sketch-constrain" />
    </UDropdownMenu>
    <UDropdownMenu v-model:open="sketchUi.modifyOpen" :items="modifyItems" :content="{ align: 'center' }" :ui="{ content: 'min-w-60 max-h-[70vh]' }">
      <UButton :icon="modifyActive?.icon ?? 'i-lucide-scissors'" color="neutral" :variant="modifyActive ? 'soft' : 'ghost'" size="sm" :label="phone ? undefined : (modifyActive?.title ?? 'Modify')" aria-label="Modify" trailing-icon="i-lucide-chevron-down" data-testid="sketch-modify" />
    </UDropdownMenu>
    <USeparator orientation="vertical" class="h-5 mx-0.5" />
    <UTooltip text="Look at the sketch plane" :kbds="bindingTokensOf('design.sketch.normal')">
      <UButton icon="i-lucide-scan-eye" color="neutral" variant="ghost" size="sm" aria-label="Look at the sketch plane" @click="run('design.sketch.normal')" />
    </UTooltip>
    <span class="skb__dof" :class="`skb__dof--${dofClass}`" role="status" aria-live="polite" data-testid="sketch-dof">{{ dofText() }}</span>
    <UButton v-if="phone" icon="i-lucide-list" color="neutral" variant="soft" size="sm" aria-label="Sketch panel: constraints, conflicts" data-testid="sketch-panel-open" @click="designUi.panelOpen = true" />
  </div>
</template>

<style scoped>
.skb {
  position: absolute; z-index: var(--z-toolbar); top: 10px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 2px; padding: 4px; max-width: calc(100% - 140px); overflow-x: auto; scrollbar-width: none;
  background: color-mix(in srgb, var(--bg-1) 94%, transparent); border: 1px solid color-mix(in srgb, var(--vp-sketch-free) 45%, var(--line)); border-radius: 10px; box-shadow: var(--shadow); backdrop-filter: blur(6px);
}
.skb--phone { top: auto; bottom: calc(8px + env(safe-area-inset-bottom)); max-width: calc(100% - 16px); left: 8px; right: 8px; transform: none; }
.skb__split { display: flex; align-items: center; }
.skb__more { padding-inline: 1px; margin-left: -3px; }
.skb__dof { flex: none; margin-left: 4px; padding: 3px 8px; font: 600 var(--fs-xs) var(--font); border-radius: 12px; white-space: nowrap; }
.skb__dof--free { color: var(--vp-sketch-free); background: color-mix(in srgb, var(--vp-sketch-free) 14%, transparent); }
.skb__dof--fixed { color: var(--vp-sketch-fixed); background: color-mix(in srgb, var(--vp-sketch-fixed) 12%, transparent); }
.skb__dof--bad { color: var(--vp-sketch-bad); background: color-mix(in srgb, var(--vp-sketch-bad) 16%, transparent); }
</style>
