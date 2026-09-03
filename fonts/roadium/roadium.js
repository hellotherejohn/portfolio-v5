import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

// ---------- tunables, carried over from the glb-viewer dev tool defaults ----------

const MODEL_URL = 'assets/crbn-01-baked-1024.glb';
const HDRI_URL = 'assets/monochrome_studio_02_512.hdr';

const LIGHT_RIG = {
  ambient: 0.5,
  environmentIntensity: 0.9,
  environmentRotation: 67,
  lights: {
    key:  { azimuth: 1,   elevation: 62, distance: 2.3, angle: 32, penumbra: 0.64, color: '#fff3df', intensity: 0, decay: 0.25 },
    fill: { azimuth: 55,  elevation: 15, distance: 4.0, angle: 45, penumbra: 0.55, color: '#d7e6ff', intensity: 0, decay: 0 },
    rim:  { azimuth: 175, elevation: 45, distance: 3.2, angle: 28, penumbra: 0.4,  color: '#ffffff', intensity: 0, decay: 0 },
  },
};

const MATERIAL = {
  metalnessFactor: 1.25,
  roughnessFactor: 1.25,
  metalnessFloor: 0.29,
  metalnessCeil: 0.9,
  roughnessFloor: 0.19,
  roughnessCeil: 1,
};

const TILT_Z = -30;       // fixed lean, doesn't change with scroll
const TILT_X_ENTER = 0;  // tilt X as #stage enters the viewport
const TILT_X_LEAVE = 60; // tilt X as #stage leaves the viewport
const IDLE_SPIN_DEG_PER_SEC = 6;
const SPIN_START_DEG = 145;
const SCROLL_SMOOTHING = 14; // higher = snappier tracking, lower = laggier/smoother

// "Radio waves" background rings — center matches the model (canvasHost is
// 360px tall starting at top:155px, so its visual center sits at 155+180).
const STAGE_W = 960, STAGE_H = 680;
const RING_CENTER_PX = { x: STAGE_W / 2, y: 155 + 180 };
// Life is sized off the stage's half-width (960/2 = 480px) rather than its
// height, so rings are faded out at roughly the point they'd reach the left
// or right edges, not the (much farther) top/bottom.
const RING_SPAWN_INTERVAL_MS = 4000;
const RING_SPEED_PX_PER_SEC = 25;
const RING_FADE_START_SEC = 10; // full opacity through the first half of life...
const RING_FADE_END_SEC = 20;   // ...then fades out over the second half
const RING_STROKE_PX = 1;
const RING_OPACITY = 0.10;
const RING_MAX_CONCURRENT = 24;

function smoothstepJS(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ---------- renderer / scene / camera ----------

const host = document.getElementById('canvasHost');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// The `false` here stops three.js from also writing an inline
// style.width/height onto the canvas -- an inline style beats the
// "#canvasHost canvas { width:100%; height:100% }" CSS rule regardless of
// selector specificity, which pinned this canvas at a fixed 360px display
// size even inside a #canvasHost that's now sized responsively (a % of
// #stage). The drawing buffer is still exactly 360x360 either way; only the
// display size handling changes.
renderer.setSize(360, 360, false);
renderer.setClearAlpha(0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.01;
renderer.outputColorSpace = THREE.SRGBColorSpace;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);

const ambientLight = new THREE.AmbientLight(0xffffff, LIGHT_RIG.ambient);
scene.add(ambientLight);

function sphericalPos(azimuthDeg, elevationDeg, radius) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return new THREE.Vector3(
    radius * Math.cos(el) * Math.sin(az),
    radius * Math.sin(el),
    radius * Math.cos(el) * Math.cos(az)
  );
}

function makeSpotLight(cfg) {
  const light = new THREE.SpotLight(new THREE.Color(cfg.color), cfg.intensity);
  light.distance = 0;
  light.angle = THREE.MathUtils.degToRad(cfg.angle);
  light.penumbra = cfg.penumbra;
  light.decay = cfg.decay;
  light.position.copy(sphericalPos(cfg.azimuth, cfg.elevation, cfg.distance));
  const target = new THREE.Object3D();
  scene.add(light, target);
  light.target = target;
  return light;
}
makeSpotLight(LIGHT_RIG.lights.key);
makeSpotLight(LIGHT_RIG.lights.fill);
makeSpotLight(LIGHT_RIG.lights.rim);

// HDRI environment
const pmrem = new THREE.PMREMGenerator(renderer);
new RGBELoader().load(HDRI_URL, (tex) => {
  tex.mapping = THREE.EquirectangularReflectionMapping;

  // Rotate on the horizon the same way glb-viewer does: bake the PMREM from a
  // small scene containing a rotated, texture-wrapped inverted sphere, rather
  // than relying on scene.environmentRotation (not available on three@0.160).
  const bakeScene = new THREE.Scene();
  const bakeSphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, toneMapped: false })
  );
  bakeSphere.rotation.y = THREE.MathUtils.degToRad(LIGHT_RIG.environmentRotation);
  bakeScene.add(bakeSphere);

  scene.environment = pmrem.fromScene(bakeScene).texture;
  applyEnvIntensity();
}, undefined, (err) => console.error('Failed to load HDRI', err));

function applyEnvIntensity() {
  if (!currentModel) return;
  currentModel.traverse(o => {
    if (o.isMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => { if (m) m.envMapIntensity = LIGHT_RIG.environmentIntensity; });
    }
  });
}

// ---------- model transform: fixed lean (Z) + scroll-driven lean (X) + spin ----------

const modelPivot = new THREE.Group();
modelPivot.rotation.z = THREE.MathUtils.degToRad(TILT_Z);
scene.add(modelPivot);

let currentModel = null;
let baseModelScale = 1; // the load-time normalization scale; pop bounce multiplies on top of this
let appliedTiltX = TILT_X_ENTER;
let idleSpinDeg = SPIN_START_DEG;
let kickTween = null; // { fromDeg, toDeg, start, duration }
let popState = null; // { downStart, upStart } -- click "pop" bounce, see currentPopScale

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Ease-out only (starts at full speed, decelerates into the landing) rather
// than ease-in-out. This matters beyond feel: ease-in-out starts every tween
// at zero velocity, so interrupting one mid-flight with a fresh click causes
// a visible hitch — the motion has to brake to ~0 and re-launch. Ease-out has
// no such dead point, so rapid repeated clicks re-target smoothly instead of
// staggering/stuttering.
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function currentKickDeg(now) {
  if (!kickTween) return 0;
  const t = Math.min(1, (now - kickTween.start) / kickTween.duration);
  const eased = easeOutCubic(t);
  return kickTween.fromDeg + (kickTween.toDeg - kickTween.fromDeg) * eased;
}

