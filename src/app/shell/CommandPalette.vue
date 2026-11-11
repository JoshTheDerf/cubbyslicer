<script setup lang="ts">
/**
 * The Speed Dial (Orca 2.5.0 SpeedDialDialog + resources/web/dialog/SpeedDial): a chrome-less
 * popup centred on the window (Space, plus our Ctrl/⌘+K and Ctrl/⌘+Shift+P). The model is
 * ../actions/project/palette.ts (a port of speeddial.js); history and pins are ../actions/recent.ts.
 *
 *  - Favourites bar on top (up to 10, Alt/Option+1–9, 0): one click runs a tile, right-click
 *    offers Move left / Move right / Unpin. Every row has a bookmark that pins it (Ctrl/⌘+B).
 *  - One search over every action: commands, plugin commands, every setting, "Go to Plate N",
 *    and the two-phase "Go to layer (percent)" / "Go to tab...". Tab accepts the inline completion.
 *  - Empty query: Recent, then every action under its category (A→Z), frecency first.
 *  - One click (or Enter) runs a row. The footer describes the hovered row (after a short rest),
 *    else the keyboard selection: description, Wiki (F1), and a collapse arrow (remembered).
 *  - Esc leaves a phase, then clears the query, then closes.
 */
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { ContextMenuItem } from '@nuxt/ui';
import { getActionContext } from '../actions/context';
import {
  actionStats, digitFromEvent, MAX_PINNED, movePinned, paletteDetailsExpanded, paletteRecentCount, pinnedActionIds, pinnedIndexForDigit,
  pinnedSlot, prunePinned, recentIds, recordRecent, shouldAsk, suppressAsk, togglePinned,
} from '../actions/recent';
import { getAction, getActionSource, getAllActions } from '../actions/registry';
import { runAction } from '../actions/run';
import {
  actionEyebrow, actionLabels, commandList, completionFor, detailActionId, filterTabs, frecencySort, K_ROWS, markSegments, MODE_LABEL, modeBadge,
  needsModeSwitch, nextSel, parsePercent, phaseClickIgnored, phaseItems, plateItems, projectPalette, ROW_H, selectedActionId, settingItems,
  spacerHeight, visibleFavourites, type Completion, type PaletteItem, type PaletteMode, type PaletteTab, type Range, type Sel, type SettingEntry,
} from '../actions/project/palette';
import { platform } from './useActions';
import { askConfirm, confirmAction } from './uiState';
import { dialogs } from '../../dialogs/state';
import { currentPresets } from '../../presets/store';
import { buildSearchIndex } from '../../settings/search';
import { jumpToSetting, pageIcon, settingsLayout } from '../../settings/useLayout';
import { settingsUi } from '../../settings/uiState';
import { rowStates } from '../../settings/useRules';
import type { SettingsTabId } from '../../settings/layout/types';
import { layerCount, setTopLayer } from '../../preview/store';

// Hover preview state (used by watchers below, declared first).
let hoverTimer: ReturnType<typeof setTimeout> | 0 = 0;
let hoverPending: string | null = null;
let hoverSince = 0, hoverX = 0, hoverY = 0;

const ALT = platform === 'mac' ? '⌥' : 'Alt';
const MOD = platform === 'mac' ? '⌘' : 'Ctrl';
const DEFAULT_ICON = 'i-lucide-square-terminal';
/** speeddial.js HOVER_SETTLE_MS / HOVER_MAX_WAIT_MS / HOVER_JITTER_PX. */
const HOVER_SETTLE_MS = 150;
const HOVER_MAX_WAIT_MS = 1000;
const HOVER_JITTER_PX = 6;
const FLASH_MS = 2500;
/** The view tabs "Go to tab..." offers (Orca: the notebook's pages). */
const TAB_ACTIONS = ['view.design', 'view.prepare', 'view.preview'];

// ---- snapshot (Orca send_actions: rebuilt on every open) -------------------------------------------

interface Snapshot { items: PaletteItem[]; recent: PaletteItem[]; tabs: PaletteTab[]; byId: Map<string, PaletteItem>; labels: Map<string, string> }
const EMPTY: Snapshot = { items: [], recent: [], tabs: [], byId: new Map(), labels: new Map() };
const snap = shallowRef<Snapshot>(EMPTY);

const pluginName = (id: string) => {
  const s = getActionSource(id);
  return s?.id.startsWith('plugin:') ? s.name ?? s.id : undefined;
};

