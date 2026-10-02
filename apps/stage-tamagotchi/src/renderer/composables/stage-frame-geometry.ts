/**
 * Geometry of the character inside the stage window.
 *
 * The stage anchors a model to the bottom centre of the window and draws it at
 * `normalized.scale × userScale`, where `normalized.scale` follows the window
 * and the user scale is a plain multiplier on top of it. Every painted pixel
 * therefore sits on a line through that anchor: raising the user scale to `k`
 * times its current value moves the art `k` times as far from the anchor.
 *
 * A single measurement of the painted bounds therefore describes the character
 * at *every* user scale for that window, which is what makes an absolute target
 * possible. The previous implementation compared each measurement with the one
 * before it and applied the difference; a stage that had already re-framed the
 * model between the two moved the goalposts, and the error accumulated on every
 * resize. Nothing below looks at an earlier frame.
 *
 * Two edges need care:
 *
 * - The character is cut by the bottom edge on purpose, so the measured height
 *   is the visible height and never the size of the character. Only the left,
 *   top and right edges can be cut by a window that is too small, and only those
 *   are checked.
 * - A cut edge cannot be measured: the bounds read as the window edge instead of
 *   the character. Callers must reach an uncut frame before trusting a target,
 *   which is what `isArtClipped` is for.
 */

export interface StageArtBounds {
  /** Left edge of the drawn character, in CSS pixels from the stage's left edge. */
  x: number
  /** Top edge of the drawn character, in CSS pixels from the stage's top edge. */
  y: number
  /** Width of the drawn character, in CSS pixels. */
  width: number
  /**
   * Painted pixels down to the bottom of the stage.
   *
   * The stage cuts the character at the bottom edge on purpose, so this is the
   * visible height, not the size of the character. Never use it as a size.
   */
  height: number
}

/** Gaps the character keeps from the window edges, in CSS pixels. */
export interface StageFrameMargins {
  /** Gap on the left and right edges. */
  side: number
  /** Gap on the top edge. */
  top: number
  /** Extra height below the cut line, so the window is not flush with it. */
  bottom: number
}

/** One measurement of the window and the character painted inside it. */
export interface StageFrame {
  /** Stage width in CSS pixels, which equals the window content width. */
  width: number
  /** Stage height in CSS pixels, which equals the window content height. */
  height: number
  /** The user scale the bounds were measured at. */
  scale: number
  art: StageArtBounds
}

/** A painted pixel this close to an edge counts as cut off by that edge. */
export const ART_CLIP_EPSILON = 2

/** Growth ratios below this are treated as "already where it should be". */
export const SCALE_TOLERANCE = 0.01

/**
 * True when two measurements describe the same painted character.
 *
 * The canvas paints a frame or two behind whatever changed it, so a frame caught
 * mid repaint describes neither the size before nor the size after. A decision
 * taken from one of those asks for a size the character never had: it is how a
 * window fit ended up wrapping a character that was briefly measured small, which
 * is what made repeated fits shrink it a little at a time.
 */
export function framesAgree(a: StageFrame, b: StageFrame, tolerance = 0.03) {
  return Math.abs(a.width - b.width) <= 1
    && Math.abs(a.height - b.height) <= 1
    && Math.abs(a.art.width - b.art.width) <= Math.max(2, a.art.width * tolerance)
    && Math.abs(a.art.y - b.art.y) <= Math.max(2, a.art.width * tolerance)
}

/**
 * True when the window cuts the character on the left, top or right edge.
 *
 * The bottom edge is where the stage always cuts the character, so it is not a
 * cut in this sense and is not reported.
 */
export function isArtClipped(frame: StageFrame, epsilon = ART_CLIP_EPSILON): boolean {
  const { art, width } = frame

  return art.x <= epsilon
    || art.y <= epsilon
    || art.x + art.width >= width - epsilon
}

/**
 * How much the user scale may still grow before the character reaches a margin.
 *
 * `1` means the character already touches a margin, a value below `1` means it
 * overflows and has to shrink, and a value far above `1` means there is room to
 * grow. The result is a ratio, so it applies to the scale the frame was measured
 * at and does not depend on how the character reached that scale.
 *
 * Every constraint is linear in the user scale because all painted pixels move
 * on lines through the bottom centre anchor, so the tightest one is the answer.
 */
export function growthToMargins(frame: StageFrame, margins: StageFrameMargins): number {
  const { width, height, art } = frame
  const anchorX = width / 2
  const roomSide = anchorX - margins.side
  const roomTop = height - margins.top
  const limits: number[] = []

  // Left edge: moving away from the anchor, the art's left side heads for 0.
  const spanLeft = anchorX - art.x
  if (spanLeft > 0)
    limits.push(roomSide / spanLeft)

  // Right edge.
  const spanRight = art.x + art.width - anchorX
  if (spanRight > 0)
    limits.push(roomSide / spanRight)

  // Top edge: the character is anchored at the bottom, so growing lifts the head.
  const spanTop = height - art.y
  if (spanTop > 0)
    limits.push(roomTop / spanTop)

  if (!limits.length)
    return Number.POSITIVE_INFINITY

  return Math.min(...limits)
}

/**
 * The user scale that puts the character exactly on the margins.
 *
 * Returned unclamped: the caller owns the range the scale is allowed to take and
 * knows whether a target above it should be capped or refused.
 */
export function scaleForMargins(frame: StageFrame, margins: StageFrameMargins): number {
  const growth = growthToMargins(frame, margins)
  if (!Number.isFinite(growth) || growth <= 0)
    return frame.scale

  return frame.scale * growth
}

/** Height of the character the user can see, from the head to the cut line. */
export function artVisibleHeight(frame: StageFrame): number {
  return Math.max(0, frame.height - frame.art.y)
}

/** Distance from the window centre to the middle of the character, in CSS pixels. */
export function artCenterOffsetX(frame: StageFrame): number {
  return (frame.art.x + frame.art.width / 2) - frame.width / 2
}

/**
 * Window size that wraps the character with the margins.
 *
 * The character keeps the pixel size it has in `frame`: the window is sized
 * around it instead of the character being resized to the window. Only the
 * visible part of the character is wrapped; the stage cuts the rest at the
 * bottom edge wherever that edge happens to be.
 *
 * `fill` is how much of the room the character is meant to take, and it is what
 * makes the wrapped window the same window the resize path settles on: a
 * character that keeps `fill` of the room keeps `fill` of the room after the
 * window is placed around it, so the two never correct each other.
 *
 * A character painted off the anchor leaves less room on one side than on the
 * other, and the resize path can only use what the tighter side allows, so the
 * offset is taken off the room here as well.
 */
export function wrappedWindowSize(
  frame: StageFrame,
  margins: StageFrameMargins,
  fill = 1,
): { width: number, height: number } {
  const share = fill > 0 && fill <= 1 ? fill : 1
  const offCentre = Math.abs(artCenterOffsetX(frame))

  return {
    width: frame.art.width / share + offCentre * 2 + margins.side * 2,
    height: artVisibleHeight(frame) / share + margins.top + margins.bottom,
  }
}