// Click "pop": a quick snap down to 95% on mousedown, held there for as long
// as the mouse stays down (so a click-and-hold stays squished, not just a
// fixed-duration animation), then a bouncy overshoot back past 100% starting
// exactly on mouseup -- so the release, not the press, is what's synced with
// the kick-spin (both start together on 'click' and share the same 550ms
// duration, landing together instead of the pop settling early).
const KICK_SPIN_DURATION_MS = 550;
const POP_DOWN_MS = 70; // quick snap
const POP_UP_MS = KICK_SPIN_DURATION_MS;
const POP_DEPTH = 0.05; // 1.0 -> 0.95

function easeOutQuad(t) {
  return 1 - (1 - t) * (1 - t);
}

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// popState: { downStart: ms, upStart: ms|null }. upStart is null until the
// mouse actually comes back up, however long that takes.
function currentPopScale(now) {
  if (!popState) return 1;
  const downElapsed = now - popState.downStart;
  if (downElapsed < POP_DOWN_MS) {
    const t = downElapsed / POP_DOWN_MS;
    return 1 - POP_DEPTH * easeOutQuad(t);
  }
  if (popState.upStart === null) {
    return 1 - POP_DEPTH; // fully pressed, holding until release
  }
  const upElapsed = now - popState.upStart;
  if (upElapsed < POP_UP_MS) {
    const t = upElapsed / POP_UP_MS;
    return (1 - POP_DEPTH) + POP_DEPTH * easeOutBack(t);
  }
  return 1;
}

// ---------- material: floor/ceiling remap shader patch (matches glb-viewer) ----------

function patchMaterialForRemap(material) {
  material.metalness = MATERIAL.metalnessFactor;
  material.roughness = MATERIAL.roughnessFactor;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMetalFloor = { value: MATERIAL.metalnessFloor };
    shader.uniforms.uMetalCeil = { value: MATERIAL.metalnessCeil };
    shader.uniforms.uRoughFloor = { value: MATERIAL.roughnessFloor };
    shader.uniforms.uRoughCeil = { value: MATERIAL.roughnessCeil };
    shader.fragmentShader = 'uniform float uMetalFloor;\nuniform float uMetalCeil;\nuniform float uRoughFloor;\nuniform float uRoughCeil;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `float roughnessFactor = roughness;
      #ifdef USE_ROUGHNESSMAP
        vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
        roughnessFactor *= mix( uRoughFloor, uRoughCeil, texelRoughness.g );
      #endif`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <metalnessmap_fragment>',
      `float metalnessFactor = metalness;
      #ifdef USE_METALNESSMAP
        vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
        metalnessFactor *= mix( uMetalFloor, uMetalCeil, texelMetalness.b );
      #endif`
    );
  };
  material.needsUpdate = true;
}

// ---------- base-color crossfade across the 3 baked variants ----------

const blend = { textures: [], position: 0, target: null, scene: null, camera: null, material: null, mesh: null };
let colorTween = null; // { fromPos, toPos, start, duration }
let colorIndex = 0;
// Tracks the *intended* destination as a clean running integer, independent
// of the animated (fractional, mid-flight) blend.position. Chaining new
// targets off of this instead of off the current animated value is what
// guarantees every click lands exactly on a real color, no matter how fast
// or how many times you click before the previous transition settles.
let targetCyclePos = 0;

