/**
 * Nameplates over heads and damage numbers rising off them — the two pieces of text that live in the
 * world rather than in the log panel.
 *
 * ## troika-three-text was considered and is not here
 *
 * `PLAN-3d-migration.md` §6-M7 names `troika-three-text`, and M7b's brief allows it as the milestone's
 * one new dependency *"if it earns it"*. It does not, and the argument is what troika is *for*: it
 * builds signed-distance-field atlases from a font at run time so that arbitrary, long, live-editing
 * text stays crisp at any zoom. What this renderer needs is **a short name that never changes while
 * an entity exists, and a two-digit number**, both read at 20–90 m through a 64° camera, both fading
 * out with distance. A `<canvas>` and `fillText` produce exactly that at a fifth of the code and none
 * of the payload: troika is ~100 KB gzipped plus a worker plus a font file, against 0 bytes for the
 * browser's own text rasteriser and the font the user already has.
 *
 * The trade it loses is sharpness under extreme zoom-in. The dolly's ceiling is 96 m and its floor is
 * `CAMERA_DISTANCE_MIN`, so the range a plate is ever seen over is about 4:1, and a 256 x 64 canvas
 * covers it. **When the day comes that a name has to be legible at arm's length, this file is the one
 * to replace** — the interface is four methods and nothing else knows how the pixels are made.
 *
 * ## Everything is allocated once
 *
 * {@link PlateSet} mints its sprites, their materials and their canvases in the constructor and never
 * again: 24 nameplates (one per body the pool can hold) and 24 damage numbers (one per body per
 * round, and a round is 3 s while a number lives for {@link DAMAGE_SECONDS}). A plate that is not
 * needed this frame is `visible = false`, which is the same discipline every wrapper in `pool.ts`
 * follows. Steady state is zero allocation and zero garbage.
 *
 * The one cost that is not free is the **texture upload**: writing a plate's text redraws its canvas
 * and re-uploads 64 KB. A nameplate pays that once when an entity takes the plate, and a damage
 * number once per blow — at the very worst 8 blows a second across a full room, which is 512 KB/s
 * against a texture budget already holding 25 MB of character atlas.
 *
 * ## Fog of war does not reach them
 *
 * `entities.ts`'s rule for bodies, and for the same reason: *"a character is not terrain, and the one
 * thing that must stay legible in an unexplored room is the person standing in it"*. Nothing here is
 * ever multiplied by a fog tint — the plates are drawn at full opacity modulated only by distance.
 */

import { Sprite, SpriteMaterial, Texture, type Camera, type Scene } from 'three';

/** Canvas pixels. Wide enough for a 20-character name at 28 px, short enough to upload cheaply. */
const PLATE_WIDTH = 256;
const PLATE_HEIGHT = 64;

/** World metres a plate spans at full size. A 1.8 m body with a 1.6 m plate reads at 40 m. */
const PLATE_METRES = 1.6;

/**
 * How far above the body's own feet a nameplate floats, **at adult scale**. Just clear of a 1.81 m
 * head.
 *
 * Multiplied by `EntityView.scale` at every use — see {@link liftFor}. A constant was right while
 * every body in the world was 1.81 m tall and stopped being right the day the world's 86 `child` and
 * 44 `teen` templates started drawing at 0.72 and 0.88: a name floating at 2.1 m over a 1.30 m kobold
 * youth is not that youth's name, it is a label hanging in the air near it.
 */
export const NAMEPLATE_LIFT = 2.1;

/**
 * Where the text over a body of this scale belongs, in metres above its feet.
 *
 * A function rather than a multiplication at each call site because there are two call sites — the
 * nameplate and the damage number — and they must agree: a number rising from a different height than
 * the name it rises past reads as two different bodies.
 */
export function liftFor(scale: number): number {
  return NAMEPLATE_LIFT * scale;
}

/** Metres at which a nameplate is fully opaque, and at which it has gone. */
export const PLATE_NEAR = 18;
export const PLATE_FAR = 44;

/** Seconds a damage number lives, and the metres it climbs in that time. */
export const DAMAGE_SECONDS = 1.1;
export const DAMAGE_RISE = 1.3;

/** How many of each the set holds — one nameplate per body the pool can draw, and as many numbers. */
export const PLATE_COUNT = 24;

/**
 * A nameplate's opacity at a distance, `1` near and `0` far.
 *
 * Linear between the two bands and clamped outside them, which is deliberately the same shape
 * `foliage.fadeBandsFor` gives the undergrowth: a name that dissolved on a curve would read as the
 * connection stuttering rather than as the character being far away.
 */
export function plateOpacity(metres: number): number {
  if (metres <= PLATE_NEAR) return 1;
  if (metres >= PLATE_FAR) return 0;
  return 1 - (metres - PLATE_NEAR) / (PLATE_FAR - PLATE_NEAR);
}

