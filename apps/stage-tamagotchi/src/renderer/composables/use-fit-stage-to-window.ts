import { electron } from '@proj-airi/electron-eventa'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { getStageSurface, getStageViewport, measureStageArtBounds, useL2dViewControl } from '@proj-airi/stage-ui-live2d'
import { ref } from 'vue'

/**
 * Gap between the character and the window edge, in CSS pixels. The stage anchors
 * the character to the bottom edge, where it is cut on purpose, so the bottom
 * margin only keeps the drawn edge off the window border.
 */
const MARGIN_SIDE = 10
const MARGIN_TOP = 12
const MARGIN_BOTTOM = 6

/** Smallest window the desktop app is allowed to shrink to. */
const MIN_WINDOW_SIZE = 120

/** A painted pixel this close to the stage edge counts as cut off. */
const CLIP_EPSILON = 2

/** Corrections below these thresholds are not worth another round trip. */
const SCALE_TOLERANCE = 0.008
const POSITION_TOLERANCE = 2

/** Bound on measurement rounds; each one shrinks or grows towards the target. */
const MAX_PASSES = 6

/** Step used while a cut-off character is scaled back into view. */
const SHRINK_STEP = 0.75
const MAX_SHRINK_PASSES = 8

const STAGE_SETTLE_TIMEOUT = 900
const STAGE_SETTLE_INTERVAL = 40
const SCALE_APPLY_DELAY = 160

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