function settingEntries(): SettingEntry[] | null {
  const schema = currentPresets.value.schema.value;
  const layout = settingsLayout.value;
  if (!schema || !layout) return null;
  const stateOf = (k: string, tab: SettingsTabId) => rowStates(tab, tab === 'filament' ? settingsUi.filamentSlot : 0).get(k);
  return buildSearchIndex(schema, layout, stateOf).map((e) => {
    const def = schema.options[e.key];
    return {
      key: e.key, label: e.label, tab: e.tab, pageTitle: e.pageTitle, groupTitle: e.groupTitle,
      fullLabel: [def?.fullLabel, def?.label].find((x) => x && x !== e.label),
      tooltip: def?.tooltip || undefined, mode: def?.mode, icon: pageIcon(e.pageTitle),
      ...(e.state?.hidden ? { hidden: e.state.reason ?? '' } : e.state?.disabled ? { disabled: e.state.reason ?? '' } : {}),
    };
  });
}

function buildSnapshot(): Snapshot {
  const ctx = getActionContext();
  if (!ctx) return EMPTY;
  const registered = getAllActions();
  const cmds = projectPalette(registered, ctx, platform, pluginName);
  const plates = plateItems(ctx.plates.count, (i) => ctx.dispatch.selectPlate(i));
  const phases = phaseItems(goToLayer, goToTab);
  const entries = settingEntries();
  const settings = entries ? settingItems(entries, (e) => jumpToSetting(e.key)) : [];
  const items = frecencySort([...cmds, ...plates, ...phases, ...settings], actionStats.value);
  const byId = new Map(items.map((i) => [i.id, i]));
  // Pins that can no longer resolve (a gone setting or plate) stop taking a slot (Orca snapshot()).
  prunePinned((id) => (id.startsWith('setting:') ? !entries || byId.has(id) : id.startsWith('plate.goto.') ? byId.has(id) : true));
  const recent = recentIds(actionStats.value, paletteRecentCount.value, (id) => byId.has(id)).map((id) => byId.get(id)!);
  const tabs: PaletteTab[] = [];
  for (const id of TAB_ACTIONS) {
    const a = registered.find((x) => x.id === id);
    if (a && !(a.when && a.when(ctx) === false)) tabs.push({ id, title: a.title, icon: a.icon });
  }
  return { items, recent, tabs, byId, labels: actionLabels(items) };
}

async function goToLayer(pct: number): Promise<void> {
  getActionContext()?.dispatch.setActiveView('preview');
  await nextTick();
  const max = layerCount() - 1;
  if (max <= 0) return;
  setTopLayer(Math.round((Math.min(100, Math.max(0, pct)) / 100) * max));
}

async function goToTab(id: string): Promise<void> {
  const a = getAction(id);
  const ctx = getActionContext();
  if (a && ctx) await runAction(a, ctx);
}

// ---- state ---------------------------------------------------------------------------------------

type Phase = 'commands' | 'percent' | 'tab';
const phase = ref<Phase>('commands');
const query = ref('');
const sel = ref<Sel>({ zone: 'list', i: 0 });
const hover = ref<string | null>(null);
const ghost = ref<Completion | null>(null);
const flashText = ref('');
const renderEnd = ref(K_ROWS);
let phaseEnteredAt = 0;

const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const favBarEl = ref<HTMLElement | null>(null);

const userMode = computed<PaletteMode>(() => settingsUi.mode);
const favIds = computed(() => visibleFavourites(pinnedActionIds.value, (id) => snap.value.byId.has(id)));
const result = computed(() => commandList(snap.value.items, snap.value.recent, query.value));
const tabList = computed(() => filterTabs(snap.value.tabs, query.value));
const currentList = computed<Array<{ id: string }>>(() => (phase.value === 'tab' ? tabList.value : phase.value === 'commands' ? result.value.list : []));

watch(() => dialogs.palette, (open) => {
  if (!open) { resetHover(); return; }
  snap.value = buildSnapshot();
  phase.value = 'commands';
  phaseEnteredAt = 0;
  query.value = '';
  sel.value = { zone: 'list', i: 0 };
  ghost.value = null;
  renderEnd.value = K_ROWS;
  resetHover();
  void nextTick(() => { if (listEl.value) listEl.value.scrollTop = 0; });
}, { immediate: true });

