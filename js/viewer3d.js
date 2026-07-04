/**
 * DealInbox — procedural 3D product viewer for designer lighting.
 *
 * Exports:
 *   PRODUCT_KEYS   — the 6 supported product keys
 *   ProductViewer  — interactive per-canvas viewer (OrbitControls, power/kelvin/intensity)
 *   renderThumbnail— cheap offscreen PNG thumbnails (shared renderer)
 *   kelvinToRGB    — Tanner Helland kelvin → RGB approximation
 *
 * No external assets: all geometry is procedural, all textures are canvas-generated.
 */

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

/** @type {string[]} Product keys supported by ProductViewer / renderThumbnail. */
export const PRODUCT_KEYS = [
  'aurora-pendant',
  'crystal-chandelier',
  'arc-floor',
  'mushroom-table',
  'neon-quasar',
  'lumen-desk',
];

/* ============================================================================
 * Small helpers
 * ========================================================================== */

const _UP = new THREE.Vector3(0, 1, 0);

/**
 * Tanner Helland blackbody approximation, normalized to 0..1 channels.
 * @param {number} kelvin - color temperature in Kelvin (clamped 1000..40000)
 * @returns {THREE.Color}
 */
export function kelvinToRGB(kelvin) {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const cl = (v) => Math.min(255, Math.max(0, v)) / 255;
  return new THREE.Color(cl(r), cl(g), cl(b));
}

function makeCanvas(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  return c;
}

/* ---- cached canvases (textures are created fresh per scene, canvases shared) */
let _haloCanvas = null;
function haloTexture() {
  if (!_haloCanvas) {
    _haloCanvas = makeCanvas(128, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0.0, 'rgba(255,255,255,1)');
      g.addColorStop(0.22, 'rgba(255,255,255,0.5)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.13)');
      g.addColorStop(1.0, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    });
  }
  const tex = new THREE.CanvasTexture(_haloCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let _contactCanvas = null;
function contactShadowTexture() {
  if (!_contactCanvas) {
    _contactCanvas = makeCanvas(256, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0.0, 'rgba(0,0,0,0.38)');
      g.addColorStop(0.45, 'rgba(0,0,0,0.2)');
      g.addColorStop(0.8, 'rgba(0,0,0,0.05)');
      g.addColorStop(1.0, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    });
  }
  return new THREE.CanvasTexture(_contactCanvas);
}

let _marbleCanvas = null;
function marbleTexture() {
  if (!_marbleCanvas) {
    _marbleCanvas = makeCanvas(512, (ctx, s) => {
      ctx.fillStyle = '#eceae5';
      ctx.fillRect(0, 0, s, s);
      // soft tonal patches
      for (let i = 0; i < 26; i++) {
        const x = Math.random() * s, y = Math.random() * s, r = 40 + Math.random() * 120;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const shade = 220 + Math.floor(Math.random() * 22);
        g.addColorStop(0, `rgba(${shade},${shade - 3},${shade - 8},0.35)`);
        g.addColorStop(1, 'rgba(230,228,222,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
      }
      // veins: meandering strokes
      const vein = (w, alpha) => {
        let x = Math.random() * s, y = -10;
        ctx.beginPath();
        ctx.moveTo(x, y);
        while (y < s + 10) {
          const nx = x + (Math.random() - 0.5) * 90;
          const ny = y + 30 + Math.random() * 55;
          const cx = x + (Math.random() - 0.5) * 60;
          const cy = (y + ny) / 2;
          ctx.quadraticCurveTo(cx, cy, nx, ny);
          x = nx; y = ny;
        }
        ctx.strokeStyle = `rgba(105,110,122,${alpha})`;
        ctx.lineWidth = w;
        ctx.stroke();
      };
      for (let i = 0; i < 4; i++) vein(2.2 + Math.random() * 2, 0.16 + Math.random() * 0.1);
      for (let i = 0; i < 9; i++) vein(0.7 + Math.random() * 1.1, 0.10 + Math.random() * 0.08);
      // fine speckle
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = `rgba(120,120,130,${0.02 + Math.random() * 0.05})`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 1.2, 1.2);
      }
    });
  }
  const tex = new THREE.CanvasTexture(_marbleCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Cheap warm plank-wood canvas texture, used by room-mode floors. */
let _woodCanvas = null;
function woodFloorTexture() {
  if (!_woodCanvas) {
    _woodCanvas = makeCanvas(512, (ctx, s) => {
      ctx.fillStyle = '#5f4630';
      ctx.fillRect(0, 0, s, s);
      const planks = 6;
      const plankW = s / planks;
      // per-plank tonal variation
      for (let i = 0; i < planks; i++) {
        const shade = 0.86 + ((i * 53) % 17) / 60;
        ctx.fillStyle = `rgba(0,0,0,${(1 - shade) * 0.55})`;
        ctx.fillRect(i * plankW, 0, plankW, s);
      }
      // seams
      ctx.strokeStyle = 'rgba(24,16,10,0.4)';
      ctx.lineWidth = 2;
      for (let i = 0; i <= planks; i++) {
        ctx.beginPath();
        ctx.moveTo(i * plankW, 0);
        ctx.lineTo(i * plankW, s);
        ctx.stroke();
      }
      // grain streaks (deterministic pseudo-random via index math, not Math.random,
      // so the texture is stable across renders)
      for (let i = 0; i < planks; i++) {
        for (let j = 0; j < 6; j++) {
          const seed = i * 13 + j * 7;
          const x = i * plankW + (seed % 11) / 11 * plankW * 0.7;
          const y = j * (s / 6) + (seed % 5) * 4;
          ctx.strokeStyle = `rgba(40,26,15,${0.12 + (seed % 9) / 90})`;
          ctx.lineWidth = 1 + (seed % 3) * 0.4;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.bezierCurveTo(x + plankW * 0.18, y + 10, x - plankW * 0.12, y + 24, x + plankW * 0.08, y + 38);
          ctx.stroke();
        }
      }
    });
  }
  const tex = new THREE.CanvasTexture(_woodCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/* ---- material factories (fresh instances each call — safe per-viewer dispose) */
function brassMat() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xd2a552, metalness: 1, roughness: 0.24,
    clearcoat: 0.35, clearcoatRoughness: 0.25, envMapIntensity: 1.8,
  });
}
function steelMat() {
  return new THREE.MeshStandardMaterial({
    color: 0xc9ced6, metalness: 1, roughness: 0.32, envMapIntensity: 1.7,
  });
}
function darkMetalMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x23252a, metalness: 0.8, roughness: 0.42, envMapIntensity: 0.9,
  });
}
function matteBlackMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x232529, metalness: 0.3, roughness: 0.5, envMapIntensity: 1.1,
  });
}
function crystalMat() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.03,
    transmission: 0.92, thickness: 0.22, ior: 1.7,
    clearcoat: 1, clearcoatRoughness: 0.04,
    envMapIntensity: 2.2, flatShading: true,
  });
}
function opalGlassMat() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xf6e7d2, metalness: 0, roughness: 0.38,
    transmission: 0.72, thickness: 0.5, ior: 1.45,
    clearcoat: 0.5, clearcoatRoughness: 0.3, envMapIntensity: 1.0,
    emissive: 0xffffff, emissiveIntensity: 0,
  });
}
function cordMat() {
  return new THREE.MeshStandardMaterial({ color: 0x181818, metalness: 0.1, roughness: 0.85 });
}
/** Standard glowing-bulb glass. */
function bulbMat() {
  return new THREE.MeshStandardMaterial({
    color: 0xd8d2c4, roughness: 0.35, metalness: 0,
    emissive: 0xffffff, emissiveIntensity: 0,
  });
}

/**
 * Register a mesh as a "bulb" (its emissive tracks power/kelvin/intensity).
 * colorMix: 1 = fully kelvin-tinted, 0 = stays white.
 */
function asBulb(mesh, baseEmissive, colorMix = 1) {
  mesh.userData._bulb = { base: baseEmissive, colorMix };
  return mesh;
}
function asLight(light, baseIntensity, colorMix = 1) {
  light.userData._lamp = { base: baseIntensity, colorMix };
  return light;
}
function makeHalo(baseScale, baseOpacity, colorMix = 1) {
  const mat = new THREE.SpriteMaterial({
    map: haloTexture(), blending: THREE.AdditiveBlending,
    transparent: true, opacity: 0, depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.userData._halo = { baseScale, baseOpacity, colorMix };
  sprite.scale.set(baseScale, baseScale, 1);
  return sprite;
}

/** Smooth a hand-drawn lathe profile ([r, y] pairs) with a Catmull-Rom pass. */
function smoothProfile(pairs, samples = 48) {
  const pts3 = pairs.map(([r, y]) => new THREE.Vector3(r, y, 0));
  const curve = new THREE.CatmullRomCurve3(pts3, false, 'catmullrom', 0.5);
  return curve.getPoints(samples).map((v) => new THREE.Vector2(Math.max(0.0005, v.x), v.y));
}

/** Cylinder rod between two points. */
function rodBetween(a, b, radius, material, segs = 18) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, segs), material);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(_UP, dir.normalize());
  return mesh;
}

/** Bounding box of meshes only (ignores sprites/lights). */
function meshBounds(root) {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o.isMesh && o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      tmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      box.union(tmp);
    }
  });
  return box;
}

