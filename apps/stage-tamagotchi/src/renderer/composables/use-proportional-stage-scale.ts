import type { WatchSource } from 'vue'

import type { StageFrame, StageFrameMargins } from './stage-frame-geometry'

import { getStageViewport, measureStageArtBounds, useL2dViewControl } from '@proj-airi/stage-ui-live2d'
import { useEventListener } from '@vueuse/core'
import { onMounted, onScopeDispose, watch } from 'vue'

import { isArtClipped, scaleForMargins } from './stage-frame-geometry'

/**
 * Margin the character keeps from the window edge, in CSS pixels. Mirrors the
 * window fit so a resize never grows the character into the frame it just left.
 */
export const STAGE_FRAME_MARGINS: StageFrameMargins = { side: 10, top: 12, bottom: 6 }

/** A resize settles before the character is re-measured; dragging emits many. */
const RESIZE_DEBOUNCE = 120
const MODEL_SETTLE_DELAY = 90
const SCALE_APPLY_DELAY = 90

/** How long the canvas is given to repaint after a scale change. */
const STAGE_SETTLE_TIMEOUT = 600
const STAGE_SETTLE_INTERVAL = 40

/** Step used while a cut character is brought back into view. */
const SHRINK_STEP = 0.8
const MAX_SHRINK_STEPS = 8

/**
 * The target stops this far short of the margins.
 *
 * The character breathes, blinks and moves, and its painted silhouette changes
 * with the pose: measured over half a minute at one size, this model's painted
 * width swings by about four and a half percent and its left edge by nineteen
 * pixels. A target on the exact margin would be cut by the next pose, and "never
 * cut the character" outranks the last few pixels of size. The window fit uses
 * the same share, so the two agree on where the character belongs.
 */
export const FIT_SAFETY = 0.95

/** A correction this small is not worth another round trip. */
const SCALE_TOLERANCE = 0.01

/** Bound on corrections per resize; each one is absolute, so one is typical. */
const MAX_CORRECTIONS = 2

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Keeps the character as large as the window can hold while the user resizes it.
 *
 * The stage scales a model with the window through whichever dimension is
 * binding, so a window the user drags along one axis stops following that axis,
 * and a model that does not fit is cut off. This watches the window instead and
 * drives the user scale directly: it reads the character as it is painted right
 * now and sets the scale that belongs to *that* window.
 *
 * Every target is a function of the current window and the current character
 * only. Nothing is compared with an earlier frame and nothing is accumulated, so
 * a drag cannot walk the character down to nothing, cannot leave it stranded at
 * a size it passed through, and cannot grow it past the window edge.
 *
 * The window itself is left alone. A resize the user performs is theirs, and
 * moving another edge while they drag reads as the window running away from the
 * cursor; the window fit exists for tightening the frame on request.
 *
 * `suspended` marks window changes that are not the user's, such as the fit
 * itself, which sets the character and the window together and must not be
 * corrected while it works.
 */