/** How far a damage number has climbed, in metres, at an age in seconds. Decelerating: `1-(1-t)^2`. */
export function damageRise(age: number): number {
  const t = Math.min(Math.max(age / DAMAGE_SECONDS, 0), 1);
  return DAMAGE_RISE * (1 - (1 - t) * (1 - t));
}

/**
 * A damage number's opacity at an age — **full for the first third, then out**.
 *
 * The hold matters: a number that starts fading on the frame it appears is a number a player reads as
 * a flicker. A third of 1.1 s is 0.37 s, which is long enough to read two digits and short enough that
 * two rounds' worth never overlap.
 */
export function damageOpacity(age: number): number {
  const t = Math.min(Math.max(age / DAMAGE_SECONDS, 0), 1);
  if (t < DAMAGE_HOLD) return 1;
  // Written as the *remaining* fraction rather than as `1 - elapsed`, so the end of the fade is
  // exactly zero rather than 2.2e-16: a plate is switched off on `opacity <= 0` and a value that is
  // positive by one bit is a number that never quite goes out. Clamped at the top for the same
  // reason at the other end.
  return Math.min(1, (1 - t) / (1 - DAMAGE_HOLD));
}

/** The fraction of a damage number's life it spends at full opacity. See {@link damageOpacity}. */
export const DAMAGE_HOLD = 0.34;

/** What a number is drawn in. A critical is the one thing worth a second colour. */
export const DAMAGE_COLOUR = '#ffe9b8';
export const CRITICAL_COLOUR = '#ffd24a';
/** A blow that missed. Drawn, because "miss" is information and an absent number is ambiguous. */
export const MISS_COLOUR = '#cfd6de';

interface Plate {
  readonly sprite: Sprite;
  readonly material: SpriteMaterial;
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D | null;
  readonly texture: Texture;
  /** What is currently drawn, so a plate that has not changed costs no upload. */
  text: string;
  colour: string;
  /** Seconds since the number was fired, for the damage half. Unused by nameplates. */
  age: number;
  /** Where it was fired from, so the rise is recomputed from the age rather than integrated. */
  baseY: number;
  live: boolean;
}

/**
 * The pooled text layer: {@link PLATE_COUNT} nameplates and as many damage numbers.
 *
 * Constructed with a `document`, so it exists only in the browser. Nothing headless builds one, and
 * the two curves above are exported as pure functions precisely so the behaviour that matters can be
 * tested without one.
 */
export class PlateSet {
  private readonly names: Plate[] = [];
  private readonly numbers: Plate[] = [];
  /** Which nameplate an entity currently owns, so a body keeps its plate across frames. */
  private readonly claimed = new Map<number, Plate>();
  private nextNumber = 0;

  constructor(scene: Scene) {
    for (let i = 0; i < PLATE_COUNT; i++) {
      const name = makePlate();
      // Names sit behind numbers in the sort order: a number rising through a name should be the thing
      // you read. Both are transparent and depth-tested, so a plate behind a wall is behind a wall.
      name.sprite.renderOrder = 1;
      scene.add(name.sprite);
      this.names.push(name);
      const number = makePlate();
      number.sprite.renderOrder = 2;
      scene.add(number.sprite);
      this.numbers.push(number);
    }
  }

  /** Bytes of canvas texture held — 48 x 256 x 64 x 4. On the report, not on the pool's ledger. */
  get bytes(): number {
    return this.names.length * 2 * PLATE_WIDTH * PLATE_HEIGHT * 4;
  }

  /** How many damage numbers are in flight. `__debug3d.plates`. */
  get liveNumbers(): number {
    return this.numbers.filter((plate) => plate.live).length;
  }

  /**
   * Claim (or keep) the nameplate for an entity and put it over their head.
   *
   * Called once per body per frame from `entities.render`. The plate is only redrawn when the *text*
   * changes, which for a name is once per entity — so the steady-state cost is a position, a
   * quaternion copy and an opacity write.
   */
  showName(
    id: number,
    text: string,
    x: number,
    y: number,
    z: number,
    metres: number,
    camera: Camera,
    /** The body's `EntityView.scale`. Defaults to adult, which is what every caller sent before. */
    scale = 1,
  ): void {
    let plate = this.claimed.get(id);
    if (!plate) {
      plate = this.names.find((candidate) => !candidate.live);
      // Over the cap the body still draws; it simply goes unlabelled, which is the same graceful
      // degradation `ScenePool.acquireBody` makes one level down.
      if (!plate) return;
      plate.live = true;
      this.claimed.set(id, plate);
    }
    if (plate.text !== text) draw(plate, text, '#f2f4f7');
    const opacity = plateOpacity(metres);
    plate.material.opacity = opacity;
    plate.sprite.visible = opacity > 0.02;
    plate.sprite.position.set(x, y + liftFor(scale), z);
    plate.sprite.quaternion.copy(camera.quaternion);
  }

