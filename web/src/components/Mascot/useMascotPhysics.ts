'use client';

import { useEffect, useRef } from 'react';

import type { MascotState } from './types';

/** Display size of the mascot canvas (sprite is scaled from 256×256 source). */
export const CHAR_W = 96;
export const CHAR_H = 96;

/** Horizontal delta per animation frame (~60fps); tuned for "Game Boy pace", not real m/s. */
export const WALK_SPEED = 1.5;
/** Upward kick on jump: negative vy because screen Y grows downward. */
export const JUMP_STRENGTH = 12;
/** Added to vy each frame while airborne; with ~60fps rAF this approximates a fall curve. */
export const GRAVITY = 0.5;
/**
 * How many px above the real floor the landing animation is triggered.
 * The character keeps falling physically during the animation; only the FSM event fires early.
 * Tune this so the landing squash frame lines up with the feet touching ground.
 */
export const LAND_TRIGGER_OFFSET = 150;

export interface PhysicsState {
  x: number;
  y: number;
  vy: number;
  onGround: boolean;
}

export interface UseMascotPhysicsResult {
  physicsRef: React.RefObject<PhysicsState>;
  jumpRef: React.RefObject<(() => void) | null>;
  /** When true, physics tick skips walk/gravity/floor (position driven by drag). */
  dragRef: React.RefObject<boolean>;
}

/**
 * Viewport physics: horizontal walk/jump drift, vertical gravity and landing.
 * Reads `stateRef` each frame; calls `onLand` once per fall when the character
 * descends into the landing trigger zone (LAND_TRIGGER_OFFSET px above the real floor).
 * The character continues to fall physically after onLand fires — it stops at the real floor.
 */
export function useMascotPhysics(options: {
  stateRef: React.RefObject<MascotState>;
  onWallHit: (side: 'left' | 'right') => void;
  onLand: () => void;
}): UseMascotPhysicsResult {
  const { stateRef } = options;
  // Latest wall callback without putting it in the effect deps (avoids restarting rAF).
  const onWallHitRef = useRef(options.onWallHit);
  onWallHitRef.current = options.onWallHit;
  const onLandRef = useRef(options.onLand);
  onLandRef.current = options.onLand;

  const physicsRef = useRef<PhysicsState>({
    x: 200,
    y: 0,
    vy: 0,
    onGround: true,
  });

  const jumpRef = useRef<(() => void) | null>(null);
  const dragRef = useRef(false);

  useEffect(() => {
    jumpRef.current = () => {
      // Impulse from spacebar: leave the floor branch below so gravity + integration run.
      physicsRef.current.vy = -JUMP_STRENGTH;
      physicsRef.current.onGround = false;
    };
    return () => {
      jumpRef.current = null;
    };
  }, []);

  useEffect(() => {
    let rafId = 0;

    const onResize = () => {
      const maxX = Math.max(0, window.innerWidth - CHAR_W);
      const newFloor = window.innerHeight - CHAR_H;
      if (physicsRef.current.x > maxX) {
        physicsRef.current.x = maxX;
      }
      if (physicsRef.current.onGround) {
        physicsRef.current.y = newFloor;
      }
    };

    window.addEventListener('resize', onResize, { passive: true });

    // Tracks whether onLand has already fired for the current airborne session so the
    // early trigger fires exactly once per fall, even if the character lingers in the zone.
    let landFired = false;
    // Remembers the last horizontal direction so LAND_TRANSITION keeps that momentum.
    let lastHorizState: 'left' | 'right' | 'none' = 'none';

    const tick = () => {
      if (dragRef.current) {
        // Reset so the next drop always gets a fresh trigger.
        landFired = false;
        rafId = requestAnimationFrame(tick);
        return;
      }

      const state = stateRef.current;
      // Top of sprite when feet sit on the bottom of the viewport (fixed canvas, y = top-left).
      const floor = window.innerHeight - CHAR_H;
      // Early animation trigger: LAND_TRIGGER_OFFSET px above the real floor.
      const landTrigger = floor - LAND_TRIGGER_OFFSET;

      // Update lastHorizState from explicit directional states so LAND_TRANSITION can inherit it.
      if (
        state === 'WALKING_RIGHT' ||
        state === 'JUMPING_TAKEOFF_RIGHT' ||
        state === 'JUMPING_AIRBORNE_RIGHT'
      ) {
        lastHorizState = 'right';
      } else if (
        state === 'WALKING_LEFT' ||
        state === 'JUMPING_TAKEOFF_LEFT' ||
        state === 'JUMPING_AIRBORNE_LEFT'
      ) {
        lastHorizState = 'left';
      }

      const movingRight =
        state === 'WALKING_RIGHT' ||
        state === 'JUMPING_TAKEOFF_RIGHT' ||
        state === 'JUMPING_AIRBORNE_RIGHT' ||
        (state === 'LAND_TRANSITION' && lastHorizState === 'right');
      const movingLeft =
        state === 'WALKING_LEFT' ||
        state === 'JUMPING_TAKEOFF_LEFT' ||
        state === 'JUMPING_AIRBORNE_LEFT' ||
        (state === 'LAND_TRANSITION' && lastHorizState === 'left');

      if (movingRight) {
        const nextX = physicsRef.current.x + WALK_SPEED;
        if (nextX + CHAR_W >= window.innerWidth) {
          // Pin to the right edge; don’t let x drift past the viewport.
          physicsRef.current.x = Math.max(0, window.innerWidth - CHAR_W);
          // Flip FSM only when walking: mid-jump we clamp silently so we don’t swap anim on a wall tap.
          if (state === 'WALKING_RIGHT') onWallHitRef.current('right');
        } else {
          physicsRef.current.x = nextX;
        }
      } else if (movingLeft) {
        const nextX = physicsRef.current.x - WALK_SPEED;
        if (nextX <= 0) {
          physicsRef.current.x = 0;
          if (state === 'WALKING_LEFT') onWallHitRef.current('left');
        } else {
          physicsRef.current.x = nextX;
        }
      }

      if (physicsRef.current.onGround && physicsRef.current.vy === 0) {
        // Settled on floor: skip gravity, reset trigger for the next jump/drop.
        physicsRef.current.y = floor;
        landFired = false;
      } else {
        // Euler step.
        physicsRef.current.vy += GRAVITY;
        physicsRef.current.y += physicsRef.current.vy;

        // Reset the trigger while ascending so each descent gets a fresh fire.
        if (physicsRef.current.vy < 0) {
          landFired = false;
        }

        // Fire onLand early while descending into the trigger zone.
        if (!landFired && physicsRef.current.vy > 0 && physicsRef.current.y >= landTrigger) {
          landFired = true;
          onLandRef.current();
        }
      }

      // Real floor clamp: character stops here regardless of when the animation triggered.
      if (physicsRef.current.y >= floor) {
        physicsRef.current.y = floor;
        physicsRef.current.vy = 0;
        physicsRef.current.onGround = true;
      } else {
        physicsRef.current.onGround = false;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
    };
  }, [stateRef]);

  return { physicsRef, jumpRef, dragRef };
}
