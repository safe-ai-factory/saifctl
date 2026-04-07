'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import manifestJson from './mascot-manifest.json';
import type { MascotManifest } from './types';
import { useMascotFSM } from './useMascotFSM';
import { CHAR_H, CHAR_W, LAND_TRIGGER_OFFSET, useMascotPhysics } from './useMascotPhysics';
import { useSpriteRenderer } from './useSpriteRenderer';

const manifest = manifestJson as MascotManifest;

/** Mouse speed (px/move event) above this promotes calm → swing while dragging. */
const DRAG_SWING_SPEED = 8;
/** Below this for 300ms promotes swing → calm while dragging. */
const DRAG_CALM_SPEED = 2;
const DRAG_CALM_DEBOUNCE_MS = 300;
/** Pointer must move at least this many px from the down position before drag is committed. */
const DRAG_THRESHOLD_PX = 6;
// Configure the anchor point here.
// E.g. { x: 0.75, y: 0 } means the anchor is 75% from the left and 0% from the top.
const DRAG_ANCHOR_RELATIVE = {
  x: 0.75,
  y: 0,
};

const DESTROY_CLICK_COUNT = 5;
const DESTROY_WINDOW_MS = 1500;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

// This defines the anchor point (where the cursor is when holding the mascot)
// relative to the mascot's hitbox. Starting from top-left.
function clampDragPosition(clientX: number, clientY: number) {
  const maxX = Math.max(0, window.innerWidth - CHAR_W);
  const maxY = Math.max(0, window.innerHeight - CHAR_H);

  return {
    x: Math.max(0, Math.min(maxX, clientX - CHAR_W * DRAG_ANCHOR_RELATIVE.x)),
    y: Math.max(0, Math.min(maxY, clientY - CHAR_H * DRAG_ANCHOR_RELATIVE.y)),
  };
}