// A favourite selection can't outlive its tile (renderFav).
watch(() => favIds.value.length, (n) => {
  if (sel.value.zone !== 'fav') return;
  sel.value = n ? { zone: 'fav', i: Math.min(sel.value.i, n - 1) } : { zone: 'list', i: 0 };
});

// ---- windowed list -------------------------------------------------------------------------------

type RenderRow = { key: string; header: string } | { key: string; item: PaletteItem; i: number };
const rendered = computed<RenderRow[]>(() => {
  const { list, sections } = result.value;
  const out: RenderRow[] = [];
  const end = Math.min(list.length, renderEnd.value);
  for (let i = 0; i < end; i++) {
    const h = sections.get(i);
    if (h !== undefined) out.push({ key: `h:${i}`, header: h });
    out.push({ key: list[i].id, item: list[i], i });
  }
  return out;
});
const spacer = computed(() => {
  const { list, sections } = result.value;
  const end = Math.min(list.length, renderEnd.value);
  let shown = 0;
  for (const i of sections.keys()) if (i < end) shown++;
  return spacerHeight(list.length, end, sections.size, shown);
});

function onScroll(): void {
  if (phase.value !== 'commands' || !listEl.value) return;
  const len = result.value.list.length;
  if (renderEnd.value >= len) return;
  const first = Math.max(0, Math.floor(listEl.value.scrollTop / ROW_H));
  renderEnd.value = Math.max(renderEnd.value, Math.min(len, first + 2 * K_ROWS));
}

function scrollSelectedIntoView(): void {
  void nextTick(() => {
    const el = sel.value.zone === 'fav' ? favBarEl.value?.querySelector('.sd-fav.sel') : listEl.value?.querySelector('.sd-row.sel');
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });
}

function resetListView(): void {
  renderEnd.value = K_ROWS;
  resetHover();
  void nextTick(() => { if (listEl.value) listEl.value.scrollTop = 0; });
}

// ---- hover preview (setHover / cancelHover / clearHover) ------------------------------------------


function setHover(id: string, ev: MouseEvent): void {
  const sameRow = hoverPending === id;
  if (sameRow && Math.hypot(ev.clientX - hoverX, ev.clientY - hoverY) < HOVER_JITTER_PX) return;
  cancelHover();
  if (hover.value === id) return;
  const now = Date.now();
  if (!sameRow) hoverSince = now;
  hoverX = ev.clientX;
  hoverY = ev.clientY;
  hoverPending = id;
  hoverTimer = setTimeout(() => {
    hoverTimer = 0;
    hoverPending = null;
    hover.value = id;
  }, Math.max(0, Math.min(HOVER_SETTLE_MS, hoverSince + HOVER_MAX_WAIT_MS - now)));
}
function cancelHover(): void {
  hoverPending = null;
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
}
function resetHover(): void { cancelHover(); hover.value = null; }
onBeforeUnmount(() => { cancelHover(); if (flashTimer) clearTimeout(flashTimer); });

// ---- footer detail --------------------------------------------------------------------------------

const detailItem = computed(() => {
  if (phase.value !== 'commands') return undefined;
  const id = detailActionId(hover.value, sel.value, currentList.value, favIds.value);
  return id ? snap.value.byId.get(id) : undefined;
});
const detailHasDesc = computed(() => !!detailItem.value?.description);
const showDetail = computed(() => !!detailItem.value && (detailHasDesc.value || !!detailItem.value.helpUrl));

// ---- texts ----------------------------------------------------------------------------------------

const placeholder = computed(() => (phase.value === 'percent' ? 'Go to layer % (0-100)' : phase.value === 'tab' ? 'Go to tab' : 'Search actions'));
const countText = computed(() => {
  const q = query.value.trim();
  if (phase.value === 'tab') return tabList.value.length ? (q ? `Matching tabs: ${tabList.value.length}` : `Tabs: ${tabList.value.length}`) : '';
  if (phase.value === 'commands' && q && result.value.list.length) return `Matching actions: ${result.value.list.length}`;
  return '';
});
const emptyText = computed(() => {
  const q = query.value.trim();
  if (phase.value === 'percent') return q ? `Go to ${q}% of the layer range` : 'Enter a layer percentage (0-100)';
  if (phase.value === 'tab') return tabList.value.length ? '' : q ? 'No tabs match' : 'No tabs';
  if (result.value.list.length) return '';
  return q ? `No actions match (Total: ${snap.value.items.length})` : 'No actions yet';
});
const favEyebrow = computed(() => (phase.value === 'commands' && sel.value.zone === 'fav' ? snap.value.byId.get(favIds.value[sel.value.i])?.label ?? '' : ''));

