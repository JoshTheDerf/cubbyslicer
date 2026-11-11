<script setup lang="ts">
/**
 * Orca 2.5 printer settings › Multimaterial › IDEX/IQEX Configuration › Modes
 * (GUI/IMEXModesCtrl): Add Mode + help, the role legend, then one row per
 * mode — name (the Primary row is fixed), a tile per tool head that cycles its
 * role on click, the mode's G-code with the placeholder editor, remove, and a
 * per-row reset to the saved preset. Edits the three mode lists together.
 */
import { computed, ref, watch } from 'vue';
import GcodeEditDialog from '../dialogs/gcode/GcodeEditDialog.vue';
import {
  fixRowName, gridTiles, loadRows, modeData, nextTileRole, removedNames, ROLE_HINT, ROLE_STYLE, roleOffered, suggestedModeNames, uniqueModeName,
  type Grid, type ModeRow,
} from './imexModes';
import type { ImexRole } from './imex';

const props = defineProps<{
  names: string[]; tools: string[]; gcodes: string[];
  /** The selected preset's saved lists (per-row reset). */
  saved?: { names: string[]; tools: string[]; gcodes: string[] };
  grid: Grid;
  disabled?: boolean;
}>();
const emit = defineEmits<{ change: [v: { names: string[]; tools: string[]; gcodes: string[] }]; removed: [names: string[]] }>();

const rows = ref<ModeRow[]>(loadRows(props.names, props.tools, props.gcodes));
const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
// matches_config: reload only when the lists changed from outside (not on our own write-back).
watch(() => [props.names, props.tools, props.gcodes], () => {
  const d = modeData(rows.value);
  if (same(d.names, props.names) && same(d.tools, props.tools) && same(d.gcodes, props.gcodes)) return;
  rows.value = loadRows(props.names, props.tools, props.gcodes);
});

const tiles = computed(() => gridTiles(props.grid));
const legend = computed(() => (['P', 'C', 'M', 'S'] as ImexRole[]).filter((r) => roleOffered(r, props.grid)));
function notify(): void { emit('change', modeData(rows.value)); }

function addRow(): void {
  const name = suggestedModeNames(rows.value, props.grid)[0] ?? uniqueModeName(rows.value);
  rows.value.push({ primary: false, name, roles: new Map([[0, 'P']]), gcode: '', origName: name });
  notify();
}
function removeRow(i: number): void {
  const gone = removedNames(rows.value, i);
  rows.value.splice(i, 1);
  notify();
  if (gone.length) emit('removed', gone);
}
function cycle(row: ModeRow, tool: number): void {
  if (row.primary || row.roles.get(tool) === 'P' || props.disabled) return;
  const next = nextTileRole(row, tool, props.grid);
  if (next) row.roles.set(tool, next); else row.roles.delete(tool);
  notify();
}
function setName(i: number, v: string): void { rows.value[i].name = v; notify(); }
function blurName(i: number): void {
  const fixed = fixRowName(rows.value, i);
  if (fixed !== null) { rows.value[i].name = fixed; notify(); }
}
function setGcode(i: number, v: string): void { rows.value[i].gcode = v; notify(); }

// Per-row reset: back to the saved preset's row at the same position.
function savedRow(i: number): ModeRow | null {
  const s = props.saved;
  if (!s || i >= s.names.length) return null;
  return loadRows(s.names, s.tools, s.gcodes)[i] ?? null;
}
const roleKey = (r: ModeRow) => modeData([r]).tools[0];
function dirty(i: number): boolean {
  const s = savedRow(i), r = rows.value[i];
  return !!s && (s.name !== r.name || roleKey(s) !== roleKey(r) || s.gcode !== r.gcode);
}
function resetRow(i: number): void {
  const s = savedRow(i);
  if (!s) return;
  rows.value[i] = { ...s, origName: rows.value[i].origName };
  blurName(i);
  notify();
}

const edit = ref<{ open: boolean; index: number }>({ open: false, index: 0 });
const suggestions = (i: number) => suggestedModeNames(rows.value, props.grid, i);
</script>