blend.scene = new THREE.Scene();
blend.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
blend.material = new THREE.ShaderMaterial({
  uniforms: { texA: { value: null }, texB: { value: null }, mixFactor: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0); }`,
  fragmentShader: `
    uniform sampler2D texA; uniform sampler2D texB; uniform float mixFactor;
    varying vec2 vUv;
    void main(){ gl_FragColor = mix(texture2D(texA, vUv), texture2D(texB, vUv), mixFactor); }
  `,
});
blend.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blend.material));

function renderBlendComposite() {
  const n = blend.textures.length;
  if (n < 2 || !blend.target) return;
  // blend.position is intentionally allowed to grow past n-1 while chaining
  // rapid clicks (see goToColorIndex) — wrap it back into range here rather
  // than clamping, so it still indexes the right pair of textures.
  const numStates = blend.numStates || Math.max(n - 1, 1);
  const wrapped = ((blend.position % numStates) + numStates) % numStates;
  const floorIdx = Math.floor(wrapped);
  const ceilIdx = Math.min(n - 1, floorIdx + 1);
  const frac = wrapped - floorIdx;
  blend.material.uniforms.texA.value = blend.textures[floorIdx];
  blend.material.uniforms.texB.value = blend.textures[ceilIdx];
  blend.material.uniforms.mixFactor.value = frac;
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(blend.target);
  renderer.render(blend.scene, blend.camera);
  renderer.setRenderTarget(prevTarget);
}

async function setupVariantBlending(gltf, root) {
  const json = gltf.parser.json;
  const variantsExt = json.extensions && json.extensions.KHR_materials_variants;
  const mappings = json.meshes?.[0]?.primitives?.[0]?.extensions?.KHR_materials_variants?.mappings;
  if (!variantsExt || !mappings) return;

  const materialIndexByVariant = [];
  mappings.forEach(m => { m.variants.forEach(vIdx => { materialIndexByVariant[vIdx] = m.material; }); });
  const materials = await Promise.all(materialIndexByVariant.map(idx => gltf.parser.getDependency('material', idx)));
  const textures = materials.map(m => m.map).filter(Boolean);
  if (textures.length < 2) return;

  let targetMesh = null;
  root.traverse(o => { if (o.isMesh && !targetMesh) targetMesh = o; });
  if (!targetMesh) return;

  // Append a duplicate of the first texture after the last real one. Cycling
  // forward can then always move forward (0→1→2→[dup of 0]→snap to 0→…)
  // instead of ever needing to lerp backward through an unrelated color when
  // wrapping past the end — that backward sweep was the visible glitch.
  blend.numStates = textures.length;
  blend.textures = [...textures, textures[0]];
  blend.mesh = targetMesh;

  const w = textures[0].image?.width || 1024;
  const h = textures[0].image?.height || 1024;
  blend.target = new THREE.WebGLRenderTarget(w, h);
  targetMesh.material.map = blend.target.texture;
  targetMesh.material.needsUpdate = true;
  renderBlendComposite();
}

// ---------- words section: scroll-driven, teleprompter-style text reveal ----------
// A duplicate white copy of the gray base text is stacked on top of it, and
// each row gets its own left-to-right mask sweep (not one vertical fade over
// the whole block) -- so a row reveals like it's being read, and completed
// rows above it and untouched rows below it are unambiguously fully white or
// fully gray. Each row's sweep progress comes from where THAT row's own
// position sits relative to a fixed point in the viewport (60% down),
// not from a plain scroll-fraction of the block -- so every row crosses the
// same on-screen point as you scroll, regardless of how tall the whole list
// is or where it starts.

// A row's `.wordLine` shrink-wraps to its own natural (nowrap) width for
// centering and for the reveal sweep to measure against -- but nothing
// stops that natural width from exceeding the 760px column at these sizes
// (e.g. "QUALITY* VORTEX, WOO!" at 72pt). Rather than centered-and-clipped
// by the section's own overflow:hidden, shrink just that line's font-size
// enough to fit, applied identically to its base and reveal copies so they
// stay pixel-aligned. Runs once at startup and again on resize -- it's a
// layout fix, not a per-frame scroll effect like updateWordsReveal below.
function fitWordLines() {
  document.querySelectorAll('.wordsList').forEach((list) => {
    const availableWidth = list.clientWidth;
    const baseLines = list.querySelectorAll('.wordsBase .wordLine');
    const revealLines = list.querySelectorAll('.wordsReveal .wordLine');
    baseLines.forEach((line, i) => {
      // Reset first in case a previous (e.g. narrower) resize shrank this
      // line and it now fits at the group's full size again.
      line.style.fontSize = '';
      if (revealLines[i]) revealLines[i].style.fontSize = '';
      const naturalWidth = line.getBoundingClientRect().width;
      if (naturalWidth > availableWidth) {
        const fullSize = parseFloat(getComputedStyle(line).fontSize);
        const fitSize = `${fullSize * (availableWidth / naturalWidth)}px`;
        line.style.fontSize = fitSize;
        if (revealLines[i]) revealLines[i].style.fontSize = fitSize;
      }
    });
  });
}
fitWordLines();
window.addEventListener('resize', fitWordLines);

// Each group's rendered size is its own --pt custom property times
// #wordsSection's --wsScale (stepped down at narrower widths, see the media
// queries on #wordsSection above) -- so the divider label above it can't just
// be static text any more, or it'd go stale the moment the CSS scales things
// down for mobile. Instead, read the group's *actual* computed font-size
// back out and write that real number into its label, every time it could
// have changed.
function updateDividerLabels() {
  document.querySelectorAll('.wordsList').forEach((list) => {
    const divider = list.previousElementSibling;
    const label = divider && divider.querySelector('.dividerLabel');
    if (!label) return;
    const px = Math.round(parseFloat(getComputedStyle(list).fontSize));
    label.textContent = `${px}pt`;
  });
}
updateDividerLabels();
window.addEventListener('resize', updateDividerLabels);

const wordsRevealLines = document.querySelectorAll('.wordsReveal .wordLine');
// One per line, so a line's mask is only touched when its *rounded* gradient
// actually changes -- see the rounding note below.
const wordsRevealLastGradient = new Array(wordsRevealLines.length).fill(null);
const WORDS_REVEAL_VIEWPORT_FRACTION = 0.60; // how far down the viewport rows reveal
// Wide enough that a row is still finishing its own fade-in as the next one
// starts -- overlapping softness reads smoother than keeping every row's
// transition fully separate.
const WORDS_REVEAL_FEATHER_PX = 240; // soft left-right sweep edge, instead of a hard cut
// Interior stops sampled across the feather band, eased (reusing the same
// easeInOutCubic the 3D model's color blend uses) rather than a plain
// 2-stop linear ramp -- a straight linear alpha fade reads harsher than it
// measures, since perceived brightness isn't linear in alpha; easing the
// falloff is what actually reads as a smooth, seamless dissolve.
const WORDS_REVEAL_EASE_STEPS = 10;

function buildRevealGradient(leftStop, rightStop, width) {
  const span = rightStop - leftStop;
  const stops = [`#fff 0px`, `#fff ${leftStop}px`];
  for (let i = 1; i < WORDS_REVEAL_EASE_STEPS; i++) {
    const t = i / WORDS_REVEAL_EASE_STEPS;
    const alpha = (1 - easeInOutCubic(t)).toFixed(3);
    const pos = Math.round(leftStop + span * t);
    stops.push(`rgba(255,255,255,${alpha}) ${pos}px`);
  }
  stops.push(`transparent ${rightStop}px`, `transparent ${width}px`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function updateWordsReveal() {
  const revealViewportY = window.innerHeight * WORDS_REVEAL_VIEWPORT_FRACTION;
  wordsRevealLines.forEach((line, i) => {
    const rect = line.getBoundingClientRect();
    // The sweep itself plays out over one row-height's worth of scrolling
    // (ties it to the actual font metrics, so it keeps pacing sensibly once
    // the real typeface replaces this Arial placeholder).
    const windowPx = rect.height;
    const progress = (revealViewportY + windowPx / 2 - rect.top) / windowPx;
    const leadX = progress * rect.width;
    // Rounded to whole px: getBoundingClientRect() reports the browser's own
    // subpixel scroll offset, so without rounding these stops carry that
    // same subpixel noise straight into the mask every frame. Compositing a
    // sub-pixel-shifting mask edge against the text's own antialiased glyph
    // edges is exactly what read as shimmer/jitter, especially scrolling
    // fast or reversing direction. Snapping to whole px removes that beat
    // between two independently-antialiased edges; at this feather width a
    // 1px step is imperceptible on its own.
    const leftStop = Math.round(leadX - WORDS_REVEAL_FEATHER_PX / 2);
    const rightStop = Math.round(leadX + WORDS_REVEAL_FEATHER_PX / 2);
    const width = Math.round(rect.width);
    // Out-of-range stops (row hasn't reached the reveal point yet, or has
    // already scrolled past it) self-clamp per the CSS gradient spec -- no
    // special-casing needed for "fully gray" / "fully revealed" here, and
    // that holds regardless of how many interior stops sit between them.
    const gradient = buildRevealGradient(leftStop, rightStop, width);
    // Skip the write entirely when nothing actually moved a whole pixel --
    // reapplying an unchanged mask-image still costs a repaint on some
    // browsers, which was contributing to the same shimmer while idle.
    if (wordsRevealLastGradient[i] === gradient) return;
    wordsRevealLastGradient[i] = gradient;
    line.style.webkitMaskImage = gradient;
    line.style.maskImage = gradient;
  });
}

// ---------- intro CTA: scroll to download without an address-bar hash ----------
// Keeps the real href="#downloadSection" in the markup as a no-JS fallback
// (and so it still behaves like a normal link -- middle-click/open-in-new-
// tab, etc.) but intercepts the actual click so the browser's native
// hash-jump never fires. Without this, clicking it writes #downloadSection
// into the URL, which is both an ugly thing to have sitting in the address
// bar and something a visitor could copy/share without meaning to -- landing
// whoever opens that link straight into the middle of the page instead of
// the top.
const scrollToDownloadLink = document.querySelector('a[href="#downloadSection"]');
if (scrollToDownloadLink) {
  scrollToDownloadLink.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('downloadSection').scrollIntoView({ behavior: 'smooth' });
  });
}

