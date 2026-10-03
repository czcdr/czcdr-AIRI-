import type { StageFrame, StageFrameMargins } from './stage-frame-geometry'

import { electron } from '@proj-airi/electron-eventa'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { getStageFrameCount, getStageViewport, measureStageArtBounds, useL2dViewControl } from '@proj-airi/stage-ui-live2d'
import { ref } from 'vue'

import { artCenterOffsetX, framesAgree, isArtWidthSaturated, scaleForMargins, wrappedWindowSize } from './stage-frame-geometry'
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

/** Share of its starting size a fit may leave a character it found whole. */
const RESTORE_SHARE = 0.97
/**
 * Share of the window a placement may be off by and still count as fitting.
 *
 * Wide enough to contain the pose: the margins are a share of the character, and
 * a window placed again for every pose would grow by that share on every click —
 * a fit that is used a few times would leave the character loose in a frame it
 * had already fitted.
 */
const BOUNDS_TOLERANCE_RATIO = 0.1

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
   *
   * Two readings that agree are not enough on their own: a window that is not
   * painting answers with the same frame every time, and that frame describes the
   * window from before the change — read as a character that spans the window, it
   * sent a whole recovery after a character that was never oversized. Each
   * reading therefore waits for a frame the renderer counted after the previous
   * one, which is the only evidence that what is measured is what is on screen.
   */
  async function readStableFrame() {
    let frame = await readPaintedFrame()
    if (!frame)
      return undefined

    for (let attempt = 0; frame && attempt < 3; attempt++) {
      const next = await readPaintedFrame()
      if (!next)
        return undefined
      if (framesAgree(frame, next))
        return next

      frame = next
    }

    return frame
  }

  /** A measurement taken from a frame the canvas painted after `since`. */
  async function readPaintedFrame(since: number | undefined = getStageFrameCount()) {
    if (since === undefined)
      return readFrame()

    const deadline = Date.now() + STAGE_SETTLE_TIMEOUT
    while (Date.now() < deadline) {
      if (getStageFrameCount() !== since)
        return readFrame()

      await wait(STAGE_SETTLE_INTERVAL)
    }

    return undefined
  }

  /**
   * The character as painted after the user scale was just changed.
   *
   * The store holds the new scale immediately, but the canvas repaints a frame
   * or two later, so a measurement taken straight away describes the size the
   * character had *before* the change. Reading that as the result makes the next
   * round repeat the correction, and the fit used to walk the character down a
   * little on every round because of it.
   *
   * The frame the renderer counts answers this exactly. Where a surface does not
   * report one, the painted bounds stand in: they move with the scale unless the
   * character is cut, in which case its head still does.
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

    await wait(MODEL_SETTLE_DELAY)

    let frame = readFrame()
    while (Date.now() < deadline) {
      if (painted !== undefined) {
        if (getStageFrameCount() !== painted) {
          // The counter moved, so the frame on screen is the one the change asked
          // for — measure *that*, not the one read before it. Returning the earlier
          // frame hands the caller the size from before the change, and the next
          // round corrects for a size that no longer exists.
          await wait(MODEL_SETTLE_DELAY)
          return readFrame()
        }
      }
      else if (moved(frame)) {
        return frame
      }

      await wait(STAGE_SETTLE_INTERVAL)
      frame = readFrame()
    }

    // The canvas never painted the change, so the frame it left behind describes
    // the size from before it. Deciding from that asks for the same correction
    // again, which is how a fit collapsed a character to a quarter of its size.
    return undefined
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

    for (let step = 0; current && isArtWidthSaturated(current) && step < MAX_RECOVER_STEPS; step++) {
      const before = current
      const scale = currentScale()
      const target = Math.max(floor, scaleForMargins(current, margins) * FIT_SAFETY)

      if (!(scale - target > scale * MIN_RECOVER_STEP))
        break

      await applyScale(target)
      current = await frameAfterApply(before, target)
    }

    return current && !isArtWidthSaturated(current) ? current : undefined
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
      const wasClipped = isArtWidthSaturated(initial)
      const visible = wasClipped ? await reveal(initial) : initial
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

        if (isArtWidthSaturated(current)) {
          // A cut character cannot be measured, so the step comes from the margins
          // instead: a few percent at a time, never below the floor. The round
          // after it reaches the exact size again.
          const scale = Math.max(currentScale() * MIN_RECOVERED_SHARE, scaleForMargins(current, margins) * FIT_SAFETY)
          await applyScale(scale)
          if (!await frameAfterApply(current, scale))
            break
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
          if (!await frameAfterApply(current, scale))
            break
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
      // exists for. The check asks twice for the reason every other decision here
      // asks twice: one frame caught mid repaint reads as a cut character, and
      // acting on that walks the size down to the floor of a recovery — a whole
      // fit's worth of shrinking for a window that was only late to paint.
      const settled = await readStableFrame()
      if (settled && isArtWidthSaturated(settled))
        await reveal(settled)

      // The promise a fit makes: the character it found whole is the size it
      // leaves behind. It wraps the window around the character, so a character
      // that comes out smaller means a round read the pose as a size — and the
      // next click would read that smaller size and take a little more off it,
      // which is how a button that is meant to fit a window made one shrink.
      if (!wasClipped) {
        const after = await readStableFrame()
        if (after && after.art.width < artWidth * RESTORE_SHARE) {
          await applyScale(after.scale * (artWidth / after.art.width))
          await wait(MODEL_SETTLE_DELAY)
        }
      }

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