export function useProportionalStageScale(options: {
  suspended?: () => boolean
  /** The selected display model, so a model swap re-reads the character. */
  model?: WatchSource
  margins?: StageFrameMargins
} = {}) {
  const viewControl = useL2dViewControl()
  const margins = options.margins ?? STAGE_FRAME_MARGINS

  let timer: ReturnType<typeof setTimeout> | undefined
  /** Invalidates corrections that a newer resize has overtaken. */
  let generation = 0

  function currentScale() {
    const value = viewControl.scale.value
    return Number.isFinite(value) && value > 0 ? value : 1
  }

  function readFrame(): StageFrame | undefined {
    const viewport = getStageViewport()
    const art = measureStageArtBounds()
    if (!viewport || !art || art.width <= 0 || art.height <= 0)
      return undefined

    return { width: viewport.width, height: viewport.height, scale: currentScale(), art }
  }

  /** Largest user scale this window can hold without cutting the character. */
  function fitScale(frame: StageFrame) {
    return scaleForMargins(frame, margins) * FIT_SAFETY
  }

  async function applyScale(value: number) {
    viewControl.set('scale', value)
  }

  /**
   * The character as painted after the user scale was just changed.
   *
   * The store holds the new scale immediately, but the canvas repaints a frame
   * or two later, so a measurement taken straight away describes the size the
   * character had *before* the change. Reading that as the result makes the next
   * round repeat the correction, which is how a resize used to take a little off
   * the character every time it was measured. This waits for the painted width to
   * move most of the way to the size the new scale asks for.
   */
  async function frameAfterApply(before: StageFrame, scale: number) {
    const expected = before.art.width * (scale / before.scale)
    const threshold = Math.max(1, Math.abs(expected - before.art.width) * 0.5)
    const deadline = Date.now() + STAGE_SETTLE_TIMEOUT

    await wait(SCALE_APPLY_DELAY)

    let frame = readFrame()
    while (Date.now() < deadline) {
      if (frame && Math.abs(frame.art.width - before.art.width) >= threshold)
        return frame

      await wait(STAGE_SETTLE_INTERVAL)
      frame = readFrame()
    }

    return frame
  }

  /** Scales a cut character down until its bounds can be measured again. */
  async function reveal(frame: StageFrame, stopped?: () => boolean) {
    let current: StageFrame | undefined = frame

    for (let step = 0; current && isArtClipped(current) && step < MAX_SHRINK_STEPS; step++) {
      if (stopped?.())
        return undefined

      const before = current
      const scale = currentScale() * SHRINK_STEP
      await applyScale(scale)
      current = await frameAfterApply(before, scale)
    }

    return current && !isArtClipped(current) ? current : undefined
  }

  /**
   * Applies the size the window asks for, then reads the result back.
   *
   * A frame measured before the stage repainted describes the previous window,
   * so the correction is repeated while the result disagrees. Each round starts
   * from the character as it is painted now, which is what keeps a late or an
   * early measurement to one extra round instead of a drift.
   */
  async function align(token: number) {
    /**
     * True once this correction no longer owns the character.
     *
     * A fit that starts while a correction is already in flight must not have to
     * race it: both would set the user scale, and the fit would keep measuring a
     * character the other one had just resized. The check runs after every wait,
     * so the correction stops at its next step instead of at its next resize.
     */
    const stopped = () => token !== generation || options.suspended?.() === true

    // The model follows the canvas by a frame or two, never immediately.
    await wait(MODEL_SETTLE_DELAY)
    if (stopped())
      return

    let frame = readFrame()
    if (!frame) {
      return
    }

    // A cut character cannot be measured 鈥?its bounds read as the window edge 鈥?    // so it is brought back into view before any size is taken from it.
    if (isArtClipped(frame)) {
      const revealed = await reveal(frame, stopped)
      if (!revealed || stopped()) {
        return
      }
      frame = revealed
    }

    for (let round = 0; round <= MAX_CORRECTIONS; round++) {
      if (stopped())
        return

      const target = fitScale(frame)
      const current = currentScale()
      if (!Number.isFinite(target) || target <= 0)
        return

      const off = Math.abs(target - current) / current

      // The frame is measured at the scale it is painted at, so a target that
      // matches it means the character is already where this window wants it.
      if (!isArtClipped(frame) && off <= SCALE_TOLERANCE) {
        return
      }

      await applyScale(target)
      if (stopped()) {
        return
      }

      const settled = await frameAfterApply(frame, target)
      if (!settled || stopped())
        return

      frame = settled
      if (isArtClipped(frame)) {
        const revealed = await reveal(frame, stopped)
        if (!revealed || stopped())
          return
        frame = revealed
      }
    }

    // The last round can end on a frame measured while the stage was re-framing,
    // which reads the character as smaller than it is and asks for a size that
    // cuts it. A character left cut is the one outcome that must never happen, so
    // it is checked once more and corrected from a frame that can be measured.
    const final = readFrame()
    if (final && isArtClipped(final)) {
      const revealed = await reveal(final, stopped)
      if (!revealed || stopped())
        return

      const target = fitScale(revealed)
      const current = currentScale()
      if (Number.isFinite(target) && target > 0 && Math.abs(target - current) / current > SCALE_TOLERANCE)
        await applyScale(target)
    }
  }

  function schedule(delay = RESIZE_DEBOUNCE) {
    if (timer)
      clearTimeout(timer)

    timer = setTimeout(() => {
      timer = undefined
      if (options.suspended?.()) {
        return
      }

      const token = ++generation
      void align(token)
    }, delay)
  }

  useEventListener('resize', () => schedule())

  onMounted(() => {
    // The stage mounts with the window, and a model may still be loading. The
    // first run also repairs a scale left behind by a window of another size.
    schedule(RESIZE_DEBOUNCE * 2)
  })

  onScopeDispose(() => {
    generation++
    if (timer)
      clearTimeout(timer)
  })

  if (options.model)
    watch(options.model, () => schedule(RESIZE_DEBOUNCE * 2))

  return {
    /**
     * Re-reads the character and re-applies the size the window asks for; call
     * after a programmatic resize such as the window fit.
     */
    reset() {
      schedule(RESIZE_DEBOUNCE)
    },
  }
}