// ---------- EULA modal ----------
// .eulaLink is shared by every trigger (the downloadCopy sentence and the
// "Free" spec value) rather than a single id, so any number of links can
// open the same modal.
const eulaLinks = document.querySelectorAll('.eulaLink');
const eulaModalOverlay = document.getElementById('eulaModalOverlay');
const eulaModalClose = document.getElementById('eulaModalClose');

function openEulaModal(e) {
  if (e) e.preventDefault();
  eulaModalOverlay.classList.add('open');
  eulaModalOverlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden'; // no background scroll while the modal is open
}
function closeEulaModal() {
  eulaModalOverlay.classList.remove('open');
  eulaModalOverlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}
eulaLinks.forEach((link) => link.addEventListener('click', openEulaModal));
eulaModalClose.addEventListener('click', closeEulaModal);
// Click on the dimmed backdrop itself (not the dialog) closes it too.
eulaModalOverlay.addEventListener('click', (e) => {
  if (e.target === eulaModalOverlay) closeEulaModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && eulaModalOverlay.classList.contains('open')) closeEulaModal();
});

// ---------- grid video: click anywhere on the section to pause/play ----------
const gridVideo = document.getElementById('gridVideo');
const gridPlayToggle = document.getElementById('gridPlayToggle');
// Icon shows the action a click will take (pause icon while playing, play
// icon while paused), not the current state itself -- the standard
// convention for a media toggle control.
const GRID_PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const GRID_PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

function updateGridPlayToggleIcon() {
  gridPlayToggle.innerHTML = gridVideo.paused ? GRID_PLAY_ICON : GRID_PAUSE_ICON;
  gridPlayToggle.setAttribute('aria-label', gridVideo.paused ? 'Play video' : 'Pause video');
}
function toggleGridVideo() {
  if (gridVideo.paused) gridVideo.play();
  else gridVideo.pause();
  // No manual icon update here -- the video's own 'play'/'pause' events
  // below are the single source of truth for that.
}
const gridVideoSection = document.getElementById('gridVideoSection');
gridVideoSection.addEventListener('click', toggleGridVideo);
// Without stopping propagation, a click on the button would also bubble up
// to the section's own click listener above and immediately undo itself.
gridPlayToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleGridVideo();
});
// Pressed regardless of where in the video the mousedown actually lands
// (mirrors toggleGridVideo's own click-anywhere-in-the-section behavior),
// not just when pressing the button itself. mouseup is on window, not the
// section, so releasing outside it (e.g. dragged off first) still clears
// the pressed state.
gridVideoSection.addEventListener('mousedown', () => gridPlayToggle.classList.add('pressed'));
window.addEventListener('mouseup', () => gridPlayToggle.classList.remove('pressed'));
// The video's own play/pause events, not our own toggleGridVideo() calls,
// are what actually drive the icon -- <video autoplay> doesn't necessarily
// have started playing (paused is still true) at the exact moment this
// script runs, since autoplay itself kicks in asynchronously. Reading
// .paused once synchronously here could catch it in that brief window and
// paint the wrong icon; listening for 'play' instead means the icon always
// corrects itself the instant playback actually starts, however that
// happened (autoplay, this button, or the section-wide click).
gridVideo.addEventListener('play', updateGridPlayToggleIcon);
gridVideo.addEventListener('pause', updateGridPlayToggleIcon);
updateGridPlayToggleIcon(); // best-effort initial paint, corrected by the events above if needed

// ---------- glyph overview: filter pills + grid ----------
// Based on the current (still-subject-to-change) glyph coverage list.
// "Extras" lists every stylistic-alternate glyph the font has (Simple A,
// Simple G, Simple N, slashed zero, Checkered #), plus each one's own
// diacritic versions where it has any (the alternate is a shape swap on
// the base letter, so it carries through to every accented form built on
// top of it too -- in the font's own glyph naming these are the ".001"
// suffixed glyphs). Each entry activates the matching OpenType feature via
// `feature` (see renderGlyphGrid below) so the grid actually shows the
// alternate shape, not the default one -- tag-to-feature mapping here is
// inferred from the spec given (cv01=Simple A, cv02=Simple G, cv03=Simple
// N, cv04=Checkered #); adjust if the real font numbers them differently.
//
// Diacritics groups the accented letters (grouped by base letter, in the
// order they were given) together with the lowercase dotless-i pair and the
// standalone combining/spacing marks at the end -- per the rule "anything
// that isn't a plain A-Z or a diacritic goes in punctuation," these all
// count as diacritics even though most aren't full letters on their own.
// Combining marks (the 14 right after the spacing marks below) are
// zero-width without a base to attach to, so each is prefixed with U+25CC
// (a dotted circle) purely for display -- otherwise they'd render as
// invisible.
const GLYPH_SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  numPunct: [
    '0','1','2','3','4','5','6','7','8','9',
    '.',',',':',';','…','!','¡','?','¿','·','•','*','#','/','\\','(',')','{','}','[',']',
    '-','–','—','_','‚','„','“','”','‘','’','"','\'',
    '$','+','−','×','÷','=','>','<','^','∞','%','‰','@','&','©','®','™','°',
  ],
  diacritics: [
    'Á','Ă','Â','Ä','À','Ā','Ą','Å','Ã','Æ',
    'Ć','Č','Ç','Ċ',
    'Ð','Ď','Đ',
    'É','Ě','Ê','Ë','Ė','È','Ē','Ę',
    'Ğ','Ģ','Ġ',
    'Ħ',
    'Í','Î','Ï','İ','Ì','Ī','Į',
    'Ķ',
    'Ĺ','Ľ','Ļ','Ł',
    'Ń','Ň','Ņ','Ŋ','Ñ',
    'Ó','Ô','Ö','Ò','Ő','Ō','Ø','Õ','Œ',
    'Þ',
    'Ŕ','Ř','Ŗ',
    'Ś','Š','Ş','Ș','ẞ',
    'Ŧ','Ť','Ţ','Ț',
    'Ú','Û','Ü','Ù','Ű','Ū','Ų','Ů',
    'Ẃ','Ŵ','Ẅ','Ẁ',
    'Ý','Ŷ','Ÿ','Ỳ',
    'Ź','Ž','Ż',
    'i','ı',
    '¨','˙','`','´','˝','ˆ','ˇ','˘','˚','˜','¯','¸','˛',
  ],
  extras: [
    { ch: 'A', feature: '"cv01" 1' },
    { ch: 'Á', feature: '"cv01" 1' },
    { ch: 'Ă', feature: '"cv01" 1' },
    { ch: 'Â', feature: '"cv01" 1' },
    { ch: 'Ä', feature: '"cv01" 1' },
    { ch: 'À', feature: '"cv01" 1' },
    { ch: 'Ā', feature: '"cv01" 1' },
    { ch: 'Ą', feature: '"cv01" 1' },
    { ch: 'Å', feature: '"cv01" 1' },
    { ch: 'Ã', feature: '"cv01" 1' },
    { ch: 'G', feature: '"cv02" 1' },
    { ch: 'Ğ', feature: '"cv02" 1' },
    { ch: 'Ģ', feature: '"cv02" 1' },
    { ch: 'Ġ', feature: '"cv02" 1' },
    { ch: 'N', feature: '"cv03" 1' },
    { ch: 'Ń', feature: '"cv03" 1' },
    { ch: 'Ň', feature: '"cv03" 1' },
    { ch: 'Ņ', feature: '"cv03" 1' },
    { ch: 'Ñ', feature: '"cv03" 1' },
    { ch: '0', feature: '"zero" 1' },
    { ch: '#', feature: '"cv04" 1' },
  ],
};

