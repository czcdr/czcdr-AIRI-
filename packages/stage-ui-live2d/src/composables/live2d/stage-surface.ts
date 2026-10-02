/**
 * Publishes the painted Live2D stage so features that live outside the stage
 * (window sizing, diagnostics) can measure what is actually on screen.
 *
 * The stage canvas is created with `preserveDrawingBuffer`, so reading it back
 * is valid at any time. Nothing here needs a render call or a captured frame,
 * which is what lets a caller measure mid-animation without stopping it.
 */

export interface StageSurface {
  /** The Pixi canvas that paints the stage. */
  canvas: HTMLCanvasElement
  /** Canvas pixels per CSS pixel: the stage renders at `settings/live2d/render-scale`. */
  resolution: number
}

export interface StageSurfaceViewport {
  /** Stage width in CSS pixels, which equals the window content width. */
  width: number
  /** Stage height in CSS pixels, which equals the window content height. */
  height: number
}

export interface StageArtBounds {
  /** Left edge of the drawn model, in CSS pixels from the stage's left edge. */
  x: number
  /** Top edge of the drawn model, in CSS pixels from the stage's top edge. */
  y: number
  width: number
  height: number
}

let surface: StageSurface | undefined

export function publishStageSurface(value: StageSurface | undefined) {
  surface = value
}

/** Releases the surface only when it still belongs to the canvas being torn down. */
export function releaseStageSurface(canvas: HTMLCanvasElement | undefined) {
  if (canvas && surface?.canvas !== canvas)
    return

  surface = undefined
}

export function getStageSurface() {
  return surface
}

export function getStageViewport(value: StageSurface | undefined = surface): StageSurfaceViewport | undefined {
  if (!value)
    return undefined

  const scale = resolveResolution(value)

  return {
    width: value.canvas.width / scale,
    height: value.canvas.height / scale,
  }
}

function resolveResolution(value: StageSurface) {
  return value.resolution > 0 ? value.resolution : 1
}

/**
 * Bounds of the pixels the stage actually painted, in CSS pixels.
 *
 * Reading the canvas covers everything the user can see — model, filters,
 * shadows — where the model's own geometry would report the full canvas frame
 * and a shadow or a wing that leaves the frame would be missed. `alphaThreshold`
 * keeps the faint drop shadow from widening the measurement.
 *
 * Returns `undefined` when nothing was painted, so callers can leave the stage
 * alone instead of fitting a window around an empty frame.
 */
export function measureStageArtBounds(options?: {
  alphaThreshold?: number
  surface?: StageSurface
}): StageArtBounds | undefined {
  const value = options?.surface ?? surface
  if (!value)
    return undefined

  const { canvas } = value
  if (!canvas.width || !canvas.height)
    return undefined

  const scale = resolveResolution(value)
  const width = Math.max(1, Math.round(canvas.width / scale))
  const height = Math.max(1, Math.round(canvas.height / scale))
  const alphaThreshold = options?.alphaThreshold ?? 40

  const scratch = document.createElement('canvas')
  scratch.width = width
  scratch.height = height

  const context = scratch.getContext('2d', { willReadFrequently: true })
  if (!context)
    return undefined

  try {
    context.drawImage(canvas, 0, 0, width, height)
  }
  catch (error) {
    console.warn('[Live2D] Could not read the stage canvas for measurement.', error)
    return undefined
  }

  const { data } = context.getImageData(0, 0, width, height)

  let left = width
  let top = height
  let right = -1
  let bottom = -1

  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] <= alphaThreshold)
        continue

      if (x < left)
        left = x
      if (x > right)
        right = x
      if (y < top)
        top = y
      if (y > bottom)
        bottom = y
    }
  }

  if (right < 0 || bottom < 0)
    return undefined

  return {
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1,
  }
}