const iconOf = (it: PaletteItem | undefined) => it?.icon ?? (it?.kind === 'plugin' ? 'i-lucide-puzzle' : DEFAULT_ICON);
const isPinned = (id: string) => pinnedActionIds.value.includes(id);
const pinTitle = (id: string) => `${isPinned(id) ? 'Unpin from favorites' : 'Pin to favorites'} (${MOD}+B)`;
const badgeOf = (it: PaletteItem | undefined) => modeBadge(it, userMode.value);
const favTitle = (it: PaletteItem | undefined) => (it ? it.label + (badgeOf(it) ? ` (${badgeOf(it)})` : '') : '');
const slotTitle = (i: number) => { const s = pinnedSlot(i); return `Favorite ${s === '0' ? '10' : s} (${ALT}+${s})`; };

function rowEyebrow(it: PaletteItem, i: number): { text: string; ranges: Range[] | null | undefined } {
  const q = query.value.trim();
  const isRecent = !q && i < result.value.recentCount;
  const text = actionEyebrow(it, q, isRecent);
  const mi = q ? result.value.matches.get(it.id) : undefined;
  const showPlugin = it.kind === 'plugin' && (!!q || isRecent);
  return { text, ranges: mi ? (showPlugin ? mi.plugin : mi.useEyebrowGroup ? mi.group : mi.source) : null };
}
const titleRanges = (it: PaletteItem) => (query.value.trim() ? result.value.matches.get(it.id)?.title : null);

// ---- flash hint -----------------------------------------------------------------------------------

let flashTimer: ReturnType<typeof setTimeout> | 0 = 0;
function flashHint(text: string): void {
  flashText.value = text;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashText.value = ''; flashTimer = 0; }, FLASH_MS);
}

// ---- input / phases -------------------------------------------------------------------------------

function focusInput(): void { void nextTick(() => inputEl.value?.focus()); }

function updateGhost(): void {
  const el = inputEl.value;
  const eligible = !!el && phase.value === 'commands' && !!el.value && el.selectionStart === el.value.length
    && !/\s$/.test(el.value) && el.scrollWidth <= el.clientWidth;
  ghost.value = eligible ? completionFor(query.value, result.value.list) : null;
}

function onInput(e: Event): void {
  query.value = (e.target as HTMLInputElement).value;
  sel.value = { zone: 'list', i: 0 };
  resetListView();
  void nextTick(updateGhost);
}

/** Clear the query and cursor (resetPhaseInput). */
function resetPhaseInput(): void {
  query.value = '';
  sel.value = { zone: 'list', i: 0 };
  ghost.value = null;
  resetListView();
}

function enterPhase(p: 'percent' | 'tab'): void {
  phase.value = p;
  phaseEnteredAt = p === 'tab' ? Date.now() : 0;
  resetPhaseInput();
  focusInput();
}
function exitPhase(): void {
  phase.value = 'commands';
  phaseEnteredAt = 0;
  resetPhaseInput();
  focusInput();
}

function onClear(): void { resetPhaseInput(); focusInput(); }

// ---- run (SpeedDialWebDialog::run_action) ---------------------------------------------------------

function activate(it: PaletteItem | undefined): void {
  if (!it) return;
  if (it.input === 'percent') { enterPhase('percent'); return; }
  if (it.input === 'tab') { enterPhase('tab'); return; }
  void runEntry(it, '');
}

async function runEntry(it: PaletteItem, param: string): Promise<void> {
  // A setting the current mode hides asks to switch first.
  if (it.kind === 'setting' && it.mode && needsModeSwitch(it, userMode.value)) {
    const need = it.mode;
    dialogs.palette = false;
    const ok = await confirmAction({
      title: 'Switch settings mode', confirmLabel: 'OK',
      message: `“${it.label}” is a ${MODE_LABEL[need]} setting. Switch from ${MODE_LABEL[userMode.value]} mode to ${MODE_LABEL[need]} mode to edit it?`,
    });
    if (!ok) return;
    if (need !== 'develop') settingsUi.mode = need;
  }
  dialogs.palette = false;
  // Only plugin actions ask before running.
  if (it.kind === 'plugin' && shouldAsk(it.id)) {
    const a = await askConfirm({ title: 'Run plugin', message: `Run “${it.label}”?`, confirmLabel: 'OK', checkLabel: 'Don’t ask again for this action' });
    if (a.choice !== 'confirm') return;
    if (a.checked) suppressAsk(it.id);
  }
  await nextTick();
  recordRecent(it.id);
  if (it.action) {
    const ctx = getActionContext();
    if (ctx) await runAction(it.action, ctx);
  } else await it.run?.(param);
}

