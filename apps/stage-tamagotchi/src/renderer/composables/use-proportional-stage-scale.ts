import type { WatchSource } from 'vue'

import type { StageFrame, StageFrameMargins } from './stage-frame-geometry'

import { getStageFrameCount, getStageViewport, measureStageArtBounds, useL2dViewControl } from '@proj-airi/stage-ui-live2d'
import { useEventListener } from '@vueuse/core'
import { onMounted, onScopeDispose, watch } from 'vue'

import { framesAgree, isArtWidthSaturated, scaleForMargins } from './stage-frame-geometry'

/**
 * Gaps the character keeps from the window edge.
 *
 * The fixed part keeps the drawn edge off the border; the shares are what holds
 * the pose inside it. The character breathes, so its painted silhouette moves —
 * measured over half a minute, this model's left edge travelled nineteen pixels
 * on a character five hundred wide. A fixed gap is crossed by that movement once
 * the character is large enough, which is why the margins grow with the character
 * and the character may then take the whole room between them.
 */
export const STAGE_FRAME_MARGINS: StageFrameMargins = { side: 8, top: 10, bottom: 6, sideShare: 0.03, topShare: 0.02 }

/** A resize settles before the character is re-measured; dragging emits many. */
const RESIZE_DEBOUNCE = 120
const MODEL_SETTLE_DELAY = 90
const SCALE_APPLY_DELAY = 90

/** How long the canvas is given to repaint after a scale change. */
const STAGE_SETTLE_TIMEOUT = 600
const STAGE_SETTLE_INTERVAL = 40

/**
 * How long to wait for the canvas to paint a change, and how often to look.
 *
 * This is a counter read, not a measurement, so asking often costs nothing: the
 * renderer reports how many frames it has drawn, and one that has not moved means
 * the window is occluded and nothing is being painted at all. Every correction
 * waits on it, because a measurement taken from a canvas that did not repaint
 * describes the size from before the change — acting on that is what walked the
 * character down to a speck.
 */
const PAINT_WAIT = 700
const PAINT_POLL = 30

/**
 * How a cut character is brought back into view.
 *
 * Steps are solved from the margins rather than fixed, so each one takes off a
 * few percent and the walk back in is over in a handful of frames. The floor is
 * what keeps an intermittent measurement from walking the character down to
 * nothing: a recovery can never take more than this share of the size it started
 * from, however many rounds it is given.
 */
const MAX_RECOVER_STEPS = 8
const MIN_RECOVERED_SHARE = 0.4

/** A recovery step smaller than this is not progress; stop instead of spinning. */
const MIN_RECOVER_STEP = 0.005

/**
 * The target sits exactly on the margins.
 *
 * It used to stop five percent short of them, because a fixed gap cannot hold a
 * silhouette that breathes. The margins grow with the character now, so the pose
 * is held by the margin itself and the last five percent of size is the
 * character's to keep.
 */
export const FIT_SAFETY = 1

/** A correction this small is not worth another round trip. */
const SCALE_TOLERANCE = 0.01

/**
 * How far the size may sit from the target before a dragged frame is corrected.
 *
 * Wider than `SCALE_TOLERANCE` because this runs on every frame of a drag: the
 * painted bounds move by a pixel or two on their own, and following that would
 * make the character breathe while the user holds the edge.
 */
const TRACK_TOLERANCE = 0.015

/** Bound on corrections per resize; each one is absolute, so one is typical. */
const MAX_CORRECTIONS = 2