const glyphGrid = document.getElementById('glyphGrid');

function renderGlyphGrid(filterKey) {
  glyphGrid.innerHTML = '';
  GLYPH_SETS[filterKey].forEach((entry) => {
    // Every other set is a plain array of characters; "extras" alone is
    // {ch, feature} objects so its glyphs can request their own alternate.
    const ch = typeof entry === 'string' ? entry : entry.ch;
    const feature = typeof entry === 'string' ? null : entry.feature;

    const box = document.createElement('div');
    box.className = 'glyphBox';

    const glyph = document.createElement('div');
    glyph.className = 'glyphChar';
    glyph.textContent = ch;
    if (feature) glyph.style.fontFeatureSettings = feature;

    const label = document.createElement('div');
    label.className = 'glyphLabel';
    label.textContent = ch;

    box.appendChild(glyph);
    box.appendChild(label);
    glyphGrid.appendChild(box);
  });
}
renderGlyphGrid('upper');

// Single-select, radio-button-style -- not multi-selectable tags.
document.querySelectorAll('.filterPill').forEach((pill) => {
  pill.addEventListener('click', () => {
    if (pill.classList.contains('selected')) return;
    document.querySelectorAll('.filterPill').forEach((p) => p.classList.remove('selected'));
    pill.classList.add('selected');
    renderGlyphGrid(pill.dataset.filter);
  });
  // Same press-feedback pattern as #gridPlayToggle: press this specific
  // pill, not the whole row, so mousedown is scoped per-button -- but
  // mouseup lives on window (not the pill) so releasing after dragging off
  // it still clears the pressed state.
  pill.addEventListener('mousedown', () => pill.classList.add('pressed'));
});

// Same press-feedback pattern again for the CTA buttons (both .ctaPrimary
// instances -- intro and download -- plus .ctaSecondary).
document.querySelectorAll('.ctaPrimary, .ctaSecondary').forEach((cta) => {
  cta.addEventListener('mousedown', () => cta.classList.add('pressed'));
});

window.addEventListener('mouseup', () => {
  document.querySelectorAll('.filterPill.pressed, .ctaPrimary.pressed, .ctaSecondary.pressed, .navHome.pressed')
    .forEach((el) => el.classList.remove('pressed'));
});

// ---------- top nav: home + font switcher dropdown ----------
const navHome = document.getElementById('navHome');
navHome.addEventListener('mousedown', () => navHome.classList.add('pressed'));

// Both the top-nav copy and the footer copy (added below) share this exact
// behavior -- only their expand direction (down vs. up, via the
// .fontSwitcherUp modifier class in CSS) and page position differ, so this
// is written once and instantiated per root element rather than duplicated.
function setupFontSwitcher(root) {
  const surface = root.querySelector('.fontSwitcherSurface');
  const trigger = root.querySelector('.fontSwitcherTrigger');
  // Placeholder rows for preview purposes (only JK Roadium is a real font
  // so far) -- selecting any of them just closes the menu.
  const options = root.querySelectorAll('.fontSwitcherOption');

  // .fontSwitcherSurface is the whole expanding shape (trigger row + item
  // rows are just its normal-flow children), so its own content height
  // isn't knowable to CSS ahead of time -- measured here and set as an
  // explicit inline height for the CSS transition above to animate toward.
  // scrollHeight reports the full, un-clipped content height even while the
  // element's own height is still pinned to 60px. `root` itself never
  // changes size (see the stylesheet comment on .fontSwitcher) -- only the
  // surface does, as an absolutely-positioned overlay on top of it.
  function open() {
    root.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    surface.style.height = `${surface.scrollHeight}px`;
  }
  function close() {
    root.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    surface.style.height = '60px';
  }
  function toggle() {
    if (root.classList.contains('open')) close();
    else open();
  }
  trigger.addEventListener('click', toggle);
  options.forEach((option) => option.addEventListener('click', close));
  // Outside click / Escape close it, same pattern as the EULA modal above.
  document.addEventListener('click', (e) => {
    if (!root.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  // Press feedback is its own thing, independent of open/closed --
  // mousedown on the trigger bumps the whole surface's scale up slightly,
  // mouseup (anywhere, so dragging off the trigger before releasing still
  // clears it) settles it back down.
  trigger.addEventListener('mousedown', () => surface.classList.add('pressed'));
  window.addEventListener('mouseup', () => surface.classList.remove('pressed'));
}
setupFontSwitcher(document.getElementById('fontSwitcher'));
setupFontSwitcher(document.getElementById('fontSwitcherFooter'));

// ---------- footer ----------
// Year is read from the visitor's own clock at load time, not hardcoded, so
// this never needs a manual bump.
document.getElementById('footerCopyright').textContent = `©John Karlsson ${new Date().getFullYear()}`;

// ---------- load model ----------

function fitCamera() {
  // Models are always normalized to a 2-unit (radius 1) bounding sphere on
  // load, so we already know the fit radius — no need to re-measure the box,
  // which would pick up the parent pivot's tilt and read way too large.
  const radius = 1;
  const fitDist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5))) * 1.2;
  const dir = new THREE.Vector3(0.22, 0.16, 1).normalize();
  camera.position.copy(dir.multiplyScalar(fitDist));
  camera.near = fitDist / 100;
  camera.far = fitDist * 100;
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}

const gltfLoader = new GLTFLoader();

function disposeCurrentModel() {
  if (!currentModel) return;
  currentModel.removeFromParent();
  currentModel.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(m => {
        ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'].forEach(slot => {
          if (m[slot] && m[slot] !== blend.target?.texture) m[slot].dispose();
        });
        m.dispose();
      });
    }
  });
  currentModel = null;
  if (blend.target) { blend.target.dispose(); blend.target = null; }
  blend.textures = [];
  blend.numStates = undefined;
  blend.position = 0;
  colorTween = null;
  colorIndex = 0;
  targetCyclePos = 0;
}

