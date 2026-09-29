<script setup lang="ts">
// Cubby Slicer mark (docs/logo.svg): the CubbyCAD cat sliced into layers. The
// app is dark-only, so this is the logo's dark-scheme colouring (paper cat).
import { useId } from 'vue';

const EAR_L = 'M3 13 L7.5 0.5 L14 10 Z';
const EAR_R = 'M18 10 L24.5 0.5 L29 13 Z';
const BODY = 'M8 8 L24 8 A5 5 0 0 1 29 13 L29 22 A8 8 0 0 1 21 30 L11 30 A8 8 0 0 1 3 22 L3 13 A5 5 0 0 1 8 8 Z';
const GAPS = [5.6, 10, 14.4, 18.8, 23.2, 27.6];
const INK = '#fafaf7';
const PAPER = '#0a0a0a';
const mask = `brand-layers-${useId()}`;
</script>

<template>
  <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" class="brand-mark">
    <defs>
      <mask :id="mask" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
        <rect width="32" height="32" fill="#fff" />
        <rect v-for="y in GAPS" :key="y" x="0" :y="y" width="32" height="1" fill="#000" />
      </mask>
    </defs>
    <g :mask="`url(#${mask})`">
      <path :d="EAR_L" :fill="INK" /><path :d="EAR_R" :fill="INK" /><path :d="BODY" :fill="INK" />
      <circle cx="11.5" cy="19" r="3.6" :fill="PAPER" /><circle cx="20.5" cy="19" r="3.6" :fill="PAPER" />
      <circle cx="11.5" cy="19" r="2.76" :fill="INK" /><circle cx="20.5" cy="19" r="2.76" :fill="INK" />
      <path d="M14.8 23.5 L16 25 L17.2 23.5 Z" :fill="PAPER" />
    </g>
  </svg>
</template>
