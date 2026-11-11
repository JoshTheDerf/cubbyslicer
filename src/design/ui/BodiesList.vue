<script setup lang="ts">
/**
 * Orca's Bodies card: "Body N — name", face count, whether it is on the plate (live-linked
 * objects), colour (swatch: Orca's Color, saved in the design), zoom, eye (Design-view display
 * only; hidden bodies are not committed), delete (removes the feature the body was made from;
 * Ctrl+Z restores it) and rename (double-click / F2: the body's own name, saved in the design).
 * Right click opens the offer menu for the body. A body without faces is a legal result (the
 * kernel keeps it): shown dimmed, never committed.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { designLinks } from '../../project/store';
import { deleteBody, renameBody, toggleBodyHidden } from '../commands';
import { pickBodyColor } from '../bodyColor';
import OfferMenu from './OfferMenu.vue';
import { resolveLink } from '../link';
import { design, editBlocker, setStatus } from '../session';
import { designUi } from '../state';
import { designViewport } from '../viewport';
import { toast } from '../../ui';

const onPlate = computed(() => {
  const m = new Map<number, number>();
  for (const l of designLinks()) { const b = resolveLink(l.link, design.bodies); if (b >= 0) m.set(b, (m.get(b) ?? 0) + 1); }
  return m;
});
const hidden = computed(() => new Set(designUi.hiddenBodies));
const picked = computed(() => designUi.pick?.body ?? null);

function pick(b: number) {
  designUi.selected = [];
  designUi.pick = { kind: 'body', body: b };
  const body = design.bodies[b];
  setStatus('info', `Body ${b + 1} — ${body.name}${body.face_count ? `: ${body.face_count} faces` : ': no faces'}${design.features[body.source_feature] ? `, made by ${design.features[body.source_feature].name}` : ''}.`);
}
function zoom(b: number) { pick(b); designViewport()?.fitSelection(); }
const root = ref<HTMLElement | null>(null);
const offer = ref<{ x: number; y: number; body: number; key: number } | null>(null);
function onContext(b: number, ev: MouseEvent) {
  pick(b);
  const r = root.value?.getBoundingClientRect();
  if (r) offer.value = { x: ev.clientX - r.left, y: ev.clientY - r.top, body: b, key: Date.now() };
}
const report = (p: Promise<unknown>) => { p.catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e))); };
watch(() => designUi.renamingBody, (b) => { if (b !== null && design.bodies[b]) { void startRename(b); } designUi.renamingBody = null; });

const renaming = ref<number | null>(null);
const draft = ref('');
const inputEl = ref<{ inputRef?: HTMLInputElement }[] | null>(null);
async function startRename(b: number) {
  if (editBlocker()) return;
  renaming.value = b;
  draft.value = design.bodies[b].user_name ? design.bodies[b].name : '';
  await nextTick();
  inputEl.value?.[0]?.inputRef?.focus();
}
function commit() {
  const b = renaming.value;
  renaming.value = null;
  if (b === null) return;
  const cur = design.bodies[b];
  if ((cur.user_name ? cur.name : '') === draft.value.trim()) return;
  renameBody(b, draft.value).catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
}
</script>

<template>
  <section v-if="design.bodies.length" ref="root" class="bl" aria-label="Bodies">
    <header class="ds-head">
      <span class="ds-head__title">Bodies</span>
      <span class="ds-head__count">{{ design.bodies.length }}</span>
    </header>
    <ul class="bl__list">
      <li v-for="b in design.bodies" :key="b.index" class="bl__row"
          :class="{ 'bl__row--sel': picked === b.index, 'bl__row--off': hidden.has(b.index), 'bl__row--empty': !b.face_count }"
          :data-body="b.index" @click="pick(b.index)" @dblclick="startRename(b.index)" @contextmenu.prevent="onContext(b.index, $event)">
        <button type="button" class="bl__swatch" :style="b.has_color && b.color ? { background: `rgb(${b.color.slice(0, 3).map((c) => Math.round(c * 255)).join(',')})` } : undefined"
                :aria-label="`Color of body ${b.index + 1}`" :title="editBlocker() ? '' : 'Color…'" :disabled="!!editBlocker()" @click.stop="pickBodyColor(b.index)" />
        <UInput v-if="renaming === b.index" ref="inputEl" v-model="draft" size="xs" class="bl__rename" :placeholder="`Body ${b.index + 1}`" aria-label="Body name"
                @keydown.enter.prevent="commit" @keydown.esc.prevent.stop="renaming = null" @blur="commit" @click.stop />
        <span v-else class="bl__name" :title="b.face_count ? `${b.face_count} faces, ${b.edge_count} edges${b.is_solid ? '' : ' (not a closed solid)'}` : 'This body has no faces (a legal kernel result). It is not committed to the plate.'">
          <span class="bl__num">Body {{ b.index + 1 }}</span> — {{ b.name }}
        </span>
        <span v-if="!b.face_count" class="bl__tag">empty</span>
        <UTooltip v-else-if="onPlate.get(b.index)" :text="`On the plate (${onPlate.get(b.index)} linked object${onPlate.get(b.index)! > 1 ? 's' : ''}) — follows your edits`">
          <UIcon name="i-lucide-link" class="bl__linked" />
        </UTooltip>
        <UButton v-if="b.face_count" icon="i-lucide-scan" size="xs" variant="ghost" color="neutral" class="bl__btn" :aria-label="`Zoom to body ${b.index + 1}`" @click.stop="zoom(b.index)" />
        <UButton :icon="hidden.has(b.index) ? 'i-lucide-eye-off' : 'i-lucide-eye'" size="xs" variant="ghost" color="neutral" class="bl__btn"
                 :aria-label="hidden.has(b.index) ? `Show body ${b.index + 1}` : `Hide body ${b.index + 1}`" :aria-pressed="hidden.has(b.index)"
                 @click.stop="toggleBodyHidden(b.index)" />
        <UButton icon="i-lucide-trash-2" size="xs" variant="ghost" color="neutral" class="bl__btn" :aria-label="`Delete body ${b.index + 1}`" :disabled="!!editBlocker()"
                 :title="`Delete the feature this body was made from (${design.features[b.source_feature]?.name ?? ''}) — Ctrl+Z restores it`" @click.stop="report(deleteBody(b.index))" />
      </li>
    </ul>
    <OfferMenu v-if="offer" :key="offer.key" :x="offer.x" :y="offer.y" :pick="{ kind: 'body', body: offer.body }" @close="offer = null" />
  </section>
</template>

<style scoped>
.bl { position: relative; display: flex; flex-direction: column; min-height: 0; }
.bl__list { list-style: none; margin: 0; padding: 2px 0; overflow: auto; }
.bl__row { display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 2px 0 8px; border-radius: var(--radius-sm); font-size: var(--fs-md); color: var(--fg-0); cursor: default; }
.bl__row:hover { background: var(--bg-2); }
.bl__row--sel { background: color-mix(in srgb, var(--ui-primary) 18%, transparent); }
.bl__row--off .bl__name, .bl__row--empty .bl__name { opacity: 0.5; }
.bl__swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; background: #a9b4c2; border: 1px solid var(--line-strong); padding: 0; cursor: pointer; }
.bl__swatch:hover:not(:disabled) { outline: 2px solid color-mix(in srgb, var(--ui-primary) 60%, transparent); }
@media (pointer: coarse) { .bl__swatch { width: 18px; height: 18px; } }
.bl__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bl__num { color: var(--fg-1); }
.bl__rename { flex: 1; min-width: 0; }
.bl__tag { font-size: var(--fs-xs); color: var(--fg-2); border: 1px solid var(--line); border-radius: 8px; padding: 0 6px; }
.bl__linked { width: 13px; height: 13px; color: var(--ui-primary); flex: none; }
.bl__btn { opacity: 0.45; }
.bl__row:hover .bl__btn, .bl__row--sel .bl__btn, .bl__row--off .bl__btn { opacity: 1; }
@media (pointer: coarse) { .bl__row { min-height: 40px; } .bl__btn { opacity: 1; } }
</style>