function loadModel(url) {
  disposeCurrentModel();
  gltfLoader.load(url, (gltf) => {
    const root = gltf.scene;

    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
    baseModelScale = 2 / maxDim;
    root.scale.setScalar(baseModelScale);
    const box2 = new THREE.Box3().setFromObject(root);
    root.position.sub(box2.getCenter(new THREE.Vector3()));

    modelPivot.add(root);
    currentModel = root;

    root.traverse(o => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => m && patchMaterialForRemap(m));
    });
    applyEnvIntensity();
    fitCamera();
    setupVariantBlending(gltf, root);
  }, undefined, (err) => console.error('Failed to load model', url, err));
}

loadModel(MODEL_URL);

// ---------- scroll-driven tilt ----------

function scrollProgress() {
  const stage = document.getElementById('stage');
  const rect = stage.getBoundingClientRect();
  const vh = window.innerHeight;
  const p = (vh - rect.top) / (vh + rect.height);
  return THREE.MathUtils.clamp(p, 0, 1);
}

// ---------- version-title SVG accent: synced with the model's color cycle ----------
// crbn_base1/2/3 (the model's baked color variants, in cycle order) sample out
// to yellow / red / white — see colorpart group in the inline SVG below.

const ACCENT_COLORS = ['#FFCC00', '#F72F27', '#C8C8E1'];
const colorpartPaths = document.querySelectorAll('#colorpart path');

function syncSvgAccent() {
  const numStates = blend.numStates || ACCENT_COLORS.length;
  const hex = ACCENT_COLORS[colorIndex % numStates] || ACCENT_COLORS[0];
  colorpartPaths.forEach(p => p.setAttribute('fill', hex));
}

// ---------- click: cycle color + quick kick spin ----------

const COLOR_STEP_DURATION = 500; // ms per color step

// Animates to a specific real color state (0..numStates-1), always moving
// forward around the cycle — 0→1→2→0, never backward — so it never lerps
// through an unrelated color. Reusable as-is for a future "jump to state N"
// button (e.g. onClick={() => goToColorIndex(2)}); a 2-step jump just takes
// proportionally longer so the crossfade speed stays consistent.
function goToColorIndex(targetIndex, now = performance.now()) {
  const numStates = blend.numStates || Math.max(blend.textures.length - 1, 1);
  const steps = ((targetIndex - colorIndex) % numStates + numStates) % numStates;
  if (steps === 0) return;
  // fromPos: the current animated value, so playback continues smoothly with
  // no visual jump. toPos: chained off the last *intended* target (not off
  // fromPos), so repeated interruptions always still add up to a clean
  // integer landing spot instead of drifting to an in-between color.
  const fromPos = colorTween ? currentColorPos(now) : blend.position;
  targetCyclePos += steps;
  colorTween = { fromPos, toPos: targetCyclePos, start: now, duration: COLOR_STEP_DURATION * steps };
  colorIndex = targetIndex;
  syncSvgAccent();
}

// The color-change control replaces the system cursor while hovering
// #cursorZone (stage + title, not the copy text below) and follows the
// pointer there -- clicking anywhere in the zone triggers the change, not
// just a fixed hit target. Pop starts on mousedown -- the instant you press,
// not after the full click completes -- so the feedback reads as
// immediate/responsive rather than lagging a beat behind the actual press.
const cursorZone = document.getElementById('cursorZone');
const colorCursor = document.getElementById('colorCursor'); // the blue button, trails with lag
const colorCursorIconEl = document.getElementById('colorCursorIcon'); // the icon, tracks 1:1
const colorCursorSvg = colorCursorIconEl.querySelector('svg');
colorCursorSvg.style.transition = `transform ${KICK_SPIN_DURATION_MS}ms ease-out`;
let iconRotationDeg = 0;

// The button lerps toward the real pointer each frame (see the
// CURSOR_LERP_RATE block in the render loop below) rather than snapping
// straight to it on every mousemove, reading as a soft blob trailing behind
// the pointer. The icon (colorCursorIconEl) tracks the pointer 1:1 with no
// lag at all -- set directly here, not in the lerped render-loop block --
// so it stays visually "attached" to the real cursor while the button
// drifts behind it. cursorX/Y start unset so the very first placement can
// snap the button immediately instead of visibly flying in from wherever it
// happened to be last (e.g. the opposite side of the zone).
const CURSOR_LERP_RATE = 44; // higher = snappier/closer to the pointer, lower = more trailing lag
let cursorTargetX = 0, cursorTargetY = 0;
let cursorX = null, cursorY = null;

// Pointer position and hover membership are tracked globally (window, not
// #cursorZone) and re-derived from scratch on both mousemove and scroll,
// rather than only updating cursorTargetX/Y from a zone-scoped mousemove.
// A zone-scoped listener simply never fires while the real pointer sits
// over some other element -- e.g. while the zone has scrolled out from
// under it -- so if the pointer then moved to a new spot before scrolling
// back, that move was invisible to us: cursorTargetX/Y stayed pinned to
// wherever it was last *inside* the zone, and both the scroll-driven
// visibility check and the eventual re-show used that stale position
// instead of where the pointer actually was. Tracking globally means the
// position is always current no matter which element is under the pointer
// at any given instant.
let lastPointerX = 0, lastPointerY = 0;
let pointerKnown = false;

function updateCursorHoverState() {
  if (!pointerKnown) return;
  const rect = cursorZone.getBoundingClientRect();
  const inside = lastPointerX >= rect.left && lastPointerX <= rect.right &&
                 lastPointerY >= rect.top && lastPointerY <= rect.bottom;
  const wasVisible = colorCursor.classList.contains('visible');
  if (inside && !wasVisible) {
    colorCursor.classList.add('visible');
    colorCursorIconEl.classList.add('visible');
    // Snap both the lerped button and the 1:1 icon straight to the current
    // position on entry, same as the old mouseenter behavior, instead of
    // letting the button visibly fly in from its last (possibly far away,
    // possibly stale) position.
    cursorTargetX = cursorX = lastPointerX;
    cursorTargetY = cursorY = lastPointerY;
    colorCursorIconEl.style.transform = `translate(${lastPointerX}px, ${lastPointerY}px)`;
  } else if (!inside && wasVisible) {
    colorCursor.classList.remove('visible');
    colorCursor.classList.remove('pressed');
    colorCursorIconEl.classList.remove('visible');
  }
}

window.addEventListener('mousemove', (e) => {
  lastPointerX = e.clientX;
  lastPointerY = e.clientY;
  pointerKnown = true;
  updateCursorHoverState();
  // While already visible, keep tracking every move (not just the one that
  // triggered entry) -- updateCursorHoverState() above only handles the
  // enter/leave transitions themselves.
  if (colorCursor.classList.contains('visible')) {
    cursorTargetX = e.clientX;
    cursorTargetY = e.clientY;
    colorCursorIconEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  }
}, { passive: true });

