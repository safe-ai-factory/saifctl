'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AnimationKey, MascotState } from './types';

/** States where a random "what next?" timer may run (excludes one-shot idles). */
type TimerEligibleState = 'WALKING_LEFT' | 'WALKING_RIGHT' | 'IDLE_SPIN';

const STATE_TO_ANIMATION: Record<MascotState, AnimationKey> = {
  IDLE_SPIN: 'idle_spin',
  IDLE_JUMP: 'idle_jump',
  IDLE_BOOP: 'idle_boop',
  IDLE_CROUCH: 'idle_crouch',
  IDLE_DESTROY: 'idle_explode',
  WALKING_LEFT: 'walk_flipped',
  WALKING_RIGHT: 'walk',
  // Takeoff: landing animation played in reverse (launching upward feel).
  JUMPING_TAKEOFF_LEFT: 'jump_start_flipped',
  JUMPING_TAKEOFF_RIGHT: 'jump_start',
  JUMPING_TAKEOFF_UP: 'jump_start',
  // Airborne: freefall loop while in the air.
  JUMPING_AIRBORNE_LEFT: 'falling_flipped',
  JUMPING_AIRBORNE_RIGHT: 'falling',
  JUMPING_AIRBORNE_UP: 'falling',
  GRAB_TRANSITION: 'drag_start_grab',
  DRAGGED_CALM: 'drag_idle_calm',
  DRAGGED_SWING: 'drag_idle_swing',
  RELEASE_TRANSITION: 'drag_stop_release',
  FALLING: 'falling',
  // LAND_TRANSITION animation is set dynamically based on facing direction (see enterLandTransition).
  LAND_TRANSITION: 'landing',
};

const TIMER_STATES = new Set<TimerEligibleState>(['WALKING_LEFT', 'WALKING_RIGHT', 'IDLE_SPIN']);

/** Weighted pool for the autonomous timer; higher weight means more likely to be chosen. */
const BEHAVIOUR_WEIGHTS: Array<{
  state: TimerEligibleState | 'IDLE_JUMP' | 'IDLE_BOOP' | 'IDLE_CROUCH';
  weight: number;
}> = [
  { state: 'WALKING_RIGHT', weight: 0.25 },
  { state: 'WALKING_LEFT', weight: 0.25 },
  { state: 'IDLE_SPIN', weight: 0.15 },
  { state: 'IDLE_JUMP', weight: 0.12 },
  { state: 'IDLE_BOOP', weight: 0.12 },
  { state: 'IDLE_CROUCH', weight: 0.11 },
];

