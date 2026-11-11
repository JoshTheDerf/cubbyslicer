<script setup lang="ts">
/**
 * Orca's offer menu (DesignOffer): right click in the Design view lists what applies to the
 * pick — a header line, the body shortcuts, then the families (Add material, Remove,
 * Fillet / chamfer / draft, Repeat, Transform, Reference, Modify). Each entry opens its
 * feature card prefilled from the pick.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { DropdownMenuItem } from '@nuxt/ui';
import { offerItems, type OfferItem } from '../create';
import { deleteBody, selectFeature } from '../commands';
import { pickBodyColor } from '../bodyColor';
import { readDesign } from '../session';
import type { EdgeInfo, FaceInfo } from '../kernel/types';
import { designUi, type DesignPick } from '../state';
import { designViewport } from '../viewport';
import { toast } from '../../ui';

const props = defineProps<{ x: number; y: number; pick: DesignPick | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const open = ref(false);
const items = ref<DropdownMenuItem[][]>([]);

const report = (p: Promise<unknown>) => { p.catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e))); };

function toMenu(groups: OfferItem[][]): DropdownMenuItem[][] {
  const conv = (it: OfferItem): DropdownMenuItem => ({
    label: it.label, icon: it.icon, disabled: it.disabled, kbds: it.kbds, type: it.type,
    ...(it.children ? { children: it.children.map((g) => g.map(conv)) } : {}),
    ...(it.onSelect ? { onSelect: it.onSelect } : {}),
  });
  return groups.map((g) => g.map(conv));
}

onMounted(async () => {
  const p = props.pick;
  const info: { surface?: string; curve?: string; faceEdges?: number[]; cylinderFace?: number } = {};
  try {
    if (p?.kind === 'face') {
      const f = await readDesign(async (c, doc) => (await c.call<FaceInfo>('face_info', { doc, body: p.body, face: p.face, generation: p.generation })).result);
      info.surface = f.surface; info.faceEdges = f.edges;
    } else if (p?.kind === 'edge') {
      const e = await readDesign(async (c, doc) => {
        const ei = (await c.call<EdgeInfo>('edge_info', { doc, body: p.body, edge: p.edge, generation: p.generation })).result;
        let cyl: number | undefined;
        if (ei.curve === 'circle') {
          for (const f of ei.faces) {
            const fi = (await c.call<FaceInfo>('face_info', { doc, body: p.body, face: f, generation: p.generation })).result;
            if (fi.cylinder) { cyl = f; break; }
          }
        }
        return { curve: ei.curve, cyl };
      });
      info.curve = e.curve; info.cylinderFace = e.cyl;
    }
  } catch { /* stale ids (the design rebuilt): offer what applies to the kind anyway */ }
  items.value = toMenu(offerItems(p, info, {
    renameBody: (b) => { designUi.renamingBody = b; designUi.phoneSection = 'bodies'; },
    colorBody: (b) => pickBodyColor(b),
    deleteBody: (b) => report(deleteBody(b)),
    zoom: () => designViewport()?.fitSelection(),
    editFeature: (i) => selectFeature(i),
  }));
  open.value = true;
  designUi.offerClose = close;
});

// Esc goes through the action registry (design.offer.close), which would otherwise clear the selection.
function close() { onOpen(false); }
function onOpen(v: boolean) {
  open.value = v;
  if (v) return;
  if (designUi.offerClose === close) designUi.offerClose = null;
  emit('close');
}
onBeforeUnmount(() => { if (designUi.offerClose === close) designUi.offerClose = null; });
</script>

<template>
  <UDropdownMenu :open="open" :items="items" :content="{ align: 'start', side: 'bottom', sideOffset: 2 }" :ui="{ content: 'min-w-56 max-h-[70vh]' }" @update:open="onOpen">
    <span class="om__anchor" :style="{ left: `${x}px`, top: `${y}px` }" data-testid="design-offer" />
  </UDropdownMenu>
</template>

<style scoped>
.om__anchor { position: absolute; width: 1px; height: 1px; pointer-events: none; }
</style>
