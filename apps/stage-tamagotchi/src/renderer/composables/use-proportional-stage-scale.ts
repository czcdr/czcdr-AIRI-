import type { WatchSource } from 'vue'

import { getStageViewport, measureStageArtBounds, useL2dViewControl } from '@proj-airi/stage-ui-live2d'
import { useEventListener } from '@vueuse/core'
import { onMounted, onScopeDispose, watch } from 'vue'

/**
 * Margin the character keeps from the window edge, in CSS pixels. Mirrors the
 * window fit so a resize never grows the character into the frame it just left.
 */
const MARGIN_SIDE = 10
const MARGIN_TOP = 12
const MARGIN_BOTTOM = 6

/** The stage controls clamp the user scale to this range. */
const MAX_USER_SCALE = 3

/** A resize settles before the character is re-measured; dragging emits many. */
const RESIZE_DEBOUNCE = 120
const STAGE_SETTLE_TIMEOUT = 700
const STAGE_SETTLE_INTERVAL = 40

/** Ratios below this are treated as "the user did not really resize". */
const MIN_FACTOR_DELTA = 0.01

interface Baseline {
  width: number
  height: number
  artWidth: number
  artHeight: number
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Keeps the character proportional to the window while the user resizes it.
 *
 * The stage already scales a model with the window, but only with whichever
 * dimension is currently binding, so a window that is roughly square stops
 * following the edge the user is dragging. This watches the window instead and
 * drives the user scale directly:
 *
 * - the character keeps the share of the window it had, following the dimension
 *   the user changed, and
 * - it never grows past the room the window has, so resizing cannot cut the
 *   character off — the case the window fit exists to undo.
 *
 * `suspended` marks window changes that are not the user's, such as the fit
 * itself; those only refresh the baseline.
 */
export function useProportionalStageScale(options: {
  suspended?: () => boolean
  /** The selected display model, so a model swap re-baselines the character. */
  model?: WatchSource
} = {}) {
  const viewControl = useL2dViewControl()
  let baseline: Baseline | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function measureBaseline(): Baseline | undefined {
    const viewport = getStageViewport()
    const art = measureStageArtBounds()
    if (!viewport || !art)
      return undefined

    return {
      width: viewport.width,
      height: viewport.height,
      artWidth: art.width,
      artHeight: art.height,
    }
  }

  /** Re-reads the character and the window, so the next resize scales from here. */
  function reset() {
    baseline = measureBaseline()
  }

  async function waitForStageSize(width: number, height: number) {
    const deadline = Date.now() + STAGE_SETTLE_TIMEOUT

    while (Date.now() < deadline) {
      const viewport = getStageViewport()
      if (viewport && Math.abs(viewport.width - width) <= 1 && Math.abs(viewport.height - height) <= 1)
        return true

      await wait(STAGE_SETTLE_INTERVAL)
    }

    return false
  }

  async function apply() {
    if (options.suspended?.()) {
      reset()
      return
    }

    if (!baseline) {
      reset()
      return
    }

    const width = window.innerWidth
    const height = window.innerHeight
    if (width === baseline.width && height === baseline.height)
      return

    // The stage re-frames the model for the new window first, so the measurement
    // below describes the character the user is looking at.
    if (!await waitForStageSize(width, height)) {
      reset()
      return
    }

    const viewport = getStageViewport()
    const art = measureStageArtBounds()
    if (!viewport || !art || art.width <= 0 || art.height <= 0) {
      reset()
      return
    }

    const previous = baseline
    // The character follows the edge the user moved. A corner drag changes both
    // dimensions, and whichever changed more is the one that was asked for.
    const widthRatio = width / previous.width
    const heightRatio = height / previous.height
    const growth = Math.abs(widthRatio - 1) >= Math.abs(heightRatio - 1) ? widthRatio : heightRatio
    // The stage anchors the model to the bottom centre, so artwork that sits
    // off-centre keeps that offset in every window; the room left is what the
    // narrower side allows.
    const offsetFromCenterX = (art.x + art.width / 2) - viewport.width / 2
    const allowedWidth = viewport.width - MARGIN_SIDE * 2 - Math.abs(offsetFromCenterX) * 2
    const allowedHeight = viewport.height - MARGIN_TOP - MARGIN_BOTTOM
    const scale = viewControl.scale.value

    const factor = Math.min(
      (previous.artWidth * growth) / art.width,
      allowedWidth / art.width,
      allowedHeight / art.height,
      MAX_USER_SCALE / scale,
    )

    const applied = Number.isFinite(factor) && factor > 0 && Math.abs(factor - 1) > MIN_FACTOR_DELTA ? factor : 1
    if (applied !== 1)
      viewControl.set('scale', scale * applied)

    baseline = {
      width,
      height,
      artWidth: art.width * applied,
      artHeight: art.height * applied,
    }
  }

  function schedule() {
    if (timer)
      clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void apply()
    }, RESIZE_DEBOUNCE)
  }

  useEventListener('resize', schedule)

  onMounted(() => {
    // The stage mounts with the window, and a model may still be loading.
    setTimeout(reset, RESIZE_DEBOUNCE)
  })

  onScopeDispose(() => {
    if (timer)
      clearTimeout(timer)
  })

  if (options.model)
    watch(options.model, () => setTimeout(reset, RESIZE_DEBOUNCE))

  return {
    /** Re-reads the character and the window; call after a programmatic resize. */
    reset,
  }
}