/* ============================================================================
 * Custom curves
 * ========================================================================== */

class TorusKnotCurve extends THREE.Curve {
  constructor(p = 2, q = 3, scale = 0.16, bulge = 0.9, zAmp = 1.35) {
    super();
    this.p = p; this.q = q; this.scale = scale; this.bulge = bulge; this.zAmp = zAmp;
  }
  getPoint(t, target = new THREE.Vector3()) {
    const u = t * Math.PI * 2;
    const r = 2 + Math.cos(this.q * u) * this.bulge;
    return target
      .set(r * Math.cos(this.p * u), r * Math.sin(this.p * u), Math.sin(this.q * u) * this.zAmp)
      .multiplyScalar(this.scale);
  }
}

class HelixCurve extends THREE.Curve {
  constructor(radius, height, turns) {
    super();
    this.radius = radius; this.height = height; this.turns = turns;
  }
  getPoint(t, target = new THREE.Vector3()) {
    const a = t * this.turns * Math.PI * 2;
    return target.set(Math.cos(a) * this.radius, t * this.height, Math.sin(a) * this.radius);
  }
}

/* ============================================================================
 * Model builders
 * Each returns { group, bulbs[], lights[], halos[], sway?, flicker?, kelvinMap?,
 *                podiumRadius, fitScale?, elevation?, azimuth?, centerNudgeY? }
 * ========================================================================== */

/* ---- 1. aurora-pendant ---------------------------------------------------- */
function buildAuroraPendant() {
  const group = new THREE.Group();
  const bulbs = [], lights = [], halos = [];

  const brass = brassMat();
  brass.side = THREE.DoubleSide; // lathe shells
  const PIVOT_Y = 1.62;

  // hang group pivots at the ceiling point for cord sway
  const hang = new THREE.Group();
  hang.position.set(0, PIVOT_Y, 0);
  group.add(hang);

  // ceiling rose
  const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.085, 0.045, 32), brass);
  rose.position.y = -0.02;
  hang.add(rose);

  // cord: pivot down to dome top fitting
  hang.add(rodBetween(new THREE.Vector3(0, -0.03, 0), new THREE.Vector3(0, -0.62, 0), 0.011, cordMat()));

  const shade = new THREE.Group();
  shade.position.y = -1.04; // rim at world ~0.58, dome top ~1.0
  hang.add(shade);

  // brass dome with rolled lip (outer)
  const outerProfile = smoothProfile([
    [0.001, 0.42], [0.09, 0.415], [0.21, 0.385], [0.33, 0.325],
    [0.43, 0.235], [0.495, 0.125], [0.522, 0.03], [0.518, -0.02],
    [0.495, -0.038], [0.472, -0.02], [0.468, 0.02],
  ], 48);
  const dome = new THREE.Mesh(new THREE.LatheGeometry(outerProfile, 48), brass);
  dome.castShadow = true;
  shade.add(dome);

  // inner white lit surface
  const innerProfile = smoothProfile([
    [0.001, 0.405], [0.09, 0.4], [0.2, 0.37], [0.315, 0.312],
    [0.415, 0.228], [0.462, 0.13], [0.466, 0.035],
  ], 36);
  const innerMat = new THREE.MeshStandardMaterial({
    color: 0xf3ede2, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    emissive: 0xffffff, emissiveIntensity: 0,
  });
  const inner = asBulb(new THREE.Mesh(new THREE.LatheGeometry(innerProfile, 48), innerMat), 1.1, 0.85);
  shade.add(inner);
  bulbs.push(inner);

  // top fitting connecting cord to dome
  const fitting = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.12, 24), brass);
  fitting.position.y = 0.46;
  shade.add(fitting);

  // socket + globe bulb hanging below the shade mouth
  const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.2, 24), brass);
  socket.position.y = 0.02;
  shade.add(socket);
  const bulb = asBulb(new THREE.Mesh(new THREE.SphereGeometry(0.14, 32, 24), bulbMat()), 5.0, 1);
  bulb.position.y = -0.17;
  shade.add(bulb);
  bulbs.push(bulb);

  const halo = makeHalo(0.6, 0.5);
  halo.position.copy(bulb.position);
  shade.add(halo);
  halos.push(halo);

  // lamp light at the bulb
  const pt = asLight(new THREE.PointLight(0xffffff, 0, 9, 2), 7.0);
  pt.position.set(0, PIVOT_Y - 1.04 - 0.17, 0);
  pt.castShadow = true;
  pt.shadow.mapSize.set(512, 512);
  pt.shadow.bias = -0.002;
  group.add(pt);
  lights.push(pt);

  return {
    group, bulbs, lights, halos,
    podiumRadius: 0.62,
    elevation: 0.22,
    frameFloor: true,
    sway(t) {
      hang.rotation.z = 0.022 * Math.sin(t * 0.7);
      hang.rotation.x = 0.016 * Math.sin(t * 0.53 + 1.7);
    },
  };
}

/* ---- 2. crystal-chandelier ------------------------------------------------ */
function buildCrystalChandelier() {
  const group = new THREE.Group();
  const bulbs = [], lights = [], halos = [];
  const brass = brassMat();
  brass.side = THREE.DoubleSide;
  const crystal = crystalMat();
  const swayPivots = [];

  const hang = new THREE.Group();
  hang.position.set(0, 1.98, 0);
  group.add(hang);
  const body = new THREE.Group();
  body.position.y = -1.98; // back to world space, but under sway pivot
  hang.add(body);

  // ceiling rod + rose
  const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.085, 0.05, 28), brass);
  rose.position.y = 1.96;
  body.add(rose);
  body.add(rodBetween(new THREE.Vector3(0, 1.95, 0), new THREE.Vector3(0, 1.66, 0), 0.014, brass));

  // turned central column (lathe)
  const colProfile = smoothProfile([
    [0.001, 0.62], [0.05, 0.66], [0.075, 0.72], [0.045, 0.8],
    [0.04, 0.9], [0.105, 1.0], [0.12, 1.08], [0.1, 1.16],
    [0.045, 1.24], [0.04, 1.38], [0.07, 1.5], [0.055, 1.6],
    [0.03, 1.66], [0.001, 1.7],
  ], 52);
  const column = new THREE.Mesh(new THREE.LatheGeometry(colProfile, 30), brass);
  column.castShadow = true;
  body.add(column);

  // 6 arms with candles, flames, drip pans, crystals
  const armCurveBase = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.05, 1.06, 0),
    new THREE.Vector3(0.3, 0.87, 0),
    new THREE.Vector3(0.52, 0.92, 0),
    new THREE.Vector3(0.63, 1.08, 0),
  ]);
  for (let i = 0; i < 6; i++) {
    const armGroup = new THREE.Group();
    armGroup.rotation.y = (i / 6) * Math.PI * 2;
    body.add(armGroup);

    const arm = new THREE.Mesh(new THREE.TubeGeometry(armCurveBase, 28, 0.02, 8), brass);
    armGroup.add(arm);

    const tip = new THREE.Vector3(0.63, 1.08, 0);

    // bobeche (drip pan)
    const pan = new THREE.Mesh(new THREE.LatheGeometry(smoothProfile([
      [0.001, 0.0], [0.05, 0.005], [0.09, 0.025], [0.105, 0.05],
    ], 16), 24), brass);
    pan.position.copy(tip).y += 0.02;
    armGroup.add(pan);

    // candle sleeve
    const candle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.034, 0.2, 16),
      new THREE.MeshStandardMaterial({ color: 0xf6efe0, roughness: 0.6 }));
    candle.position.copy(tip).y += 0.15;
    armGroup.add(candle);

    // flame-shaped bulb
    const flame = asBulb(new THREE.Mesh(new THREE.SphereGeometry(0.034, 20, 16), bulbMat()), 4.0, 1);
    flame.scale.set(1, 1.8, 1);
    flame.position.copy(tip).y += 0.31;
    armGroup.add(flame);
    bulbs.push(flame);

    const halo = makeHalo(0.22, 0.45);
    halo.position.copy(flame.position);
    armGroup.add(halo);
    halos.push(halo);

    // crystal drop under the arm tip (chain + faceted octahedron), sway pivot
    const dropPivot = new THREE.Group();
    dropPivot.position.copy(tip).y -= 0.0;
    armGroup.add(dropPivot);
    dropPivot.add(rodBetween(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.13, 0), 0.0035, brass, 6));
    const drop = new THREE.Mesh(new THREE.OctahedronGeometry(0.055, 0), crystal);
    drop.scale.set(0.62, 1.5, 0.62);
    drop.position.y = -0.21;
    dropPivot.add(drop);
    swayPivots.push({ pivot: dropPivot, phase: i * 1.7, amp: 0.09 });

    // second smaller drop mid-arm
    const midPivot = new THREE.Group();
    midPivot.position.set(0.36, 0.875, 0);
    armGroup.add(midPivot);
    midPivot.add(rodBetween(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.09, 0), 0.003, brass, 6));
    const drop2 = new THREE.Mesh(new THREE.OctahedronGeometry(0.04, 0), crystal);
    drop2.scale.set(0.6, 1.45, 0.6);
    drop2.position.y = -0.15;
    midPivot.add(drop2);
    swayPivots.push({ pivot: midPivot, phase: i * 2.3 + 0.8, amp: 0.11 });
  }

  // center crystal cascade under the column finial
  const cascade = new THREE.Group();
  cascade.position.set(0, 0.62, 0);
  body.add(cascade);
  const cascadeSpec = [
    { y: -0.1, s: 0.06, e: 1.4 },
    { y: -0.24, s: 0.05, e: 1.5 },
    { y: -0.38, s: 0.075, e: 1.7 },
  ];
  cascade.add(rodBetween(new THREE.Vector3(0, 0.0, 0), new THREE.Vector3(0, -0.32, 0), 0.0035, brass, 6));
  for (const c of cascadeSpec) {
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(c.s, 0), crystal);
    m.scale.set(0.65, c.e, 0.65);
    m.position.y = c.y;
    cascade.add(m);
  }
  swayPivots.push({ pivot: cascade, phase: 4.2, amp: 0.05 });

  // one central warm light (cheaper than 6 shadow casters)
  const pt = asLight(new THREE.PointLight(0xffffff, 0, 10, 2), 16);
  pt.position.set(0, 1.42, 0);
  pt.castShadow = true;
  pt.shadow.mapSize.set(512, 512);
  pt.shadow.bias = -0.002;
  group.add(pt);
  lights.push(pt);

  return {
    group, bulbs, lights, halos,
    podiumRadius: 0.88,
    frameFloor: true,
    sway(t) {
      hang.rotation.z = 0.008 * Math.sin(t * 0.5);
      for (const s of swayPivots) {
        s.pivot.rotation.x = s.amp * Math.sin(t * 1.15 + s.phase);
        s.pivot.rotation.z = s.amp * 0.8 * Math.sin(t * 0.9 + s.phase * 1.3);
      }
    },
  };
}

