import type { StageFrame, StageFrameMargins } from './stage-frame-geometry'

import { electron } from '@proj-airi/electron-eventa'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { getStageViewport, measureStageArtBounds, useL2dViewControl } from '@proj-airi/stage-ui-live2d'
import { ref } from 'vue'

import { artCenterOffsetX, framesAgree, isArtClipped, scaleForMargins, wrappedWindowSize } from './stage-frame-geometry'
import { FIT_SAFETY, STAGE_FRAME_MARGINS } from './use-proportional-stage-scale'

/**
 * Smallest window the desktop app is allowed to shrink to.
 *
 * Mirrors `MAIN_WINDOW_MIN_WIDTH`/`MAIN_WINDOW_MIN_HEIGHT` in
 * `src/main/windows/main/index.ts`. The window manager clamps anything smaller,
 * so asking for less would leave the fit working from a size the window never
 * took — which is how a fit used to end with the character against an edge.
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
/**
 * How far the character may sit from where the fit would put it.
 *
 * The painted centre moves by several pixels with the pose, and acting on that
 * would place the window again on every click — and take the size with it.
 */
const POSITION_TOLERANCE = 4
const POSITION_TOLERANCE_RATIO = 0.015
const BOUNDS_TOLERANCE = 8
/** Share of the window a placement may be off by and still count as fitting. */
const BOUNDS_TOLERANCE_RATIO = 0.05

/** Bound on measurement rounds; each one is absolute, so one is typical. */
const MAX_PASSES = 8

/** Longest a fit may run before its control is handed back. */
const FIT_TIMEOUT = 20000

/** Step used while a cut-off character is scaled back into view. */
const MAX_RECOVER_STEPS = 8
const MIN_RECOVERED_SHARE = 0.4
const MIN_RECOVER_STEP = 0.005

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
   * The character once two measurements agree on it.
   *
   * A fit decides the window size from one measurement, so a frame caught mid
   * repaint would wrap a character that was never that small and leave it that
   * way. Re-reading costs about a millisecond.
   */
  async function readStableFrame() {
    let frame = readFrame()

    for (let attempt = 0; frame && attempt < 3; attempt++) {
      await wait(MODEL_SETTLE_DELAY)
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
   * The character as painted after the user scale was just changed.
   *
   * The store holds the new scale immediately, but the canvas repaints a frame
   * or two later, so a measurement taken straight away describes the size the
   * character had *before* the change. Reading that as the result makes the next
   * round repeat the correction, and the fit used to walk the character down a
   * little on every round because of it.
   */
  async function frameAfterApply(before: StageFrame, scale: number) {
    // A cut character is painted to the window edge, so its bounds cannot move
    // until it fits: waiting for them would burn the timeout on every step.
    if (isArtClipped(before)) {
      await wait(MODEL_SETTLE_DELAY)
      return readFrame()
    }

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
   * A cut character cannot be measured, so its real size is unknown. The step is
   * still solved from the margins rather than fixed: the character is at least as
   * large as the window, so it may keep only the room the margins leave, which is
   * a few percent at a time instead of the fifth of its size a fixed step took.
   * It can never go below the floor, so an odd measurement cannot shrink the
   * character away while the fit runs.
   */
  async function reveal(frame: StageFrame) {
    const floor = currentScale() * MIN_RECOVERED_SHARE
    let current: StageFrame | undefined = frame

    for (let step = 0; current && isArtClipped(current) && step < MAX_RECOVER_STEPS; step++) {
      const before = current
      const scale = currentScale()
      const target = Math.max(floor, scaleForMargins(current, margins) * FIT_SAFETY)

      if (!(scale - target > scale * MIN_RECOVER_STEP))
        break

      await applyScale(target)
      current = await frameAfterApply(before, target)
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

    const initial = await readStableFrame()
    if (!initial) {
      return false
    }

    fitting.value = true

    // The control that starts a fit is disabled while one runs, so a fit that
    // somehow never returns would leave the button unusable for the rest of the
    // session. The bound is far longer than a fit takes.
    const watchdog = setTimeout(() => {
      fitting.value = false
    }, FIT_TIMEOUT)

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
      // hold its place on screen.
      //
      // The window is placed once, and only the size is corrected after that.
      // Placing it again from the character as it looks after each correction
      // makes the two chase each other — the stage re-frames the model for the new
      // window, which changes the size, which asks for another correction — and a
      // fit used to walk the character a few percent down on every pass.
      let placed = false

      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const current = await readStableFrame()
        if (!current)
          break

        if (isArtClipped(current)) {
          // A cut character cannot be measured, so the step comes from the margins
          // instead: a few percent at a time, never below the floor. The round
          // after it reaches the exact size again.
          const scale = Math.max(currentScale() * MIN_RECOVERED_SHARE, scaleForMargins(current, margins) * FIT_SAFETY)
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
        // A window that already holds the character with its margins is left where
        // it is: the painted centre and size move by a few percent with the pose,
        // and placing the window again for every such reading — and again on the
        // next click — walks it a little further out each time.
        const wiggleX = Math.max(POSITION_TOLERANCE, target.width * POSITION_TOLERANCE_RATIO)
        const boundsOk = Math.abs(bounds.x - target.x) <= wiggleX
          && Math.abs(bounds.y - target.y) <= wiggleX
          && Math.abs(bounds.width - target.width) <= Math.max(BOUNDS_TOLERANCE, target.width * BOUNDS_TOLERANCE_RATIO)
          && Math.abs(bounds.height - target.height) <= Math.max(BOUNDS_TOLERANCE, target.height * BOUNDS_TOLERANCE_RATIO)

        if (sizeOk && boundsOk)
          break

        // The size comes first: the window was placed around the size it asks for.
        if (!sizeOk) {
          const scale = current.scale * sizeFix
          await applyScale(scale)
          await frameAfterApply(current, scale)
          continue
        }

        if (placed)
          break

        placed = true
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
      clearTimeout(watchdog)
      fitting.value = false
    }
  }

  return {
    /** True while a fit is running, so the control that starts one can show progress. */
    fitting,
    fit,
  }
}
