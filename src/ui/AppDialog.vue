<script setup lang="ts">
/**
 * The app's dialog shell: a UModal with the mobile convention applied
 * (docs/DEVELOPMENT.md "Dialogs on phones"), a width, and the standard footer
 * (secondary actions on the left, Cancel + the primary button on the right).
 *
 *   <AppDialog v-model:open="dialogs.arrange" title="Arrange options" size="md" fullscreen
 *              confirm-label="Arrange" @confirm="arrangeNow">
 *     …body…
 *     <template #footer-start><UButton label="Reset" … /></template>
 *   </AppDialog>
 *
 * Without `confirmLabel` and a `#footer` slot there is no footer. `#footer`
 * replaces the whole button row. `fullscreen` fills a phone screen (long
 * forms, lists); otherwise a phone gets the bottom sheet.
 */
import { computed, useSlots } from 'vue';
import { mobileDialog } from './mobileDialog';

const props = withDefaults(defineProps<{
  title: string;
  description?: string;
  /** Desktop width; 'wide' = min(1200px, 96vw) for data grids. */
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '5xl' | '6xl' | 'wide';
  /** Full screen on phones. */
  fullscreen?: boolean;
  /** Esc / outside click / the close button may close it. */
  dismissible?: boolean;
  /** Primary button; omitted = no primary button. */
  confirmLabel?: string;
  confirmColor?: 'primary' | 'error';
  confirmIcon?: string;
  confirmDisabled?: boolean;
  confirmLoading?: boolean;
  /** Focus the primary button on open (confirmations). */
  confirmAutofocus?: boolean;
  /** Cancel button label ('' = none). */
  cancelLabel?: string;
  /** Extra classes for the body slot (e.g. 'flex flex-col gap-4'). */
  bodyClass?: string;
  /** Prefix for the buttons' data-testid (`<id>-ok`, `<id>-cancel`). */
  testId?: string;
  /**
   * Above every other dialog. Modals have no z-index and stack in DOM order, and a dialog
   * mounted early (the app's confirm, in ShellDialogs) would otherwise open underneath a
   * modal mounted later that asked the question.
   */
  onTop?: boolean;
}>(), { size: 'md', dismissible: true, confirmColor: 'primary', cancelLabel: 'Cancel' });

const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const slots = useSlots();

const WIDTH = { sm: 'sm:max-w-sm', md: 'sm:max-w-md', lg: 'sm:max-w-lg', xl: 'sm:max-w-xl', '2xl': 'sm:max-w-2xl', '3xl': 'sm:max-w-3xl',
  '5xl': 'sm:max-w-5xl', '6xl': 'sm:max-w-6xl', wide: 'sm:max-w-[min(1200px,96vw)]' } as const;
const ui = computed(() => ({
  content: props.onTop ? `${WIDTH[props.size]} z-[60]` : WIDTH[props.size],
  ...(props.onTop ? { overlay: 'z-[60]' } : {}),
  ...(props.bodyClass ? { body: props.bodyClass } : {}),
  // Messages keep their line breaks (Orca's dialogs use "\n" for paragraphs and Yes / No lists).
  description: 'whitespace-pre-line',
}));
const hasFooter = computed(() => !!slots.footer || !!slots['footer-start'] || !!slots['footer-end'] || !!props.confirmLabel);

function cancel(): void { emit('cancel'); open.value = false; }
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="description" :dismissible="dismissible"
          :fullscreen="fullscreen && mobileDialog" :ui="ui">
    <template v-if="slots.default" #body><slot /></template>
    <template v-if="hasFooter" #footer>
      <slot name="footer">
        <div class="flex w-full flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap gap-2"><slot name="footer-start" /></div>
          <div class="ms-auto flex flex-wrap justify-end gap-2">
            <UButton v-if="cancelLabel" color="neutral" variant="ghost" :label="cancelLabel"
                     :data-testid="testId ? `${testId}-cancel` : undefined" @click="cancel" />
            <slot name="footer-end" />
            <UButton v-if="confirmLabel" :color="confirmColor" :icon="confirmIcon" :label="confirmLabel" :disabled="confirmDisabled"
                     :loading="confirmLoading" :autofocus="confirmAutofocus || undefined" :data-testid="testId ? `${testId}-ok` : undefined" @click="emit('confirm')" />
          </div>
        </div>
      </slot>
    </template>
  </UModal>
</template>