/* ---- 3. arc-floor ---------------------------------------------------------- */
function buildArcFloor() {
  const group = new THREE.Group();
  const bulbs = [], lights = [], halos = [];
  const steel = steelMat();

  // marble base
  const marble = new THREE.MeshPhysicalMaterial({
    map: marbleTexture(), roughness: 0.22, metalness: 0,
    clearcoat: 0.55, clearcoatRoughness: 0.25,
  });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.34, 0.26, 48), marble);
  base.position.set(-0.68, 0.13, 0);
  base.castShadow = true;
  group.add(base);
  // steel collar where the arc enters the base
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.1, 24), steel);
  collar.position.set(-0.68, 0.3, 0);
  group.add(collar);

  // the arc
  const arcCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.68, 0.2, 0),
    new THREE.Vector3(-0.68, 1.0, 0),
    new THREE.Vector3(-0.6, 1.62, 0),
    new THREE.Vector3(-0.26, 2.02, 0),
    new THREE.Vector3(0.28, 2.03, 0),
    new THREE.Vector3(0.64, 1.72, 0),
    new THREE.Vector3(0.72, 1.5, 0),
  ]);
  const arc = new THREE.Mesh(new THREE.TubeGeometry(arcCurve, 72, 0.024, 12), steel);
  arc.castShadow = true;
  group.add(arc);

  // dome shade at the end, opening down
  const shade = new THREE.Group();
  shade.position.set(0.72, 1.5, 0);
  group.add(shade);
  const shadeProfile = smoothProfile([
    [0.001, 0.06], [0.08, 0.05], [0.16, 0.02], [0.235, -0.05],
    [0.27, -0.14], [0.278, -0.21], [0.272, -0.235],
  ], 40);
  const shadeSteel = steelMat();
  shadeSteel.side = THREE.DoubleSide;
  const shadeMesh = new THREE.Mesh(new THREE.LatheGeometry(shadeProfile, 40), shadeSteel);
  shadeMesh.castShadow = true;
  shade.add(shadeMesh);
  const shadeInnerProfile = smoothProfile([
    [0.001, 0.035], [0.08, 0.026], [0.15, -0.004], [0.218, -0.07],
    [0.25, -0.15], [0.258, -0.225],
  ], 32);
  const shadeInner = asBulb(new THREE.Mesh(
    new THREE.LatheGeometry(shadeInnerProfile, 40),
    new THREE.MeshStandardMaterial({
      color: 0xf0ece2, roughness: 0.9, side: THREE.DoubleSide,
      emissive: 0xffffff, emissiveIntensity: 0,
    })), 1.0, 0.85);
  shade.add(shadeInner);
  bulbs.push(shadeInner);

  // bulb inside, peeking out of the shade mouth
  const bulb = asBulb(new THREE.Mesh(new THREE.SphereGeometry(0.09, 24, 18), bulbMat()), 4.5, 1);
  bulb.position.y = -0.19;
  shade.add(bulb);
  bulbs.push(bulb);
  const halo = makeHalo(0.5, 0.55);
  halo.position.set(0, -0.24, 0);
  shade.add(halo);
  halos.push(halo);

  // spot pointing down at the podium
  const spot = asLight(new THREE.SpotLight(0xffffff, 0, 8, 0.75, 0.55, 1.6), 130);
  spot.position.set(0.72, 1.4, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0015;
  const spotTarget = new THREE.Object3D();
  spotTarget.position.set(0.74, 0, 0);
  group.add(spotTarget);
  spot.target = spotTarget;
  group.add(spot);
  lights.push(spot);

  return {
    group, bulbs, lights, halos,
    podiumRadius: 1.12,
    fitScale: 0.96,
    elevation: 0.26,
    azimuth: 0.42,
    frameFloor: true,
  };
}

/* ---- 4. mushroom-table ------------------------------------------------------ */
function buildMushroomTable() {
  const group = new THREE.Group();
  const bulbs = [], lights = [], halos = [];

  // one continuous Murano-style silhouette
  const profile = smoothProfile([
    [0.02, 0.005], [0.19, 0.005], [0.29, 0.025], [0.325, 0.1],
    [0.285, 0.2], [0.185, 0.3], [0.12, 0.42], [0.1, 0.52],
    [0.115, 0.6], [0.2, 0.66], [0.34, 0.695], [0.44, 0.74],
    [0.48, 0.82], [0.45, 0.91], [0.35, 0.98], [0.19, 1.03],
    [0.05, 1.05], [0.001, 1.053],
  ], 64);
  const glass = opalGlassMat();
  const body = asBulb(new THREE.Mesh(new THREE.LatheGeometry(profile, 48), glass), 0.16, 0.9);
  body.castShadow = true;
  group.add(body);
  bulbs.push(body);

  // inner warm emissive core (visible through the transmissive glass)
  const coreCap = asBulb(new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 18), bulbMat()), 1.1, 1);
  coreCap.scale.set(1.1, 0.5, 1.1);
  coreCap.position.y = 0.84;
  group.add(coreCap);
  bulbs.push(coreCap);
  const coreBase = asBulb(new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), bulbMat()), 0.55, 1);
  coreBase.scale.set(1.2, 1.6, 1.2);
  coreBase.position.y = 0.24;
  group.add(coreBase);
  bulbs.push(coreBase);

  const halo = makeHalo(0.75, 0.22);
  halo.position.y = 0.84;
  group.add(halo);
  halos.push(halo);

  // tiny near-field light inside the cap; the room light sits just above the
  // glass so inverse-square falloff doesn't nuke the shell from inside
  const ptGlow = asLight(new THREE.PointLight(0xffffff, 0, 3, 2), 0.22);
  ptGlow.position.set(0, 0.86, 0);
  group.add(ptGlow);
  lights.push(ptGlow);
  const ptRoom = asLight(new THREE.PointLight(0xffffff, 0, 8, 2), 6);
  ptRoom.position.set(0, 1.35, 0);
  ptRoom.castShadow = true;
  ptRoom.shadow.mapSize.set(512, 512);
  ptRoom.shadow.bias = -0.002;
  group.add(ptRoom);
  lights.push(ptRoom);

  return {
    group, bulbs, lights, halos,
    podiumRadius: 0.68,
    fitScale: 1.04,
    frameFloor: true,
  };
}