<template>
  <div class="imx" data-testid="imex-modes" :class="{ 'imx--off': disabled }">
    <div class="imx__actions">
      <UButton size="xs" icon="i-lucide-plus" label="Add Mode" :disabled="disabled" @click="addRow" />
      <UTooltip text="Each mode names the tool heads that take part and the role each one plays. Click a tool button to cycle its role — hover a color below for what each role does.">
        <UIcon name="i-lucide-circle-help" class="size-4 text-muted" />
      </UTooltip>
    </div>
    <div class="imx__legend">
      <UTooltip v-for="r in legend" :key="r" :text="ROLE_HINT[r]">
        <span class="imx__leg"><i :style="{ background: ROLE_STYLE[r].bg }" />{{ ROLE_STYLE[r].label }}</span>
      </UTooltip>
      <span class="imx__leg"><i :style="{ background: ROLE_STYLE.off.bg }" />{{ ROLE_STYLE.off.label }}</span>
    </div>
    <div class="imx__head">
      <span title="How the mode is labeled in the plate's IDEX/IQEX mode selector. Required — a mode with no name cannot be selected.">Mode</span>
      <span title="Which tool heads take part in the mode and what role each one plays. Click a tile to cycle its role.">Tools</span>
      <span title="G-code run at print start to put the printer into this mode (for example a Klipper SET_PRINT_MODE call). The slicer only emits the Primary tool's paths; the firmware drives the others.">G-code</span>
    </div>
    <div v-for="(r, i) in rows" :key="i" class="imx__row" :data-mode="r.name">
      <div class="imx__name">
        <strong v-if="r.primary">Primary</strong>
        <template v-else>
          <UInput :model-value="r.name" size="xs" placeholder="Mode name (required)" :disabled="disabled" :list="`imx-sug-${i}`"
                  title="Name of this parallel mode, as it appears in the plate's IDEX/IQEX mode selector. Stored in the project by name, so renaming a mode that plates already use makes them fall back to Primary. Cannot be empty — a blank name is replaced with a generated one."
                  aria-label="Mode name" @update:model-value="(v: string | number) => setName(i, String(v))" @blur="blurName(i)" />
          <datalist :id="`imx-sug-${i}`"><option v-for="s in suggestions(i)" :key="s" :value="s" /></datalist>
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-trash-2" aria-label="Remove mode" title="Remove mode" :disabled="disabled" @click="removeRow(i)" />
        </template>
      </div>
      <div class="imx__grid" :style="{ gridTemplateColumns: `repeat(${grid.cols}, 26px)` }">
        <template v-for="(line, li) in tiles" :key="li">
          <button v-for="t in line" :key="t" type="button" class="imx__tile" :data-tool="t" :data-role="r.roles.get(t) ?? ''"
                  :style="{ background: ROLE_STYLE[r.roles.get(t) ?? 'off'].bg }" :disabled="disabled || r.primary || r.roles.get(t) === 'P'"
                  :title="`T${t}: ${ROLE_STYLE[r.roles.get(t) ?? 'off'].label}`" @click="cycle(r, t)">T{{ t }}</button>
        </template>
      </div>
      <textarea class="imx__gcode" :value="r.gcode" rows="2" spellcheck="false" :disabled="disabled" aria-label="Mode G-code"
                title="G-code emitted once at the start of a print that uses this mode, before the machine start G-code. This is where the printer is put into the matching firmware mode — for example a Klipper SET_PRINT_MODE call or a RepRapFirmware M567 — since the slicer only emits the Primary tool's paths and the firmware drives the Copy / Mirror tools. Placeholders are supported; use the edit button to browse them. Leave empty if the mode needs no firmware setup."
                @input="(e) => setGcode(i, (e.target as HTMLTextAreaElement).value)" />
      <div class="imx__btns">
        <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" aria-label="Edit G-code / browse placeholders" title="Edit G-code / browse placeholders"
                 :disabled="disabled" @click="edit = { open: true, index: i }" />
        <UButton v-if="saved && i < saved.names.length" size="xs" color="neutral" variant="ghost" :icon="dirty(i) ? 'i-lucide-undo-2' : 'i-lucide-dot'"
                 aria-label="Discard in-session edits to this mode" title="Discard in-session edits to this mode (snap back to saved value)"
                 :disabled="disabled || !dirty(i)" @click="resetRow(i)" />
      </div>
    </div>
    <GcodeEditDialog v-model:open="edit.open" :title="`${rows[edit.index]?.primary ? 'Primary' : rows[edit.index]?.name ?? ''} — G-code`" opt-key="imex_mode_gcode"
                     :value="rows[edit.index]?.gcode ?? ''" :disabled="disabled" @apply="(v: string) => setGcode(edit.index, v)" />
  </div>
</template>

<style scoped>
.imx { display: flex; flex-direction: column; gap: 6px; padding: 6px 0 8px; font-size: var(--fs-sm); }
.imx--off { opacity: 0.6; }
.imx__actions { display: flex; align-items: center; gap: 8px; }
.imx__legend { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--fg-1); }
.imx__leg { display: inline-flex; align-items: center; gap: 4px; }
.imx__leg i { width: 0.9em; height: 0.9em; border-radius: 2px; display: inline-block; }
.imx__head, .imx__row { display: grid; grid-template-columns: minmax(120px, 176px) auto minmax(140px, 1fr) auto; gap: 6px; align-items: center; }
.imx__head { color: var(--fg-1); }
.imx__head span:nth-child(3) { grid-column: 3; }
.imx__name { display: flex; align-items: center; gap: 2px; min-width: 0; }
.imx__name strong { color: var(--fg-0); }
.imx__grid { display: grid; gap: 2px; }
.imx__tile { width: 26px; height: 26px; border-radius: 3px; color: #fff; font-size: 11px; font-weight: 600; cursor: pointer; }
.imx__tile:disabled { cursor: default; opacity: 0.9; }
.imx__gcode {
  width: 100%; min-height: 40px; resize: vertical; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px;
  padding: 4px 6px; border-radius: 4px; border: 1px solid var(--border, rgb(128 128 128 / 0.4)); background: var(--bg-0); color: var(--fg-0);
}
.imx__btns { display: flex; flex-direction: column; }
@media (max-width: 640px) {
  .imx__head { display: none; }
  .imx__row { grid-template-columns: 1fr auto; }
  .imx__gcode { grid-column: 1 / -1; }
}
</style>
