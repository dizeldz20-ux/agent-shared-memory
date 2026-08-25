/**
 * Volumetric neuron sprites for the 2D brain.
 *
 * Flat single-colour discs read as a scatter plot, not as tissue. Each soma is
 * baked once at a fixed radius into an offscreen canvas — additive glow, a lit
 * body gradient, and a rim light — then blitted at whatever radius the node
 * needs. Baking beats per-node gradients: 1,646 somas repaint every frame and
 * `createRadialGradient` per node per frame blows the frame budget.
 */

export type NeuronState = 'idle' | 'focus' | 'active' | 'picked';

/** Sprite half-extent in node radii; the glow needs room beyond the body. */
export const NEURON_GLOW = 2.25;
/** Radius the sprite is baked at. Blitting rescales it to the real node radius. */
export const NEURON_BAKE_RADIUS = 24;

const WHITE = '#FFFFFF';
const DEEP = '#040711';

function channels(color: string) {
  const hex = color.replace('#', '');
  const value = Number.parseInt(hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex, 16);
  if (!Number.isFinite(value) || hex.length !== 6) return { r: 158, g: 165, b: 173 };
  return { r: value >> 16, g: (value >> 8) & 255, b: value & 255 };
}

/** Blend `color` toward `target` by `t` (0..1). */
export function mixColor(color: string, target: string, t: number) {
  const a = channels(color);
  const b = channels(target);
  const k = Math.min(1, Math.max(0, t));
  const round = (from: number, to: number) => Math.round(from + (to - from) * k);
  return `rgb(${round(a.r, b.r)},${round(a.g, b.g)},${round(a.b, b.b)})`;
}

export function rgba(color: string, alpha: number) {
  const { r, g, b } = channels(color);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Relative luminance, used to prove the body gradient actually has depth. */
export function luminance(color: string) {
  const match = /rgba?\((\d+),(\d+),(\d+)/.exec(color);
  const { r, g, b } = match
    ? { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
    : channels(color);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export interface NeuronRamp {
  /** Additive halo: [offset, colour] pairs from the body edge outward. */
  glow: Array<[number, string]>;
  /** Lit body: hot core through saturated midtone to a shaded rim. */
  body: Array<[number, string]>;
  rim: string;
  rimWidth: number;
  /** Outer contour ring, for picked/active somas only. */
  contour: string | null;
}

export function neuronRamp(color: string, state: NeuronState): NeuronRamp {
  const glowAlpha = state === 'picked' ? 0.34 : state === 'active' ? 0.28 : state === 'focus' ? 0.16 : 0.07;
  const highlight = state === 'picked' ? WHITE : mixColor(color, WHITE, 0.88);
  return {
    glow: [
      [0, rgba(state === 'picked' ? WHITE : color, glowAlpha)],
      [0.38, rgba(color, glowAlpha * 0.34)],
      [1, rgba(color, 0)],
    ],
    body: [
      [0, highlight],
      [0.34, mixColor(color, WHITE, 0.34)],
      [0.72, color],
      [1, mixColor(color, DEEP, state === 'idle' ? 0.52 : 0.4)],
    ],
    rim: rgba(state === 'picked' ? WHITE : mixColor(color, WHITE, 0.55), state === 'idle' ? 0.42 : 0.72),
    rimWidth: state === 'picked' ? 0.14 : 0.1,
    contour: state === 'picked' ? rgba(WHITE, 0.5) : state === 'active' ? rgba(color, 0.42) : null,
  };
}

export function neuronSpriteKey(color: string, state: NeuronState, core: boolean) {
  return `${color}|${state}|${core ? 'core' : 'plain'}`;
}

export function neuronSpriteSize() {
  return Math.ceil(NEURON_BAKE_RADIUS * NEURON_GLOW * 2);
}

/** Paint one soma into an offscreen context sized `neuronSpriteSize()` square. */
export function paintNeuron(
  ctx: CanvasRenderingContext2D,
  color: string,
  state: NeuronState,
  core: boolean,
) {
  const size = neuronSpriteSize();
  const c = size / 2;
  const r = NEURON_BAKE_RADIUS;
  const ramp = neuronRamp(color, state);

  ctx.clearRect(0, 0, size, size);

  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(c, c, r * 0.5, c, c, r * NEURON_GLOW);
  for (const [stop, value] of ramp.glow) halo.addColorStop(stop, value);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(c, c, r * NEURON_GLOW, 0, Math.PI * 2);
  ctx.fill();

  // Idle tissue is intentionally hollow. Thousands of filled, glowing somas turn the
  // brain into a toy-like bead cloud; a thin membrane keeps topology legible.
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = ramp.rim;
  ctx.lineWidth = Math.max(0.7, r * (state === 'idle' ? 0.075 : ramp.rimWidth));
  ctx.beginPath();
  ctx.arc(c, c, r * 0.88, 0, Math.PI * 2);
  ctx.stroke();

  if (ramp.contour) {
    ctx.strokeStyle = ramp.contour;
    ctx.lineWidth = Math.max(0.6, r * 0.06);
    ctx.beginPath();
    ctx.arc(c, c, r * 1.42, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (core || state === 'active' || state === 'picked') {
    ctx.globalCompositeOperation = 'lighter';
    const spark = ctx.createRadialGradient(c, c, 0, c, c, r * 0.38);
    spark.addColorStop(0, rgba(WHITE, state === 'idle' ? 0.46 : 0.9));
    spark.addColorStop(0.5, rgba(WHITE, state === 'idle' ? 0.12 : 0.24));
    spark.addColorStop(1, rgba(WHITE, 0));
    ctx.fillStyle = spark;
    ctx.beginPath();
    ctx.arc(c, c, r * 0.38, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
}