  /** Give an entity's nameplate back — `entityLeave`, and every Place change. */
  release(id: number): void {
    const plate = this.claimed.get(id);
    if (!plate) return;
    this.claimed.delete(id);
    plate.live = false;
    plate.text = '';
    plate.sprite.visible = false;
  }

  /**
   * Fire a damage number off a body — one per resolved blow, round-robin over the pool.
   *
   * Round-robin rather than first-free, so that a burst longer than the pool overwrites its own oldest
   * number instead of dropping the newest: in a fight the number you have not read yet is the one that
   * just landed.
   */
  showDamage(
    amount: number,
    critical: boolean,
    hit: boolean,
    x: number,
    y: number,
    z: number,
    /** The struck body's `EntityView.scale`, so the number starts off *its* head. */
    scale = 1,
  ): void {
    const plate = this.numbers[this.nextNumber % this.numbers.length];
    this.nextNumber += 1;
    if (!plate) return;
    const text = hit ? String(amount) : 'miss';
    const colour = hit ? (critical ? CRITICAL_COLOUR : DAMAGE_COLOUR) : MISS_COLOUR;
    if (plate.text !== text || plate.colour !== colour) draw(plate, text, colour);
    plate.age = 0;
    plate.live = true;
    plate.sprite.visible = true;
    plate.sprite.position.set(x, y + liftFor(scale), z);
    // **Recorded here and nowhere else.** The rise is a function of the age, not an integration, so a
    // dropped frame does not leave one number half a metre behind the others — but that only works if
    // the origin is re-read on every firing. Latching it lazily inside `advance` would make a recycled
    // plate climb from wherever the *last* blow put it, which in a fight is somebody else's head.
    plate.baseY = y + liftFor(scale);
  }

  /** Age every number in flight. One call a frame, after the bodies have been placed. */
  advance(seconds: number, camera: Camera): void {
    for (const plate of this.numbers) {
      if (!plate.live) continue;
      plate.age += seconds;
      if (plate.age >= DAMAGE_SECONDS) {
        plate.live = false;
        plate.sprite.visible = false;
        continue;
      }
      plate.sprite.position.y = plate.baseY + damageRise(plate.age);
      plate.material.opacity = damageOpacity(plate.age);
      plate.sprite.quaternion.copy(camera.quaternion);
    }
  }

  dispose(): void {
    for (const plate of [...this.names, ...this.numbers]) {
      plate.sprite.removeFromParent();
      plate.texture.dispose();
      plate.material.dispose();
    }
    this.names.length = 0;
    this.numbers.length = 0;
    this.claimed.clear();
  }
}

function makePlate(): Plate {
  const canvas = document.createElement('canvas');
  canvas.width = PLATE_WIDTH;
  canvas.height = PLATE_HEIGHT;
  const texture = new Texture(canvas);
  texture.needsUpdate = true;
  const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new Sprite(material);
  sprite.scale.set(PLATE_METRES, (PLATE_METRES * PLATE_HEIGHT) / PLATE_WIDTH, 1);
  sprite.visible = false;
  return {
    sprite,
    material,
    canvas,
    context: canvas.getContext('2d'),
    texture,
    text: '',
    colour: '',
    age: 0,
    baseY: 0,
    live: false,
  };
}

/**
 * Redraw one plate — the only place a texture is uploaded, and it runs on a change and not a frame.
 *
 * The dark outline is doing real work: a light name over a sunlit field and a light name over a cave
 * floor are the same pixels, and a 4 px stroke is what makes both legible without a background quad
 * that would occlude the character under it.
 */
function draw(plate: Plate, text: string, colour: string): void {
  plate.text = text;
  plate.colour = colour;
  const context = plate.context;
  if (!context) return;
  context.clearRect(0, 0, PLATE_WIDTH, PLATE_HEIGHT);
  context.font = '600 34px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.lineWidth = 6;
  context.strokeStyle = 'rgba(0, 0, 0, 0.82)';
  context.strokeText(text, PLATE_WIDTH / 2, PLATE_HEIGHT / 2, PLATE_WIDTH - 8);
  context.fillStyle = colour;
  context.fillText(text, PLATE_WIDTH / 2, PLATE_HEIGHT / 2, PLATE_WIDTH - 8);
  plate.texture.needsUpdate = true;
}

/** Exported for the debug object: what a plate would be sized at. */
export function plateSize(): { readonly width: number; readonly height: number; readonly metres: number } {
  return { width: PLATE_WIDTH, height: PLATE_HEIGHT, metres: PLATE_METRES };
}