function runSelected(): void {
  if (phase.value === 'percent') { runJumpToLayer(); return; }
  if (phase.value === 'tab') { const t = tabList.value[sel.value.i]; if (t) jumpToTab(t); return; }
  const id = selectedActionId(sel.value, result.value.list, favIds.value);
  if (id) activate(snap.value.byId.get(id));
}

function runJumpToLayer(): void {
  const n = parsePercent(query.value);
  const it = snap.value.items.find((x) => x.input === 'percent');
  if (n !== null && it) void runEntry(it, String(n));
}

function jumpToTab(t: PaletteTab): void {
  const it = snap.value.items.find((x) => x.input === 'tab');
  if (it) void runEntry(it, t.id);
}

function onRowClick(i: number, it: PaletteItem): void {
  sel.value = { zone: 'list', i };
  activate(it);
}
function onTabClick(i: number, t: PaletteTab): void {
  // The second click of a double-click on "Go to tab..." lands on the new rows: ignore it.
  if (phaseClickIgnored(Date.now(), phaseEnteredAt)) return;
  sel.value = { zone: 'list', i };
  jumpToTab(t);
}
function onFavClick(i: number): void {
  sel.value = { zone: 'fav', i };
  activate(snap.value.byId.get(favIds.value[i]));
}

function openWiki(it: PaletteItem): void {
  if (!it.helpUrl) return;
  dialogs.palette = false;
  window.open(it.helpUrl, '_blank', 'noopener');
}

// ---- favourites -----------------------------------------------------------------------------------

function toggleFav(id: string): void {
  if (!togglePinned(id)) flashHint(`Favorites are full (${MAX_PINNED} max)`);
}

function moveFav(id: string, dir: -1 | 1): void {
  const ni = movePinned(id, dir, favIds.value);
  if (ni >= 0) sel.value = { zone: 'fav', i: ni };
}

function favMenu(id: string, i: number): ContextMenuItem[] {
  return [
    { label: 'Move left', disabled: i <= 0, onSelect: () => moveFav(id, -1) },
    { label: 'Move right', disabled: i >= favIds.value.length - 1, onSelect: () => moveFav(id, 1) },
    { label: 'Unpin', onSelect: () => toggleFav(id) },
  ];
}
const favMenuContent = { onCloseAutoFocus: (e: Event) => { e.preventDefault(); inputEl.value?.focus(); } };

// ---- keys -----------------------------------------------------------------------------------------

/** Esc: leave the phase, else clear the query, else close (the modal closes on its own). */
function onEscape(e: Event): void {
  if (phase.value !== 'commands') { e.preventDefault(); exitPhase(); return; }
  if (query.value) { e.preventDefault(); resetPhaseInput(); focusInput(); }
}

const modalContent = {
  onEscapeKeyDown: onEscape,
  // The search field takes the focus, not the first favourite tile.
  onOpenAutoFocus: (e: Event) => { e.preventDefault(); inputEl.value?.focus(); },
};

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' || e.isComposing) return;
  if (e.key === 'F1') {
    e.preventDefault();
    if (phase.value !== 'commands') return;
    const it = detailItem.value;
    if (it?.helpUrl) openWiki(it); else flashHint('No wiki page for this action');
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Tab' && phase.value === 'commands' && ghost.value && !e.altKey && !mod && !e.shiftKey) {
    e.preventDefault();
    query.value += ghost.value.suffix;
    resetListView();
    focusInput();
    void nextTick(updateGhost);
    return;
  }
  if (phase.value === 'commands' && mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    const id = selectedActionId(sel.value, currentList.value, favIds.value);
    if (id) toggleFav(id);
    return;
  }
  if (phase.value === 'commands' && e.altKey && !mod) {
    const i = pinnedIndexForDigit(digitFromEvent(e));
    if (i >= 0 && i < favIds.value.length) {
      e.preventDefault();
      sel.value = { zone: 'fav', i };
      activate(snap.value.byId.get(favIds.value[i]));
      return;
    }
  }
  const lr = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (lr && sel.value.zone === 'fav')) {
    if (phase.value === 'percent') return;
    e.preventDefault();
    const favLen = phase.value === 'commands' ? favIds.value.length : 0;
    sel.value = nextSel(sel.value, e.key, currentList.value.length, favLen);
    resetHover();
    if (sel.value.zone === 'list' && sel.value.i >= renderEnd.value) renderEnd.value = Math.min(currentList.value.length, sel.value.i + K_ROWS);
    scrollSelectedIntoView();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runSelected();
  }
}
</script>

