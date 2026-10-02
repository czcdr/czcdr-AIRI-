import type { StageFrame, StageFrameMargins } from './stage-frame-geometry'

import { electron } from '@proj-airi/electron-eventa'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { getStageViewport, measureStageArtBounds, useL2dViewControl } from '@proj-airi/stage-ui-live2d'
import { ref } from 'vue'

import { artCenterOffsetX, isArtClipped, wrappedWindowSize } from './stage-frame-geometry'
import { FIT_SAFETY, STAGE_FRAME_MARGINS } from './use-proportional-stage-scale'

/**
 * Smallest window the desktop app is allowed to shrink to.
 *
 * Mirrors `MAIN_WINDOW_MIN_WIDTH`/`MAIN_WINDOW_MIN_HEIGHT` in
 * `src/main/windows/main/index.ts`. The window manager clamps anything smaller,
 * so asking for less would leave the fit working from a size the window never
 * took 鈥?which is how a fit used to end with the character against an edge.
 */
const MIN_WINDOW_WIDTH = 240
const MIN_WINDOW_HEIGHT = 200

/**
 * Corrections below these thresholds are not worth another round trip.
 *
 * The character keeps moving while the fit runs, and its painted width swings by
 * a few percent with the pose, so a tighter bound than the pose itself would
 * never be reached and the fit would spend every round chasing the animation.
 */
const SCALE_TOLERANCE = 0.025
const POSITION_TOLERANCE = 2
const BOUNDS_TOLERANCE = 8

/** Bound on measurement rounds; each one is absolute, so one is typical. */
const MAX_PASSES = 8

/** Size taken off a cut character inside a pass, small enough to keep its size. */
const CLIP_STEP = 0.97

/** Step used while a cut-off character is scaled back into view. */
const SHRINK_STEP = 0.8
const MAX_SHRINK_STEPS = 8

const STAGE_SETTLE_TIMEOUT = 900
const STAGE_SETTLE_INTERVAL = 40
const MODEL_SETTLE_DELAY = 90

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Fits the desktop window around the character currently on the stage.
 *
 * The stage frames a model on its own terms: bottom-anchored, upper body, and
 * twice the viewport height at `scale == 1`. An imported model therefore usually
 * leaves a band of empty window above it, or is drawn wider than the window and
 * loses a wing to the frame. This measures the painted pixels instead and chooses
 * the window size, the model scale and the window position together:
 *
 * - a character drawn past the window edge is scaled down until it is fully visible,
 * - the window is sized to the visible character plus a small margin,
 * - the character keeps the pixel size it already had, so it does not jump, and
 * - the window moves so the character stays where it is on screen.
 *
 * A cut character cannot be measured: its bounds read as the window edge. That
 * case is resolved first, so every size used below comes from a character that is
 * fully on screen. Each round sets an absolute size for the window that is
 * measured, so a round that reads a stale frame pays for one more round instead
 * of leaving an error behind.
 */