// Scrolling moves the zone under a pointer that hasn't itself moved, so no
// mousemove fires -- without this, the cursor would silently keep showing
// (or hiding) stale state until the next real pointer movement corrected
// it, which on a trackpad with scroll easing could be a long beat after
// the content had already settled. Re-checking on 'scroll' fixes that at
// the source instead of covering for it with a rAF/interval poll: it only
// runs when scroll position actually changes, and each check is one cheap
// getBoundingClientRect() read, not a loop.
window.addEventListener('scroll', updateCursorHoverState, { passive: true });

cursorZone.addEventListener('mousedown', () => {
  popState = { downStart: performance.now(), upStart: null };
  colorCursor.classList.add('pressed');
});
// Released outside the zone (dragged off before mouseup) still needs to
// clear the press state -- a plain 'click' listener on the zone alone would
// miss that case since 'click' never fires then.
window.addEventListener('mouseup', () => {
  colorCursor.classList.remove('pressed');
});

cursorZone.addEventListener('click', () => {
  const now = performance.now();

  // 'click' fires after mouseup, so this is the release -- start the bounce
  // back up now, however long the press was held. Safety fallback in case
  // click somehow fires without a prior mousedown (e.g. a synthetic event).
  if (!popState) popState = { downStart: now - POP_DOWN_MS, upStart: null };
  popState.upStart = now;

  const numStates = blend.numStates || Math.max(blend.textures.length - 1, 1);
  goToColorIndex((colorIndex + 1) % numStates, now);

  const fromKick = currentKickDeg(now);
  kickTween = { fromDeg: fromKick, toDeg: fromKick + 90, start: now, duration: KICK_SPIN_DURATION_MS };

  // Icon spin rides the same CSS-eased transition rather than the JS
  // easeOutCubic tween the model uses, so this is a fire-and-forget target
  // change -- no per-frame update needed. Negative (counter-clockwise) and
  // a full 180deg so it reads as travelling with the model's own spin
  // rather than against it.
  iconRotationDeg -= 180;
  colorCursorSvg.style.transform = `rotate(${iconRotationDeg}deg)`;

  triggerRingBoost(now);
});

function currentColorPos(now) {
  if (!colorTween) return blend.position;
  const t = Math.min(1, (now - colorTween.start) / colorTween.duration);
  const eased = easeInOutCubic(t);
  return colorTween.fromPos + (colorTween.toPos - colorTween.fromPos) * eased;
}

// ---------- "radio waves" background rings (plain WebGL, not three.js) ----------
// A second, deliberately minimal context — no depth/stencil/antialias/mipmaps,
// nothing loaded into it but one tiny shader — so it adds only what it needs
// on top of the model canvas's GPU footprint rather than paying for a whole
// second three.js renderer instance.

const ringsCanvas = document.getElementById('ringsCanvas');
const ringsGl = ringsCanvas.getContext('webgl', {
  alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true,
});

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Ring shader compile error: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

const ringsVertSrc = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const ringsFragSrc = `
precision mediump float;
varying vec2 vUv;
uniform vec2 uResolutionPx;
uniform vec2 uCenterPx;
uniform float uRadii[${RING_MAX_CONCURRENT}];
uniform float uFade[${RING_MAX_CONCURRENT}]; // 0..1, precomputed per-ring from age in JS
uniform int uRingCount;
uniform float uStrokeWidthPx;
uniform float uBaseOpacity;

void main() {
  vec2 fragPx = vec2(vUv.x, 1.0 - vUv.y) * uResolutionPx;
  float dist = distance(fragPx, uCenterPx);
  float alpha = 0.0;
  for (int i = 0; i < ${RING_MAX_CONCURRENT}; i++) {
    if (i >= uRingCount) break;
    float r = uRadii[i];
    float d = abs(dist - r);
    float coverage = 1.0 - smoothstep(0.0, uStrokeWidthPx * 0.5 + 1.0, d);
    alpha = max(alpha, coverage * uFade[i]);
  }
  float a = alpha * uBaseOpacity;
  gl_FragColor = vec4(vec3(1.0) * a, a); // premultiplied
}`;

const ringsProgram = ringsGl.createProgram();
ringsGl.attachShader(ringsProgram, compileShader(ringsGl, ringsGl.VERTEX_SHADER, ringsVertSrc));
ringsGl.attachShader(ringsProgram, compileShader(ringsGl, ringsGl.FRAGMENT_SHADER, ringsFragSrc));
ringsGl.linkProgram(ringsProgram);
if (!ringsGl.getProgramParameter(ringsProgram, ringsGl.LINK_STATUS)) {
  throw new Error('Ring shader link error: ' + ringsGl.getProgramInfoLog(ringsProgram));
}
ringsGl.useProgram(ringsProgram);

const ringsQuadBuffer = ringsGl.createBuffer();
ringsGl.bindBuffer(ringsGl.ARRAY_BUFFER, ringsQuadBuffer);
ringsGl.bufferData(ringsGl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ringsGl.STATIC_DRAW);
const aPosLoc = ringsGl.getAttribLocation(ringsProgram, 'aPos');
ringsGl.enableVertexAttribArray(aPosLoc);
ringsGl.vertexAttribPointer(aPosLoc, 2, ringsGl.FLOAT, false, 0, 0);

const ringsUniforms = {
  uResolutionPx: ringsGl.getUniformLocation(ringsProgram, 'uResolutionPx'),
  uCenterPx: ringsGl.getUniformLocation(ringsProgram, 'uCenterPx'),
  uRadii: ringsGl.getUniformLocation(ringsProgram, 'uRadii'),
  uFade: ringsGl.getUniformLocation(ringsProgram, 'uFade'),
  uRingCount: ringsGl.getUniformLocation(ringsProgram, 'uRingCount'),
  uStrokeWidthPx: ringsGl.getUniformLocation(ringsProgram, 'uStrokeWidthPx'),
  uBaseOpacity: ringsGl.getUniformLocation(ringsProgram, 'uBaseOpacity'),
};

const ringsDpr = Math.min(window.devicePixelRatio, 2);
ringsCanvas.width = STAGE_W * ringsDpr;
ringsCanvas.height = STAGE_H * ringsDpr;
ringsGl.viewport(0, 0, ringsCanvas.width, ringsCanvas.height);
ringsGl.uniform2f(ringsUniforms.uResolutionPx, STAGE_W, STAGE_H);
ringsGl.uniform2f(ringsUniforms.uCenterPx, RING_CENTER_PX.x, RING_CENTER_PX.y);
ringsGl.uniform1f(ringsUniforms.uStrokeWidthPx, RING_STROKE_PX);
ringsGl.uniform1f(ringsUniforms.uBaseOpacity, RING_OPACITY);
ringsGl.enable(ringsGl.BLEND);
ringsGl.blendFunc(ringsGl.ONE, ringsGl.ONE_MINUS_SRC_ALPHA); // premultiplied-alpha blending

