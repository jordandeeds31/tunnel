import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { roadTextures } from './textures.js';
import { SPEED as ENTRY_SPEED } from './tunnel.js'; // carry on at the tunnel speed

// Out of the tunnel mouth, the road runs down a hillside valley to a beach, golden hour, the sun
// low over the sea and gulls wheeling above the shore. The car picks up a little speed on the
// way down and eases to a stop at the end of the road, looking out to sea. Shot like film.
// Coordinates: the tunnel mouth is at the origin and the road runs down -z, as inside.

const EYE_HEIGHT = 1.35;
const ROAD_WIDTH = 10.8;
const DESCENT = 30; // metres the road drops from the tunnel mouth to the beach
const HILL_START = 10; // metres from the mouth where the road starts to fall
const HILL_END = 330; // ...and where it levels out at the beach
const ROAD_END = 345; // where the road meets the sand
const SEA_LEVEL = -DESCENT - 1.2;
const SHORE = 385; // distance from the mouth to the waterline, in the middle of the bay
const DRIVE_TIME = 45; // seconds from the mouth to the end of the road
const STOP_AT = 335; // where the car comes to rest
// Golden hour: the sun low over the sea, a little right of the road
const SUN_DIR = new THREE.Vector3(0.16, 0.065, -1).normalize();
const SUN_COLOUR = new THREE.Color(1.0, 0.72, 0.42);
const HORIZON = new THREE.Color(0.93, 0.68, 0.45); // warm haze, shared by the sky, sea and fog (linear)

const NOISE = /* glsl */ `
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) {
      v += a * noise(p);
      p = p * 2.03 + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return v;
  }
`;

// Height of the road at distance d from the tunnel mouth.
function roadHeight(d) {
  return -DESCENT * THREE.MathUtils.smootherstep(d, HILL_START, HILL_END);
}

// Distance along the road t seconds after leaving the tunnel: rolling on at the tunnel speed,
// gathering a little pace downhill, then easing to a stop at the end of the road.
function travelled(t) {
  const u = Math.min(t / DRIVE_TIME, 1);
  const h10 = u * u * u - 2 * u * u + u; // Hermite curve: start speed ENTRY_SPEED, end speed 0
  const h01 = -2 * u * u * u + 3 * u * u;
  return h10 * DRIVE_TIME * ENTRY_SPEED + h01 * STOP_AT;
}

// Sky dome: golden haze at the horizon, blue overhead, thin clouds catching the light, and the sun.
function makeSkyDome() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      horizon: { value: HORIZON },
      sunDir: { value: SUN_DIR },
      sunColour: { value: SUN_COLOUR },
    },
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform vec3 horizon;
      uniform vec3 sunDir;
      uniform vec3 sunColour;
      varying vec3 vDir;
      ${NOISE}
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        float toSun = max(dot(d, sunDir), 0.0);

        // Amber at the horizon, through a pale gold band, to soft blue overhead
        vec3 col = mix(pow(horizon, vec3(1.0 / 2.2)), vec3(0.93, 0.80, 0.62), smoothstep(0.0, 0.08, h));
        col = mix(col, vec3(0.56, 0.66, 0.76), smoothstep(0.06, 0.35, h));
        col = mix(col, vec3(0.30, 0.45, 0.64), smoothstep(0.35, 1.0, h));
        // A warm bloom of light around the sun
        col = mix(col, vec3(1.0, 0.78, 0.50), pow(toSun, 6.0) * 0.85);

        // Thin clouds, lit gold on the side towards the sun
        if (d.y > 0.01) {
          vec2 p = d.xz / d.y * 0.45;
          float ang = -0.55;
          vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p;
          q *= vec2(1.1, 3.0);
          q.x += time * 0.012;
          vec2 warp = vec2(fbm(q * 0.7 + time * 0.004), fbm(q * 0.7 + 5.2));
          float cloud = smoothstep(0.45, 0.92, fbm(q + 1.6 * warp)) * smoothstep(0.02, 0.25, d.y);
          vec3 cloudCol = mix(vec3(0.90, 0.80, 0.72), vec3(1.0, 0.82, 0.58), pow(toSun, 3.0));
          col = mix(col, cloudCol, cloud * 0.55);
        }
        vec3 lin = pow(col, vec3(2.2)); // authored in sRGB, output linear

        // The sun itself: a blinding disc and glare, bright enough to bloom
        float disc = smoothstep(0.99955, 0.99975, toSun);
        lin += sunColour * (disc * 8.0 + pow(toSun, 600.0) * 1.5 + pow(toSun, 60.0) * 0.35);
        gl_FragColor = vec4(lin, 1.0);
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(2000, 48, 24), material);
  dome.renderOrder = -1;
  return dome;
}

