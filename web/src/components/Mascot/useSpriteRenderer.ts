'use client';

import { useEffect, useRef } from 'react';

import type { AnimationDef, AnimationKey, MascotManifest } from './types';

function blitFrame(args: {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  image: HTMLImageElement;
  frameIndex: number;
  def: AnimationDef;
  frameWidth: number;
  frameHeight: number;
}) {
  const { ctx, canvas, image, frameIndex, def, frameWidth, frameHeight } = args;

  // Resolve actual source frame: reverse plays last→first.
  const srcFrame = def.reverse ? def.frames - 1 - frameIndex : frameIndex;
  const sx = srcFrame * frameWidth;
  const sy = def.row * frameHeight;

  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (def.flipH) {
    // Flip horizontally: translate to right edge, scale x by -1.
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }

  ctx.drawImage(image, sx, sy, frameWidth, frameHeight, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

export function useSpriteRenderer(options: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  image: HTMLImageElement | null;
  animationKey: AnimationKey;
  /** Increment to restart the current clip from frame 0 (e.g. multi-jump). */
  resetKey?: number;
  manifest: MascotManifest;
  onComplete?: () => void;
}): void {
  const { canvasRef, image, animationKey, resetKey = 0, manifest, onComplete } = options;

  const frameIndexRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const prevAnimationKeyRef = useRef<AnimationKey | null>(null);
  const prevResetKeyRef = useRef<number | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!image) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (prevAnimationKeyRef.current !== animationKey) {
      frameIndexRef.current = 0;
      lastFrameTimeRef.current = 0;
      prevAnimationKeyRef.current = animationKey;
    }

    if (prevResetKeyRef.current !== resetKey) {
      frameIndexRef.current = 0;
      lastFrameTimeRef.current = 0;
      prevResetKeyRef.current = resetKey;
    }

    const def = manifest.animations[animationKey];
    const { frameWidth, frameHeight } = manifest;
    const frameDurationMs = 1000 / def.fps;

    let rafId = 0;
    let stopped = false;

    const tick = (now: number) => {
      if (stopped) return;

      if (lastFrameTimeRef.current === 0) {
        lastFrameTimeRef.current = now;
      }

      while (now - lastFrameTimeRef.current >= frameDurationMs) {
        lastFrameTimeRef.current += frameDurationMs;
        frameIndexRef.current += 1;

        if (frameIndexRef.current >= def.frames) {
          if (def.loop) {
            frameIndexRef.current = 0;
          } else {
            frameIndexRef.current = def.frames - 1;
            blitFrame({
              ctx,
              canvas,
              image,
              frameIndex: frameIndexRef.current,
              def,
              frameWidth,
              frameHeight,
            });
            onCompleteRef.current?.();
            stopped = true;
            return;
          }
        }
      }

      blitFrame({
        ctx,
        canvas,
        image,
        frameIndex: frameIndexRef.current,
        def,
        frameWidth,
        frameHeight,
      });

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
    };
  }, [canvasRef, image, animationKey, resetKey, manifest]);
}