/* ---- 5. neon-quasar ---------------------------------------------------------- */
function buildNeonQuasar() {
  const group = new THREE.Group();
  const bulbs = [], lights = [], halos = [];

  // dark hexagonal base
  const hexMat = new THREE.MeshStandardMaterial({
    color: 0x131418, metalness: 0.65, roughness: 0.3, envMapIntensity: 1.0,
  });
  const hex = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.47, 0.12, 6), hexMat);
  hex.position.y = 0.06;
  hex.castShadow = true;
  group.add(hex);
  const inset = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.025, 6), darkMetalMat());
  inset.position.y = 0.125;
  group.add(inset);

  // knot sculpture
  const knot = new THREE.Group();
  knot.position.y = 0.72;
  knot.rotation.x = Math.PI / 2; // stand the knot plane upright
  knot.rotation.z = 0.35;
  group.add(knot);

  const curve = new TorusKnotCurve(2, 3, 0.155, 0.85, 1.5);
  const outerMat = new THREE.MeshStandardMaterial({
    color: 0x15090f, roughness: 0.3, metalness: 0,
    emissive: 0xffffff, emissiveIntensity: 0,
    transparent: true, opacity: 0.8,
  });
  const outer = asBulb(new THREE.Mesh(new THREE.TubeGeometry(curve, 220, 0.042, 10, true), outerMat), 1.1, 1);
  knot.add(outer);
  bulbs.push(outer);

  const innerMat = new THREE.MeshStandardMaterial({
    color: 0x111111, roughness: 0.4,
    emissive: 0xffffff, emissiveIntensity: 0,
  });
  const innerTube = asBulb(new THREE.Mesh(new THREE.TubeGeometry(curve, 220, 0.015, 8, true), innerMat), 3.2, 0.7);
  innerTube.scale.setScalar(1.001);
  knot.add(innerTube);
  bulbs.push(innerTube);

  // support rods from the base to the knot's lowest points
  knot.updateMatrixWorld(true);
  const samples = [];
  for (let i = 0; i < 120; i++) {
    const p = curve.getPoint(i / 120).applyMatrix4(knot.matrixWorld);
    samples.push(p);
  }
  samples.sort((a, b) => a.y - b.y);
  const picked = [];
  for (const p of samples) {
    if (picked.length >= 3) break;
    if (picked.every((q) => q.distanceTo(p) > 0.3)) picked.push(p);
  }
  for (const p of picked) {
    group.add(rodBetween(new THREE.Vector3(p.x * 0.85, 0.13, p.z * 0.85), p, 0.013, darkMetalMat(), 8));
  }

  // glow
  const haloBig = makeHalo(1.4, 0.3);
  haloBig.position.y = 0.72;
  group.add(haloBig);
  halos.push(haloBig);

  const pt = asLight(new THREE.PointLight(0xffffff, 0, 8, 2), 7.0);
  pt.position.set(0, 0.72, 0);
  pt.castShadow = true;
  pt.shadow.mapSize.set(512, 512);
  pt.shadow.bias = -0.002;
  group.add(pt);
  lights.push(pt);

  return {
    group, bulbs, lights, halos,
    podiumRadius: 0.78,
    fitScale: 1.02,
    frameFloor: true,
    // artistic magenta <-> cyan ramp instead of blackbody
    kelvinMap(kelvin) {
      const tn = THREE.MathUtils.clamp((kelvin - 2200) / (6500 - 2200), 0, 1);
      const hue = 0.87 - tn * 0.36; // magenta -> cyan
      return new THREE.Color().setHSL(hue, 1.0, 0.5);
    },
    flicker(t) {
      const buzz = 0.965
        + 0.02 * Math.sin(t * 29.7)
        + 0.012 * Math.sin(t * 47.3 + 1.3)
        + 0.008 * Math.sin(t * 7.1);
      // occasional deeper dip
      const dip = Math.sin(t * 1.7) > 0.995 ? 0.75 : 1;
      return buzz * dip;
    },
    sway(t) {
      knot.rotation.y = 0.06 * Math.sin(t * 0.4);
    },
  };
}

/* ---- 6. lumen-desk ------------------------------------------------------------ */
function buildLumenDesk() {
  const group = new THREE.Group();
  const bulbs = [], lights = [], halos = [];
  const black = matteBlackMat();
  const brass = brassMat();

  // weighted round base
  const baseProfile = smoothProfile([
    [0.02, 0.0], [0.24, 0.0], [0.3, 0.015], [0.31, 0.05],
    [0.27, 0.085], [0.16, 0.1], [0.07, 0.105],
  ], 32);
  const base = new THREE.Mesh(new THREE.LatheGeometry(baseProfile, 40), black);
  base.castShadow = true;
  group.add(base);

  const j0 = new THREE.Vector3(0, 0.1, 0);
  const j1 = new THREE.Vector3(-0.26, 0.62, 0);
  const j2 = new THREE.Vector3(0.24, 0.98, 0);

  // joints (brass spheres)
  for (const [p, r] of [[j0, 0.06], [j1, 0.055], [j2, 0.05]]) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 18), brass);
    s.position.copy(p);
    s.castShadow = true;
    group.add(s);
  }

  // arms
  const arm1 = rodBetween(j0, j1, 0.026, black);
  arm1.castShadow = true;
  group.add(arm1);
  const arm2 = rodBetween(j1, j2, 0.024, black);
  arm2.castShadow = true;
  group.add(arm2);

  // springs alongside each arm (anglepoise flavour)
  const addSpring = (a, b, side) => {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const n = dir.clone().normalize();
    // in-plane perpendicular (arms live in the XY plane)
    const perp = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 0, 1)).multiplyScalar(side * 0.055);
    const helix = new HelixCurve(0.026, len * 0.5, 8);
    const spring = new THREE.Mesh(
      new THREE.TubeGeometry(helix, 96, 0.007, 6),
      steelMat());
    spring.position.copy(a).addScaledVector(dir, 0.25).add(perp);
    spring.quaternion.setFromUnitVectors(_UP, n);
    group.add(spring);
  };
  addSpring(j0, j1, 1);
  addSpring(j1, j2, 1);

  // head: dome shade angled down-forward
  const head = new THREE.Group();
  head.position.copy(j2);
  const dir = new THREE.Vector3(0.42, -0.88, 0).normalize();
  head.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir); // local -Y is beam axis
  group.add(head);

  const shadeProfile = smoothProfile([
    [0.001, 0.16], [0.05, 0.155], [0.1, 0.125], [0.145, 0.06],
    [0.165, -0.02], [0.17, -0.055], [0.163, -0.07],
  ], 36);
  const blackShade = matteBlackMat();
  blackShade.side = THREE.DoubleSide;
  const shadeMesh = new THREE.Mesh(new THREE.LatheGeometry(shadeProfile, 36), blackShade);
  shadeMesh.castShadow = true;
  head.add(shadeMesh);
  // neck between joint and shade
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.1, 12), brass);
  neck.position.y = 0.14;
  head.add(neck);

  // recessed glowing disc
  const disc = asBulb(new THREE.Mesh(
    new THREE.CircleGeometry(0.115, 32),
    new THREE.MeshStandardMaterial({
      color: 0xd9d4c8, roughness: 0.5,
      emissive: 0xffffff, emissiveIntensity: 0,
    })), 5.0, 1);
  disc.rotation.x = Math.PI / 2; // face local -Y
  disc.position.y = -0.02;
  head.add(disc);
  bulbs.push(disc);

  const halo = makeHalo(0.45, 0.6);
  halo.position.y = -0.09;
  head.add(halo);
  halos.push(halo);

  // spot light out of the head
  const spot = asLight(new THREE.SpotLight(0xffffff, 0, 7, 0.75, 0.6, 1.5), 110);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0015;
  const headWorld = j2.clone().addScaledVector(dir, 0.08);
  spot.position.copy(headWorld);
  const spotTarget = new THREE.Object3D();
  spotTarget.position.copy(j2).addScaledVector(dir, 1.25);
  group.add(spotTarget);
  spot.target = spotTarget;
  group.add(spot);
  lights.push(spot);

  return {
    group, bulbs, lights, halos,
    podiumRadius: 0.72,
    fitScale: 1.0,
    azimuth: 0.5,
    frameFloor: true,
  };
}

const BUILDERS = {
  'aurora-pendant': buildAuroraPendant,
  'crystal-chandelier': buildCrystalChandelier,
  'arc-floor': buildArcFloor,
  'mushroom-table': buildMushroomTable,
  'neon-quasar': buildNeonQuasar,
  'lumen-desk': buildLumenDesk,
};

/* ============================================================================
 * Scene assembly (shared by viewer + thumbnails)
 * ========================================================================== */

function addPodium(scene, radius) {
  const podiumRadius = radius * 0.62;
  const podium = new THREE.Mesh(
    new THREE.CylinderGeometry(podiumRadius, podiumRadius * 1.02, 0.05, 64),
    new THREE.MeshStandardMaterial({
      color: 0x100f0d, metalness: 0.04, roughness: 0.6, envMapIntensity: 0.12,
    }));
  podium.position.y = -0.026;
  podium.receiveShadow = true;
  scene.add(podium);

  const shadowTex = contactShadowTexture();
  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 1.7, radius * 1.7),
    new THREE.MeshBasicMaterial({
      map: shadowTex, transparent: true, depthWrite: false,
    }));
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.003;
  contact.renderOrder = 1;
  scene.add(contact);

  return { podium, contact };
}

function addLightRig(scene) {
  const rig = [];
  const hemi = new THREE.HemisphereLight(0x8fa3c0, 0x201d1a, 0.32);
  hemi.userData._rig = { base: 0.32, offBoost: 0.7 };
  scene.add(hemi); rig.push(hemi);

  const key = new THREE.DirectionalLight(0xbdd2ec, 0.5);
  key.position.set(2.6, 3.2, 2.2);
  key.userData._rig = { base: 0.5, offBoost: 0.45 };
  scene.add(key); rig.push(key);

  const rim = new THREE.DirectionalLight(0x7f9dc9, 0.65);
  rim.position.set(-2.4, 2.4, -2.8);
  rim.userData._rig = { base: 0.65, offBoost: 0.8 };
  scene.add(rim); rig.push(rim);
  return rig;
}