/** How long to keep asking for a character that is still loading, and how often. */
const MODEL_LOAD_RETRY = 500
const MAX_LOAD_RETRIES = 40

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
  /** Pending per-frame correction while the window is being dragged. */
  let tracking: number | undefined
  /** Invalidates corrections that a newer resize has overtaken. */
  let generation = 0
  /** Runs spent waiting for a model that has not been painted yet. */
  let loadRetries = 0
  /**
   * The last correction the canvas has not painted yet.
   *
   * A window that is hidden or covered stops painting, and a model transform that
   * never lands leaves the canvas on the size from before as well. Either way the
   * next measurement still describes the old size, solving from it asks for the
   * same correction again, and the round after that asks again: the character
   * walks downwards for as long as it lasts. While the canvas owes a repaint,
   * nothing is corrected.
   */
  let awaitingPaint: { artWidth: number } | undefined
  /** The frame count at the last correction, where the surface reports one. */
  let paintedAt: number | undefined

  /** True once the canvas has painted something new since the last correction. */
  function paintCaughtUp(frame: StageFrame) {
    // The renderer counts the frames it draws, which answers this exactly: a
    // window that is not painting keeps handing back the same count however much
    // time passes, and no frame it produces can be told apart from the old one.
    const painted = getStageFrameCount()
    if (painted !== undefined) {
      if (paintedAt === undefined || painted !== paintedAt) {
        paintedAt = undefined
        return true
      }

      return false
    }

    if (!awaitingPaint)
      return true

    // A cut character is painted to the window edge, so its bounds cannot move
    // however the scale changed; that is not evidence either way.
    if (isArtWidthSaturated(frame))
      return true

    if (Math.abs(frame.art.width - awaitingPaint.artWidth) > Math.max(1, awaitingPaint.artWidth * 0.005)) {
      awaitingPaint = undefined
      return true
    }

    return false
  }

  /** Records a correction whose repaint the next measurement has to show. */
  function rememberApply(frame: StageFrame) {
    const painted = getStageFrameCount()
    if (painted !== undefined) {
      paintedAt = painted
      return
    }

    awaitingPaint = { artWidth: frame.art.width }
  }

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

  /**
   * The character once two measurements agree on it.
   *
   * Everything below decides a size from one measurement, so it must not be a
   * frame caught mid repaint. Re-reading costs about a millisecond.
   */
  async function readStableFrame(stopped?: () => boolean) {
    let frame = readFrame()

    for (let attempt = 0; frame && attempt < 3; attempt++) {
      await wait(MODEL_SETTLE_DELAY)
      if (stopped?.())
        return undefined

      const next = readFrame()
      if (!next)
        return undefined
      if (framesAgree(frame, next))
        return next

      frame = next
    }

    return frame
  }

  /**
   * Waits for the canvas to paint a frame counted after `since`.
   *
   * The renderer reports how many frames it has drawn. A window that is hidden or
   * covered stops drawing, and every measurement then describes the frame it
   * stopped on: the character reads as cut however small it is made, and a
   * correction taken from it steps down again and again. Reading a counter costs
   * nothing, so this is asked before any decision that follows a change.
   */
  async function waitForPaint(since: number | undefined, timeout = PAINT_WAIT) {
    if (since === undefined)
      return true

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await wait(PAINT_POLL)
      const now = getStageFrameCount()
      if (now === undefined || now !== since)
        return true
    }

    return false
  }

  /** Sets the user scale, and reports whether the canvas painted it. */
  async function applyScale(value: number) {
    const painted = getStageFrameCount()
    viewControl.set('scale', value)
    return waitForPaint(painted)
  }

  /**
   * The character as painted after the user scale was just changed.
   *
   * The store holds the new scale immediately, but the canvas repaints a frame
   * or two later, so a measurement taken straight away describes the size the
   * character had *before* the change. Reading that as the result makes the next
   * round repeat the correction, which is how a resize used to take a little off
   * the character every time it was measured.
   *
   * The frame counter answers this exactly. Where a surface does not report one,
   * the painted bounds stand in for it: they move with the scale unless the
   * character is cut, in which case the top edge still does.
   */
  async function frameAfterApply(before: StageFrame, scale: number) {
    const painted = getStageFrameCount()
    const expected = before.art.width * (scale / before.scale)
    const threshold = Math.max(1, Math.abs(expected - before.art.width) * 0.4)
    const moved = (frame: StageFrame | undefined) => Boolean(frame) && (
      Math.abs(frame!.art.width - before.art.width) >= threshold
      || Math.abs(frame!.art.y - before.art.y) >= 2
    )

    const deadline = Date.now() + STAGE_SETTLE_TIMEOUT

    await wait(SCALE_APPLY_DELAY)

    let frame = readFrame()
    while (Date.now() < deadline) {
      if (painted !== undefined) {
        if (getStageFrameCount() !== painted) {
          // The counter moved, so what is on screen is the size the change asked
          // for — measure *that*, not the frame read before it. Handing back the
          // earlier one describes the size from before the change, and the round
          // after it corrects for a size that no longer exists.
          await wait(SCALE_APPLY_DELAY)
          return readFrame()
        }
      }
      else if (moved(frame)) {
        return frame
      }

      await wait(STAGE_SETTLE_INTERVAL)
      frame = readFrame()
    }

    // The canvas never painted the change, so the frame it left behind still
    // describes the old size: solving from it asks for the same correction again,
    // and again, walking the character down while it lasts. Say so instead.
    return undefined
  }

  /**
   * Walks a cut character back into view.
   *
   * A cut character cannot be measured — its bounds read as the window edge — so
   * its real size is unknown. What the bounds do say is the direction, and the
   * margin arithmetic answers with a step of a few percent even from them: the
   * character is at least as large as the window, so it may keep only the room the
   * margins leave. Repeating that reaches a measurable size quickly, without the
   * fifth-of-its-size jump a fixed step made, and the floor below stops it from
   * ever going far.
   */
  async function recover(frame: StageFrame, stopped?: () => boolean) {
    const floor = currentScale() * MIN_RECOVERED_SHARE
    let current: StageFrame | undefined = frame

    for (let step = 0; current && isArtWidthSaturated(current) && step < MAX_RECOVER_STEPS; step++) {
      if (stopped?.())
        return undefined

      const before = current
      const scale = currentScale()
      const target = Math.max(floor, fitScale(current))

      if (!(scale - target > scale * MIN_RECOVER_STEP))
        break

      // A step the canvas never painted leaves the next measurement describing the
      // size from before it, and another step taken from that walks the character
      // down for as long as the window stays unpainted.
      if (!await applyScale(target))
        return undefined

      current = await frameAfterApply(before, target)
    }

    return current && !isArtWidthSaturated(current) ? current : undefined
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

    let frame = await readStableFrame(stopped)
    if (!frame) {
      // The model is read out of storage and decoded after the stage mounts.
      // Giving up here keeps whatever scale the last window left behind, so a
      // character that closed small comes back small and stays small.
      if (loadRetries++ < MAX_LOAD_RETRIES)
        schedule(MODEL_LOAD_RETRY)
      return
    }

    loadRetries = 0

    if (!paintCaughtUp(frame))
      return

    // A cut character cannot be measured — its bounds read as the window edge —
    // so it is brought back into view before any size is taken from it.
    if (isArtWidthSaturated(frame)) {
      const recovered = await recover(frame, stopped)
      if (!recovered || stopped()) {
        return
      }
      frame = recovered
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
      if (!isArtWidthSaturated(frame) && off <= SCALE_TOLERANCE) {
        return
      }

      rememberApply(frame)
      if (!await applyScale(target) || stopped()) {
        return
      }

      const settled = await frameAfterApply(frame, target)
      if (!settled || stopped())
        return

      if (!paintCaughtUp(settled))
        return

      frame = settled
      if (isArtWidthSaturated(frame)) {
        const recovered = await recover(frame, stopped)
        if (!recovered || stopped())
          return
        frame = recovered
      }
    }

    // The last round can end on a frame measured mid-repaint, which reads the
    // character as smaller than it is and asks for a size that cuts it. Being
    // left cut must never happen, so it is checked once more.
    const final = readFrame()
    if (final && isArtWidthSaturated(final)) {
      const recovered = await recover(final, stopped)
      if (!recovered || stopped())
        return

      const target = fitScale(recovered)
      const current = currentScale()
      if (Number.isFinite(target) && target > 0 && Math.abs(target - current) / current > SCALE_TOLERANCE)
        await applyScale(target)
    }
  }
  /**
   * Moves the character with the frame the window is dragged through.
   *
   * Waiting for the drag to pause lets the stage re-frame the model on its own:
   * the character drifts out of the window and is cut, then jumps back once the
   * user stops, one jump per waypoint. A measurement costs about a millisecond,
   * so the size the frame asks for is set on every dragged frame instead.
   *
   * The canvas paints a frame or two behind the store, and a frame that still
   * shows the size from before the last correction solves to a slightly smaller
   * size than the one just set. Following that reads as the character shrinking
   * on its own, so a frame that has not moved since the last correction is
   * skipped and the next one is used.
   */
  function track() {
    if (options.suspended?.())
      return

    const frame = readFrame()
    if (!frame)
      return

    if (!paintCaughtUp(frame))
      return

    const target = fitScale(frame)
    const current = currentScale()
    if (!Number.isFinite(target) || target <= 0)
      return

    if (Math.abs(target - current) / current <= TRACK_TOLERANCE)
      return

    rememberApply(frame)
    viewControl.set('scale', target)
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

  useEventListener('resize', () => {
    // One correction per painted frame, however many resize events arrive.
    if (tracking === undefined) {
      tracking = requestAnimationFrame(() => {
        tracking = undefined
        track()
      })
    }

    // The full solve waits until the drag stops, so a hundred resize events
    // produce one converging correction instead of a hundred of them.
    schedule()
  })

  onMounted(() => {
    // The stage mounts with the window, and a model may still be loading. The
    // first run also repairs a scale left behind by a window of another size.
    schedule(RESIZE_DEBOUNCE * 2)
  })

  onScopeDispose(() => {
    generation++
    if (timer)
      clearTimeout(timer)
    if (tracking !== undefined)
      cancelAnimationFrame(tracking)
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