export function Mascot() {
  const pathname = usePathname();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [hintVisible, setHintVisible] = useState(false);
  const [footerVisible, setFooterVisible] = useState(false);
  const footerVisibleRef = useRef(false);

  const isDraggingRef = useRef(false);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const swingCalmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const removeDocDragListenersRef = useRef<(() => void) | null>(null);
  const clickCountRef = useRef(0);
  const lastClickTimeRef = useRef(0);

  useEffect(() => {
    const img = new Image();
    img.src = '/mascot/mascot-sheet.png';
    img.onload = () => setImage(img);
    return () => {
      img.onload = null;
    };
  }, []);

  useEffect(() => {
    // Re-query the footer on every route change so the observer always
    // targets the current page's footer element after client-side navigation.
    const footer = document.querySelector('footer');
    if (!footer) {
      footerVisibleRef.current = false;
      setFooterVisible(false);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Don't hide while the user is dragging the mascot.
        if (!entry.isIntersecting && isDraggingRef.current) return;
        footerVisibleRef.current = entry.isIntersecting;
        setFooterVisible(entry.isIntersecting);
      },
      { threshold: 0.05 },
    );

    observer.observe(footer);
    return () => observer.disconnect();
  }, [pathname]);

  // Stable getter ref: populated after physicsRef exists, read lazily by the FSM.
  const isNearFloorRef = useRef<() => boolean>(() => false);

  const {
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
  } = useMascotFSM({ isNearFloor: () => isNearFloorRef.current() });

  const { physicsRef, jumpRef, dragRef } = useMascotPhysics({ stateRef, onWallHit, onLand });

  // Now physicsRef exists — wire the real implementation into the ref.
  isNearFloorRef.current = () => {
    const floor = window.innerHeight - CHAR_H;
    return physicsRef.current.y >= floor - LAND_TRIGGER_OFFSET;
  };

  const handleJump = useCallback(() => {
    if (isDraggingRef.current) return;
    jumpRef.current?.();
    onJump();
  }, [jumpRef, onJump]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (e.repeat) return;
      if (isTypingTarget(e.target)) return;
      if (isDraggingRef.current) return;
      if (!footerVisibleRef.current) return;
      e.preventDefault();
      handleJump();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleJump]);

  const onGrabRef = useRef(onGrab);
  const onDragSwingRef = useRef(onDragSwing);
  const onDragCalmRef = useRef(onDragCalm);
  const onReleaseRef = useRef(onRelease);
  onGrabRef.current = onGrab;
  onDragSwingRef.current = onDragSwing;
  onDragCalmRef.current = onDragCalm;
  onReleaseRef.current = onRelease;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      setHintVisible(e.clientY > window.innerHeight - 100);
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  useEffect(() => {
    return () => {
      removeDocDragListenersRef.current?.();
      removeDocDragListenersRef.current = null;
      if (swingCalmTimerRef.current) {
        clearTimeout(swingCalmTimerRef.current);
        swingCalmTimerRef.current = null;
      }
    };
  }, []);

  const tryDestroyEasterEgg = useCallback(() => {
    const now = Date.now();
    if (now - lastClickTimeRef.current > DESTROY_WINDOW_MS) {
      clickCountRef.current = 0;
    }
    lastClickTimeRef.current = now;
    clickCountRef.current += 1;
    if (clickCountRef.current >= DESTROY_CLICK_COUNT) {
      clickCountRef.current = 0;
      return onDestroy();
    }
    return false;
  }, [onDestroy]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (isDraggingRef.current) return;

      const pointerId = e.pointerId;
      const downX = e.clientX;
      const downY = e.clientY;
      let dragCommitted = false;

      const commitDrag = (clientX: number, clientY: number) => {
        if (dragCommitted) return;
        dragCommitted = true;
        isDraggingRef.current = true;
        lastMousePosRef.current = { x: clientX, y: clientY };
        const { x, y } = clampDragPosition(clientX, clientY);
        physicsRef.current.x = x;
        physicsRef.current.y = y;
        dragRef.current = true;
        onGrabRef.current();
      };

      const onDocMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;

        if (!dragCommitted) {
          // Commit to drag only once the pointer has moved enough to distinguish from a tap.
          const dist = Math.hypot(ev.clientX - downX, ev.clientY - downY);
          if (dist < DRAG_THRESHOLD_PX) return;
          commitDrag(ev.clientX, ev.clientY);
          return;
        }

        const dx = ev.clientX - lastMousePosRef.current.x;
        const dy = ev.clientY - lastMousePosRef.current.y;
        const speed = Math.hypot(dx, dy);
        lastMousePosRef.current = { x: ev.clientX, y: ev.clientY };

        const pos = clampDragPosition(ev.clientX, ev.clientY);
        physicsRef.current.x = pos.x;
        physicsRef.current.y = pos.y;

        const st = stateRef.current;
        if (st === 'DRAGGED_CALM' && speed > DRAG_SWING_SPEED) {
          if (swingCalmTimerRef.current) {
            clearTimeout(swingCalmTimerRef.current);
            swingCalmTimerRef.current = null;
          }
          onDragSwingRef.current();
        } else if (st === 'DRAGGED_SWING') {
          if (speed >= DRAG_CALM_SPEED) {
            if (swingCalmTimerRef.current) {
              clearTimeout(swingCalmTimerRef.current);
              swingCalmTimerRef.current = null;
            }
          } else if (!swingCalmTimerRef.current) {
            swingCalmTimerRef.current = setTimeout(() => {
              swingCalmTimerRef.current = null;
              if (stateRef.current === 'DRAGGED_SWING') {
                onDragCalmRef.current();
              }
            }, DRAG_CALM_DEBOUNCE_MS);
          }
        }
      };

      const endDrag = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        document.removeEventListener('pointermove', onDocMove);
        document.removeEventListener('pointerup', endDrag);
        document.removeEventListener('pointercancel', endDrag);
        removeDocDragListenersRef.current = null;

        if (!dragCommitted) {
          // Pointer released before drag threshold — treat as a click.
          tryDestroyEasterEgg();
          return;
        }

        isDraggingRef.current = false;
        physicsRef.current.vy = 2;
        physicsRef.current.onGround = false;
        dragRef.current = false;
        if (swingCalmTimerRef.current) {
          clearTimeout(swingCalmTimerRef.current);
          swingCalmTimerRef.current = null;
        }
        onReleaseRef.current();
      };

      document.addEventListener('pointermove', onDocMove);
      document.addEventListener('pointerup', endDrag);
      document.addEventListener('pointercancel', endDrag);

      removeDocDragListenersRef.current = () => {
        document.removeEventListener('pointermove', onDocMove);
        document.removeEventListener('pointerup', endDrag);
        document.removeEventListener('pointercancel', endDrag);
      };

      try {
        e.currentTarget.setPointerCapture(pointerId);
      } catch {
        /* ignore if capture unsupported */
      }
    },
    [dragRef, physicsRef, stateRef, tryDestroyEasterEgg],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Apply `physicsRef` to fixed-position canvas via inline styles (no setState per frame).
  useEffect(() => {
    if (!image) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let rafId = 0;
    const sync = () => {
      canvas.style.left = `${physicsRef.current.x}px`;
      canvas.style.top = `${physicsRef.current.y}px`;
      rafId = requestAnimationFrame(sync);
    };
    rafId = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(rafId);
  }, [image, physicsRef]);

  useSpriteRenderer({
    canvasRef,
    image,
    animationKey,
    resetKey: jumpSeq,
    manifest,
    onComplete: onAnimationComplete,
  });

  if (!image) return null;

  return (
    <>
      <canvas
        ref={canvasRef}
        width={CHAR_W}
        height={CHAR_H}
        className="fixed z-[9999] cursor-grab select-none active:cursor-grabbing transition-opacity duration-500"
        style={{
          pointerEvents: footerVisible ? 'auto' : 'none',
          touchAction: 'none',
          imageRendering: 'pixelated',
          opacity: footerVisible ? 1 : 0,
          top: 0,
          left: 0,
        }}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        role="img"
        aria-label="Site mascot — drag to move, space to jump"
      />
      <div
        className="pointer-events-none fixed bottom-4 left-0 z-[9998] w-full select-none text-center font-mono text-[13px] text-fg transition-opacity duration-300"
        style={{ opacity: footerVisible && hintVisible ? 0.35 : 0 }}
        aria-hidden
      >
        {'<press space to jump>'}
      </div>
    </>
  );
}
