import * as THREE from 'three';
import { concreteTexture, wallTexture, roadTextures, glowTexture } from './textures.js';

// All dimensions in metres. The tunnel runs straight down -z from the camera.
// Cross-section: x = across (right +), y = up from the road surface, s = distance along (z = -s).
const LANE = 3.6;
const ROAD_HALF = LANE * 1.5; // three lanes
const CURB = 0.3;
const START = -20; // how far the tunnel extends behind the camera
export const SPEED = 7; // metres per second through the tunnel, and out of it
export const EXIT = 450; // distance from the camera's start to the tunnel exit
const LENGTH = EXIT - START;
const AXIS_Y = 1.8; // height of the tunnel's centre line, which the walls spin around
const RADIUS = 6.9;
const WALL_SEGS = 96;
const RING_LEN = 10; // length of each concrete lining section
const JOINT_HALF = 0.03; // half-width of the groove between sections
const JOINT_DEPTH = 0.025;
const LEDGE_EDGE = Math.sqrt(RADIUS ** 2 - (CURB - AXIS_Y) ** 2); // where the ledge meets the wall
export const LAMP_SPACING = 15;
const LAMP_ANGLE = 0.62; // radians above horizontal

// Sweep cross-section profiles along the tunnel. Each sample: { s, pts: [[x, y]...], join }.
// `join` connects a sample to the next one; leaving it off makes a hard edge.
// Points may carry a third value, a small shift along the tunnel, and samples an optional `tint`.
// `normal(x, y)` overrides the computed normals.
function sweep(samples, { uScale = 1, vScale = 1, vOffset = 0, shade = () => 1, normal } = {}) {
  const n = samples[0].pts.length;
  const pos = [], uv = [], col = [], idx = [], nrm = [];

  samples.forEach((smp, i) => {
    let u = 0;
    smp.pts.forEach(([x, y, ds = 0], j) => {
      if (j) u += Math.hypot(x - smp.pts[j - 1][0], y - smp.pts[j - 1][1]);
      const along = smp.s + ds;
      pos.push(x, y, -along);
      uv.push(u * uScale, (along - vOffset) * vScale);
      const c = shade(x, y) * (smp.tint ?? 1);
      col.push(c, c, c);
      if (normal) nrm.push(...normal(x, y));
    });
    if (smp.join && i < samples.length - 1) {
      for (let j = 0; j < n - 1; j++) {
        const a = i * n + j, b = a + n;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  if (normal) geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  else geo.computeVertexNormals();
  return geo;
}

// Straight samples every `step` metres over the tunnel's length.
function straight(pts, step = 5) {
  const samples = [];
  for (let s = START; s <= START + LENGTH; s += step) samples.push({ s, pts, join: true });
  return samples;
}

// Smooth random wobble around the circle, so joints aren't perfectly straight.
function wobble(amount) {
  const k = [1, 2, 3, 5, 8].map((f) => [f, Math.random() * Math.PI * 2, (Math.random() - 0.5) / f]);
  return Array.from({ length: WALL_SEGS + 1 }, (_, j) => {
    const th = (j / WALL_SEGS) * Math.PI * 2;
    return amount * k.reduce((sum, [f, ph, a]) => sum + a * Math.sin(f * th + ph), 0);
  });
}

// Full circle around the axis (relative to it), so it keeps its shape as it spins.
// `shift` is an optional per-point offset along the tunnel.
function ringProfile(offset, shift) {
  const pts = [];
  for (let j = 0; j <= WALL_SEGS; j++) {
    const th = (j / WALL_SEGS) * Math.PI * 2;
    pts.push([(RADIUS + offset) * Math.cos(th), (RADIUS + offset) * Math.sin(th), shift?.[j] ?? 0]);
  }
  return pts;
}

// Cast-concrete lining in 10 m sections separated by narrow, slightly wavy grooves.
function buildWalls() {
  const shiftBy = (arr, d) => arr.map((v) => v + d);
  const samples = [];
  const sections = LENGTH / RING_LEN;
  // Each pour comes out a slightly different tone
  const tints = Array.from({ length: sections }, () => 0.85 + Math.random() * 0.3);
  const tint = (k) => tints[THREE.MathUtils.clamp(k, 0, sections - 1)];

  for (let k = 0; k <= sections; k++) {
    const s = START + k * RING_LEN;
    const w = wobble(0.02);
    const before = tint(k - 1), after = tint(k);
    const groove = 0.35 * Math.min(before, after);
    if (k > 0) samples.push({ s, pts: ringProfile(0, shiftBy(w, -JOINT_HALF)), tint: before, join: true });
    samples.push(
      { s, pts: ringProfile(JOINT_DEPTH, shiftBy(w, -JOINT_HALF * 0.4)), tint: groove, join: true },
      { s, pts: ringProfile(JOINT_DEPTH, shiftBy(w, JOINT_HALF * 0.4)), tint: groove, join: true }
    );
    if (k < sections) samples.push({ s, pts: ringProfile(0, shiftBy(w, JOINT_HALF)), tint: after, join: true });
  }

  // Tile the texture a whole number of times around, so there's no seam as it spins
  const around = Math.round((2 * Math.PI * RADIUS) / 6);
  const geo = sweep(samples, {
    uScale: around / (2 * Math.PI * RADIUS),
    vScale: 1 / (2 * RING_LEN), // texture covers two sections
    vOffset: START,
    // Grime along a band of the wall, which travels around with the rotation
    shade: (x, y) => 0.4 + 0.6 * THREE.MathUtils.smoothstep(y, -1.4, 1.4),
    // Light the lining as a smooth cylinder; the grooves read through tone, not faceting.
    // Faces wind outward and we see their back sides, which three.js lights with the normal flipped.
    normal: (x, y) => {
      const r = Math.hypot(x, y);
      return [x / r, y / r, 0];
    },
  });
  const map = wallTexture(6, RING_LEN);
  const mat = new THREE.MeshStandardMaterial({
    map,
    color: 0x6a6a6a,
    vertexColors: true,
    roughness: 0.95,
    side: THREE.BackSide,
  });
  return new THREE.Mesh(geo, mat);
}

function buildRoad() {
  const tile = 20;
  const geo = sweep(straight([[-ROAD_HALF, 0], [ROAD_HALF, 0]]), {
    uScale: 1 / (ROAD_HALF * 2),
    vScale: 1 / tile,
  });
  const mat = new THREE.MeshStandardMaterial({
    ...roadTextures(ROAD_HALF * 2, tile),
    bumpScale: 1.5,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
}

function buildLedges() {
  const left = [[-LEDGE_EDGE, CURB], [-ROAD_HALF, CURB], [-ROAD_HALF, 0]];
  const right = [[ROAD_HALF, 0], [ROAD_HALF, CURB], [LEDGE_EDGE, CURB]];
  const mat = new THREE.MeshStandardMaterial({
    color: 0x555555,
    map: concreteTexture(),
    roughness: 1,
    side: THREE.DoubleSide,
  });
  return [left, right].map((pts) => new THREE.Mesh(sweep(straight(pts), { uScale: 1 / 4, vScale: 1 / 4 }), mat));
}

// Point on the wall circle at angle th (relative to the axis), pulled `inset` metres in.
function wallPoint(th, inset) {
  const r = RADIUS - inset;
  return [r * Math.cos(th), r * Math.sin(th)];
}

// Real lights are expensive, so a fixed pool is handed to the lamps nearest the camera: the
// closest pairs get a light on each side, further pairs one light on the axis each, and
// beyond that the fog does the work.
const NEAR_PAIRS = 6;
const FAR_PAIRS = 8;
const LAMP_INTENSITY = 22;
const FAR_INTENSITY = 350;

// Pairs of lamps on both walls, each pair with its own brightness (0 = off, 1 = on).
class Lamps {
  constructor() {
    this.group = new THREE.Group();
    this.count = Math.floor((LENGTH + START) / LAMP_SPACING);
    const housingMat = new THREE.MeshBasicMaterial();
    housingMat.color.setScalar(4);
    this.housings = new THREE.InstancedMesh(new THREE.BoxGeometry(0.35, 0.14, 0.9), housingMat, this.count * 2);
    const glowTex = glowTexture();

    this.pairs = [];
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.count; i++) {
      const s = i * LAMP_SPACING;
      const glowMat = new THREE.SpriteMaterial({
        map: glowTex,
        color: 0xdfe8ff,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const lightPos = [];

      [LAMP_ANGLE, Math.PI - LAMP_ANGLE].forEach((th, side) => {
        const [x, y] = wallPoint(th, 0.2);
        m.makeRotationZ(th - Math.PI / 2).setPosition(x, y, -s);
        this.housings.setMatrixAt(i * 2 + side, m);

        const glow = new THREE.Sprite(glowMat);
        glow.position.set(x * 0.98, y * 0.98, -s);
        glow.scale.setScalar(1.0);
        this.group.add(glow);

        const [lx, ly] = wallPoint(th, 0.9);
        lightPos.push(new THREE.Vector3(lx, ly, -s));
      });

      this.pairs.push({ s, glowMat, lightPos, axisPos: new THREE.Vector3(0, 2, -s), level: 0, strikeAt: null });
      this.setLevel(i, 0);
    }
    this.group.add(this.housings);

    const pool = (n, distance) =>
      Array.from({ length: n }, () => {
        const light = new THREE.PointLight(0xe4ecff, 0, distance, 1.6);
        this.group.add(light);
        return light;
      });
    this.nearLights = pool(NEAR_PAIRS * 2, 40);
    this.farLights = pool(FAR_PAIRS, 60);
  }

  setLevel(i, level) {
    const pair = this.pairs[i];
    pair.level = level;
    pair.glowMat.opacity = level;
    const c = new THREE.Color().setScalar(level);
    this.housings.setColorAt(i * 2, c);
    this.housings.setColorAt(i * 2 + 1, c);
    this.housings.instanceColor.needsUpdate = true;
  }

  // Move the light pool along with the camera. Lights entering or leaving the pool, or passing
  // from the far pool to the near one, are cross-faded so nothing pops.
  update(camS) {
    const pos = camS / LAMP_SPACING - 1;
    const first = Math.floor(pos), frac = pos - first;
    const assign = (light, i, pos, intensity) => {
      const pair = this.pairs[i];
      light.intensity = pair ? intensity * pair.level : 0;
      if (pair) light.position.copy(pos(pair));
    };

    for (let k = 0; k < NEAR_PAIRS; k++) {
      const fade = k === 0 ? 1 - frac : k === NEAR_PAIRS - 1 ? frac : 1;
      for (let side = 0; side < 2; side++) {
        assign(this.nearLights[k * 2 + side], first + k, (p) => p.lightPos[side], LAMP_INTENSITY * fade);
      }
    }
    for (let k = 0; k < FAR_PAIRS; k++) {
      const fade = k === 0 ? 1 - frac : k === FAR_PAIRS - 1 ? frac : 1;
      assign(this.farLights[k], first + NEAR_PAIRS - 1 + k, (p) => p.axisPos, FAR_INTENSITY * fade);
    }
  }
}

// Reflective delineators low on both walls
function buildMarkers() {
  const count = Math.floor(LENGTH / 20);
  // Retro-reflective, so they only show up once light reaches them
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const markers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.3, 0.05), mat, count * 2);
  const m = new THREE.Matrix4();
  const th = Math.asin((1.0 - AXIS_Y) / RADIUS);
  for (let i = 0; i < count; i++) {
    for (const [k, a] of [[0, th], [1, Math.PI - th]]) {
      const [x, y] = wallPoint(a, 0.05);
      markers.setMatrixAt(i * 2 + k, m.makeTranslation(x, y, -(START + i * 20)));
    }
  }
  return markers;
}

// The exit: daylight at the far end of the tunnel, where the illumination begins. The outside
// itself is drawn into the opening later (see main.js); here there's the glare around it, the
// daylight spilling in, and a shape marking the opening for working out where it's visible.
class EndGlow {
  constructor() {
    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(),
        color: 0xe8eeff,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    this.sprite.position.set(0, AXIS_Y, 0.5);
    this.sprite.scale.setScalar(RADIUS * 2.4);
    this.light = new THREE.PointLight(0xe8eeff, 0, 70, 1.6);
    this.light.position.set(0, AXIS_Y, 5);
    this.group = new THREE.Group().add(this.sprite, this.light);
    this.group.position.z = -EXIT;

    // The opening, in a scene of its own: it's only ever rendered into the exit mask
    const opening = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS, 64),
      new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false })
    );
    opening.position.set(0, AXIS_Y, -EXIT);
    this.openingScene = new THREE.Scene().add(opening);
    this.peak = 0;
  }

  setLevel(level) {
    this.sprite.material.opacity = level;
    // How bright the view through the opening is; it stays at its brightest once reached
    this.peak = Math.max(this.peak, level);
    this.light.intensity = 160 * level; // daylight spilling in
  }
}

// The road and ledges stay put; everything on the walls lives in `spin`, centred on the axis.
export function buildTunnel(scene) {
  scene.add(buildRoad(), ...buildLedges());
  const endGlow = new EndGlow();
  scene.add(endGlow.group);

  const spin = new THREE.Group();
  spin.position.y = AXIS_Y;
  const lamps = new Lamps();
  spin.add(buildWalls(), lamps.group, buildMarkers());
  scene.add(spin);
  return { spin, lamps, endGlow };
}