interface ArtMeasurement {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  /** The character reaches a stage edge, so its real size is larger than measured. */
  clipped: boolean
  /**
   * Distance from the stage centre to the painted centre, in CSS pixels.
   *
   * The stage anchors a model to the bottom centre of the window, so a character
   * whose artwork sits off-centre keeps that offset: it is the same in every
   * window while the model scale does not change. A window only as wide as the
   * character plus margins would therefore cut the tighter side off.
   */
  offsetFromCenterX: number
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
 * - a character drawn past the stage edge is scaled down until it is fully visible,
 * - the window is sized to the character plus a small margin,
 * - the character keeps the pixel size it already had, so it does not jump, and
 * - the window moves so the character stays where it is on screen.
 *
 * A cut-off character cannot be measured: its bounds read as the stage itself.
 * That case is resolved first, so every size used below comes from a character
 * that is fully on screen.
 */
export function useFitStageToWindow() {
  const getBounds = useElectronEventaInvoke(electron.window.getBounds)
  const setBounds = useElectronEventaInvoke(electron.window.setBounds)
  const viewControl = useL2dViewControl()
  const fitting = ref(false)

  function measure(): ArtMeasurement | undefined {
    const surface = getStageSurface()
    const viewport = getStageViewport(surface)
    const art = measureStageArtBounds()
    if (!viewport || !art)
      return undefined

    return {
      ...art,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      clipped: art.x <= CLIP_EPSILON
        || art.y <= CLIP_EPSILON
        || art.x + art.width >= viewport.width - CLIP_EPSILON,
      offsetFromCenterX: (art.x + art.width / 2) - viewport.width / 2,
    }
  }

  /** Width the character may fill without coming closer than the margins allow. */
  function allowedArtWidth(measurement: ArtMeasurement) {
    return measurement.viewportWidth - MARGIN_SIDE * 2 - Math.abs(measurement.offsetFromCenterX) * 2
  }

  function applyScale(factor: number) {
    viewControl.set('scale', viewControl.scale.value * factor)
  }

  /**
   * Scales the character until it is fully visible.
   *
   * A cut-off character cannot be measured: its bounds read as the stage itself,
   * so the real size is unknown and the first steps only have to be safe. Scaling
   * down by a fixed step reaches a state that can be measured, and from there the
   * exact scale that just fits follows from the ratio the visible area allows.
   */
  async function revealCharacter(initial: ArtMeasurement) {
    if (!initial.clipped)
      return initial

    let current = initial
    for (let pass = 0; current.clipped && pass < MAX_SHRINK_PASSES; pass++) {
      applyScale(SHRINK_STEP)
      await wait(SCALE_APPLY_DELAY)

      const next = measure()
      if (!next)
        return undefined

      current = next
    }

    if (current.clipped)
      return undefined

    // The painted size is proportional to the user scale while the window stays
    // the same, so one ratio lands on the largest character that still fits.
    const allowedWidth = allowedArtWidth(current)
    const allowedHeight = current.viewportHeight - MARGIN_TOP - MARGIN_BOTTOM
    const grow = Math.min(allowedWidth / current.width, allowedHeight / current.height)

    if (Number.isFinite(grow) && Math.abs(grow - 1) > SCALE_TOLERANCE) {
      applyScale(grow)
      await wait(SCALE_APPLY_DELAY)

      const next = measure()
      if (next && !next.clipped) {
        current = next
      }
      else {
        // A pose that grew or a stage that framed differently: keep the last
        // state that was known to be fully visible.
        applyScale(0.97)
        await wait(SCALE_APPLY_DELAY)
        current = measure() ?? current
      }
    }

    return current
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

  async function fit() {
    if (fitting.value)
      return false

    const initial = measure()
    if (!initial)
      return false

    fitting.value = true

    try {
      // Step 1: whatever is cut off has to fit before it can be measured.
      const visible = await revealCharacter(initial)
      if (!visible)
        return false

      const before = await getBounds()
      if (!before || !before.width)
        return false

      // Step 2: size the window to the character. The stage anchors the character
      // to the bottom centre, so while the character keeps its pixel size it also
      // keeps its offset from that anchor; both are measured here and reused.
      const offsetFromCenterX = (visible.x + visible.width / 2) - visible.viewportWidth / 2
      const offsetFromBottomY = (visible.y + visible.height) - visible.viewportHeight

      const artCenterScreenX = before.x + visible.x + visible.width / 2
      const artBottomScreenY = before.y + visible.y + visible.height

      const width = Math.max(MIN_WINDOW_SIZE, Math.round(visible.width + MARGIN_SIDE * 2 + Math.abs(offsetFromCenterX) * 2))
      const height = Math.max(MIN_WINDOW_SIZE, Math.round(visible.height + MARGIN_TOP + MARGIN_BOTTOM))

      await setBounds([clampIntoWorkArea({
        x: Math.round(artCenterScreenX - (width / 2 + offsetFromCenterX)),
        y: Math.round(artBottomScreenY - (height + offsetFromBottomY)),
        width,
        height,
      })])
      await waitForStageSize(width, height)

      // Step 3: a resize re-frames the model through the stage's own fit, so the
      // size and the position are re-measured and corrected instead of assumed.
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const current = measure()
        if (!current)
          break

        if (current.clipped) {
          const revealed = await revealCharacter(current)
          if (!revealed)
            break
          continue
        }

        const targetWidth = visible.width
        const sizeFix = targetWidth / current.width
        if (Number.isFinite(sizeFix) && Math.abs(sizeFix - 1) > SCALE_TOLERANCE) {
          // The window was sized for the character, so growing it back stays inside;
          // the cap only guards against a stale measurement.
          const maxFix = Math.min(
            allowedArtWidth(current) / current.width,
            (current.viewportHeight - MARGIN_TOP - MARGIN_BOTTOM) / current.height,
          )
          applyScale(sizeFix > 1 ? Math.min(sizeFix, maxFix) : sizeFix)
          await wait(SCALE_APPLY_DELAY)
          continue
        }

        const bounds = await getBounds()
        if (!bounds || !bounds.width)
          break

        const driftX = (bounds.x + current.x + current.width / 2) - artCenterScreenX
        const driftY = (bounds.y + current.y + current.height) - artBottomScreenY
        if (Math.abs(driftX) < POSITION_TOLERANCE && Math.abs(driftY) < POSITION_TOLERANCE)
          break

        await setBounds([clampIntoWorkArea({
          x: Math.round(bounds.x - driftX),
          y: Math.round(bounds.y - driftY),
          width: bounds.width,
          height: bounds.height,
        })])
        await waitForStageSize(bounds.width, bounds.height)
      }

      // A fit that ends with the character cut off has failed at the one thing it
      // exists for, and a scale correction can land there when a measurement was
      // read before the stage repainted. Settle it before returning.
      const settled = measure()
      if (settled?.clipped)
        await revealCharacter(settled)

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