export function useFitStageToWindow(options: { margins?: StageFrameMargins } = {}) {
  const getBounds = useElectronEventaInvoke(electron.window.getBounds)
  const setBounds = useElectronEventaInvoke(electron.window.setBounds)
  const viewControl = useL2dViewControl()
  const margins = options.margins ?? STAGE_FRAME_MARGINS
  const fitting = ref(false)

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

  async function applyScale(value: number) {
    viewControl.set('scale', value)
  }

  /**
   * The character as painted after the user scale was just changed.
   *
   * The store holds the new scale immediately, but the canvas repaints a frame
   * or two later, so a measurement taken straight away describes the size the
   * character had *before* the change. Reading that as the result makes the next
   * round repeat the correction, and the fit used to walk the character down a
   * little on every round because of it.
   */
  async function frameAfterApply(before: StageFrame, scale: number) {
    const expected = before.art.width * (scale / before.scale)
    const threshold = Math.max(1, Math.abs(expected - before.art.width) * 0.5)
    const deadline = Date.now() + STAGE_SETTLE_TIMEOUT

    await wait(MODEL_SETTLE_DELAY)

    let frame = readFrame()
    while (Date.now() < deadline) {
      if (frame && Math.abs(frame.art.width - before.art.width) >= threshold)
        return frame

      await wait(STAGE_SETTLE_INTERVAL)
      frame = readFrame()
    }

    return frame
  }

  /**
   * Scales the character until it is fully visible.
   *
   * A cut character cannot be measured, so its real size is unknown and the first
   * steps only have to be safe. Scaling down by a fixed step reaches a state that
   * can be measured; the rounds after that set their target from the measurement
   * itself and do not depend on the steps that led there.
   */
  async function reveal(frame: StageFrame) {
    let current: StageFrame | undefined = frame

    for (let step = 0; current && isArtClipped(current) && step < MAX_SHRINK_STEPS; step++) {
      const before = current
      const scale = currentScale() * SHRINK_STEP
      await applyScale(scale)
      current = await frameAfterApply(before, scale)
    }

    return current && !isArtClipped(current) ? current : undefined
  }

  /** Waits until the stage repaints at the size the window was just given. */
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

  /** Keeps a window of this size inside the work area. */
  function clampIntoWorkArea(bounds: Bounds): Bounds {
    // Chromium reports the work area origin, but the DOM types predate that.
    const { availLeft = 0, availTop = 0, availWidth, availHeight } = window.screen as Screen & { availLeft?: number, availTop?: number }
    const maxX = availLeft + availWidth - bounds.width
    const maxY = availTop + availHeight - bounds.height

    return {
      ...bounds,
      x: Math.round(Math.min(Math.max(bounds.x, availLeft), Math.max(availLeft, maxX))),
      y: Math.round(Math.min(Math.max(bounds.y, availTop), Math.max(availTop, maxY))),
    }
  }

  function place(art: { centerScreenX: number, bottomScreenY: number }, frame: StageFrame, size: { width: number, height: number }): Bounds {
    return clampIntoWorkArea({
      x: Math.round(art.centerScreenX - size.width / 2 - artCenterOffsetX(frame)),
      y: Math.round(art.bottomScreenY - size.height),
      width: size.width,
      height: size.height,
    })
  }

  async function fit() {
    if (fitting.value)
      return false

    const initial = readFrame()
    if (!initial) {
      return false
    }

    fitting.value = true

    try {
      // Step 1: whatever is cut off has to fit before it can be measured.
      const visible = isArtClipped(initial) ? await reveal(initial) : initial
      if (!visible) {
        return false
      }

      const before = await getBounds()
      if (!before || !before.width) {
        return false
      }

      // Step 2: the character keeps where it is on screen. The stage anchors the
      // model to the bottom centre of the window, so holding the bottom edge and
      // the character's screen centre holds the character itself.
      const art = {
        centerScreenX: before.x + visible.art.x + visible.art.width / 2,
        bottomScreenY: before.y + before.height,
      }
      const artWidth = visible.art.width

      // Step 3: keep the character's pixel size, wrap the window around it, and
      // hold its place on screen. A resize re-frames the model, which changes both
      // the size and the offset from the window centre, so each pass measures the
      // character it is about to wrap.
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const current = readFrame()
        if (!current)
          break

        if (isArtClipped(current)) {
          // A cut character cannot be measured, so the size comes down by a step
          // small enough to keep it recognisable; the next round reaches the exact
          // size again. Larger steps would throw most of the size away.
          const scale = current.scale * CLIP_STEP
          await applyScale(scale)
          await frameAfterApply(current, scale)
          continue
        }

        const bounds = await getBounds()
        if (!bounds || !bounds.width)
          break

        const wrapped = wrappedWindowSize(current, margins, FIT_SAFETY)
        const target = place(art, current, {
          width: Math.max(MIN_WINDOW_WIDTH, Math.round(wrapped.width)),
          height: Math.max(MIN_WINDOW_HEIGHT, Math.round(wrapped.height)),
        })

        const sizeFix = artWidth / current.art.width
        const sizeOk = !Number.isFinite(sizeFix) || Math.abs(sizeFix - 1) <= SCALE_TOLERANCE
        const boundsOk = Math.abs(bounds.x - target.x) <= POSITION_TOLERANCE
          && Math.abs(bounds.y - target.y) <= POSITION_TOLERANCE
          && Math.abs(bounds.width - target.width) <= BOUNDS_TOLERANCE
          && Math.abs(bounds.height - target.height) <= BOUNDS_TOLERANCE

        if (sizeOk && boundsOk)
          break

        // The size is corrected first: the window wrap is measured from it.
        if (!sizeOk) {
          const scale = current.scale * sizeFix
          await applyScale(scale)
          await frameAfterApply(current, scale)
          continue
        }

        await setBounds([target])
        await waitForStageSize(target.width, target.height)
        await wait(MODEL_SETTLE_DELAY)
      }

      // A fit that ends with the character cut off has failed at the one thing it
      // exists for, and a correction can land there when a measurement was read
      // before the stage repainted. Settle it before returning.
      const settled = readFrame()
      if (settled && isArtClipped(settled))
        await reveal(settled)

      return true
    }
    finally {
      fitting.value = false
    }
  }

  return {
    /** True while a fit is running, so the control that starts one can show progress. */
    fitting,
    fit,
  }
}