/* environment map, cached per renderer */
const _envCache = new WeakMap();
function getEnvMap(renderer) {
  let env = _envCache.get(renderer);
  if (env) return env;
  const envScene = new THREE.Scene();
  const room = new THREE.Mesh(
    new THREE.SphereGeometry(12, 16, 12),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.015, 0.017, 0.024), side: THREE.BackSide }));
  envScene.add(room);
  const panel = (w, h, color, pos, lookAt) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    m.position.copy(pos);
    m.lookAt(lookAt);
    envScene.add(m);
  };
  panel(6, 4, new THREE.Color(5, 5, 5.5), new THREE.Vector3(0, 7, 0), new THREE.Vector3(0, 0, 0));      // top softbox
  panel(2, 7, new THREE.Color(1.6, 2.0, 2.6), new THREE.Vector3(8, 2, -2), new THREE.Vector3(0, 1, 0)); // cool side strip
  panel(5, 2, new THREE.Color(1.2, 1.1, 1.0), new THREE.Vector3(-6, 1.5, 6), new THREE.Vector3(0, 1, 0)); // warm fill card
  // soft horizon band so curved metal always catches a gradient
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(10.5, 10.5, 3.2, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.32, 0.36, 0.45), side: THREE.BackSide }));
  band.position.y = 1.2;
  envScene.add(band);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(envScene, 0.035);
  env = rt.texture;
  _envCache.set(renderer, env);
  pmrem.dispose();
  envScene.traverse((o) => {
    if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
  });
  return env;
}

function buildProductScene(productKey, renderer) {
  const builder = BUILDERS[productKey];
  if (!builder) throw new Error(`viewer3d: unknown product key "${productKey}"`);
  const scene = new THREE.Scene();
  scene.environment = getEnvMap(renderer);
  scene.environmentIntensity = 0.55;
  const model = builder();
  scene.add(model.group);
  const { podium, contact } = addPodium(scene, model.podiumRadius);
  model.podiumMesh = podium;
  model.contactMesh = contact;
  const rig = addLightRig(scene);

  // frame data (optionally grounding the composition on the podium)
  const box = meshBounds(model.group);
  if (model.frameFloor) {
    const r = model.podiumRadius;
    box.union(new THREE.Box3(new THREE.Vector3(-r, -0.06, -r), new THREE.Vector3(r, 0, r)));
  }
  const center = box.getCenter(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  model.center = center;
  model.radius = sphere.radius;
  return { scene, model, rig };
}

const _white = new THREE.Color(1, 1, 1);
const _tmpColor = new THREE.Color();
const _tweenTarget = new THREE.Vector3();

/**
 * Push power/kelvin/intensity state into a built scene.
 * @param {object} built {model, rig}
 * @param {THREE.Color} color   lamp color
 * @param {number} eff          effective brightness (powerLevel * intensity * flicker)
 * @param {number} powerLevel   0..1 (for the off-state rig boost)
 */
function applyState(built, color, eff, powerLevel) {
  const { model, rig, scene } = built;
  const offAmount = 1 - Math.min(1, powerLevel);
  scene.environmentIntensity = 0.55 - 0.22 * offAmount;
  for (const l of rig) {
    l.intensity = l.userData._rig.base * (1 + l.userData._rig.offBoost * offAmount);
  }
  for (const l of model.lights) {
    const d = l.userData._lamp;
    _tmpColor.copy(color).lerp(_white, 1 - d.colorMix);
    l.color.copy(_tmpColor);
    l.intensity = d.base * eff;
  }
  for (const b of model.bulbs) {
    const d = b.userData._bulb;
    _tmpColor.copy(color).lerp(_white, 1 - d.colorMix);
    b.material.emissive.copy(_tmpColor);
    b.material.emissiveIntensity = d.base * eff;
  }
  for (const h of model.halos) {
    const d = h.userData._halo;
    _tmpColor.copy(color).lerp(_white, 1 - d.colorMix);
    h.material.color.copy(_tmpColor);
    h.material.opacity = d.baseOpacity * Math.min(1.15, eff);
    const s = d.baseScale * (0.55 + 0.5 * Math.min(1.4, eff));
    h.scale.set(s, s, 1);
  }
  // room-only ambiance lights (present only when a room bundle is attached;
  // brighten slightly as the lamp powers down so the room never goes pitch black)
  for (const l of model.roomLights || []) {
    const d = l.userData._room;
    l.intensity = d.base * (1 + d.offBoost * offAmount);
  }
}

/**
 * Position/aim the camera to fit a "frame" spec: { center, radius, azimuth?,
 * elevation?, fitScale? }. Used for both the studio product frame (model
 * itself satisfies this shape) and the room-mode frame (see ROOM_BUILDERS).
 */
function computeFitDistance(camera, frame) {
  const fovV = THREE.MathUtils.degToRad(camera.fov);
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
  return (frame.radius / Math.tan(Math.min(fovV, fovH) / 2)) * 1.12 * (frame.fitScale ?? 1);
}

function sphericalPos(center, dist, azim, elev, out = new THREE.Vector3()) {
  return out.set(
    center.x + dist * Math.cos(elev) * Math.sin(azim),
    center.y + dist * Math.sin(elev),
    center.z + dist * Math.cos(elev) * Math.cos(azim));
}

function frameCamera(camera, frame) {
  const dist = computeFitDistance(camera, frame);
  const azim = frame.azimuth ?? 0.6;
  const elev = frame.elevation ?? 0.3;
  sphericalPos(frame.center, dist, azim, elev, camera.position);
  camera.lookAt(frame.center);
  camera.updateProjectionMatrix();
  return dist;
}

function configureRenderer(renderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

function disposeSceneResources(scene) {
  const materials = new Set();
  const geometries = new Set();
  scene.traverse((o) => {
    if (o.geometry) geometries.add(o.geometry);
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
    }
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) {
    for (const key of ['map', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'normalMap', 'alphaMap']) {
      if (m[key]) m[key].dispose();
    }
    m.dispose();
  }
  scene.clear();
}

/* ============================================================================
 * Room mode — per-product furnished interior "stage sets"
 *
 * A room bundle is { group, roomLights, camera }:
 *   group      — THREE.Group holding all room geometry + ambiance lights,
 *                added directly into the product's own scene (so the
 *                existing dispose path cleans it up for free) and toggled
 *                via .visible when switching modes.
 *   roomLights — the room's own non-shadow ambiance lights (see
 *                addRoomAmbientLights); read by applyState().
 *   camera     — a frame spec ({ center, radius, azimuth, elevation,
 *                fitScale }, same shape frameCamera() already expects) plus
 *                OrbitControls constraints (azimuthSpread, minPolar,
 *                maxPolar, minDistScale, maxDistScale, autoRotateSpeed).
 *
 * Convention: the product model is never moved. World y=0 is always the
 * surface the product already rests on (the studio podium's plane). Floor
 * lamps keep the real floor at y=0; pendants/chandeliers/table lamps get a
 * console/table/desk/shelf built with its top surface at y=0, descending to
 * the true room floor at a negative `floorY`.
 * ========================================================================== */

const ROOM_WALL_COLOR = 0x2a2520;
const ROOM_WALL_COLOR_ACCENT = 0x201c19;
const ROOM_BASEBOARD_COLOR = 0x18140f;

function furnMat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color, roughness: opts.roughness ?? 0.85, metalness: opts.metalness ?? 0.04,
    flatShading: true, envMapIntensity: 0.22,
  });
}
function fbox(w, h, d, color, opts) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), furnMat(color, opts));
  m.receiveShadow = true;
  return m;
}
function fcyl(rt, rb, h, color, segs = 20, opts) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, segs), furnMat(color, opts));
  m.receiveShadow = true;
  return m;
}

/** Two walls (back + left side) meeting at a corner, plus a wood floor. Open
 * toward the camera on the other two sides — a stage set, not a box. */
function buildRoomShell({ width, depth, height, floorY = 0, wallColor = ROOM_WALL_COLOR, frontExtra = 1.0 }) {
  const group = new THREE.Group();
  const halfW = width / 2;
  const backZ = -depth;
  const frontZ = frontExtra;
  const sideX = -halfW;
  const cz = (backZ + frontZ) / 2;
  const spanZ = frontZ - backZ;

  const floorTex = woodFloorTexture();
  floorTex.repeat.set(Math.max(1, width / 1.4), Math.max(1, spanZ / 1.4));
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(width, spanZ),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.82, metalness: 0.05, envMapIntensity: 0.16 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, floorY, cz);
  floor.receiveShadow = true;
  group.add(floor);

  // walls don't receive real shadow-map shadows: at these distances the
  // product's own close-range shadow-casting light (tuned for the small
  // studio podium) throws soft, badly-aliased blobs onto anything far away —
  // harmless in the void of studio mode, but ugly once a wall is there to
  // catch it. The fake contact-shadow decal under the product still sells
  // the grounding cue, so walls simply skip real shadow receipt.
  const back = fbox(width, height, 0.06, wallColor, { roughness: 0.88 });
  back.position.set(0, floorY + height / 2, backZ);
  back.receiveShadow = false;
  group.add(back);

  const side = fbox(0.06, height, spanZ, wallColor, { roughness: 0.88 });
  side.position.set(sideX, floorY + height / 2, cz);
  side.receiveShadow = false;
  group.add(side);

  const bbH = 0.09;
  const bbBack = fbox(width, bbH, 0.07, ROOM_BASEBOARD_COLOR);
  bbBack.position.set(0, floorY + bbH / 2, backZ + 0.03);
  bbBack.receiveShadow = false;
  group.add(bbBack);
  const bbSide = fbox(0.07, bbH, spanZ, ROOM_BASEBOARD_COLOR);
  bbSide.position.set(sideX + 0.03, floorY + bbH / 2, cz);
  bbSide.receiveShadow = false;
  group.add(bbSide);

  return { group, halfW, sideX, backZ, frontZ, floorY, height };
}

