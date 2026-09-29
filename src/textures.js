import * as THREE from 'three';

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return [canvas, canvas.getContext('2d')];
}

function toTexture(canvas, { repeat = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function speckle(ctx, w, h, count, min, max, alpha) {
  for (let i = 0; i < count; i++) {
    const v = Math.round(min + Math.random() * (max - min));
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

// Tileable value noise: a random grid of `cells` x `cells`, sampled smoothly at (u, v) in [0, 1).
function valueNoise(cellsX, cellsY) {
  const grid = Float32Array.from({ length: cellsX * cellsY }, Math.random);
  const at = (x, y) => grid[((y + cellsY) % cellsY) * cellsX + ((x + cellsX) % cellsX)];
  return (u, v) => {
    const x = u * cellsX, y = v * cellsY;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    let fx = x - x0, fy = y - y0;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

// Cast-concrete tunnel lining. Texture x runs `around` metres around the wall, y runs along two
// lining sections of `sectionLen` metres; joints sit at y = 0, half and full height.
export function wallTexture(around = 6, sectionLen = 10) {
  const W = 1536, H = 4096;
  const along = sectionLen * 2;
  const perX = W / around, perY = H / along;
  const noise = (mx, my) => valueNoise(Math.max(1, Math.round(around * mx)), Math.max(1, Math.round(along * my)));
  const blotch = noise(0.5, 0.3);
  const mottle = noise(2.5, 2);
  const grain = noise(30, 30);
  const damp = noise(3, 0.2); // how far moisture spreads from each joint
  const streak = noise(14, 0.6); // mineral runs leaching out of the joints

  const img = new ImageData(W, H);
  const d = img.data;
  const tieHoles = [0.25, 0.75].flatMap((fy) => [1, 4].map((x) => [x, fy * sectionLen]));

  for (let py = 0; py < H; py++) {
    const y = py / perY, v = py / H;
    const ys = y % sectionLen;
    const jointDist = Math.min(ys, sectionLen - ys);
    for (let px = 0; px < W; px++) {
      const x = px / perX, u = px / W;
      const speck = Math.random();

      let c = 0.5 + 0.14 * (blotch(u, v) - 0.5) + 0.1 * (mottle(u, v) - 0.5) + 0.07 * (grain(u, v) - 0.5);
      c += 0.05 * (speck - 0.5);

      // Moisture darkening around the joints, with a ragged edge
      const reach = 0.1 + 0.9 * damp(u, v) ** 2;
      c *= 1 - 0.4 * (1 - THREE.MathUtils.smoothstep(jointDist, reach * 0.3, reach));
      // Pale efflorescence streaks running out of the joints
      const run = THREE.MathUtils.smoothstep(streak(u, v), 0.6, 0.85) * Math.exp(-jointDist / 0.9);
      c += 0.22 * run * (0.7 + 0.3 * speck);

      // Faint seams from the steel formwork panels
      const seam = Math.abs(((x + 0.75) % 1.5) - 0.75);
      if (seam < 0.006) c *= 0.9;
      else if (seam < 0.012) c *= 1.04;

      // Air pockets
      if (speck < 0.004) c *= 0.55;

      // Formwork tie holes, plugged with slightly different mortar
      for (const [hx, hy] of tieHoles) {
        for (const off of [0, sectionLen]) {
          const r = Math.hypot(x - hx, y - hy - off);
          if (r < 0.035) c = r < 0.025 ? c * 0.6 : c * 1.08;
        }
      }

      const i = (py * W + px) * 4;
      d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, c * 255));
      d[i + 3] = 255;
    }
  }

  const [canvas, ctx] = makeCanvas(W, H);
  ctx.putImageData(img, 0, 0);
  return toTexture(canvas);
}

// Asphalt with lane markings, as colour, roughness and bump maps.
// Texture x spans the road width, y spans one tile of road length (both in metres).
// Generating them is slow, so they're made once and shared by the tunnel and the road outside.
const roadCache = new Map();
export function roadTextures(width, tileLen) {
  const key = `${width}x${tileLen}`;
  if (!roadCache.has(key)) roadCache.set(key, makeRoadTextures(width, tileLen));
  return roadCache.get(key);
}

function makeRoadTextures(width, tileLen) {
  const W = 1024, H = 4096;
  const perX = W / width, perY = H / tileLen;
  const noise = (mx, my) => valueNoise(Math.round(width * mx), Math.round(tileLen * my));
  const blotch = noise(0.4, 0.4); // large stains
  const mottle = noise(3, 3); // mid-scale unevenness
  const grain = noise(40, 40); // aggregate stones
  const wear = noise(12, 12); // how worn the paint is

  // A few rectangular repair patches of newer, darker asphalt
  const patches = Array.from({ length: 2 }, () => {
    const w = 1 + Math.random() * 2.5, h = 1.5 + Math.random() * 4;
    const x = -width / 2 + Math.random() * (width - w);
    return { x0: x, x1: x + w, y0: Math.random() * (tileLen - h), y1: 0, h };
  }).map((p) => ({ ...p, y1: p.y0 + p.h }));

  const tracks = [-3.6, 0, 3.6].flatMap((lane) => [lane - 0.9, lane + 0.9]);
  const edgeLine = width / 2 - 0.3;

  const images = [0, 1, 2].map(() => new ImageData(W, H));
  const [color, rough, bump] = images.map((img) => img.data);

  for (let py = 0; py < H; py++) {
    const y = py / perY, v = py / H;
    for (let px = 0; px < W; px++) {
      const x = px / perX - width / 2, u = px / W;
      const g = grain(u, v), speck = Math.random();

      // Polished, slightly darker wheel paths
      let track = 0;
      for (const c of tracks) track += Math.exp(-(((x - c) / 0.38) ** 2));
      // Grime collecting along the gutters
      const gutter = Math.exp(-((width / 2 - Math.abs(x)) / 0.35));

      let shade = 0.17 + 0.05 * blotch(u, v) + 0.04 * mottle(u, v) + 0.06 * (g - 0.5) + 0.05 * (speck - 0.5);
      shade *= 1 - 0.2 * track - 0.35 * gutter;
      let r = 0.82 - 0.32 * track + 0.1 * (speck - 0.5);
      let h = 0.5 + 0.35 * (g - 0.5) + 0.15 * (speck - 0.5);

      for (const p of patches) {
        if (x > p.x0 && x < p.x1 && y > p.y0 && y < p.y1) {
          const seam = Math.min(x - p.x0, p.x1 - x, y - p.y0, p.y1 - y) < 0.04;
          shade = seam ? 0.07 : shade * 0.75;
          r = seam ? 0.95 : r + 0.05;
        }
      }

      // Markings: solid edge lines, 3 m dashes every 10 m, cat's-eye studs in the gaps
      const ax = Math.abs(x);
      const ym = y % 10;
      let paint = 0;
      if (Math.abs(ax - edgeLine) < 0.08) paint = 1;
      if (Math.abs(ax - 1.8) < 0.075 && ym < 3) paint = 1;
      if (Math.abs(ax - 1.8) < 0.07 && ym > 4.5 && (ym - 4.5) % 3 < 0.14) paint = 1.3;
      if (paint) {
        const worn = wear(u, v) * 0.6 + speck * 0.4;
        if (worn > 0.22) {
          const p = Math.min(1, (worn - 0.22) * 4);
          shade += (0.72 * paint - shade) * p;
          r += (0.55 - r) * p;
          h += 0.25 * p;
        }
      }

      const i = (py * W + px) * 4;
      color[i] = color[i + 1] = color[i + 2] = Math.min(255, shade * 255);
      rough[i] = rough[i + 1] = rough[i + 2] = Math.min(255, Math.max(0, r * 255));
      bump[i] = bump[i + 1] = bump[i + 2] = Math.min(255, Math.max(0, h * 255));
      color[i + 3] = rough[i + 3] = bump[i + 3] = 255;
    }
  }

  const [map, roughnessMap, bumpMap] = images.map((img, k) => {
    const [canvas, ctx] = makeCanvas(W, H);
    ctx.putImageData(img, 0, 0);
    const tex = toTexture(canvas);
    if (k > 0) tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    return tex;
  });
  return { map, roughnessMap, bumpMap };
}

// Stained concrete. Canvas x runs around the arch, y runs along the tunnel.
export function concreteTexture() {
  const S = 512;
  const [canvas, ctx] = makeCanvas(S, S);
  ctx.fillStyle = '#7c7c7c';
  ctx.fillRect(0, 0, S, S);

  for (let i = 0; i < 90; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 20 + Math.random() * 90;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const v = Math.random() < 0.6 ? 0 : 255;
    g.addColorStop(0, `rgba(${v},${v},${v},0.09)`);
    g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Water streaks running down the arch
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.07})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 40 + Math.random() * 200, 1 + Math.random() * 3);
  }
  speckle(ctx, S, S, 40000, 40, 180, 0.25);
  return toTexture(canvas);
}

export function glowTexture() {
  const S = 128;
  const [canvas, ctx] = makeCanvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.08, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return toTexture(canvas, { repeat: false });
}
