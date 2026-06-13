/**
 * Animated wireframe volatility surface — the hero's living backdrop.
 *
 * A parametric height field over (moneyness × expiry) projected obliquely
 * and stroked as a mesh, colour-graded aqua → violet by height, breathing
 * over time. Pure 2D canvas, DPR-aware, additive glow. Honours
 * prefers-reduced-motion (renders a single static frame).
 */
import { useEffect, useRef } from 'react';

const N = 46; // moneyness resolution (columns)
const M = 26; // expiry resolution (rows)
const AQUA = [77, 162, 255];
const VIOLET = [139, 123, 255];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Surface height in ~[0, 1.2]: a vol smile that lifts with expiry and breathes. */
function heightAt(gx: number, gz: number, t: number): number {
  const smile = 1.9 * gx * gx; // wings rise (parabolic smile)
  const skew = -0.45 * gx; // gentle downward skew
  const term = gz * 0.28; // longer expiry → a touch more vol
  const breath =
    0.06 * Math.sin(t * 0.6 + gz * 3.1) + 0.05 * Math.sin(t * 0.9 - gx * 4.2);
  return 0.14 + (smile + skew) * (0.5 + 0.5 * gz) * 0.5 + term + breath;
}

export function SurfaceField() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;

    const resize = () => {
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (cw === 0 || ch === 0) return; // layout not ready yet
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cw;
      h = ch;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduce) draw(0.8); // static frame re-render on resize
    };

    // precompute screen positions per frame
    const project = (i: number, j: number, t: number): [number, number, number] => {
      const gx = i / (N - 1) - 0.5; // -0.5..0.5
      const gz = j / (M - 1); // 0 (front) .. 1 (back)
      const ht = heightAt(gx, gz, t);
      const originX = w * 0.5;
      const originY = h * 0.86;
      const spanX = w * 0.82;
      const skewX = -w * 0.2; // rows shear left going back
      const spanZ = h * 0.5;
      const heightScale = h * 0.2;
      const px = originX + gx * spanX + gz * skewX;
      const py = originY - gz * spanZ - ht * heightScale;
      return [px, py, ht];
    };

    const colorFor = (ht: number, alpha: number): string => {
      const k = Math.max(0, Math.min(1, (ht - 0.1) / 1.0));
      const r = Math.round(lerp(AQUA[0]!, VIOLET[0]!, k));
      const g = Math.round(lerp(AQUA[1]!, VIOLET[1]!, k));
      const b = Math.round(lerp(AQUA[2]!, VIOLET[2]!, k));
      return `rgba(${r},${g},${b},${alpha})`;
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 1;

      // rows (constant expiry) — front rows brighter
      for (let j = 0; j < M; j++) {
        const depth = j / (M - 1);
        const alpha = lerp(0.5, 0.08, depth);
        ctx.beginPath();
        let avgH = 0;
        for (let i = 0; i < N; i++) {
          const [px, py, ht] = project(i, j, t);
          avgH += ht;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = colorFor(avgH / N, alpha);
        ctx.stroke();
      }

      // columns (constant moneyness) — fainter, gives the mesh
      for (let i = 0; i < N; i += 2) {
        ctx.beginPath();
        let avgH = 0;
        for (let j = 0; j < M; j++) {
          const [px, py, ht] = project(i, j, t);
          avgH += ht;
          if (j === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = colorFor(avgH / M, 0.12);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    };

    // draw is now defined — safe to wire sizing + initial measure
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    if (w > 0) draw(0.8); // guarantee a frame even if rAF is throttled

    if (reduce) {
      return () => ro.disconnect();
    }

    let start = 0;
    const loop = (ts: number) => {
      if (!start) start = ts;
      draw((ts - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="surface-field" aria-hidden="true" />;
}