/** Faux "window" — a glowing inset panel, no real geometry depth needed. */
function addWindow(group, { width, height, pos, normal = 'z', color = 0x8fb8dc }) {
  const g = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color: 0x100d0a }));
  g.add(frame);
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(width - 0.08, height - 0.08),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 }));
  glass.position.z = 0.004;
  g.add(glass);
  if (normal === 'x') g.rotation.y = Math.PI / 2;
  g.position.copy(pos);
  group.add(g);
  return g;
}

/** Soft contact-shadow decal on the surface the product rests on (y=0 local). */
function addRestingContactShadow(group, radius) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 1.7, radius * 1.7),
    new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.004;
  m.renderOrder = 1;
  group.add(m);
  return m;
}

/** Dim warm ambient + one soft cool "window daylight" accent, non-shadow-casting. */
function addRoomAmbientLights(group, {
  warmPos = new THREE.Vector3(0.5, 1.0, 0.85), warmColor = 0xffb27a, warmBase = 0.5,
  coolPos = new THREE.Vector3(-1.6, 2.1, 1.3), coolColor = 0x9fc2e6, coolBase = 0.34,
} = {}) {
  const warm = new THREE.PointLight(warmColor, warmBase, 6, 2);
  warm.position.copy(warmPos);
  warm.userData._room = { base: warmBase, offBoost: 0.55 };
  group.add(warm);

  const cool = new THREE.DirectionalLight(coolColor, coolBase);
  cool.position.copy(coolPos);
  cool.userData._room = { base: coolBase, offBoost: 0.4 };
  group.add(cool);

  return [warm, cool];
}

/* ---- simple context-furniture silhouettes (flat-shaded, muted, low-poly) --- */

function chairSilhouette(color = 0x474038) {
  const g = new THREE.Group();
  const seat = fbox(0.36, 0.045, 0.36, color);
  seat.position.y = 0.24;
  g.add(seat);
  const back = fbox(0.34, 0.4, 0.045, color);
  back.position.set(0, 0.24 + 0.2, -0.155);
  g.add(back);
  for (const [dx, dz] of [[0.15, 0.15], [-0.15, 0.15], [0.15, -0.15], [-0.15, -0.15]]) {
    const leg = fcyl(0.018, 0.018, 0.24, color, 8);
    leg.position.set(dx, 0.12, dz);
    g.add(leg);
  }
  return g;
}

function roundTable({ topRadius, topH = 0.045, legH, footRadius, color }) {
  const g = new THREE.Group();
  const top = fcyl(topRadius, topRadius, topH, color, 40);
  top.position.y = -topH / 2;
  g.add(top);
  const col = fcyl(0.05, 0.08, legH, color, 24);
  col.position.y = -topH - legH / 2;
  g.add(col);
  const foot = fcyl(footRadius, footRadius, 0.04, color, 40);
  foot.position.y = -topH - legH - 0.02;
  g.add(foot);
  return g;
}

/** A platform whose top surface sits at local y=0 (where the product rests)
 * and which descends legH+topH to the real floor — used for consoles/desks. */
function platform({ topW, topD, topH = 0.05, legH, color, legInset = 0.07 }) {
  const g = new THREE.Group();
  const top = fbox(topW, topH, topD, color);
  top.position.y = -topH / 2;
  g.add(top);
  const dx = topW / 2 - legInset, dz = topD / 2 - legInset;
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = fcyl(0.024, 0.024, legH, color, 12);
    leg.position.set(sx * dx, -topH - legH / 2, sz * dz);
    g.add(leg);
  }
  return g;
}

/** Wall-mounted floating shelf; top surface at local y=0, no legs to the floor. */
function floatingShelf({ w, d, h = 0.055, color }) {
  const g = new THREE.Group();
  const top = fbox(w, h, d, color);
  top.position.y = -h / 2;
  g.add(top);
  return g;
}

function armchairSilhouette(color = 0x54504a) {
  const g = new THREE.Group();
  const seat = fbox(0.62, 0.3, 0.6, color);
  seat.position.y = 0.15;
  g.add(seat);
  const back = fbox(0.62, 0.46, 0.14, color);
  back.position.set(0, 0.3 + 0.23, -0.23);
  g.add(back);
  const armL = fbox(0.13, 0.32, 0.56, color);
  armL.position.set(-0.245, 0.15 + 0.16, 0);
  g.add(armL);
  const armR = armL.clone();
  armR.position.x = 0.245;
  g.add(armR);
  return g;
}

function sofaSilhouette(color = 0x54504a, width = 1.6) {
  const g = new THREE.Group();
  const seat = fbox(width, 0.32, 0.68, color);
  seat.position.y = 0.16;
  g.add(seat);
  const back = fbox(width, 0.5, 0.16, color);
  back.position.set(0, 0.32 + 0.25, -0.26);
  g.add(back);
  const armL = fbox(0.16, 0.4, 0.68, color);
  armL.position.set(-width / 2 + 0.08, 0.2, 0);
  g.add(armL);
  const armR = armL.clone();
  armR.position.x = width / 2 - 0.08;
  g.add(armR);
  return g;
}

function sideTable(color = 0x5a4432) {
  const g = new THREE.Group();
  const top = fcyl(0.2, 0.2, 0.03, color, 24);
  top.position.y = 0.44;
  g.add(top);
  const leg = fcyl(0.018, 0.026, 0.41, color, 16);
  leg.position.y = 0.22;
  g.add(leg);
  const foot = fcyl(0.13, 0.13, 0.02, color, 24);
  foot.position.y = 0.01;
  g.add(foot);
  return g;
}

function rugMesh(radius, color = 0x342c24) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 40), new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 }));
  m.rotation.x = -Math.PI / 2;
  m.receiveShadow = true;
  return m;
}

function artFrame(w, h, frameColor = 0x18140f, insetColor = 0x6d5c46) {
  const g = new THREE.Group();
  const f = fbox(w, h, 0.03, frameColor);
  g.add(f);
  const inset = fbox(w - 0.07, h - 0.07, 0.012, insetColor);
  inset.position.z = 0.021;
  g.add(inset);
  return g;
}

/** A row of book-block silhouettes, deterministic (no Math.random) so the
 * shelf reads the same on every load. */
function bookRow(n, w, h, d, colors) {
  const g = new THREE.Group();
  let x = -(n - 1) * w / 2;
  for (let i = 0; i < n; i++) {
    const seed = i * 17;
    const bw = w * (0.78 + (seed % 5) / 12);
    const bh = h * (0.65 + (seed % 7) / 9);
    const b = fbox(bw, bh, d, colors[i % colors.length]);
    b.position.set(x, bh / 2, 0);
    g.add(b);
    x += w;
  }
  return g;
}

/* ---- per-product room presets ---------------------------------------------- */

/**
 * Room-mode camera framing shares frameCamera()'s fit formula (dist grows
 * ~3.66x faster than radius at the viewer's fixed 34deg vertical FOV), so a
 * room sized to just the furniture footprint gets blown through by the
 * camera long before the OrbitControls azimuth arc maxes out. Every room
 * shell below is sized generously so the ~130-160deg frontal arc, at any
 * allowed polar/distance, keeps the camera on the interior side of both
 * walls (verified empirically via screenshots, see task notes).
 */
const FITSCALE_ROOM = 0.78;

/**
 * Build a frame spec ({center, radius, azimuth, ...}) that fits BOTH the
 * product (approximated as model.center +/- model.radius, i.e. the same
 * sphere studio mode fits tightly) and the room's furniture group — unlike
 * model.radius alone, which only ever accounted for the product + a sliver
 * of podium and knows nothing about a dining table or a chair down at floor
 * level. Wall/floor shell meshes are deliberately excluded from this fit
 * (only `furniture` is measured) so the camera doesn't zoom out to frame the
 * whole wall — a fixed generous room size handles that instead.
 */
