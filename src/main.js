import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { buildTunnel, EXIT, SPEED } from './tunnel.js';
import { Outside } from './outside.js';
import { onShopClick } from './shop.js';

const canvas = document.querySelector('#app');

// Renderer
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // capped: three scenes render each frame
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;

// Scene & camera
const makeFog = () => new THREE.Fog(0x000000, 60, 520);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = makeFog();

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 600);


const { spin, lamps, endGlow } = buildTunnel(scene);
const ambient = new THREE.HemisphereLight(0x8a939e, 0x1a1a1a, 0);
scene.add(ambient);

const SPIN_SPEED = 0.15; // radians per second
// From deep in the tunnel the exit is just blinding light; the outside comes into view
// through it as you get closer and your eyes adjust.
const GLARE_FAR = 170; // metres from the exit: nothing but glare
const GLARE_NEAR = 50; // metres from the exit: the outside fully visible
// It begins as a faint light at the far end of the tunnel, which slowly grows until the lamps
// start striking, far to near. A lit front sweeps in from the far end towards the camera; each
// halving of its distance takes equal time, so the lit region grows steadily on screen.
const LIGHT_UP_DELAY = 5; // seconds of the end glow alone before the first lamps
const LIGHT_UP_DURATION = 45; // seconds from the furthest pair to the nearest
const END_GLOW_START = 0.04; // barely visible
const LIGHT_UP_WARM = 1.6; // seconds for a pair to warm up to full after it strikes
const AMBIENT_MAX = 0.18;
const BLOOM_BASE = 0.35;
const BLOOM_SURGE = 0.5; // extra bloom when the final pair comes on