// Smooth 2D value noise and fractal sums of it, for shaping and colouring the land.
function hash2(x, z) {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function noise2(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  let fx = x - xi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
function fbm2(x, z, octaves = 5) {
  let v = 0, amp = 0.5;
  for (let i = 0; i < octaves; i++) {
    v += amp * noise2(x, z);
    x = x * 2.07 + 13.1;
    z = z * 2.07 + 7.7;
    amp *= 0.5;
  }
  return v; // roughly 0..1
}

// Grass seen up close: short blades in clumps. Grey, so the land's colours show through,
// and used as a bump map too so the low sun catches it.
function grassDetailTexture() {
  const S = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 40 + Math.random() * 120;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const v = Math.random() < 0.5 ? 70 : 200;
    g.addColorStop(0, `rgba(${v},${v},${v},0.25)`);
    g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.lineCap = 'round';
  for (let i = 0; i < 26000; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const len = 6 + Math.random() * 16, lean = (Math.random() - 0.5) * 0.9;
    const v = 60 + Math.random() * 190;
    ctx.strokeStyle = `rgba(${v},${v},${v},0.55)`;
    ctx.lineWidth = 0.8 + Math.random() * 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + lean * len, y - len);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(450, 350);
  tex.anisotropy = 16;
  return tex;
}

// Height of the land: the valley the road runs down, rising into rolling hills either side
// that run out into the sea as headlands, and the beach and seabed around a curved bay.
function landHeight(x, z) {
  const d = -z;
  const side = Math.abs(x);
  const shore = SHORE + 25 * Math.cos(x * 0.008); // the bay curves in at the middle
  let base = roadHeight(Math.min(d, ROAD_END));
  if (d > shore - 40) base = THREE.MathUtils.lerp(base, SEA_LEVEL + 0.6, THREE.MathUtils.smoothstep(d, shore - 40, shore));
  if (d > shore) base = SEA_LEVEL + 0.6 - (d - shore) * 0.06; // shelving into the water

  const ridge = 24 + 14 * Math.sin(z * 0.011 + (x > 0 ? 1.7 : 0.3)) + 30 * (fbm2(x * 0.004, z * 0.004) - 0.5);
  const rise = THREE.MathUtils.smoothstep(side, 14, 240) ** 1.4 * ridge;
  // Near the sea the hills only survive well to the sides, as headlands framing the bay
  const headland = THREE.MathUtils.lerp(1, THREE.MathUtils.smoothstep(side, 180, 420), THREE.MathUtils.smoothstep(d, shore - 80, shore + 40));

  // Rolling ground, gullies and hummocks, fading out on the flat verge beside the road
  const away = THREE.MathUtils.smoothstep(side, 9, 45);
  const roll = (fbm2(x * 0.018, z * 0.018) - 0.5) * 9 * away;
  const gully = -Math.abs(noise2(x * 0.03 + 4.2, z * 0.012) - 0.5) * 4 * away;
  const hummocks = (fbm2(x * 0.2, z * 0.2, 3) - 0.5) * 0.7 * THREE.MathUtils.smoothstep(side, 7, 14);
  const land = (rise + roll + gully) * headland + hummocks * headland;
  const h = base + land - 0.06;
  // Keep the land above water until the shoreline, so the noise can't leave stray pools
  return d < shore ? Math.max(h, SEA_LEVEL + 0.35) : h;
}

function buildLand() {
  const geo = new THREE.PlaneGeometry(1800, 1400, 450, 350).rotateX(-Math.PI / 2);
  geo.translate(0, 0, -500);
  const pos = geo.attributes.position;
  const colours = [];
  const c = new THREE.Color();
  const lush = new THREE.Color(0.17, 0.25, 0.07), meadow = new THREE.Color(0.3, 0.34, 0.12);
  const dry = new THREE.Color(0.55, 0.46, 0.2), earth = new THREE.Color(0.36, 0.29, 0.2);
  const rock = new THREE.Color(0.42, 0.38, 0.33);
  const sand = new THREE.Color(0.86, 0.72, 0.52), wetSand = new THREE.Color(0.55, 0.45, 0.33);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = landHeight(x, z);
    pos.setY(i, y);
    const slope = Math.hypot(landHeight(x + 1, z) - y, landHeight(x, z + 1) - y);
    const above = y - SEA_LEVEL;

    // Greener in the hollows, drier and golden on the ridges and exposed slopes, in patches
    const patch = fbm2(x * 0.012 + 50, z * 0.012, 4);
    const exposure = THREE.MathUtils.clamp((y - roadHeight(Math.min(-z, ROAD_END))) / 40, 0, 1);
    c.copy(lush).lerp(meadow, THREE.MathUtils.smoothstep(patch, 0.3, 0.55));
    c.lerp(dry, THREE.MathUtils.clamp(exposure * 0.8 + (patch - 0.5) * 1.2, 0, 1));
    c.multiplyScalar(0.85 + 0.3 * fbm2(x * 0.08, z * 0.08, 3));
    // Bare earth, then rock, where it gets steep
    c.lerp(earth, THREE.MathUtils.smoothstep(slope, 0.35, 0.6));
    c.lerp(rock, THREE.MathUtils.smoothstep(slope, 0.6, 1.0));
    // Sand down at the shore
    if (above < 4) c.lerp(sand, THREE.MathUtils.smoothstep(4 - above, 0, 2.5));
    if (above < 0.9) c.lerp(wetSand, THREE.MathUtils.smoothstep(0.9 - above, 0, 0.6));
    colours.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geo.computeVertexNormals();
  const detail = grassDetailTexture();
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ map: detail, bumpMap: detail, bumpScale: 2, vertexColors: true, roughness: 1 })
  );
}

