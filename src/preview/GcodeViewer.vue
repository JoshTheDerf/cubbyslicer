<template>
  <section class="gv" data-testid="preview-gcode-viewer" @wheel.prevent="onWheel">
    <header class="gv-head">
      <UIcon name="i-lucide-file-code" class="size-4 text-muted" />
      <span class="font-medium text-highlighted">G-code</span>
      <UBadge size="sm" variant="subtle" color="neutral" class="font-mono">line {{ (anchorLineNo + 1).toLocaleString() }}</UBadge>
      <span class="flex-1" />
      <UTooltip text="Back to current move">
        <UButton size="xs" variant="ghost" icon="i-lucide-locate-fixed" aria-label="Back to current move" :disabled="!detached" @click="reset" />
      </UTooltip>
      <UTooltip text="Close" :kbds="['G']">
        <UButton size="xs" variant="ghost" icon="i-lucide-x" aria-label="Close G-code viewer" @click="emit('close')" />
      </UTooltip>
    </header>
    <div ref="body" class="gv-body">
      <div
        v-for="l in lines"
        :key="l.offset"
        class="gv-line"
        :class="{ current: l.offset === currentOffset }"
        @click="emit('pick', l.offset, l.lineNo)"
      >
        <span class="gv-no">{{ l.lineNo + 1 }}</span>
        <span class="gv-text"><span v-for="(t, i) in tokenize(l.text)" :key="i" :class="`t-${t.kind}`">{{ t.text }}</span></span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { lineStartAt, linesAround, nextLineStart, prevLineStart, tokenize } from './gcodeText';

const props = defineProps<{
  bytes: Uint8Array;
  /** Byte offset + 0-based line number of the current move's line. */
  anchorOffset: number;
  anchorLineNo: number;
}>();
const emit = defineEmits<{ pick: [offset: number, lineNo: number]; close: [] }>();

const LINE_H = 18;
const body = ref<HTMLDivElement | null>(null);
const rows = ref(30);
// View window anchor (independent of the move while the user scrolls).
const viewOffset = ref(0);
const viewLineNo = ref(0);
const detached = ref(false);
const currentOffset = computed(() => lineStartAt(props.bytes, props.anchorOffset));

const lines = shallowRef<ReturnType<typeof linesAround>>([]);

function refresh() {
  const before = Math.floor(rows.value / 2);
  lines.value = linesAround(props.bytes, viewOffset.value, viewLineNo.value, before, rows.value - before);
}

function reset() {
  viewOffset.value = props.anchorOffset;
  viewLineNo.value = props.anchorLineNo;
  detached.value = false;
  refresh();
}

watch(() => [props.anchorOffset, props.anchorLineNo, props.bytes], reset, { immediate: true });

function onWheel(e: WheelEvent) {
  const steps = Math.max(1, Math.round(Math.abs(e.deltaY) / LINE_H)) * (e.shiftKey ? 10 : 1);
  let off = lineStartAt(props.bytes, viewOffset.value), no = viewLineNo.value;
  for (let k = 0; k < steps; k++) {
    const nx = e.deltaY > 0 ? nextLineStart(props.bytes, off) : prevLineStart(props.bytes, off);
    if (nx < 0) break;
    off = nx; no += e.deltaY > 0 ? 1 : -1;
  }
  viewOffset.value = off; viewLineNo.value = no;
  detached.value = true;
  refresh();
}

let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver(() => {
    const h = body.value?.clientHeight ?? 0;
    const n = Math.max(5, Math.floor(h / LINE_H));
    if (n !== rows.value) { rows.value = n; refresh(); }
  });
  if (body.value) ro.observe(body.value);
});
onBeforeUnmount(() => ro?.disconnect());
</script>

<style scoped>
.gv {
  display: flex;
  flex-direction: column;
  width: 360px;
  height: 100%;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: color-mix(in srgb, var(--ui-bg) 92%, transparent);
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
  overflow: hidden;
  font-size: 12px;
}
.gv-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 4px 8px;
  border-bottom: 1px solid var(--ui-border);
}
.gv-body { flex: 1; overflow: hidden; font-family: var(--mono, ui-monospace, monospace); font-size: 11px; }
.gv-line {
  display: flex;
  height: 18px;
  line-height: 18px;
  white-space: pre;
  cursor: pointer;
}
.gv-line:hover { background: var(--ui-bg-elevated); }
.gv-line.current { background: color-mix(in srgb, var(--ui-primary) 22%, transparent); box-shadow: inset 2px 0 0 var(--ui-primary); }
.gv-no { flex: none; width: 64px; padding-right: 8px; text-align: right; color: var(--ui-text-dimmed); user-select: none; font-variant-numeric: tabular-nums; }
.gv-text { overflow: hidden; text-overflow: ellipsis; color: var(--ui-text); }
.t-cmd { color: var(--ui-info); font-weight: 600; }
.t-axis { color: var(--ui-warning); }
.t-num { color: var(--ui-text-highlighted); }
.t-comment { color: var(--ui-text-dimmed); font-style: italic; }
</style>
