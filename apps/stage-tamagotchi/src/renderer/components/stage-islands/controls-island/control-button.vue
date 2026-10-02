<script setup lang="ts">
import { OverlayButton } from '@proj-airi/ui'

const props = defineProps<{ buttonStyle?: string, disabled?: boolean }>()
</script>

<template>
  <OverlayButton
    size="sm"
    :disabled="props.disabled"
    :class="[
      'p-2!',
      props.buttonStyle,
    ]"
  >
    <slot />
  </OverlayButton>
</template>