<template>
  <UModal v-model:open="dialogs.palette" title="Speed Dial" description="Search and run any action" :overlay="false" :close="false"
          :content="modalContent"
          :ui="{ content: 'sd-content w-[calc(100vw-2rem)] max-w-[540px] top-[max(1rem,calc(50dvh-141px))] translate-y-0 max-h-[min(85dvh,calc(50dvh+125px))] sm:max-h-[min(85dvh,calc(50dvh+125px))] rounded-[7px] divide-y-0 overflow-hidden' }">
    <template #content>
      <div class="sd" data-testid="speed-dial" @keydown="onKey" @mouseleave="resetHover">
        <div v-if="flashText" class="sd-flash" role="status">{{ flashText }}</div>
        <div v-if="favEyebrow" class="sd-eyebrow sd-fav-eyebrow">{{ favEyebrow }}</div>
        <div v-if="phase === 'commands' && favIds.length" ref="favBarEl" class="sd-favbar" role="toolbar" aria-label="Favorites">
          <UContextMenu v-for="(id, i) in favIds" :key="id" :items="favMenu(id, i)" :content="favMenuContent">
            <button type="button" class="sd-fav" :class="{ sel: sel.zone === 'fav' && sel.i === i }" data-own-menu tabindex="-1"
                    :title="favTitle(snap.byId.get(id))" :aria-label="snap.labels.get(id)"
                    @click="onFavClick(i)" @contextmenu="sel = { zone: 'fav', i }" @mousemove="setHover(id, $event)">
              <UIcon :name="iconOf(snap.byId.get(id))" class="sd-ic" />
              <span v-if="pinnedSlot(i)" class="sd-slot" :title="slotTitle(i)">{{ pinnedSlot(i) }}</span>
            </button>
          </UContextMenu>
        </div>
        <div class="sd-head">
          <div class="sd-search">
            <UIcon name="i-lucide-search" class="sd-search-icon" />
            <span class="sd-field">
              <span v-if="ghost" class="sd-ghost" aria-hidden="true"><span class="sd-ghost-typed">{{ query }}</span><span class="sd-ghost-suffix">{{ ghost.suffix }}</span></span>
              <input ref="inputEl" class="sd-input" type="text" :value="query" :placeholder="placeholder" :aria-label="placeholder"
                     spellcheck="false" autocomplete="off" data-testid="speed-dial-search"
                     @input="onInput" @keyup="updateGhost" @click="updateGhost">
            </span>
            <button v-if="query" type="button" class="sd-clear" title="Clear" aria-label="Clear search" @click="onClear">
              <UIcon name="i-lucide-x" class="size-2.5" />
            </button>
          </div>
          <div v-if="countText" class="sd-count">{{ countText }}</div>
        </div>
        <div ref="listEl" class="sd-list" :class="{ empty: !!emptyText }" role="listbox" aria-label="Actions" @scroll="onScroll" @mouseleave="cancelHover">
          <div v-if="emptyText" class="sd-empty">{{ emptyText }}</div>
          <template v-else-if="phase === 'tab'">
            <div v-for="(t, i) in tabList" :key="t.id" class="sd-row" :class="{ sel: sel.zone === 'list' && sel.i === i }" role="option"
                 :aria-selected="sel.zone === 'list' && sel.i === i" :aria-label="t.title" @click="onTabClick(i, t)">
              <span class="sd-tile"><UIcon :name="t.icon ?? DEFAULT_ICON" class="sd-ic" /></span>
              <span class="sd-left"><span class="sd-line"><span class="sd-name">{{ t.title }}</span></span></span>
            </div>
          </template>
          <template v-else-if="phase === 'commands'">
            <template v-for="r in rendered" :key="r.key">
              <div v-if="'header' in r" class="sd-section">{{ r.header }}</div>
              <div v-else class="sd-row" :class="{ sel: sel.zone === 'list' && sel.i === r.i }" role="option" :data-idx="r.i"
                   :aria-selected="sel.zone === 'list' && sel.i === r.i" :aria-label="snap.labels.get(r.item.id)"
                   @click="onRowClick(r.i, r.item)" @mousemove="setHover(r.item.id, $event)">
                <span class="sd-tile"><UIcon :name="iconOf(r.item)" class="sd-ic" /></span>
                <span class="sd-left">
                  <span class="sd-eyebrow"><template v-for="(s, k) in markSegments(rowEyebrow(r.item, r.i).text, rowEyebrow(r.item, r.i).ranges)" :key="k"><mark v-if="s.m">{{ s.t }}</mark><template v-else>{{ s.t }}</template></template></span>
                  <span class="sd-line">
                    <span class="sd-name" :title="r.item.label"><template v-for="(s, k) in markSegments(r.item.label, titleRanges(r.item))" :key="k"><mark v-if="s.m">{{ s.t }}</mark><template v-else>{{ s.t }}</template></template></span>
                    <span v-if="badgeOf(r.item)" class="sd-mode">{{ badgeOf(r.item) }}</span>
                    <span v-if="r.item.current" class="sd-current">current</span>
                  </span>
                </span>
                <span v-if="r.item.kbds" class="sd-kbds"><UKbd v-for="(k, n) in r.item.kbds" :key="n" :value="k" size="sm" /></span>
                <button type="button" class="sd-pin" :class="{ on: isPinned(r.item.id) }" tabindex="-1" :title="pinTitle(r.item.id)" :aria-label="pinTitle(r.item.id)"
                        :aria-pressed="isPinned(r.item.id)" @click.stop="toggleFav(r.item.id)">
                  <svg width="15" height="15" viewBox="0 0 24 24" :fill="isPinned(r.item.id) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
                    <path d="M6 3.5A1.5 1.5 0 0 1 7.5 2h9A1.5 1.5 0 0 1 18 3.5V21l-6-4.2L6 21z" />
                  </svg>
                </button>
              </div>
            </template>
            <div class="sd-spacer" :style="{ height: `${spacer}px` }" />
          </template>
        </div>
        <div v-if="showDetail && detailItem" class="sd-detail" data-testid="palette-footer">
          <div v-if="detailHasDesc && paletteDetailsExpanded" class="sd-desc">{{ detailItem.description }}</div>
          <button v-if="detailItem.helpUrl && (!detailHasDesc || paletteDetailsExpanded)" type="button" class="sd-wiki" @click.stop="openWiki(detailItem)">Wiki (F1)</button>
          <button v-if="detailHasDesc" type="button" class="sd-toggle" :aria-expanded="paletteDetailsExpanded"
                  :title="paletteDetailsExpanded ? 'Hide details' : 'Show details'" :aria-label="paletteDetailsExpanded ? 'Hide details' : 'Show details'"
                  @click.stop="paletteDetailsExpanded = !paletteDetailsExpanded">
            <UIcon name="i-lucide-chevron-down" class="size-3" />
          </button>
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
/* Orca resources/web/dialog/SpeedDial/style.css, on the app's tokens. */
.sd { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; font-size: 13px; color: var(--ui-text); background: var(--ui-bg); user-select: none; }
.sd-flash { flex: none; padding: 4px 10px; font-size: 11px; color: var(--ui-warning); background: color-mix(in oklab, var(--ui-warning) 18%, transparent); }
.sd-eyebrow { font-size: 10px; line-height: 1.3; color: var(--ui-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.sd-fav-eyebrow { flex: none; padding: 8px 10px 0; }
.sd-favbar { flex: none; display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-bottom: 1px solid var(--ui-border); overflow-x: auto; scrollbar-width: thin; scroll-padding-inline: 10px; }
.sd-fav { position: relative; flex: none; width: 30px; height: 30px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; cursor: pointer;
  background: var(--ui-bg-elevated); border: 1px solid var(--ui-border); }
.sd-fav.sel { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.sd-slot { position: absolute; top: 1px; left: 1px; min-width: 11px; height: 11px; padding: 0 2px; border-radius: 3px; font-size: 8px; font-weight: 600; line-height: 11px; text-align: center;
  color: var(--ui-text-muted); background: rgb(127 127 127 / .22); }
.sd-ic { width: 16px; height: 16px; color: var(--ui-text-muted); }
.sd-head { flex: none; padding: 8px; }
.sd-search { display: flex; align-items: center; gap: 4px; height: 30px; padding: 0 8px; border: 1px solid var(--ui-border); border-radius: 7px; background: var(--ui-bg); }
.sd-search:focus-within { border-color: var(--ui-primary); box-shadow: 0 0 0 2px color-mix(in oklab, var(--ui-primary) 25%, transparent); }
.sd-search-icon { width: 14px; height: 14px; color: var(--ui-text-muted); }
.sd-field { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
.sd-input { flex: 1; min-width: 0; padding: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; }
.sd-ghost { position: absolute; inset: 0; display: flex; align-items: center; overflow: hidden; white-space: pre; pointer-events: none; }
.sd-ghost-typed { visibility: hidden; }
.sd-ghost-suffix { color: var(--ui-text-muted); opacity: .7; }
.sd-clear { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; padding: 0; border-radius: 50%; color: var(--ui-text-muted);
  background: rgb(127 127 127 / .2); cursor: pointer; }
.sd-count { padding: 4px 4px 0; font-size: 11px; color: var(--ui-text-muted); }
.sd-list { flex: 0 1 auto; min-height: 0; max-height: calc(5.3 * 44px + 4px); overflow-y: auto; padding: 4px 4px 6px; scrollbar-width: thin; }
.sd-list.empty { overflow-y: hidden; }
.sd-section { height: 30px; display: flex; align-items: center; padding: 0 8px; font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ui-text-muted); }
.sd-row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
.sd-row:hover { background: rgb(127 127 127 / .16); }
.sd-row.sel { background: color-mix(in oklab, var(--ui-primary) 18%, transparent); }
.sd-tile { flex: none; width: 26px; height: 26px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; background: var(--ui-bg-elevated); border: 1px solid var(--ui-border); }
.sd-left { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.sd-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
.sd-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-row mark { background: color-mix(in oklab, var(--ui-warning) 22%, transparent); color: var(--ui-warning); border-radius: 2px; }
.sd-mode, .sd-current { flex: none; padding: 1px 6px; font-size: 10px; line-height: 1.4; border-radius: 8px; white-space: nowrap; }
.sd-mode { color: var(--ui-warning); background: color-mix(in oklab, var(--ui-warning) 18%, transparent); }
.sd-current { color: var(--ui-text-muted); background: rgb(127 127 127 / .16); }
.sd-kbds { flex: none; display: inline-flex; gap: 2px; }
.sd-pin { flex: none; width: 24px; height: 24px; padding: 0; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; color: var(--ui-text-muted); cursor: pointer; opacity: 0; }
.sd-row:hover .sd-pin:not(.on), .sd-row.sel .sd-pin:not(.on) { opacity: .5; }
.sd-pin.on { opacity: 1; color: var(--ui-primary); }
.sd-pin:hover { background: rgb(127 127 127 / .18); }
@media (pointer: coarse) { .sd-pin:not(.on) { opacity: .5; } }
.sd-empty { min-height: 64px; padding: 18px 10px; display: flex; align-items: center; justify-content: center; text-align: center; color: var(--ui-text-muted); }
.sd-detail { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--ui-border); overflow: hidden; }
.sd-desc { flex: 1 1 auto; min-width: 0; font-size: 11px; line-height: 1.4; color: var(--ui-text-muted); white-space: pre-line; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; line-clamp: 6; overflow: hidden; }
.sd-wiki { flex: none; padding: 0; font-size: 11px; color: var(--ui-primary); cursor: pointer; white-space: nowrap; }
.sd-wiki:hover { text-decoration: underline; }
.sd-toggle { flex: none; margin-left: auto; display: inline-flex; padding: 2px; color: var(--ui-text-muted); cursor: pointer; }
.sd-toggle:hover { color: var(--ui-text); }
.sd-toggle :deep(svg), .sd-toggle > * { transition: transform .12s ease; }
.sd-toggle[aria-expanded="true"] > * { transform: rotate(180deg); }
</style>
