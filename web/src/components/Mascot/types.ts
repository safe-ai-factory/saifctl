export type AnimationKey =
  | 'idle_spin'
  | 'idle_jump'
  | 'idle_boop'
  | 'idle_crouch'
  | 'idle_explode'
  | 'walk'
  | 'walk_flipped'
  | 'jump_start'
  | 'jump_start_flipped'
  | 'drag_start_grab'
  | 'drag_idle_calm'
  | 'drag_idle_swing'
  | 'drag_stop_release'
  | 'falling'
  | 'falling_flipped'
  | 'landing'
  | 'landing_flipped';

export type MascotState =
  | 'IDLE_SPIN'
  | 'IDLE_JUMP'
  | 'IDLE_BOOP'
  | 'IDLE_CROUCH'
  | 'IDLE_DESTROY'
  | 'WALKING_LEFT'
  | 'WALKING_RIGHT'
  | 'JUMPING_TAKEOFF_LEFT'
  | 'JUMPING_TAKEOFF_RIGHT'
  | 'JUMPING_TAKEOFF_UP'
  | 'JUMPING_AIRBORNE_LEFT'
  | 'JUMPING_AIRBORNE_RIGHT'
  | 'JUMPING_AIRBORNE_UP'
  | 'GRAB_TRANSITION'
  | 'DRAGGED_CALM'
  | 'DRAGGED_SWING'
  | 'RELEASE_TRANSITION'
  | 'FALLING'
  | 'LAND_TRANSITION';

export interface AnimationDef {
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
  /** If true, draw the frame horizontally mirrored (canvas transform). No extra spritesheet row needed. */
  flipH?: boolean;
  /** If true, play frames in reverse order (last → first). Used for jump_start (landing played backwards). */
  reverse?: boolean;
  /**
   * Override the frames/ subdirectory name used by the build script.
   * Required when the animation key differs from the directory name
   * (e.g. walk_flipped → "walk", jump_start → "landing").
   */
  sourceDir?: string;
}

export interface MascotManifest {
  frameWidth: number;
  frameHeight: number;
  animations: Record<AnimationKey, AnimationDef>;
}
