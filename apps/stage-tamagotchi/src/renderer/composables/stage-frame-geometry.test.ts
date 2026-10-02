import type { StageFrame, StageFrameMargins } from './stage-frame-geometry'

import { describe, expect, it } from 'vitest'

import {
  artCenterOffsetX,
  artVisibleHeight,
  framesAgree,
  growthToMargins,
  isArtClipped,
  scaleForMargins,
  wrappedWindowSize,
} from './stage-frame-geometry'

const margins: StageFrameMargins = { side: 10, top: 12, bottom: 6 }

/** Bounds read off the running app: a window the character fits in. */
const fitted: StageFrame = {
  width: 340,
  height: 280,
  scale: 0.80454,
  art: { x: 47, y: 74, width: 228, height: 206 },
}

/** The same character in a window narrow enough to cut both sides. */
const cutSideways: StageFrame = {
  width: 420,
  height: 620,
  scale: 0.82835,
  art: { x: 0, y: 164, width: 420, height: 456 },
}

/** A synthetic frame with the character centred on the anchor. */
const centered: StageFrame = {
  width: 400,
  height: 300,
  scale: 1,
  art: { x: 100, y: 100, width: 200, height: 200 },
}

/**
 * The frame the stage paints after the user scale changes by `ratio`.
 *
 * Every painted pixel moves on a line through the bottom centre anchor, which is
 * the property every target here rests on. Tests apply it so a frame stays
 * consistent with its own bounds instead of only changing its scale field.
 */
function applyScale(frame: StageFrame, ratio: number): StageFrame {
  const anchorX = frame.width / 2
  const anchorY = frame.height
  const left = anchorX + (frame.art.x - anchorX) * ratio
  const right = anchorX + (frame.art.x + frame.art.width - anchorX) * ratio
  const top = anchorY + (frame.art.y - anchorY) * ratio

  return {
    ...frame,
    scale: frame.scale * ratio,
    art: { x: left, y: top, width: right - left, height: anchorY - top },
  }
}

describe('isArtClipped', () => {
  it('does not report the bottom cut the stage always makes', () => {
    // The art reaches the bottom edge in every one of these frames.
    expect(isArtClipped(fitted)).toBe(false)
    expect(isArtClipped(centered)).toBe(false)
  })

  it('reports a window that cuts the sides', () => {
    expect(isArtClipped(cutSideways)).toBe(true)
  })

  it('reports a window that cuts the head off', () => {
    expect(isArtClipped({ ...centered, art: { ...centered.art, y: 0 } })).toBe(true)
  })

  it('reports a window that cuts one side only', () => {
    expect(isArtClipped({ ...centered, art: { ...centered.art, x: 0 } })).toBe(true)
    expect(isArtClipped({ ...centered, width: 260 })).toBe(true)
  })
})

describe('growthToMargins', () => {
  it('solves the tightest edge for an off-centre character', () => {
    // Left edge binds: (170 - 10) / (170 - 47).
    expect(growthToMargins(fitted, margins)).toBeCloseTo(160 / 123, 6)
  })

  it('solves the top edge when the sides have room', () => {
    expect(growthToMargins(centered, margins)).toBeCloseTo(1.44, 6)
  })

  it('asks for a shrink when the window cuts the character', () => {
    expect(growthToMargins(cutSideways, margins)).toBeLessThan(1)
  })

  it('reports a frame already on the margins as no growth', () => {
    const target = scaleForMargins(centered, margins)
    const onMargin = applyScale(centered, target / centered.scale)

    expect(growthToMargins(onMargin, margins)).toBeCloseTo(1, 6)
  })
})

describe('scaleForMargins', () => {
  it('lands the character on a margin in one step', () => {
    const target = scaleForMargins(fitted, margins)
    const grew = applyScale(fitted, target / fitted.scale)
    const { art } = grew

    // One of the three margins is reached exactly, none is passed.
    expect(Math.min(
      art.x - margins.side,
      fitted.width - margins.side - (art.x + art.width),
      art.y - margins.top,
    )).toBeCloseTo(0, 6)
    expect(art.x).toBeGreaterThanOrEqual(margins.side - 1e-6)
    expect(art.x + art.width).toBeLessThanOrEqual(fitted.width - margins.side + 1e-6)
    expect(growthToMargins(grew, margins)).toBeCloseTo(1, 6)
    expect(isArtClipped(grew)).toBe(false)
  })

  it('does not depend on the scale the frame was measured at', () => {
    // The same character, measured halfway through a drag: the absolute target
    // is the same, which is what keeps repeated resizes from drifting.
    const early = scaleForMargins(fitted, margins)
    const late = scaleForMargins({ ...fitted, scale: fitted.scale * 1.37 }, margins)

    expect(late / 1.37).toBeCloseTo(early, 6)
  })

  it('shrinks a cut character into view', () => {
    expect(scaleForMargins(cutSideways, margins)).toBeLessThan(cutSideways.scale)
  })
})

describe('artVisibleHeight and artCenterOffsetX', () => {
  it('measures from the head to the cut line', () => {
    expect(artVisibleHeight(fitted)).toBe(206)
  })

  it('measures the character against the window centre', () => {
    expect(artCenterOffsetX(fitted)).toBeCloseTo(161 - 170, 6)
  })
})

describe('framesAgree', () => {
  it('accepts the same character measured twice', () => {
    expect(framesAgree(fitted, { ...fitted })).toBe(true)
  })

  it('accepts the pose moving a couple of percent between measurements', () => {
    const posed: StageFrame = { ...fitted, art: { ...fitted.art, width: fitted.art.width * 1.02 } }

    expect(framesAgree(fitted, posed)).toBe(true)
  })

  it('rejects a frame measured while the character was still small', () => {
    const midRepaint: StageFrame = { ...fitted, art: { ...fitted.art, width: fitted.art.width * 0.8 } }

    expect(framesAgree(fitted, midRepaint)).toBe(false)
  })

  it('rejects a frame from a canvas that has not resized yet', () => {
    const stale: StageFrame = { ...fitted, width: fitted.width - 40 }

    expect(framesAgree(fitted, stale)).toBe(false)
  })
})

describe('wrappedWindowSize', () => {
  it('wraps the visible character with the margins', () => {
    // The character sits nine pixels left of the anchor, so one side of the room
    // is worth eighteen fewer pixels than the other.
    expect(wrappedWindowSize(fitted, margins)).toEqual({ width: 266, height: 224 })
  })

  it('leaves the character its share of room when the window is wrapped', () => {
    // The resize path keeps the character at a share of the room below the
    // margins; a window placed around the character has to leave the same share
    // or the two corrections would take turns shrinking it.
    const fill = 0.95
    const wrapped = wrappedWindowSize(fitted, margins, fill)
    const room = wrapped.width - margins.side * 2 - Math.abs(artCenterOffsetX(fitted)) * 2

    expect(room).toBeCloseTo(fitted.art.width / fill, 6)
    expect(fitted.art.width / room).toBeCloseTo(fill, 6)
  })
})
