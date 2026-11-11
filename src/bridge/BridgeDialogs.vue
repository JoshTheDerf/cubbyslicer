<script setup lang="ts">
/**
 * "Connect an AI agent" dialog. Mounted once by App.vue. (The confirm the
 * agent's printer tools wait on is the app's confirm dialog, ./store.ts.)
 */
import { computed, onMounted, ref, watch } from 'vue';
import { dialogs } from '../dialogs/state';
import AppDialog from '../ui/AppDialog.vue';
import { bridge, bridgeState, bridgeUi, startBridge } from './store';
import McpSetup from './McpSetup.vue';

onMounted(startBridge);

const code = ref('');
const auto = ref(false);
watch(() => dialogs.bridge, (o) => { if (o) { code.value = bridgeUi.prefill; auto.value = bridgeState.value.autoReconnect; } });

const s = bridgeState;
const connected = computed(() => s.value.status === 'connected');
const busy = computed(() => s.value.status === 'connecting');
const statusText = computed(() => {
  switch (s.value.status) {
    case 'connected': return `Connected as ${s.value.tab}. Your agent can use this tab.`;
    case 'connecting': return 'Connecting…';
    case 'needs-code': return 'Enter the pairing code from your agent.';
    case 'error': return 'Not connected.';
    default: return s.value.paired ? 'This site is paired. Connect to let your agent use this tab.' : 'Not connected.';
  }
});

async function connect() {
  await bridge.connect({ input: code.value.trim() || undefined, autoReconnect: auto.value });
}
</script>

<template>
  <AppDialog v-model:open="dialogs.bridge" title="Connect an AI agent" size="md" cancel-label="">
    <div class="bd dlg-flow text-sm" data-testid="bridge-dialog">
      <p class="bd__status dlg-span" :class="{ 'bd__status--on': connected }" data-testid="bridge-status">
        <span class="bd__dot" />{{ statusText }}
      </p>
      <p v-if="s.error" class="bd__error dlg-span" role="alert">{{ s.error }}</p>
      <template v-if="!connected">
        <p class="text-toned dlg-span">
          Your AI agent drives this tab through the cubby MCP server on your computer (127.0.0.1). Add it to your agent once
          (any MCP client works), ask the agent for the pairing code, and paste it here.
        </p>
        <McpSetup class="dlg-span" />
        <UFormField :label="s.paired ? 'Pairing code (only to pair again)' : 'Pairing code'">
          <UInput v-model="code" placeholder="K7QD-93XM" spellcheck="false" autocomplete="off" class="w-full font-mono" data-testid="bridge-code"
                  @keydown.enter="connect" />
        </UFormField>
        <UCheckbox v-model="auto" label="Reconnect when this page loads" class="mt-3 self-end" data-testid="bridge-auto" />
        <p class="text-dimmed mt-3 dlg-span">
          On https, the browser asks to let this site reach devices on your local network. Allow it; it only reaches cubby-mcp on this computer.
        </p>
      </template>
      <template v-else>
        <p class="text-toned dlg-span">
          Your agent can use everything in the slicer, like you can. Uploads, prints, print host changes and deleting presets ask you here first
          <template v-if="bridge.isSessionAllowed('print') || bridge.isSessionAllowed('upload')">
            (you allowed them without asking for this session. <ULink as="button" class="text-info" @click="bridge.revokeSessionAllow('print'); bridge.revokeSessionAllow('upload')">Ask again</ULink>)
          </template>.
        </p>
      </template>
    </div>
    <template #footer-start>
      <UButton v-if="s.paired" color="neutral" variant="ghost" label="Forget pairing" @click="bridge.forget()" />
    </template>
    <template #footer-end>
      <UButton v-if="connected || busy" color="neutral" variant="outline" label="Disconnect" data-testid="bridge-disconnect" @click="bridge.disconnect()" />
      <UButton v-if="!connected" color="primary" :loading="busy" :disabled="!code.trim() && !s.paired" label="Connect" data-testid="bridge-connect" @click="connect" />
      <UButton v-else color="primary" label="Done" @click="dialogs.bridge = false" />
    </template>
  </AppDialog>
</template>

<style scoped>
.bd { display: flex; flex-direction: column; gap: 10px; }
.bd__status { display: flex; align-items: center; gap: 8px; color: var(--fg-0); }
.bd__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-2, #777); flex: none; }
.bd__status--on .bd__dot { background: var(--ui-primary); }
.bd__error { color: var(--ui-error); white-space: pre-line; }
.bd code { font-size: 0.92em; padding: 1px 4px; border-radius: 4px; background: var(--bg-2); user-select: all; }
</style>
