import type { Rectangle } from 'electron'
import type { InjectionKey, Ref } from 'vue'

import type { DisplayArea } from '../../../../shared/utils/electron/display'

import { inject } from 'vue'

import { findDominantDisplayArea } from '../../../../shared/utils/electron/display'

/** A corner of the AIRI window where the Controls Island can dock. */
export type ControlsIslandDock = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** Inputs for the Controls Island quadrant policy. */
export interface ResolveControlsIslandDockOptions {
  /** Available displays in Electron logical coordinates. */
  displays: readonly DisplayArea[]
  /** Dock that remains active while display data is missing or the window is near the display center. */
  previousDock: ControlsIslandDock
  /** AIRI window bounds in Electron logical coordinates. Zero width or height means that the bounds are not available. */
  windowBounds: Rectangle
}

/**
 * Half-width of the center band that prevents repeated flips near an axis.
 *
 * A window parked near the display center flips corners on every small move,
 * and each flip is a fade out, a corner change and a fade in. The band is a
 * tenth of the work area, so the window has to be clearly inside a quadrant
 * before the Island follows it there, and the same band has to be crossed back
 * before it returns.
 */
const displayCenterDeadZoneRatio = 0.1

/**
 * Resolves the window corner in the same quadrant as its display position.
 *
 * The screen geometry stays in Electron logical coordinates. The returned
 * dock contains no DOM coordinates, so display scaling cannot affect layout.
 */
export function resolveControlsIslandDock(options: ResolveControlsIslandDockOptions): ControlsIslandDock {
  if (options.windowBounds.width <= 0 || options.windowBounds.height <= 0) {
    return options.previousDock
  }

  const display = findDominantDisplayArea(options.windowBounds, options.displays)
  if (!display) {
    return options.previousDock
  }

  const windowCenterX = options.windowBounds.x + options.windowBounds.width / 2
  const windowCenterY = options.windowBounds.y + options.windowBounds.height / 2
  const displayCenterX = display.workArea.x + display.workArea.width / 2
  const displayCenterY = display.workArea.y + display.workArea.height / 2
  const horizontalDeadZone = display.workArea.width * displayCenterDeadZoneRatio
  const verticalDeadZone = display.workArea.height * displayCenterDeadZoneRatio

  let horizontalDock: 'left' | 'right' = options.previousDock.endsWith('left') ? 'left' : 'right'
  let verticalDock: 'top' | 'bottom' = options.previousDock.startsWith('top') ? 'top' : 'bottom'

  if (windowCenterX < displayCenterX - horizontalDeadZone) {
    horizontalDock = 'left'
  }
  else if (windowCenterX > displayCenterX + horizontalDeadZone) {
    horizontalDock = 'right'
  }

  if (windowCenterY < displayCenterY - verticalDeadZone) {
    verticalDock = 'top'
  }
  else if (windowCenterY > displayCenterY + verticalDeadZone) {
    verticalDock = 'bottom'
  }

  if (verticalDock === 'top') {
    return horizontalDock === 'left' ? 'top-left' : 'top-right'
  }

  return horizontalDock === 'left' ? 'bottom-left' : 'bottom-right'
}

/** Visual phase for a Controls Island corner change. */
export type ControlsIslandMotionPhase = 'idle' | 'leaving' | 'entering' | 'arriving'

/** Placement state shared by the Controls Island and its anchored surfaces. */
export interface ControlsIslandPlacement {
  /** Current corner inside the AIRI window. */
  dock: Readonly<Ref<ControlsIslandDock>>
  /** True when the Island uses the left edge of the AIRI window. */
  isLeft: Readonly<Ref<boolean>>
  /** True when the Island uses the top edge of the AIRI window. */
  isTop: Readonly<Ref<boolean>>
  /** Current phase of the fade and move animation. */
  motionPhase: Readonly<Ref<ControlsIslandMotionPhase>>
}

/** Placement contract provided by the Controls Island root. */
export const controlsIslandPlacementKey: InjectionKey<ControlsIslandPlacement> = Symbol('controls-island-placement')

/** Returns the placement from the nearest Controls Island root. */
export function useControlsIslandPlacement(): ControlsIslandPlacement {
  const placement = inject(controlsIslandPlacementKey)
  if (!placement) {
    throw new Error('useControlsIslandPlacement() requires a parent ControlsIslandRoot')
  }

  return placement
}
