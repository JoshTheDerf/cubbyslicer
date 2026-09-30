<script setup lang="ts">
/** Setup examples for the cubby MCP server (one tab per agent), each copyable. */
import { computed, ref } from 'vue';
import { MCP_SETUP } from '@cubby/shared/bridge';

const tab = ref(MCP_SETUP[0].id);
const items = MCP_SETUP.map((e) => ({ value: e.id, label: e.label }));
const cur = computed(() => MCP_SETUP.find((e) => e.id === tab.value) ?? MCP_SETUP[0]);
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
async function copy() {
  try { await navigator.clipboard.writeText(cur.value.snippet); } catch { return; }
  copied.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => { copied.value = false; }, 1500);
}
</script>

<template>
  <div class="ms" data-testid="mcp-setup">
    <UTabs v-model="tab" :items="items" :content="false" size="xs" class="w-full" :ui="{ list: 'w-full', trigger: 'flex-auto min-w-0 px-1.5', label: 'truncate' }" />
    <div class="ms__code">
      <code data-testid="mcp-setup-snippet">{{ cur.snippet }}</code>
      <UButton size="xs" color="neutral" variant="ghost" :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'" :aria-label="copied ? 'Copied' : 'Copy'"
               data-testid="mcp-setup-copy" @click="copy" />
    </div>
    <p v-if="cur.note" class="ms__note">{{ cur.note }}</p>
  </div>
</template>

<style scoped>
.ms { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ms__code { display: flex; align-items: flex-start; gap: 4px; padding: 6px 4px 6px 8px; border-radius: 6px; background: var(--bg-2); min-width: 0; }
.ms__code code { flex: 1; min-width: 0; font-size: 0.85em; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; user-select: all; align-self: center; }
.ms__note { font-size: 0.85em; color: var(--ui-text-dimmed); }
</style>
