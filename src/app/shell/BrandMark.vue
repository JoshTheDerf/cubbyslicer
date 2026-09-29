<script setup lang="ts">
// The CubbyCAD cat mark (cad-project/src/components/BrandMark.vue): a rounded
// head with two ear notches and dot eyes, always black. The slicer is dark-only,
// so the paper halo that lifts it off dark backgrounds is always drawn.
const EAR_L = 'M3 13 L7.5 0.5 L14 10 Z';
const EAR_R = 'M18 10 L24.5 0.5 L29 13 Z';
const BODY = 'M8 8 L24 8 A5 5 0 0 1 29 13 L29 22 A8 8 0 0 1 21 30 L11 30 A8 8 0 0 1 3 22 L3 13 A5 5 0 0 1 8 8 Z';
const BLACK = '#0a0a0a';
const PAPER = '#fafaf7';
</script>

<template>
  <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" class="brand-mark">
    <g :stroke="PAPER" stroke-width="3" stroke-linejoin="round" :fill="PAPER">
      <path :d="EAR_L" /><path :d="EAR_R" /><path :d="BODY" />
    </g>
    <path :d="EAR_L" :fill="BLACK" /><path :d="EAR_R" :fill="BLACK" /><path :d="BODY" :fill="BLACK" />
    <circle cx="11.5" cy="19" r="3.6" :fill="PAPER" /><circle cx="20.5" cy="19" r="3.6" :fill="PAPER" />
    <circle cx="11.5" cy="19" r="2.76" fill="#111" /><circle cx="20.5" cy="19" r="2.76" fill="#111" />
    <path d="M14.8 23.5 L16 25 L17.2 23.5 Z" :fill="PAPER" />
  </svg>
</template>

<style scoped>
.brand-mark { overflow: visible; }
</style>
