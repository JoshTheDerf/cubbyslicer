<script setup lang="ts">
/**
 * Orca's Variables card: document variables (name → expression) that feature fields can be
 * bound to. Each change is one rebuild and one undo step. Expressions: + − × ÷, parentheses,
 * sqrt abs sin cos tan min max deg rad, pi; trig in degrees; variables may use each other.
 */
import { computed, reactive, ref } from 'vue';
import { setVariable } from '../commands';
import { design, editBlocker } from '../session';
import { toast } from '../../ui';

const readOnly = computed(() => !!editBlocker());
const entries = computed(() => Object.entries(design.variables).sort(([a], [b]) => a.localeCompare(b)));
const edits = reactive<Record<string, string>>({});
const adding = ref(false);
const newName = ref('');
const newExpr = ref('');
const pending = ref<string | null>(null);

async function run(name: string, expr: string): Promise<boolean> {
  pending.value = name;
  try {
    const r = await setVariable(name, expr);
    return r.ok;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    pending.value = null;
  }
}
async function commitEdit(name: string) {
  const v = edits[name];
  if (v === undefined || v.trim() === design.variables[name]) { delete edits[name]; return; }
  if (!v.trim()) { delete edits[name]; return; }
  if (await run(name, v)) delete edits[name];
}
async function add() {
  if (!newName.value.trim() || !newExpr.value.trim()) return;
  if (await run(newName.value, newExpr.value)) { newName.value = ''; newExpr.value = ''; adding.value = false; }
}
</script>

<template>
  <section class="vt" aria-label="Variables">
    <header class="ds-head">
      <span class="ds-head__title">Variables</span>
      <span v-if="entries.length" class="ds-head__count">{{ entries.length }}</span>
      <span class="flex-1" />
      <UButton v-if="!readOnly && !adding" size="xs" color="neutral" variant="ghost" icon="i-lucide-plus" label="Add" @click="adding = true" />
    </header>
    <p v-if="!entries.length && !adding" class="vt__empty">No variables. Add one, then drive a parameter with it (the fx button next to the value).</p>
    <ul v-if="entries.length" class="vt__list">
      <li v-for="[name, expr] in entries" :key="name" class="vt__row">
        <code class="vt__name" :title="name">{{ name }}</code>
        <span class="vt__eq">=</span>
        <UInput :model-value="edits[name] ?? expr" size="xs" class="vt__expr" spellcheck="false" :disabled="readOnly || pending === name" :aria-label="`${name} expression`"
                @update:model-value="edits[name] = String($event)" @keydown.enter.prevent="commitEdit(name)" @keydown.esc="delete edits[name]" @blur="commitEdit(name)" />
        <span v-if="design.variableErrors[name]" class="vt__val vt__val--err" :title="design.variableErrors[name]" data-testid="variable-error"><UIcon name="i-lucide-circle-alert" class="size-3.5" /></span>
        <span v-else-if="name in design.variableValues && String(design.variableValues[name]) !== expr.trim()" class="vt__val" :title="`${name} evaluates to ${design.variableValues[name]}`"
              data-testid="variable-value">= {{ Math.round(design.variableValues[name] * 1e4) / 1e4 }}</span>
        <UButton v-if="!readOnly" icon="i-lucide-trash-2" size="xs" variant="ghost" color="neutral" :loading="pending === name" :aria-label="`Delete ${name}`" @click="run(name, '')" />
      </li>
    </ul>
    <form v-if="adding" class="vt__add" @submit.prevent="add">
      <UInput v-model="newName" size="xs" placeholder="name" aria-label="Variable name" spellcheck="false" autofocus />
      <span class="vt__eq">=</span>
      <UInput v-model="newExpr" size="xs" placeholder="expression, e.g. 12 or w*2" aria-label="Variable expression" spellcheck="false" />
      <UButton type="submit" size="xs" color="primary" label="Add" :loading="pending === newName.trim()" :disabled="!newName.trim() || !newExpr.trim()" />
      <UButton type="button" size="xs" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Cancel" @click="adding = false" />
    </form>
  </section>
</template>

<style scoped>
.vt { display: flex; flex-direction: column; gap: 4px; }
.vt__empty { margin: 0; padding: 0 8px 4px; font-size: var(--fs-sm); color: var(--fg-2); line-height: 1.4; }
.vt__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.vt__row, .vt__add { display: flex; align-items: center; gap: 6px; padding: 0 2px 0 8px; }
.vt__name { flex: 0 1 auto; max-width: 40%; overflow: hidden; text-overflow: ellipsis; font: var(--fs-sm) var(--mono); color: var(--fg-0); }
.vt__eq { color: var(--fg-2); font-size: var(--fs-sm); }
.vt__expr { flex: 1; min-width: 0; }
.vt__val { flex: none; max-width: 72px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--fs-xs) var(--mono); color: var(--fg-2); }
.vt__val--err { color: var(--danger); display: inline-flex; }
.vt__add > :first-child { width: 30%; flex: none; }
.vt__add > :nth-child(3) { flex: 1; min-width: 0; }
</style>