function prefersReducedMotionNow(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function pickNextState(current: MascotState): MascotState {
  // Slightly "sticky" walks so direction changes feel less jittery than pure random.
  if (current === 'WALKING_LEFT' && Math.random() < 0.35) return 'WALKING_LEFT';
  if (current === 'WALKING_RIGHT' && Math.random() < 0.35) return 'WALKING_RIGHT';

  const pool = prefersReducedMotionNow()
    ? BEHAVIOUR_WEIGHTS.filter((b) => b.state !== 'IDLE_SPIN' && b.state !== 'IDLE_JUMP')
    : BEHAVIOUR_WEIGHTS;

  const total = pool.reduce((s, b) => s + b.weight, 0);
  let r = Math.random() * total;
  for (const b of pool) {
    r -= b.weight;
    if (r <= 0) return b.state;
  }
  return pool.some((b) => b.state === 'WALKING_RIGHT') ? 'WALKING_RIGHT' : 'WALKING_LEFT';
}

const DECISION_INTERVAL_MIN = 3000;
const DECISION_INTERVAL_MAX = 8000;

function randomInterval() {
  return DECISION_INTERVAL_MIN + Math.random() * (DECISION_INTERVAL_MAX - DECISION_INTERVAL_MIN);
}

/**
 * Mascot behaviour as a small FSM.
 *
 * Jump sequence (user-triggered):
 *   WALKING_* / IDLE_* → JUMPING_TAKEOFF_* (landing reversed, one-shot)
 *                       → JUMPING_AIRBORNE_* (falling loop, physics-driven)
 *                       → LAND_TRANSITION (landing forward, one-shot)
 *                       → WALKING_* / IDLE_*
 *
 * Multi-jump: re-entering any JUMPING_TAKEOFF_* while already airborne restarts the
 * takeoff clip and physics applies a new upward impulse — no state guard needed.
 */
export function useMascotFSM(options?: {
  /** Returns true when the character is within the landing trigger zone. Used to short-circuit RELEASE_TRANSITION. */
  isNearFloor?: () => boolean;
}) {
  const isNearFloorRef = useRef(options?.isNearFloor ?? (() => false));
  isNearFloorRef.current = options?.isNearFloor ?? (() => false);
  const [animationKey, setAnimationKey] = useState<AnimationKey>('walk');
  const [jumpSeq, setJumpSeq] = useState(0);
  const stateRef = useRef<MascotState>('WALKING_RIGHT');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Tracks the last horizontal facing so LAND_TRANSITION uses the correct mirrored animation. */
  const facingLeftRef = useRef(false);

  const enterState = useCallback((next: MascotState) => {
    console.log('[Mascot] state:', next, '→ anim:', STATE_TO_ANIMATION[next]);
    stateRef.current = next;
    if (next === 'WALKING_LEFT') facingLeftRef.current = true;
    else if (next === 'WALKING_RIGHT') facingLeftRef.current = false;
    setAnimationKey(STATE_TO_ANIMATION[next]);
  }, []);

  /** Enter LAND_TRANSITION with the correct facing animation. */
  const enterLandTransition = useCallback(() => {
    const anim = facingLeftRef.current ? 'landing_flipped' : 'landing';
    console.log('[Mascot] state: LAND_TRANSITION → anim:', anim);
    stateRef.current = 'LAND_TRANSITION';
    setAnimationKey(anim);
  }, []);

  /** After a delay, pick a new behaviour if still in a timer-eligible state; chain if result stays eligible. */
  const scheduleAutonomous = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const s = stateRef.current;
    if (!TIMER_STATES.has(s as TimerEligibleState)) return;

    timerRef.current = setTimeout(() => {
      const cur = stateRef.current;
      if (!TIMER_STATES.has(cur as TimerEligibleState)) return;
      enterState(pickNextState(cur));
      const next = stateRef.current;
      if (TIMER_STATES.has(next as TimerEligibleState)) {
        scheduleAutonomous();
      }
    }, randomInterval());
  }, [enterState]);

  /** Fired by the sprite renderer when a non-looping clip finishes. */
  const onAnimationComplete = useCallback(() => {
    const s = stateRef.current;

    if (s === 'IDLE_JUMP' || s === 'IDLE_BOOP' || s === 'IDLE_CROUCH' || s === 'IDLE_DESTROY') {
      enterState(pickNextState(s));
      const next = stateRef.current;
      if (TIMER_STATES.has(next as TimerEligibleState)) scheduleAutonomous();
    } else if (s === 'JUMPING_TAKEOFF_LEFT') {
      enterState('JUMPING_AIRBORNE_LEFT');
    } else if (s === 'JUMPING_TAKEOFF_RIGHT') {
      enterState('JUMPING_AIRBORNE_RIGHT');
    } else if (s === 'JUMPING_TAKEOFF_UP') {
      enterState('JUMPING_AIRBORNE_UP');
    } else if (s === 'GRAB_TRANSITION') {
      enterState('DRAGGED_CALM');
    } else if (s === 'RELEASE_TRANSITION') {
      facingLeftRef.current = false;
      // If we're already in the landing zone by the time the release anim finishes, skip falling.
      if (isNearFloorRef.current()) {
        enterLandTransition();
      } else {
        enterState('FALLING');
      }
    } else if (s === 'LAND_TRANSITION') {
      enterState(pickNextState(s));
      const next = stateRef.current;
      if (TIMER_STATES.has(next as TimerEligibleState)) scheduleAutonomous();
    }
  }, [enterState, scheduleAutonomous]);

  /** Physics clamped at viewport edge: flip walk direction and reset the autonomous timer. */
  const onWallHit = useCallback(
    (side: 'left' | 'right') => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const next = side === 'left' ? 'WALKING_RIGHT' : 'WALKING_LEFT';
      facingLeftRef.current = next === 'WALKING_LEFT';
      enterState(next);
      scheduleAutonomous();
    },
    [enterState, scheduleAutonomous],
  );

  /**
   * User spacebar: enter takeoff phase (plays landing in reverse).
   * Multi-jump is supported — each press restarts the takeoff clip and re-applies
   * the upward impulse via physics (no guard on whether we're already airborne).
   */
  const onJump = useCallback(() => {
    const s = stateRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);

    if (s === 'WALKING_LEFT' || s === 'JUMPING_TAKEOFF_LEFT' || s === 'JUMPING_AIRBORNE_LEFT') {
      facingLeftRef.current = true;
      enterState('JUMPING_TAKEOFF_LEFT');
    } else if (
      s === 'WALKING_RIGHT' ||
      s === 'JUMPING_TAKEOFF_RIGHT' ||
      s === 'JUMPING_AIRBORNE_RIGHT'
    ) {
      facingLeftRef.current = false;
      enterState('JUMPING_TAKEOFF_RIGHT');
    } else {
      // Keep previous facing for straight-up jumps.
      enterState('JUMPING_TAKEOFF_UP');
    }
    setJumpSeq((n) => n + 1);
  }, [enterState]);

  /** Physics reports first frame back on the floor after being airborne. */
  const onLand = useCallback(() => {
    const s = stateRef.current;
    if (
      s === 'JUMPING_AIRBORNE_LEFT' ||
      s === 'JUMPING_AIRBORNE_RIGHT' ||
      s === 'JUMPING_AIRBORNE_UP' ||
      s === 'JUMPING_TAKEOFF_LEFT' ||
      s === 'JUMPING_TAKEOFF_RIGHT' ||
      s === 'JUMPING_TAKEOFF_UP' ||
      s === 'FALLING' ||
      // Dropped from low height: release animation still playing when floor is hit.
      s === 'RELEASE_TRANSITION'
    ) {
      enterLandTransition();
    }
  }, [enterLandTransition]);

  const onGrab = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    enterState('GRAB_TRANSITION');
  }, [enterState]);

  const onRelease = useCallback(() => {
    enterState('RELEASE_TRANSITION');
  }, [enterState]);

  const onDragSwing = useCallback(() => {
    enterState('DRAGGED_SWING');
  }, [enterState]);

  const onDragCalm = useCallback(() => {
    enterState('DRAGGED_CALM');
  }, [enterState]);

  /**
   * Easter egg: 5 quick taps on the mascot. Returns true if destroy started (caller should skip drag).
   */
  const onDestroy = useCallback((): boolean => {
    const s = stateRef.current;
    if (
      s === 'IDLE_DESTROY' ||
      s === 'GRAB_TRANSITION' ||
      s === 'DRAGGED_CALM' ||
      s === 'DRAGGED_SWING' ||
      s === 'RELEASE_TRANSITION' ||
      s === 'FALLING' ||
      s === 'LAND_TRANSITION'
    ) {
      return false;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    enterState('IDLE_DESTROY');
    return true;
  }, [enterState]);

  useEffect(() => {
    // Initial walk + first scheduled decision; cleanup clears pending timeouts (e.g. Strict Mode).
    enterState('WALKING_RIGHT');
    scheduleAutonomous();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enterState, scheduleAutonomous]);

  return {
    stateRef,
    animationKey,
    jumpSeq,
    onAnimationComplete,
    onWallHit,
    onJump,
    onLand,
    onGrab,
    onRelease,
    onDragSwing,
    onDragCalm,
    onDestroy,
  };
}
