<script setup lang="ts">
/** Top-bar indicator while Claude Code is connected (or reconnecting). Click: the connect dialog. */
import { computed } from 'vue';
import { bridgeState, openBridgeDialog } from './store';

const s = bridgeState;
const show = computed(() => s.value.status === 'connected' || s.value.status === 'connecting');
const label = computed(() => (s.value.status === 'connected' ? (s.value.busy ? `Claude Code: ${s.value.lastTool?.name ?? 'working'}…` : 'Claude Code connected') : 'Claude Code: reconnecting'));
</script>

<template>
  <UTooltip v-if="show" :text="label">
    <UButton size="sm" variant="ghost" :color="s.status === 'connected' ? 'primary' : 'warning'" :aria-label="label"
             :icon="s.busy ? 'i-lucide-loader-circle' : 'i-lucide-bot'" :ui="{ leadingIcon: s.busy ? 'animate-spin' : '' }"
             data-testid="bridge-chip" @click="openBridgeDialog()" />
  </UTooltip>
</template>