function roomCameraFrame(model, furniture, opts) {
  const r = model.radius, c = model.center;
  const box = new THREE.Box3(
    new THREE.Vector3(c.x - r, c.y - r, c.z - r),
    new THREE.Vector3(c.x + r, c.y + r, c.z + r));
  if (furniture) {
    furniture.updateMatrixWorld(true);
    box.union(new THREE.Box3().setFromObject(furniture));
  }
  const center = box.getCenter(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  return {
    center, radius: sphere.radius, fitScale: opts.fitScale ?? FITSCALE_ROOM,
    azimuth: opts.azimuth ?? 0.45, elevation: opts.elevation ?? 0.28,
    azimuthSpread: THREE.MathUtils.degToRad(opts.spreadDeg ?? 68),
    minPolar: opts.minPolar ?? 0.85, maxPolar: opts.maxPolar ?? 1.25,
    minDistScale: opts.minDistScale ?? 0.85, maxDistScale: opts.maxDistScale ?? 1.12,
    autoRotateSpeed: opts.autoRotateSpeed ?? 0.3,
  };
}

function buildAuroraPendantRoom(model) {
  const floorY = -0.74;
  const shell = buildRoomShell({ width: 6.4, depth: 1.6, height: 2.3, floorY, frontExtra: 1.3 });
  const group = shell.group;
  const furniture = new THREE.Group();
  group.add(furniture);

  furniture.add(roundTable({ topRadius: 0.82, legH: 0.62, footRadius: 0.28, color: 0x6b4d34 }));
  addRestingContactShadow(group, model.podiumRadius);

  const chairColor = 0x474038;
  const chair1 = chairSilhouette(chairColor);
  chair1.position.set(-0.62, floorY, 0.8);
  chair1.rotation.y = -0.4;
  furniture.add(chair1);
  const chair2 = chairSilhouette(chairColor);
  chair2.position.set(0.68, floorY, 0.66);
  chair2.rotation.y = 0.55;
  furniture.add(chair2);

  addWindow(group, { width: 0.7, height: 1.0, pos: new THREE.Vector3(0.8, floorY + 1.35, shell.backZ + 0.035), normal: 'z' });
  const roomLights = addRoomAmbientLights(group);

  return {
    group, roomLights,
    camera: roomCameraFrame(model, furniture, { azimuth: 0.44, elevation: 0.3 }),
  };
}

function buildCrystalChandelierRoom(model) {
  const floorY = -0.78;
  const shell = buildRoomShell({ width: 8.0, depth: 1.8, height: 2.75, floorY, frontExtra: 1.4 });
  const group = shell.group;
  const furniture = new THREE.Group();
  group.add(furniture);

  furniture.add(roundTable({ topRadius: 1.05, legH: 0.66, footRadius: 0.34, color: 0x5a4128 }));
  addRestingContactShadow(group, model.podiumRadius);

  const moldingColor = 0x14110d;
  const molding = fbox(shell.halfW * 2 - 0.1, 0.035, 0.03, moldingColor);
  molding.position.set(0, floorY + 1.75, shell.backZ + 0.033);
  molding.receiveShadow = false;
  group.add(molding);
  const moldingSide = fbox(0.03, 0.035, shell.frontZ - shell.backZ - 0.1, moldingColor);
  moldingSide.position.set(shell.sideX + 0.033, floorY + 1.75, (shell.backZ + shell.frontZ) / 2);
  moldingSide.receiveShadow = false;
  group.add(moldingSide);

  addWindow(group, { width: 0.85, height: 1.3, pos: new THREE.Vector3(-1.05, floorY + 1.6, shell.backZ + 0.035), normal: 'z' });
  const roomLights = addRoomAmbientLights(group);

  return {
    group, roomLights,
    camera: roomCameraFrame(model, furniture, { azimuth: 0.4, elevation: 0.28, autoRotateSpeed: 0.28 }),
  };
}

function buildArcFloorRoom(model) {
  const floorY = 0;
  const shell = buildRoomShell({ width: 9.2, depth: 1.9, height: 2.4, floorY, frontExtra: 1.5 });
  const group = shell.group;
  const furniture = new THREE.Group();
  group.add(furniture);

  const rug = rugMesh(0.95, 0x33291f);
  rug.position.set(-0.1, floorY + 0.004, 0.2);
  rug.receiveShadow = false; // avoid shadow-map acne from the tight overhead spot on a big flat disc
  furniture.add(rug);

  const chair = armchairSilhouette(0x50493f);
  chair.position.set(-1.05, floorY, 0.6);
  chair.rotation.y = 0.55;
  furniture.add(chair);

  const side = sideTable(0x5a4432);
  side.position.set(-0.12, floorY, 1.0);
  furniture.add(side);

  const art = artFrame(0.55, 0.75);
  art.position.set(0.55, floorY + 1.55, shell.backZ + 0.033);
  group.add(art);

  addWindow(group, { width: 0.6, height: 0.95, pos: new THREE.Vector3(shell.sideX + 0.035, floorY + 1.5, 0.35), normal: 'x' });
  const roomLights = addRoomAmbientLights(group);

  return {
    group, roomLights,
    camera: roomCameraFrame(model, furniture, { azimuth: 0.4, elevation: 0.24, autoRotateSpeed: 0.28 }),
  };
}

function buildMushroomTableRoom(model) {
  const floorY = -0.46;
  const shell = buildRoomShell({ width: 6.0, depth: 1.3, height: 2.2, floorY, frontExtra: 1.1 });
  const group = shell.group;
  const furniture = new THREE.Group();
  group.add(furniture);

  furniture.add(platform({ topW: 1.05, topD: 0.42, legH: 0.4, color: 0x5d4530 }));
  addRestingContactShadow(group, model.podiumRadius);

  const sofa = sofaSilhouette(0x4c473f, 1.3);
  sofa.scale.setScalar(0.85);
  sofa.rotation.y = Math.PI / 2;
  sofa.position.set(shell.sideX + 0.55, floorY, shell.backZ + 0.75);
  furniture.add(sofa);

  addWindow(group, { width: 0.55, height: 0.85, pos: new THREE.Vector3(0.75, floorY + 1.35, shell.backZ + 0.035), normal: 'z' });
  const roomLights = addRoomAmbientLights(group);

  return {
    group, roomLights,
    camera: roomCameraFrame(model, furniture, { azimuth: 0.45, elevation: 0.28 }),
  };
}

function buildNeonQuasarRoom(model) {
  const floorY = -0.36;
  const shell = buildRoomShell({
    width: 6.4, depth: 1.3, height: 2.2, floorY, frontExtra: 1.1, wallColor: ROOM_WALL_COLOR_ACCENT,
  });
  const group = shell.group;
  const furniture = new THREE.Group();
  group.add(furniture);

  furniture.add(platform({ topW: 0.95, topD: 0.5, topH: 0.045, legH: 0.315, color: 0x211d17 }));
  addRestingContactShadow(group, model.podiumRadius);

  addWindow(group, {
    width: 0.35, height: 1.1,
    pos: new THREE.Vector3(shell.sideX + 0.035, floorY + 1.4, 0.25), normal: 'x', color: 0x7fb0da,
  });
  const roomLights = addRoomAmbientLights(group, { warmBase: 0.34, coolBase: 0.3 });

  return {
    group, roomLights,
    camera: roomCameraFrame(model, furniture, { azimuth: 0.45, elevation: 0.3 }),
  };
}

function buildLumenDeskRoom(model) {
  const floorY = -0.72;
  const shell = buildRoomShell({ width: 6.2, depth: 1.3, height: 2.3, floorY, frontExtra: 1.1 });
  const group = shell.group;
  const furniture = new THREE.Group();
  group.add(furniture);

  furniture.add(platform({ topW: 1.0, topD: 0.55, legH: 0.67, color: 0x4a3826 }));
  addRestingContactShadow(group, model.podiumRadius);

  const chair = chairSilhouette(0x433d34);
  chair.rotation.y = Math.PI;
  chair.position.set(0.05, floorY, 0.58);
  furniture.add(chair);

  const shelfY = floorY + 1.55;
  const shelf = floatingShelf({ w: 0.9, d: 0.22, color: 0x3c2c1d });
  shelf.position.set(0, shelfY, shell.backZ + 0.14);
  group.add(shelf);
  const books = bookRow(7, 0.06, 0.22, 0.18, [0x6a4638, 0x35424a, 0x55502f, 0x2d3838, 0x5c3c33]);
  books.position.set(0, shelfY + 0.001, shell.backZ + 0.14);
  group.add(books);

  addWindow(group, { width: 0.6, height: 0.9, pos: new THREE.Vector3(shell.sideX + 0.035, floorY + 1.3, 0.4), normal: 'x' });
  const roomLights = addRoomAmbientLights(group);

  return {
    group, roomLights,
    camera: roomCameraFrame(model, furniture, { azimuth: 0.45, elevation: 0.28 }),
  };
}

const ROOM_BUILDERS = {
  'aurora-pendant': buildAuroraPendantRoom,
  'crystal-chandelier': buildCrystalChandelierRoom,
  'arc-floor': buildArcFloorRoom,
  'mushroom-table': buildMushroomTableRoom,
  'neon-quasar': buildNeonQuasarRoom,
  'lumen-desk': buildLumenDeskRoom,
};

/** Build a product's room bundle and attach it into the (already-built)
 * product scene. Only called by ProductViewer — renderThumbnail never
 * touches room mode, keeping thumbnails on the fast studio/podium path. */
function buildRoomBundle(productKey, model, scene) {
  const builder = ROOM_BUILDERS[productKey];
  if (!builder) throw new Error(`viewer3d: no room preset for "${productKey}"`);
  const room = builder(model);
  room.group.visible = false;
  scene.add(room.group);
  model.roomLights = room.roomLights;
  return room;
}

/* ============================================================================
 * ProductViewer
 * ========================================================================== */

const POWER_ANIM_S = 0.3;

/**
 * Interactive 3D viewer for one product, rendering into a supplied canvas.
 */
export class ProductViewer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {string} productKey one of PRODUCT_KEYS
   * @param {{interactive?: boolean, autoRotate?: boolean, transparent?: boolean, room?: boolean}} [opts]
   */
  constructor(canvas, productKey, opts = {}) {
    const { interactive = true, autoRotate = true, transparent = true, room = false } = opts;
    this._canvas = canvas;
    this._disposed = false;

    this._renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: transparent,
      powerPreference: 'high-performance',
    });
    configureRenderer(this._renderer);
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if (transparent) this._renderer.setClearColor(0x000000, 0);

    this._built = buildProductScene(productKey, this._renderer);
    this._roomBundle = buildRoomBundle(productKey, this._built.model, this._built.scene);

    // state
    this._power = true;
    this._powerLevel = 1;
    this._intensity = 1;
    this._kelvin = 3000;
    this._color = this._lampColor(3000);
    this._roomMode = false;
    this._camTween = null;

    // camera + controls (studio framing first — matches pre-room-mode behavior exactly)
    this._camera = new THREE.PerspectiveCamera(34, 1, 0.05, 60);
    this._camera.aspect = Math.max(0.1, (canvas.clientWidth || 640) / (canvas.clientHeight || 480));
    const dist = frameCamera(this._camera, this._built.model);
    this._controls = null;
    this._fallbackSpin = autoRotate;
    this._autoRotateWanted = autoRotate;
    if (interactive) {
      this._controls = new OrbitControls(this._camera, canvas);
      this._controls.enableDamping = true;
      this._controls.dampingFactor = 0.06;
      this._controls.enablePan = false;
      this._controls.target.copy(this._built.model.center);
      this._controls.minDistance = dist * 0.55;
      this._controls.maxDistance = dist * 2.2;
      this._controls.minPolarAngle = 0.15;
      this._controls.maxPolarAngle = 1.52;
      this._controls.autoRotate = autoRotate;
      this._controls.autoRotateSpeed = 1.0;
      this._controls.update();
      this._fallbackSpin = false;
    }

    // listeners
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._onVisibility = () => {
      if (this._disposed) return;
      if (document.hidden) this._stopLoop();
      else this._startLoop();
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    this._raf = 0;
    this._lastT = performance.now();
    this.resize();
    applyState(this._built, this._color, this._effective(1), this._powerLevel);
    if (room) this.setRoom(true, { instant: true });
    this._startLoop();
  }

  _lampColor(kelvin) {
    const map = this._built?.model?.kelvinMap;
    return map ? map(kelvin) : kelvinToRGB(kelvin);
  }

  _effective(flicker) {
    return this._powerLevel * this._intensity * flicker;
  }

  /** Turn the lamp on/off (smooth ~300ms transition). @param {boolean} on */
  setPower(on) {
    this._power = !!on;
  }

  /** Set color temperature in Kelvin (2200..6500). @param {number} kelvin */
  setTemperature(kelvin) {
    this._kelvin = THREE.MathUtils.clamp(kelvin, 2200, 6500);
    this._color = this._lampColor(this._kelvin);
  }

  /** Scale lamp brightness. @param {number} v 0..1 */
  setIntensity(v) {
    this._intensity = THREE.MathUtils.clamp(v, 0, 1);
  }

  /** Toggle idle auto-rotation. @param {boolean} on */
  setAutoRotate(on) {
    this._autoRotateWanted = !!on;
    if (this._camTween) return; // re-applied when the tween finishes
    if (this._controls) this._controls.autoRotate = !!on;
    else this._fallbackSpin = !!on;
  }

  /**
   * Switch between "studio" (podium in a void — unchanged look) and "room"
   * (furnished stylized interior) modes. Smoothly animates the camera to the
   * new framing (~600ms ease) and constrains OrbitControls to a frontal arc
   * in room mode so orbiting can never show the outside of a wall.
   * @param {boolean} on
   */
  setRoom(on, { instant = false } = {}) {
    on = !!on;
    if (this._disposed) return;
    if (on === this._roomMode && !instant) return;
    this._roomMode = on;

    // swap scene contents: the generic studio podium/contact vs. the room
    const model = this._built.model;
    model.podiumMesh.visible = !on;
    model.contactMesh.visible = !on;
    this._roomBundle.group.visible = on;

    const frame = on ? this._roomBundle.camera : model;
    const dist = computeFitDistance(this._camera, frame);
    const azim = frame.azimuth ?? 0.6;
    const elev = frame.elevation ?? 0.3;
    const toPos = sphericalPos(frame.center, dist, azim, elev);

    const finalize = () => {
      if (this._controls) {
        if (on) {
          const rc = this._roomBundle.camera;
          this._controls.minAzimuthAngle = rc.azimuth - rc.azimuthSpread;
          this._controls.maxAzimuthAngle = rc.azimuth + rc.azimuthSpread;
          this._controls.minPolarAngle = rc.minPolar;
          this._controls.maxPolarAngle = rc.maxPolar;
          this._controls.minDistance = dist * rc.minDistScale;
          this._controls.maxDistance = dist * rc.maxDistScale;
          this._controls.autoRotateSpeed = rc.autoRotateSpeed;
        } else {
          this._controls.minAzimuthAngle = -Infinity;
          this._controls.maxAzimuthAngle = Infinity;
          this._controls.minPolarAngle = 0.15;
          this._controls.maxPolarAngle = 1.52;
          this._controls.minDistance = dist * 0.55;
          this._controls.maxDistance = dist * 2.2;
          this._controls.autoRotateSpeed = 1.0;
        }
        this._controls.target.copy(frame.center);
        this._controls.enabled = true;
        this._controls.autoRotate = this._autoRotateWanted;
        this._controls.update();
      }
      this._camTween = null;
    };

    if (instant) {
      this._camera.position.copy(toPos);
      this._camera.lookAt(frame.center);
      this._camera.updateProjectionMatrix();
      this._camTween = null;
      finalize();
      return;
    }

    if (this._controls) {
      this._controls.autoRotate = false;
      this._controls.enabled = false;
    }
    this._camTween = {
      fromPos: this._camera.position.clone(),
      fromTarget: this._controls ? this._controls.target.clone() : frame.center.clone(),
      toPos, toTarget: frame.center.clone(),
      t0: performance.now(), dur: 620,
      onDone: finalize,
    };
  }

  /** Re-read the canvas client size and update renderer + camera. */
  resize() {
    if (this._disposed) return;
    const w = Math.max(1, this._canvas.clientWidth || this._canvas.width || 1);
    const h = Math.max(1, this._canvas.clientHeight || this._canvas.height || 1);
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  _startLoop() {
    if (this._raf || this._disposed) return;
    this._lastT = performance.now();
    const tick = (now) => {
      if (this._disposed) return;
      this._raf = requestAnimationFrame(tick);
      // clamp: RAF can hand the first callback a timestamp older than _lastT
      const dt = Math.max(0, Math.min(0.1, (now - this._lastT) / 1000));
      this._lastT = now;
      const t = now / 1000;

      // smooth power transition (~300ms)
      const target = this._power ? 1 : 0;
      const step = dt / POWER_ANIM_S;
      this._powerLevel = THREE.MathUtils.clamp(
        this._powerLevel < target ? this._powerLevel + step : this._powerLevel - step,
        Math.min(this._powerLevel, target), Math.max(this._powerLevel, target));

      const model = this._built.model;
      const flicker = model.flicker ? model.flicker(t) : 1;
      applyState(this._built, this._color, this._effective(flicker), this._powerLevel);
      if (model.sway) model.sway(t);

      if (this._camTween) {
        const tw = this._camTween;
        const k = Math.min(1, (now - tw.t0) / tw.dur);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // easeInOutCubic
        this._camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
        _tweenTarget.lerpVectors(tw.fromTarget, tw.toTarget, e);
        this._camera.lookAt(_tweenTarget);
        if (k >= 1) {
          const done = tw.onDone;
          tw.onDone = null;
          if (done) done();
        }
      } else if (this._controls) {
        this._controls.update();
      } else if (this._fallbackSpin) {
        model.group.rotation.y += dt * 0.35;
      }

      this._renderer.render(this._built.scene, this._camera);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _stopLoop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
  }

  /** Stop rendering and free all GPU resources. Safe to call twice. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._stopLoop();
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._controls) this._controls.dispose();
    for (const h of this._built.model.halos) if (h.material.map) h.material.map.dispose();
    disposeSceneResources(this._built.scene);
    this._renderer.dispose();
    this._built = null;
  }
}

/* ============================================================================
 * Thumbnails — one shared offscreen renderer
 * ========================================================================== */

let _thumbRenderer = null;

/**
 * Render a static product thumbnail (powered on, 3000K, 3/4 view, transparent bg).
 * Reuses one shared offscreen renderer, so calling it 6x at page load is cheap.
 * @param {string} productKey one of PRODUCT_KEYS
 * @param {number} [width=640]
 * @param {number} [height=480]
 * @returns {string} PNG data URL
 */
export function renderThumbnail(productKey, width = 640, height = 480) {
  if (!_thumbRenderer) {
    _thumbRenderer = new THREE.WebGLRenderer({
      antialias: true, alpha: true, preserveDrawingBuffer: true,
    });
    configureRenderer(_thumbRenderer);
    _thumbRenderer.setClearColor(0x000000, 0);
    _thumbRenderer.setPixelRatio(1);
  }
  _thumbRenderer.setSize(width, height, false);

  const built = buildProductScene(productKey, _thumbRenderer);
  const camera = new THREE.PerspectiveCamera(34, width / height, 0.05, 60);
  frameCamera(camera, built.model);
  const model = built.model;
  const color = model.kelvinMap ? model.kelvinMap(3000) : kelvinToRGB(3000);
  applyState(built, color, 1, 1);

  _thumbRenderer.render(built.scene, camera);
  const url = _thumbRenderer.domElement.toDataURL('image/png');

  for (const h of model.halos) if (h.material.map) h.material.map.dispose();
  disposeSceneResources(built.scene);
  return url;
}