// Tufts of grass along both verges, thinning out with distance from the road, swaying in the wind.
function buildGrass() {
  // One tuft: a handful of tapered, leaning blades, darker at the root
  const pos = [], col = [], nrm = [];
  const blades = 9;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + Math.random();
    const h = 0.18 + Math.random() * 0.3, w = 0.018;
    const lean = 0.06 + Math.random() * 0.14;
    const spread = 0.08 * Math.random(); // blades rise from across a little patch, not one point
    const ox = Math.cos(a + 1.3) * spread, oz = Math.sin(a + 1.3) * spread;
    const dx = Math.cos(a), dz = Math.sin(a); // lean direction
    const px = -dz, pz = dx; // across the blade
    const at = (t) => [ox + dx * lean * t * t, h * t, oz + dz * lean * t * t];
    const rows = [0, 0.5, 1].map((t) => ({ t, p: at(t), w: w * (1 - t) }));
    for (let r = 0; r < 2; r++) {
      const [a0, a1] = [rows[r], rows[r + 1]];
      const quad = [
        [a0.p[0] - px * a0.w, a0.p[1], a0.p[2] - pz * a0.w, a0.t],
        [a0.p[0] + px * a0.w, a0.p[1], a0.p[2] + pz * a0.w, a0.t],
        [a1.p[0] + px * a1.w, a1.p[1], a1.p[2] + pz * a1.w, a1.t],
        [a1.p[0] - px * a1.w, a1.p[1], a1.p[2] - pz * a1.w, a1.t],
      ];
      for (const k of [0, 1, 2, 0, 2, 3]) {
        const [x, y, z, t] = quad[k];
        pos.push(x, y, z);
        const shade = 0.55 + 0.6 * t; // darker at the root, sunlit at the tip
        col.push(shade, shade, shade);
        nrm.push(0, 1, 0); // lit like the ground, so blades don't flicker dark as they turn
      }
    }
  }
  const tuft = new THREE.BufferGeometry();
  tuft.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  tuft.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  tuft.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));

  // A little of the sun's warmth shows through the blades, as it does in low light
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    side: THREE.DoubleSide,
    emissive: new THREE.Color(0.16, 0.11, 0.03),
  });
  const wind = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.windTime = wind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float windTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec2 root = instanceMatrix[3].xz;
        float gust = sin(windTime * 1.3 + root.x * 0.15 + root.y * 0.1) * 0.5 + sin(windTime * 2.9 + root.x * 0.7) * 0.2;
        transformed.x += gust * position.y * position.y * 0.35;
        transformed.z += gust * position.y * position.y * 0.15;`
      );
  };

  const count = 32000;
  const grass = new THREE.InstancedMesh(tuft, material, count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  const greens = [new THREE.Color(0.36, 0.44, 0.14), new THREE.Color(0.5, 0.5, 0.18), new THREE.Color(0.72, 0.6, 0.28)];
  const up = new THREE.Vector3(0, 1, 0);
  let placed = 0;
  for (let tries = 0; placed < count && tries < count * 3; tries++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = side * (ROAD_WIDTH / 2 + 0.5 + Math.random() ** 2.4 * 55); // thickest along the verge
    const d = Math.random() * ROAD_END;
    const y = landHeight(x, -d);
    if (y - SEA_LEVEL < 3.5) continue; // no grass on the beach
    q.setFromAxisAngle(up, Math.random() * Math.PI * 2);
    const s = 0.8 + Math.random() * 0.8;
    m.compose(new THREE.Vector3(x, y, -d), q, new THREE.Vector3(s, s * (0.8 + Math.random() * 0.5), s));
    grass.setMatrixAt(placed, m);
    const shade = greens[Math.floor(Math.random() * greens.length)];
    grass.setColorAt(placed, c.copy(shade).lerp(greens[2], Math.random() * 0.4));
    placed++;
  }
  grass.count = placed;
  grass.frustumCulled = false;
  grass.userData.wind = wind;
  return grass;
}

// The road, following the hill down to the beach.
function buildRoad() {
  const tile = 20;
  const segs = 240;
  const geo = new THREE.PlaneGeometry(ROAD_WIDTH, ROAD_END, 1, segs).rotateX(-Math.PI / 2);
  geo.translate(0, 0, -ROAD_END / 2);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, roadHeight(-pos.getZ(i)));
    // Repeat the road texture every `tile` metres, lining up with the markings in the tunnel
    uv.setY(i, (1 - uv.getY(i)) * (ROAD_END / tile));
  }
  geo.computeVertexNormals();
  // Dry asphalt in the sun: a soft, broad sheen rather than the polished tyre tracks of the tunnel
  const { map, bumpMap } = roadTextures(ROAD_WIDTH, tile);
  const mat = new THREE.MeshStandardMaterial({ map, bumpMap, bumpScale: 1.5, roughness: 0.92 });
  return new THREE.Mesh(geo, mat);
}

// The sea: rolling swell that mirrors the golden sky, with a glittering path under the sun.
function makeSea() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      camPos: { value: new THREE.Vector3() },
      sunDir: { value: SUN_DIR },
      sunColour: { value: SUN_COLOUR },
      horizon: { value: HORIZON },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform vec3 camPos;
      uniform vec3 sunDir;
      uniform vec3 sunColour;
      uniform vec3 horizon;
      varying vec3 vWorld;
      ${NOISE}

      // Slope of a sum of travelling waves, as a surface normal
      vec3 waveNormal(vec2 p) {
        vec2 g = vec2(0.0);
        vec2 dirs[6];
        dirs[0] = normalize(vec2(0.2, 1.0)); dirs[1] = normalize(vec2(-0.5, 0.9));
        dirs[2] = normalize(vec2(0.8, 0.6)); dirs[3] = normalize(vec2(-0.9, 0.3));
        dirs[4] = normalize(vec2(0.3, -1.0)); dirs[5] = normalize(vec2(1.0, -0.2));
        float k = 0.12, a = 0.05;
        for (int i = 0; i < 6; i++) {
          float phase = dot(dirs[i], p) * k + time * sqrt(9.8 * k);
          g += dirs[i] * a * cos(phase);
          k *= 1.7;
          a *= 0.78;
        }
        return normalize(vec3(-g.x, 1.0, -g.y));
      }

      void main() {
        vec3 toCam = camPos - vWorld;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        // Calm the ripples with distance, so the far sea doesn't shimmer
        vec3 N = normalize(mix(waveNormal(vWorld.xz), vec3(0.0, 1.0, 0.0), smoothstep(150.0, 3000.0, dist) * 0.6));

        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        float toSun = max(dot(R, sunDir), 0.0);

        // What the water reflects: the golden horizon, the blue above, the glow of the sun
        vec3 sky = mix(horizon, vec3(0.25, 0.34, 0.47), smoothstep(0.0, 0.5, R.y));
        sky += sunColour * pow(toSun, 8.0) * 0.8;
        vec3 deep = vec3(0.02, 0.06, 0.08);
        vec3 col = mix(deep, sky, fresnel);

        // The sun's path on the water: a soft golden column, and sparkles flickering on the
        // wave facets that happen to catch it
        col += sunColour * pow(toSun, 60.0) * 0.5;
        float path = smoothstep(0.93, 0.995, toSun);
        vec2 cell = floor(vWorld.xz * vec2(1.5, 0.6));
        float sparkle = step(0.93, hash(cell + floor(time * 5.0 + hash(cell) * 5.0)));
        col += sunColour * path * sparkle * 2.5;

        // Haze towards the horizon
        col = mix(col, horizon, smoothstep(300.0, 4000.0, dist) * 0.8);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000).rotateX(-Math.PI / 2), material);
  sea.position.set(0, SEA_LEVEL, -SHORE - 6000);
  return sea;
}

// Film look, applied last in display space: a warm film stock, grain and a little vignetting.
function makeFilmPass() {
  return new ShaderPass({
    uniforms: { tDiffuse: { value: null }, time: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float time;
      varying vec2 vUv;
      ${NOISE}
      void main() {
        vec3 c = texture2D(tDiffuse, vUv).rgb;

        // Film stock: a little less saturated, lifted blacks, warm highlights
        c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, 0.85);
        c = c * 0.9 + vec3(0.05, 0.045, 0.035);
        c *= vec3(1.03, 1.0, 0.96);

        // Grain and a touch of vignetting
        float n = hash(gl_FragCoord.xy + fract(time) * 97.0) - 0.5;
        c += n * 0.07;
        c *= mix(0.9, 1.0, smoothstep(1.1, 0.4, length(vUv - 0.5)));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

// Wing outlines in the XZ plane: x runs out along the wing, shape-y runs forward (-z).
function flatShape(points) {
  return new THREE.ShapeGeometry(new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)))).rotateX(
    -Math.PI / 2
  );
}

// A simple gull, about 1.6 m across (before scaling), seen from below. Local -z is forward.
class Gull {
  // It wheels around `center`, always showing its underside to an observer at `eye`.
  constructor(center, eye, { radius = 7, speed = 0.13, phase = 0, scale = 1.6 } = {}) {
    this.radius = radius;
    this.speed = speed;
    this.phase = phase;
    const shade = new THREE.MeshBasicMaterial({ color: 0x57524d, side: THREE.DoubleSide, fog: false });
    const wing = new THREE.MeshBasicMaterial({ color: 0x6b655e, side: THREE.DoubleSide, fog: false });
    const tips = new THREE.MeshBasicMaterial({ color: 0x141312, side: THREE.DoubleSide, fog: false });

    this.group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), shade);
    body.scale.set(0.13, 0.11, 0.5);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), shade);
    head.position.set(0, 0.02, -0.27);
    const tail = new THREE.Mesh(flatShape([[-0.05, -0.2], [0.05, -0.2], [0.08, -0.36], [-0.08, -0.36]]), shade);
    this.body = new THREE.Group().add(body, head, tail);
    this.body.scale.setScalar(scale);
    this.group.add(this.body);

    // Each wing hinges at the shoulder and again at the wrist, for the gull's M-shaped glide
    this.wings = [1, -1].map((side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.05, 0.02, -0.04);
      shoulder.scale.x = side;
      shoulder.add(new THREE.Mesh(flatShape([[0, 0.12], [0.34, 0.08], [0.34, -0.07], [0, -0.14]]), wing));

      const wrist = new THREE.Group();
      wrist.position.x = 0.34;
      wrist.add(
        new THREE.Mesh(flatShape([[0, 0.08], [0.2, 0.06], [0.46, -0.1], [0.4, -0.12], [0, -0.07]]), wing),
        new THREE.Mesh(flatShape([[0.26, 0.03], [0.46, -0.1], [0.4, -0.12], [0.24, -0.06]]), tips)
      );
      wrist.children[1].position.y = 0.002;
      shoulder.add(wrist);
      this.body.add(shoulder);
      return { side, shoulder, wrist };
    });

    // Loop in the plane facing the observer, so the gull is always seen from below
    this.center = center;
    this.eye = eye;
    this.view = center.clone().sub(eye).normalize();
    this.across = new THREE.Vector3().crossVectors(this.view, new THREE.Vector3(0, 1, 0)).normalize();
    this.upward = new THREE.Vector3().crossVectors(this.across, this.view).normalize();
    this.pos = new THREE.Vector3();
    this.ahead = new THREE.Vector3();
    this.behind = new THREE.Vector3();
    this.basis = new THREE.Matrix4();
  }

  // Where the gull is at time t: wheeling slowly on a wide loop overhead
  path(t, target) {
    const a = t * this.speed + this.phase;
    return target
      .copy(this.center)
      .addScaledVector(this.across, Math.cos(a) * this.radius)
      .addScaledVector(this.upward, Math.sin(a) * this.radius * 0.45)
      .addScaledVector(this.view, Math.sin(a * 2) * this.radius * 0.15);
  }

  update(t) {
    this.path(t, this.pos);
    this.path(t + 0.2, this.ahead);
    this.path(t - 0.2, this.behind);
    this.group.position.copy(this.pos);

    // Nose along the path, back turned away from the observer
    const forward = new THREE.Vector3().subVectors(this.ahead, this.pos).normalize();
    const back = this.pos.clone().sub(this.eye).normalize();
    back.addScaledVector(forward, -back.dot(forward)).normalize();
    const tail = forward.clone().negate(); // local +z
    const side = new THREE.Vector3().crossVectors(back, tail);
    this.basis.makeBasis(side, back, tail);
    this.group.quaternion.setFromRotationMatrix(this.basis);

    // A gentle bank into the turn
    const bend = new THREE.Vector3()
      .subVectors(this.ahead, this.pos)
      .cross(new THREE.Vector3().subVectors(this.pos, this.behind))
      .dot(this.view);
    this.group.rotateZ(THREE.MathUtils.clamp(bend * 2, -0.3, 0.3));

    // Mostly gliding, with a burst of flapping every few seconds (each gull on its own rhythm)
    const cycle = (t + this.phase * 3) % 6;
    const flapping = THREE.MathUtils.smoothstep(cycle, 0, 0.3) * (1 - THREE.MathUtils.smoothstep(cycle, 1.2, 1.7));
    const beat = t * 10;
    for (const { side: s, shoulder, wrist } of this.wings) {
      shoulder.rotation.z = s * (0.12 + flapping * 0.6 * Math.sin(beat));
      wrist.rotation.z = -0.15 + flapping * 0.4 * Math.sin(beat - 0.6);
    }
  }
}

export class Outside {
  constructor(renderer) {
    this.renderer = renderer;
    this.clock = 0; // runs from page load, for clouds and the gulls
    this.driveTime = null; // seconds since driving out of the tunnel, once we have
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(HORIZON, 200, 1600);
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 9000);

    this.dome = makeSkyDome();
    this.sea = makeSea();
    this.grass = buildGrass();
    this.scene.add(this.dome, this.sea, buildLand(), buildRoad(), this.grass);

    // Golden-hour sun, low over the sea, with cool skylight filling the shadows
    const sun = new THREE.DirectionalLight(SUN_COLOUR, 2.6);
    sun.position.copy(SUN_DIR).multiplyScalar(1000);
    this.scene.add(sun, new THREE.HemisphereLight(0x9fb4c8, 0x6b5236, 0.8));

    // Gulls along the whole way down: some just past the tunnel mouth, the rest over the hill
    // and the beach. `d` is distance along the road, `x` across it, `h` height above it.
    const flock = [
      { d: 45, x: -8, h: 13, radius: 7, speed: 0.13, phase: 0.0, scale: 2.0 },
      { d: 70, x: 12, h: 17, radius: 9, speed: 0.11, phase: 2.1, scale: 2.2 },
      { d: 110, x: -16, h: 21, radius: 11, speed: 0.1, phase: 4.0, scale: 2.2 },
      { d: 170, x: 20, h: 18, radius: 10, speed: 0.12, phase: 1.2, scale: 2.2 },
      { d: 240, x: -6, h: 24, radius: 13, speed: 0.09, phase: 3.3, scale: 2.4 },
      { d: 320, x: 14, h: 20, radius: 9, speed: 0.13, phase: 5.1, scale: 2.2 },
      { d: 390, x: -12, h: 17, radius: 10, speed: 0.12, phase: 0.7, scale: 2.2 },
      { d: 430, x: 22, h: 26, radius: 15, speed: 0.08, phase: 2.8, scale: 2.6 },
    ];
    this.gulls = flock.map(({ d, x, h, ...options }) => {
      // Seen from a little way back down the road, so each shows its underside as you approach
      const viewer = Math.min(d - 40, STOP_AT);
      const eye = new THREE.Vector3(0, roadHeight(viewer) + EYE_HEIGHT, -viewer);
      const center = new THREE.Vector3(x, roadHeight(Math.min(d, ROAD_END)) + h, -d);
      const gull = new Gull(center, eye, options);
      this.scene.add(gull.group);
      return gull;
    });

    const pixelRatio = renderer.getPixelRatio();
    this.composer = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget(window.innerWidth * pixelRatio, window.innerHeight * pixelRatio, {
        type: THREE.HalfFloatType,
        samples: 4,
      })
    );
    this.film = makeFilmPass();
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Only the sun and its glints off the road are bright enough to bloom
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.3, 1.2));
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.film);
    this.resize(window.innerWidth, window.innerHeight);
    this.target = new THREE.Vector3();

  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.composer.setSize(width, height);
  }

  // The finished frame when rendered off-screen, for showing through the tunnel exit
  get texture() {
    return this.composer.readBuffer.texture;
  }

  // Still inside: look out through the exit from the tunnel camera's point of view.
  // `exitZ` is where the tunnel mouth sits in the tunnel's coordinates (this scene's origin).
  viewFrom(tunnelCamera, exitZ) {
    this.camera.position.copy(tunnelCamera.position);
    this.camera.position.z -= exitZ;
    this.camera.quaternion.copy(tunnelCamera.quaternion);
  }

  // Out on the road: down the hill to the beach, looking along the road ahead
  drive(dt) {
    this.driveTime = (this.driveTime ?? 0) + dt;
    const t = this.driveTime;
    const s = travelled(t);
    this.camera.position.set(0, roadHeight(s) + EYE_HEIGHT, -s);
    // Look down the hill along the road; it levels out as the road does
    const ahead = s + 60;
    this.target.set(Math.sin(t * 0.07) * 0.3, roadHeight(ahead) + EYE_HEIGHT * 0.3, -ahead);
    this.camera.lookAt(this.target);
  }

  render(dt, { toScreen }) {
    this.clock += dt;
    this.dome.position.copy(this.camera.position);
    for (const gull of this.gulls) gull.update(this.clock);

    this.dome.material.uniforms.time.value = this.clock;
    this.sea.material.uniforms.time.value = this.clock;
    this.grass.userData.wind.value = this.clock;
    this.sea.material.uniforms.camPos.value.copy(this.camera.position);
    this.film.uniforms.time.value = this.clock;

    // The outside is authored in display colours; the tunnel uses filmic tone mapping
    const toneMapping = this.renderer.toneMapping;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.composer.renderToScreen = toScreen;
    this.composer.render();
    this.renderer.toneMapping = toneMapping;
  }
}
