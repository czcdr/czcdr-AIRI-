<script setup lang="ts">
import { OverlayButton } from '@proj-airi/ui'

const props = defineProps<{ buttonStyle?: string, disabled?: boolean }>()
</script>

<template>
  <OverlayButton
    size="sm"
    :disabled="props.disabled"
    :class="[
      'p-[var(--island-pad)]!',
      props.buttonStyle,
    ]"
  >
    <slot />
  </OverlayButton>
</template>
