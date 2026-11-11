<script setup lang="ts">
/**
 * Everything plugins put on screen: the Plugins dialog, plugin windows and
 * floating dock panels, message boxes (ui.message), progress dialogs and
 * permission prompts. Mounted once (DialogsHost.vue); reads the installed
 * plugins at startup and loads the enabled ones in idle time.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { startPlugins } from '../index';
import { pluginsDialogOpen } from '../state';
import { messageRequest, permissionRequest, pluginUi, progressCancel, type PermissionRequest, type ProgressBox } from '../host/ui';
import AppDialog from '../../ui/AppDialog.vue';
import { PERMISSION_BROWSER_NOTES } from '../manager/permissions';
import PluginWindowFrame from './PluginWindowFrame.vue';
import PluginsDialog from './PluginsDialog.vue';

onMounted(() => { void startPlugins(); });

const message = computed(() => messageRequest.current.value);
const prompt = computed(() => permissionRequest.current.value);

const BUTTONS: Record<string, Array<{ id: string; label: string; primary?: boolean }>> = {
  ok: [{ id: 'ok', label: 'OK', primary: true }],
  ok_cancel: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'OK', primary: true }],
  yes_no: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes', primary: true }],
  yes_no_cancel: [{ id: 'cancel', label: 'Cancel' }, { id: 'no', label: 'No' }, { id: 'yes', label: 'Yes', primary: true }],
};
const ICON: Record<string, string> = { info: 'i-lucide-info', warning: 'i-lucide-triangle-alert', error: 'i-lucide-circle-x', question: 'i-lucide-circle-help' };

// Progress dialogs: elapsed / estimated / remaining times tick once a second.
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function times(p: ProgressBox): string[] {
  const el = (now.value - p.startedAt) / 1000;
  const frac = p.maximum > 0 ? p.value / p.maximum : 0;
  const est = frac > 0.01 ? el / frac : 0;
  const out: string[] = [];
  if (p.style & 0x8) out.push(`Elapsed ${fmt(el)}`);
  if (p.style & 0x10 && est) out.push(`Estimated ${fmt(est)}`);
  if (p.style & 0x40 && est) out.push(`Remaining ${fmt(Math.max(0, est - el))}`);
  return out;
}

function grantLines(r: PermissionRequest['request']): Array<{ label: string; items: string[]; note?: string }> {
  const out: Array<{ label: string; items: string[]; note?: string }> = [];
  if (r.fs_read.length) out.push({ label: 'Read files', items: r.fs_read, note: PERMISSION_BROWSER_NOTES.fs });
  if (r.fs_readwrite.length) out.push({ label: 'Read and write files', items: r.fs_readwrite, note: PERMISSION_BROWSER_NOTES.fs });
  if (r.network_http.length) out.push({ label: 'Network access', items: r.network_http, note: PERMISSION_BROWSER_NOTES.network_http });
  if (r.network_socket.length) out.push({ label: 'Network sockets', items: r.network_socket, note: PERMISSION_BROWSER_NOTES.network_socket });
  if (r.process.length) out.push({ label: 'Start programs', items: r.process, note: PERMISSION_BROWSER_NOTES.process });
  if (r.threading) out.push({ label: 'Start threads', items: [], note: PERMISSION_BROWSER_NOTES.threading });
  return out;
}
</script>

<template>
  <PluginsDialog v-if="pluginsDialogOpen" />

  <PluginWindowFrame v-for="w in pluginUi.windows" :key="w.handle" :win="w" />

  <AppDialog v-for="p in pluginUi.progress" :key="p.handle" :open="true" :title="p.title" :description="p.pluginName" :dismissible="false"
             size="md" body-class="flex flex-col gap-3" cancel-label="">
    <p class="text-sm" data-testid="plugin-progress-message">{{ p.message }}</p>
    <UProgress :model-value="p.pulsing ? null : p.value" :max="p.maximum" size="sm" />
    <p v-if="times(p).length" class="text-xs text-dimmed">{{ times(p).join(' · ') }}</p>
    <template v-if="p.style & 0x81" #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton v-if="p.style & 0x80" label="Skip" variant="outline" @click="p.skipped = true" />
        <UButton v-if="p.style & 0x1" label="Cancel" :disabled="p.cancelled" data-testid="plugin-progress-cancel" @click="progressCancel(p.handle)" />
      </div>
    </template>
  </AppDialog>

  <AppDialog v-if="message" v-model:open="messageRequest.open.value" :title="message.title" :description="message.pluginName" size="md" cancel-label="">
    <div class="flex gap-3">
      <UIcon :name="ICON[message.icon] ?? ICON.info" class="mt-0.5 size-5 shrink-0" :class="message.icon === 'error' ? 'text-error' : message.icon === 'warning' ? 'text-warning' : 'text-info'" />
      <p class="whitespace-pre-line text-sm" data-testid="plugin-message-text">{{ message.text }}</p>
    </div>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton v-for="b in BUTTONS[message.buttons] ?? BUTTONS.ok" :key="b.id" :label="b.label" :color="b.primary ? 'primary' : 'neutral'"
                 :variant="b.primary ? 'solid' : 'outline'" :data-testid="`plugin-message-${b.id}`" @click="messageRequest.answer(b.id)" />
      </div>
    </template>
  </AppDialog>

  <AppDialog v-if="prompt" v-model:open="permissionRequest.open.value" :title="prompt.kind === 'load' ? 'Plugin permissions' : 'Allow plugin access?'"
             :description="prompt.pluginName" size="lg" body-class="flex flex-col gap-3" cancel-label="Deny" confirm-label="Allow"
             test-id="plugin-permission" @confirm="permissionRequest.answer(true)">
    <p class="text-sm">
      <template v-if="prompt.kind === 'load'">{{ prompt.pluginName }} asks for these permissions. Denying stops the plugin from loading.</template>
      <template v-else>{{ prompt.pluginName }} tried something it has no permission for, and it was blocked. Allow it, so the next attempt works?</template>
    </p>
    <div v-for="g in grantLines(prompt.request)" :key="g.label" class="rounded-md border border-default p-2.5">
      <p class="text-sm font-medium">{{ g.label }}</p>
      <ul v-if="g.items.length" class="mt-1 list-disc ps-5 text-xs break-all"><li v-for="t in g.items" :key="t">{{ t }}</li></ul>
      <p v-if="g.note" class="mt-1 text-xs text-dimmed">{{ g.note }}</p>
    </div>
    <p class="text-xs text-dimmed">Permission prompts help you see what a plugin does; they are not a sandbox.</p>
  </AppDialog>
</template>