// Post-processing: bloom on the lamps, then a muted, grainy photographic grade
// Multisampled render target: the composer would otherwise render without anti-aliasing,
// leaving the distant rings shimmering and soft.
const pixelRatio = renderer.getPixelRatio();
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(window.innerWidth * pixelRatio, window.innerHeight * pixelRatio, {
    type: THREE.HalfFloatType,
    samples: 4,
  })
);
const renderPass = new RenderPass(scene, camera);
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), BLOOM_BASE, 0.2, 0.95);
const grade = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    tOutside: { value: null }, // the outside, as seen from here
    tMask: { value: null }, // where the exit opening is visible
    exitLevel: { value: 1 },
    exitGlare: { value: 1 }, // 1 = the opening is just blinding light
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform sampler2D tOutside;
    uniform sampler2D tMask;
    uniform float exitLevel;
    uniform float exitGlare;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(vec3(l), c.rgb, 0.55);
      float n = fract(sin(dot(vUv * 1000.0 + time, vec2(12.9898, 78.233))) * 43758.5453);
      c.rgb += (n - 0.5) * 0.045;
      c.rgb *= mix(0.55, 1.0, smoothstep(0.95, 0.3, length(vUv - 0.5)));
      // Through the opening, the outside exactly as it will look once we're out there
      float m = texture2D(tMask, vUv).r;
      vec3 view = mix(texture2D(tOutside, vUv).rgb, vec3(1.0, 0.99, 0.97), exitGlare);
      c.rgb = mix(c.rgb, view * exitLevel, m);
      gl_FragColor = c;
    }`,
});
composer.addPass(renderPass);
composer.addPass(bloom);
composer.addPass(new OutputPass());
composer.addPass(grade);

// Press "O" to toggle an orbit view of the whole tunnel
const orbitCamera = new THREE.PerspectiveCamera(60, camera.aspect, 1, 3000);
orbitCamera.position.set(30, 20, 25);
const controls = new OrbitControls(orbitCamera, canvas);
controls.target.set(0, 2, -60);
controls.enableDamping = true;
controls.enabled = false;
let orbiting = false;

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'o') {
    orbiting = !orbiting;
    controls.enabled = orbiting;
    scene.fog = orbiting ? null : makeFog();
    renderPass.camera = orbiting ? orbitCamera : camera;
  }
});

window.addEventListener('resize', () => {
  for (const cam of [camera, orbitCamera]) {
    cam.aspect = window.innerWidth / window.innerHeight;
    cam.updateProjectionMatrix();
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  outside.resize(window.innerWidth, window.innerHeight);
  exitMask.setSize(window.innerWidth, window.innerHeight);
});

// Brightness while a lamp strikes: a few stutters, then a smooth warm-up.
const FLICKER = [[0, 0.7], [0.07, 0], [0.22, 0.45], [0.3, 0.05], [0.42, 0.9], [0.48, 0.2]];
const FLICKER_END = 0.6;

function strike(t) {
  if (t < 0) return 0;
  if (t < FLICKER_END) {
    let level = 0;
    for (const [at, value] of FLICKER) if (t >= at) level = value;
    return level;
  }
  const warm = THREE.MathUtils.clamp((t - FLICKER_END) / LIGHT_UP_WARM, 0, 1);
  return 0.3 + 0.7 * THREE.MathUtils.smootherstep(warm, 0, 1);
}

// Distance along the tunnel (from where the camera starts) beyond which lamps are lit, at a
// given time. It's fixed to the tunnel rather than the camera, so as you drive in you meet the
// wave of light coming the other way and it passes you.
const NEAR = 10; // offset that keeps the front from crawling as it reaches the camera
function litFront(elapsed) {
  const x = (elapsed - LIGHT_UP_DELAY) / LIGHT_UP_DURATION;
  if (x < 0) return Infinity;
  if (x >= 1) return -Infinity; // everything, including lamps behind us
  const far = Math.log(EXIT + NEAR), near = Math.log(NEAR);
  return Math.exp(far + (near - far) * x) - NEAR;
}
const LIGHT_UP_END = LIGHT_UP_DELAY + LIGHT_UP_DURATION;

function updateLightUp(elapsed, camS) {
  const { smoothstep } = THREE.MathUtils;
  endGlow.setLevel(
    END_GLOW_START +
      (0.35 - END_GLOW_START) * smoothstep(elapsed, 0, LIGHT_UP_DELAY) +
      0.65 * smoothstep(elapsed, LIGHT_UP_DELAY, LIGHT_UP_DELAY + 10) -
      // settle back once the lamps have taken over, so it doesn't haze the view
      0.7 * smoothstep(elapsed, LIGHT_UP_DELAY + 10, LIGHT_UP_DELAY + LIGHT_UP_DURATION)
  );

  const front = litFront(elapsed);
  let total = 0;
  lamps.pairs.forEach((pair, i) => {
    if (pair.strikeAt === null && pair.s >= front) pair.strikeAt = elapsed;
    const level = pair.strikeAt === null ? 0 : strike(elapsed - pair.strikeAt);
    total += level;
    if (level !== pair.level) lamps.setLevel(i, level);
  });
  ambient.intensity = AMBIENT_MAX * (total / lamps.count);

  const sinceFinal = elapsed - LIGHT_UP_END - FLICKER_END;
  bloom.strength = BLOOM_BASE + (sinceFinal > 0 ? BLOOM_SURGE * Math.exp(-sinceFinal * 1.2) : 0);
}

// The sequence starts part-way into the light-up: the exit glowing and the far lamps on,
// the rest dark. It plays on its own from there.
const OPENING_MOMENT = 24; // seconds into the light-up sequence to start from
let elapsed = OPENING_MOMENT; // seconds into the light-up sequence
let spinTime = 0;

// Lamps already lit at the opening moment start fully on, not mid-flicker
const openingFront = litFront(OPENING_MOMENT);
for (const pair of lamps.pairs) if (pair.s >= openingFront) pair.strikeAt = -Infinity;

document.querySelector('#shop').addEventListener('click', onShopClick);

// The world beyond the exit. Until we reach it, it's rendered off-screen from our point of
// view and shown through the opening; once we pass through, it takes over the screen.
const outside = new Outside(renderer);
outside.composer.setPixelRatio(pixelRatio * 0.5); // it only fills the opening while we're inside
let isOutside = false;

// Which pixels see out through the opening: the tunnel in black (hiding the lamp glows,
// which shouldn't block the view), then the opening in white wherever it isn't hidden.
const exitMask = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { samples: 4 });
const maskMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
const glows = [];
scene.traverse((o) => o.isSprite && glows.push(o));

function renderExitMask() {
  for (const g of glows) g.visible = false;
  scene.overrideMaterial = maskMaterial;
  renderer.setRenderTarget(exitMask);
  renderer.render(scene, camera);
  renderer.autoClear = false;
  renderer.render(endGlow.openingScene, camera);
  renderer.autoClear = true;
  renderer.setRenderTarget(null);
  scene.overrideMaterial = null;
  for (const g of glows) g.visible = true;
}
grade.uniforms.tMask.value = exitMask.texture;

// Animation loop
const timer = new THREE.Timer();
let camS = 0;
if (location.hash === '#outside') camS = EXIT - 30; // shortcut for working on the exit: open the page at #outside
// Temporary: the Skip to exit button drops you just before the exit
document.querySelector('#skip')?.addEventListener('click', () => {
  camS = Math.max(camS, EXIT - 1);
});
const lookTarget = new THREE.Vector3();

function frame(time) {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.1);
  if (isOutside) {
    outside.drive(dt);
    outside.render(dt, { toScreen: true });
    return;
  }
  spinTime += dt;
  elapsed += dt;
  camS += SPEED * dt;

  // Through the exit: the outside takes over, carrying on from exactly this view
  if (camS >= EXIT) {
    isOutside = true;
    document.body.classList.add('outside');
    outside.composer.setPixelRatio(pixelRatio);
    outside.drive(dt);
    outside.render(dt, { toScreen: true });
    return;
  }

  camera.position.set(0, 1.35, -camS);
  camera.lookAt(lookTarget.set(0, 1.35, -camS - 25)); // level, as it will be driving out
  lamps.update(camS);

  spin.rotation.z = spinTime * SPIN_SPEED;
  updateLightUp(elapsed, camS);
  grade.uniforms.time.value = timer.getElapsed() % 100;

  // The outside as seen from here, and where it shows through the opening. Far off the
  // opening is pure glare, so the outside isn't rendered until it starts to show.
  const glare = THREE.MathUtils.smoothstep(EXIT - camS, GLARE_NEAR, GLARE_FAR);
  if (glare < 1) {
    outside.viewFrom(camera, -EXIT);
    outside.render(dt, { toScreen: false });
  } else {
    outside.clock += dt;
  }
  renderExitMask();
  grade.uniforms.tOutside.value = outside.texture;
  grade.uniforms.exitLevel.value = endGlow.peak;
  grade.uniforms.exitGlare.value = glare;

  if (orbiting) controls.update();
  composer.render();
}

// Compile every shader up front, without blocking the page, before the first frame. Doing it
// on the first frame instead can lock the browser up for a long time.
const LOADER_MIN_TIME = 1200; // ms: long enough that the loader never just flashes
const COMPILE_TIMEOUT = 8000; // ms: the browser occasionally never reports a shader as ready
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
Promise.all([
  Promise.race([
    Promise.all([renderer.compileAsync(scene, camera), renderer.compileAsync(outside.scene, outside.camera)]),
    wait(COMPILE_TIMEOUT), // start anyway; anything unfinished completes on the first frames
  ]),
  wait(LOADER_MIN_TIME - performance.now()),
]).then(() => {
  // The loader fades away to black first; only then does the tunnel start and fade in, so the
  // two never overlap
  const loader = document.querySelector('#loader');
  loader.classList.add('done');
  loader.addEventListener(
    'transitionend',
    () => {
      loader.remove();
      renderer.setAnimationLoop(frame);
      requestAnimationFrame(() => document.body.classList.add('ready'));
    },
    { once: true }
  );
});