// Ambient entries are just { spawnMs }, spawnMs measured on ringClockMs (see
// below), not on real time.
let ringEntries = [];
let lastRingSpawnMs = -Infinity;
let ringsSeeded = false;
const ringRadiiBuf = new Float32Array(RING_MAX_CONCURRENT);
const ringFadeBuf = new Float32Array(RING_MAX_CONCURRENT);

// On click, the whole ring system briefly runs on fast-forward instead of
// spawning anything extra: ringClockMs is a shared virtual clock that every
// ring's age (and the spawn-interval check) is measured against, and it
// advances faster than real time for the length of a burst. Because BOTH
// radius (age * speed) and spacing (spawn interval in clock-time) are read
// off the same warped clock, a burst leaves the physical gap between any two
// rings completely unchanged -- they just all slide outward together faster
// for a moment, and new ones arrive on schedule sooner. No extra rings, no
// crowding, just a pulse of energy through the existing pattern.
let ringClockMs = null;
let lastRealMs = null;
let ringBoostStart = null; // real ms; null when idle
const RING_BOOST_DURATION_MS = KICK_SPIN_DURATION_MS; // synced with the spin
const RING_BOOST_PEAK_MULTIPLIER = 3; // how much faster the clock runs at the peak of the pulse

function triggerRingBoost(nowMs) {
  ringBoostStart = nowMs;
}

function ringClockSpeedMultiplier(nowMs) {
  if (ringBoostStart === null) return 1;
  const t = nowMs - ringBoostStart;
  if (t < 0 || t > RING_BOOST_DURATION_MS) return 1;
  // Ease-out only, using the exact same easeOutCubic as the kick-spin: hits
  // the peak multiplier immediately and settles back to 1x, rather than
  // ramping up and back down symmetrically. Sharing the curve with the spin
  // is what makes the two actually read as synced.
  const frac = t / RING_BOOST_DURATION_MS;
  return 1 + (RING_BOOST_PEAK_MULTIPLIER - 1) * (1 - easeOutCubic(frac));
}

function updateAndRenderRings(nowMs) {
  if (ringClockMs === null) { ringClockMs = nowMs; lastRealMs = nowMs; }
  // Capped the same way the main animate() loop already caps its own dt:
  // rAF fully stops while the tab is backgrounded, so the first frame after
  // coming back would otherwise see a multi-minute dt in one step. Without
  // this, that single huge step ages every existing ring past its fade
  // window at once (background goes empty) and the spawn check -- a single
  // "has an interval passed?" check, not a catch-up loop -- only adds one
  // ring for the whole gap, so it then visibly rebuilds over ~20s. Capping
  // it here means a backgrounded tab just pauses and resumes exactly where
  // it left off instead.
  const dtMs = Math.min(100, nowMs - lastRealMs);
  lastRealMs = nowMs;
  ringClockMs += dtMs * ringClockSpeedMultiplier(nowMs);
  if (ringBoostStart !== null && nowMs - ringBoostStart > RING_BOOST_DURATION_MS) ringBoostStart = null;

  if (!ringsSeeded) {
    // Backfill a full set of virtual spawn times as if rings had already
    // been going out continuously before this moment, so the very first
    // frame already shows the background filled in at every stage of the
    // life cycle instead of building up from nothing over the next 8s.
    ringsSeeded = true;
    const lifetimeMs = RING_FADE_END_SEC * 1000;
    for (let age = 0; age <= lifetimeMs; age += RING_SPAWN_INTERVAL_MS) {
      ringEntries.push({ spawnMs: ringClockMs - age });
    }
    lastRingSpawnMs = ringClockMs;
  } else if (ringClockMs - lastRingSpawnMs >= RING_SPAWN_INTERVAL_MS) {
    ringEntries.push({ spawnMs: ringClockMs });
    lastRingSpawnMs = ringClockMs;
  }

  let count = 0;
  ringEntries = ringEntries.filter((entry) => {
    const ageSec = (ringClockMs - entry.spawnMs) / 1000;
    if (ageSec > RING_FADE_END_SEC) return false; // end of life, drop it
    if (count < RING_MAX_CONCURRENT) {
      ringRadiiBuf[count] = ageSec * RING_SPEED_PX_PER_SEC;
      ringFadeBuf[count] = 1 - smoothstepJS(RING_FADE_START_SEC, RING_FADE_END_SEC, ageSec);
      count++;
    }
    return true;
  });

  ringsGl.clearColor(0, 0, 0, 0);
  ringsGl.clear(ringsGl.COLOR_BUFFER_BIT);
  ringsGl.uniform1fv(ringsUniforms.uRadii, ringRadiiBuf);
  ringsGl.uniform1fv(ringsUniforms.uFade, ringFadeBuf);
  ringsGl.uniform1i(ringsUniforms.uRingCount, count);
  ringsGl.drawArrays(ringsGl.TRIANGLES, 0, 3);
}

// ---------- render loop ----------

let lastTime = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  updateWordsReveal();

  idleSpinDeg += IDLE_SPIN_DEG_PER_SEC * dt;

  const targetTiltX = THREE.MathUtils.lerp(TILT_X_ENTER, TILT_X_LEAVE, scrollProgress());
  const smoothing = 1 - Math.exp(-SCROLL_SMOOTHING * dt);
  appliedTiltX += (targetTiltX - appliedTiltX) * smoothing;
  modelPivot.rotation.x = THREE.MathUtils.degToRad(appliedTiltX);

  if (currentModel) {
    const kick = currentKickDeg(now);
    currentModel.rotation.y = THREE.MathUtils.degToRad(idleSpinDeg + kick);
    currentModel.scale.setScalar(baseModelScale * currentPopScale(now));
  }

  if (colorTween) {
    blend.position = currentColorPos(now);
    renderBlendComposite();
    if (now - colorTween.start >= colorTween.duration) {
      // Landing on the duplicate slot is visually identical to position 0,
      // so fold both the visible position and the running target back down
      // to keep the numbers bounded across a long session of clicking.
      const numStates = blend.numStates || Math.max(blend.textures.length - 1, 1);
      blend.position = blend.position % numStates;
      targetCyclePos = targetCyclePos % numStates;
      colorTween = null;
    }
  }

  if (cursorX !== null) {
    const cursorSmoothing = 1 - Math.exp(-CURSOR_LERP_RATE * dt);
    cursorX += (cursorTargetX - cursorX) * cursorSmoothing;
    cursorY += (cursorTargetY - cursorY) * cursorSmoothing;
    colorCursor.style.transform = `translate(${cursorX}px, ${cursorY}px)`;
  }

  updateAndRenderRings(now);
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
