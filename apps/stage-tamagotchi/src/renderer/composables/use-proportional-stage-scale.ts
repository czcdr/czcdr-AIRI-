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
const RESIZE_DEBOUNCE = 140
const STAGE_SETTLE_TIMEOUT = 900
const STAGE_SETTLE_INTERVAL = 40
const SCALE_APPLY_DELAY = 180

/** The model transform follows the canvas resize by a frame or two. */
const MODEL_SETTLE_DELAY = 100

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
 * The stage scales a model with the window through whichever dimension is
 * binding, so a window that is roughly square stops following the edge the user
 * drags. This watches the window instead and drives the user scale directly: the
 * character keeps the share of the window it had, and never grows past the room
 * the window has, so resizing cannot cut it off.
 *
 * The window itself is left alone. A resize the user performs is theirs, and
 * moving another edge while they drag reads as the window running away from the
 * cursor; the window fit exists for tightening the frame on request.
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
    // below describes the character the user sees. The canvas resizes a frame
    // before the model transform follows, so the wait above is not enough alone.
    if (!await waitForStageSize(width, height)) {
      reset()
      return
    }
    await wait(MODEL_SETTLE_DELAY)

    const previous = baseline
    const widthRatio = width / previous.width
    const heightRatio = height / previous.height
    const widthDominant = Math.abs(widthRatio - 1) >= Math.abs(heightRatio - 1)
    const growth = widthDominant ? widthRatio : heightRatio

    if (!Number.isFinite(growth) || Math.abs(growth - 1) <= MIN_FACTOR_DELTA) {
      reset()
      return
    }

    const viewport = getStageViewport()
    const art = measureStageArtBounds()
    if (!viewport || !art || art.width <= 0 || art.height <= 0) {
      reset()
      return
    }

    // The stage anchors the model to the bottom centre, so artwork that sits
    // off-centre keeps that offset in every window; the room left is what the
    // narrower side allows.
    const offsetFromCenterX = (art.x + art.width / 2) - viewport.width / 2
    const allowedWidth = viewport.width - MARGIN_SIDE * 2 - Math.abs(offsetFromCenterX) * 2
    const allowedHeight = viewport.height - MARGIN_TOP - MARGIN_BOTTOM
    const scale = viewControl.scale.value

    let factor = (previous.artWidth * growth) / art.width
    // Only growth is bounded. Capping a shrink here would take a little off on
    // every resize event and walk the character down to nothing.
    if (factor > 1)
      factor = Math.min(factor, allowedWidth / art.width, allowedHeight / art.height, MAX_USER_SCALE / scale)

    const applied = Number.isFinite(factor) && factor > 0 && Math.abs(factor - 1) > MIN_FACTOR_DELTA ? factor : 1
    if (applied !== 1) {
      viewControl.set('scale', scale * applied)
      await wait(SCALE_APPLY_DELAY)
    }

    const settled = measureStageArtBounds()
    baseline = {
      width: window.innerWidth,
      height: window.innerHeight,
      artWidth: settled?.width ?? art.width * applied,
      artHeight: settled?.height ?? art.height * applied,
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
