/**
 * Fireworks (Landpot) — the particle sim behind the victory show.
 *
 * Rockets climb from below the screen towards a point, burst into a ring of
 * sparks that fall under gravity, flicker and fade. Pure state + `step`, so
 * it can be tested; `Showtime` draws it as pixel squares.
 */

export interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds left, and the life it started with. */
  life: number;
  max: number;
  color: string;
  /** A rocket bursts when its life runs out; a spark just dies. */
  rocket: boolean;
}

export const GRAVITY = 260; // px / s²
const DRAG = 0.985;

export class Fireworks {
  readonly sparks: Spark[] = [];

  constructor(private readonly rand: () => number = Math.random) {}

  /** Launch a rocket from (x, groundY) to burst near (tx, ty). */
  launch(
    x: number,
    groundY: number,
    tx: number,
    ty: number,
    color: string,
  ): void {
    const t = 0.9 + this.rand() * 0.35;
    // Solve for the launch velocity that reaches (tx, ty) after `t` seconds.
    const vx = (tx - x) / t;
    const vy = (ty - groundY - 0.5 * GRAVITY * t * t) / t;
    this.sparks.push({
      x,
      y: groundY,
      vx,
      vy,
      life: t,
      max: t,
      color,
      rocket: true,
    });
  }

  /** A ring of sparks at (x, y). */
  burst(x: number, y: number, color: string, count = 44): void {
    const speed = 150 + this.rand() * 90;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + this.rand() * 0.15;
      const s = speed * (0.75 + this.rand() * 0.35);
      const life = 1.1 + this.rand() * 0.7;
      this.sparks.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life,
        max: life,
        color,
        rocket: false,
      });
    }
  }

  step(dt: number): void {
    const out = this.sparks;
    const born: Spark[] = [];
    let w = 0;
    for (let i = 0; i < out.length; i++) {
      const p = out[i];
      p.life -= dt;
      if (p.life <= 0) {
        if (p.rocket) born.push(p);
        continue;
      }
      p.vy += GRAVITY * dt * (p.rocket ? 1 : 0.45);
      if (!p.rocket) {
        p.vx *= DRAG;
        p.vy *= DRAG;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      out[w++] = p;
    }
    out.length = w;
    for (const r of born) this.burst(r.x, r.y, r.color);
  }

  get alive(): boolean {
    return this.sparks.length > 0;
  }
}
