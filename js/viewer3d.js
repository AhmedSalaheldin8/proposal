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
import { RectAreaLightUniformsLib } from '../vendor/RectAreaLightUniformsLib.js';

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
  // room mode dials the studio rig + env way down so the room's own window /
  // lamp lights own the scene (rigScale/envScale set by ProductViewer.setRoom;
  // both default to 1 so studio + thumbnail rendering is untouched)
  const rigScale = built.rigScale ?? 1;
  scene.environmentIntensity = (0.55 - 0.22 * offAmount) * (built.envScale ?? 1);
  for (const l of rig) {
    l.intensity = l.userData._rig.base * (1 + l.userData._rig.offBoost * offAmount) * rigScale;
  }
  // room mode shrinks the product group to real-world size; light POSITIONS
  // scale with the group but intensities don't, so lampScale (set by setRoom,
  // default 1 = studio/thumbnail untouched) retrims the product's own lights.
  // Room-owned bounce fills (noRoomScale) are tuned in room space and exempt.
  const lampScale = built.lampScale ?? 1;
  for (const l of model.lights) {
    const d = l.userData._lamp;
    _tmpColor.copy(color).lerp(_white, 1 - d.colorMix);
    l.color.copy(_tmpColor);
    l.intensity = d.base * eff * (d.noRoomScale ? 1 : lampScale);
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
    for (const key of ['map', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'normalMap', 'alphaMap', 'bumpMap', 'aoMap', 'lightMap']) {
      if (m[key]) m[key].dispose();
    }
    m.dispose();
  }
  scene.clear();
}

/* ============================================================================
 * Room mode — per-product furnished interiors (archviz-style corner sets).
 *
 * Each room is a proper corner: two plaster walls + plank floor + ceiling,
 * an evening window (procedural dusk-sky texture + RectAreaLight pouring
 * cool light in), and real furniture silhouettes — rounded forms, fabric and
 * wood materials, contact-shadow decals under everything, baked corner AO.
 *
 * All texture pixels are generated once into module-cached canvases;
 * per-scene CanvasTextures are created fresh so the existing
 * disposeSceneResources path cleans them up per viewer.
 *
 * A room bundle is { group, roomLights, lampLights, camera }:
 *   group      — added into the product scene, toggled via .visible
 *   roomLights — always-on room ambience (window RectAreaLight, dim fills);
 *                applyState brightens them slightly as the lamp powers down
 *   lampLights — non-casting warm fills that FOLLOW the product lamp
 *                (kelvin-tinted, scale with power) to fake bounce light;
 *                appended into model.lights by buildRoomBundle
 *   camera     — frame spec + OrbitControls constraints (see roomCameraFrame)
 *
 * Convention: the product model is never moved; world y=0 is the surface the
 * product rests on. Rooms with tables/consoles/desks descend to a negative
 * floorY.
 * ========================================================================== */

let _rectAreaReady = false;
function ensureRectAreaLib() {
  if (!_rectAreaReady) {
    RectAreaLightUniformsLib.init();
    _rectAreaReady = true;
  }
}

/* ---- deterministic RNG + tileable value noise ------------------------------ */

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable multi-octave value noise, returns Float32Array of size*size in 0..1. */
function noiseField(size, octaves = 4, seed = 7, baseRes = 8) {
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const res = baseRes << o;
    const rnd = mulberry(seed * 31 + o * 101 + 5);
    const grid = new Float32Array(res * res);
    for (let i = 0; i < grid.length; i++) grid[i] = rnd();
    const cell = size / res;
    for (let y = 0; y < size; y++) {
      const gy = y / cell;
      const y0 = Math.floor(gy) % res, y1 = (y0 + 1) % res;
      const fy = gy - Math.floor(gy), sy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < size; x++) {
        const gx = x / cell;
        const x0 = Math.floor(gx) % res, x1 = (x0 + 1) % res;
        const fx = gx - Math.floor(gx), sx = fx * fx * (3 - 2 * fx);
        const a = grid[y0 * res + x0], b = grid[y0 * res + x1];
        const c = grid[y1 * res + x0], d = grid[y1 * res + x1];
        const top = a + (b - a) * sx, bot = c + (d - c) * sx;
        out[y * size + x] += (top + (bot - top) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function canvasOf(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function texOf(canvas, { srgb = false, repeat = null } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

/* ---- procedural texture canvases (all cached, generated once) -------------- */

/** Plank floor: albedo (1024) + bump (512) + roughness (512). 8 planks per
 * tile, one tile = 0.84m square in world space (planks ~10.5cm wide — adjacent
 * same-stain planks fuse a little at grazing angles/mip levels, so they READ
 * ~12–15cm, matching real boards; the old 1.12m tile read 30cm+). */
let _plankSet = null;
const FLOOR_TILE_M = 0.84;
function plankSet() {
  if (_plankSet) return _plankSet;
  const S = 1024;
  const A = canvasOf(S), B = canvasOf(512), R = canvasOf(512);
  const a = A.getContext('2d'), b = B.getContext('2d'), r = R.getContext('2d');
  b.setTransform(0.5, 0, 0, 0.5, 0, 0);
  r.setTransform(0.5, 0, 0, 0.5, 0, 0);
  const rnd = mulberry(4021);
  a.fillStyle = '#5d4128'; a.fillRect(0, 0, S, S);
  b.fillStyle = '#7d7d7d'; b.fillRect(0, 0, S, S);
  r.fillStyle = '#7a7a7a'; r.fillRect(0, 0, S, S);
  const cols = 8, w = S / cols;
  const stains = ['#6b4a2e', '#63452b', '#72512f', '#684b30', '#755735', '#5e4128', '#6e4e31', '#664933'];
  for (let i = 0; i < cols; i++) {
    let y = -Math.floor(rnd() * 500);
    while (y < S) {
      const len = 520 + rnd() * 430;
      a.fillStyle = stains[Math.floor(rnd() * stains.length)];
      a.fillRect(i * w, y, w, len);
      const l = (rnd() - 0.5) * 0.1;
      a.fillStyle = l > 0 ? `rgba(255,224,178,${l})` : `rgba(18,10,5,${-l})`;
      a.fillRect(i * w, y, w, len);
      const bl = 116 + Math.floor(rnd() * 26);
      b.fillStyle = `rgb(${bl},${bl},${bl})`; b.fillRect(i * w, y, w, len);
      const rl = 96 + Math.floor(rnd() * 48);
      r.fillStyle = `rgb(${rl},${rl},${rl})`; r.fillRect(i * w, y, w, len);
      // grain streaks
      const grains = 9 + Math.floor(rnd() * 7);
      for (let gi = 0; gi < grains; gi++) {
        const gx = i * w + 5 + rnd() * (w - 10);
        const amp = 2 + rnd() * 5;
        const dark = rnd() > 0.35;
        a.strokeStyle = dark
          ? `rgba(28,15,7,${0.07 + rnd() * 0.12})`
          : `rgba(235,202,150,${0.04 + rnd() * 0.07})`;
        a.lineWidth = 0.8 + rnd() * 1.5;
        a.beginPath();
        a.moveTo(gx, y);
        for (let gy = y; gy < y + len; gy += 26) {
          a.quadraticCurveTo(gx + (rnd() - 0.5) * amp * 2, gy + 13, gx + (rnd() - 0.5) * amp, gy + 26);
        }
        a.stroke();
        b.strokeStyle = `rgba(74,74,74,${0.1 + rnd() * 0.14})`;
        b.lineWidth = 1.6;
        b.beginPath(); b.moveTo(gx, y); b.lineTo(gx + (rnd() - 0.5) * 8, y + len); b.stroke();
      }
      // occasional knot
      if (rnd() < 0.28) {
        const kx = i * w + w * (0.25 + rnd() * 0.5), ky = y + len * (0.2 + rnd() * 0.6);
        const kr = 8 + rnd() * 14;
        const g = a.createRadialGradient(kx, ky, 0, kx, ky, kr);
        g.addColorStop(0, 'rgba(30,17,9,0.6)');
        g.addColorStop(0.55, 'rgba(58,36,19,0.28)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        a.fillStyle = g;
        a.beginPath(); a.arc(kx, ky, kr, 0, 7); a.fill();
      }
      // butt seam
      a.fillStyle = 'rgba(14,8,4,0.85)'; a.fillRect(i * w, y + len - 2, w, 2.6);
      b.fillStyle = '#262626'; b.fillRect(i * w, y + len - 2, w, 3);
      y += len;
    }
    // long seams between planks
    a.fillStyle = 'rgba(12,7,4,0.9)'; a.fillRect(i * w - 1.3, 0, 2.6, S);
    b.fillStyle = '#1f1f1f'; b.fillRect(i * w - 1.6, 0, 3.2, S);
  }
  _plankSet = { A, B, R };
  return _plankSet;
}

function woodFloorMaterial(width, depth) {
  const { A, B, R } = plankSet();
  const rep = [width / FLOOR_TILE_M, depth / FLOOR_TILE_M];
  const map = texOf(A, { srgb: true, repeat: rep });
  map.anisotropy = 4;
  const mat = new THREE.MeshStandardMaterial({
    map,
    bumpMap: texOf(B, { repeat: rep }),
    bumpScale: 0.6,
    roughnessMap: texOf(R, { repeat: rep }),
    roughness: 0.85, // scales the map — planks land ~0.32..0.48
    metalness: 0.02,
    envMapIntensity: 0.4,
  });
  return mat;
}

/** Warm mottled plaster: albedo (512, gradient-AO baked vertically) + bump.
 * Albedo is near-neutral (~200 gray) so material.color tints per room. */
let _plasterSet = null;
function plasterSet() {
  if (_plasterSet) return _plasterSet;
  const S = 512;
  const n1 = noiseField(S, 4, 91, 6);
  const n2 = noiseField(S, 3, 47, 24);
  const A = canvasOf(S), B = canvasOf(256);
  const a = A.getContext('2d'), b = B.getContext('2d');
  const img = a.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    const fy = y / S;
    // baked vertical AO: darker near floor (canvas bottom), whisper at ceiling
    let f = 1 - 0.2 * THREE.MathUtils.smoothstep(fy, 0.66, 1.0);
    f -= 0.07 * (1 - THREE.MathUtils.smoothstep(fy, 0.0, 0.08));
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const v = (196 + (n1[i] - 0.5) * 30 + (n2[i] - 0.5) * 10) * f;
      const o = i * 4;
      img.data[o] = v * 1.02;
      img.data[o + 1] = v * 0.975;
      img.data[o + 2] = v * 0.925;
      img.data[o + 3] = 255;
    }
  }
  a.putImageData(img, 0, 0);
  const img2 = b.createImageData(256, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const i = (y * 2) * S + x * 2;
      const v = 128 + (n1[i] - 0.5) * 44 + (n2[i] - 0.5) * 30;
      const o = (y * 256 + x) * 4;
      img2.data[o] = img2.data[o + 1] = img2.data[o + 2] = v;
      img2.data[o + 3] = 255;
    }
  }
  b.putImageData(img2, 0, 0);
  _plasterSet = { A, B };
  return _plasterSet;
}

function plasterMaterial(widthMeters, tint = 0x8d7c68) {
  const { A, B } = plasterSet();
  const repX = Math.max(1, Math.round(widthMeters / 2.6));
  const map = texOf(A, { srgb: true });
  map.wrapS = THREE.RepeatWrapping;
  map.repeat.set(repX, 1);
  const bump = texOf(B);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.repeat.set(repX * 2, 2);
  return new THREE.MeshStandardMaterial({
    color: tint, map, bumpMap: bump, bumpScale: 0.35,
    roughness: 0.92, metalness: 0, envMapIntensity: 0.18,
  });
}

/** Woven rug: albedo with border pattern + weave bump. Non-repeating (border
 * baked), near-neutral so material.color tints per room. */
let _rugSet = null;
function rugSet() {
  if (_rugSet) return _rugSet;
  const S = 512;
  const A = canvasOf(S), B = canvasOf(256);
  const a = A.getContext('2d'), b = B.getContext('2d');
  const rnd = mulberry(777);
  a.fillStyle = '#b9a88e'; a.fillRect(0, 0, S, S);
  // weave: fine cross-hatch
  for (let y = 0; y < S; y += 3) {
    a.fillStyle = `rgba(60,45,30,${0.1 + (y % 6 === 0 ? 0.1 : 0)})`;
    a.fillRect(0, y, S, 1);
  }
  for (let x = 0; x < S; x += 3) {
    a.fillStyle = `rgba(255,240,210,${0.07 + (x % 6 === 0 ? 0.06 : 0)})`;
    a.fillRect(x, 0, 1, S);
  }
  for (let i = 0; i < 2600; i++) {
    const v = rnd();
    a.fillStyle = v > 0.5 ? `rgba(50,38,26,${0.05 + rnd() * 0.1})` : `rgba(255,244,220,${0.04 + rnd() * 0.08})`;
    a.fillRect(rnd() * S, rnd() * S, 1.6, 1.6);
  }
  // border: double band + corner blocks, complementary deep tone
  a.strokeStyle = 'rgba(64,44,34,0.9)';
  a.lineWidth = 14; a.strokeRect(18, 18, S - 36, S - 36);
  a.strokeStyle = 'rgba(120,84,52,0.85)';
  a.lineWidth = 5; a.strokeRect(40, 40, S - 80, S - 80);
  a.strokeStyle = 'rgba(64,44,34,0.65)';
  a.lineWidth = 3; a.strokeRect(54, 54, S - 108, S - 108);
  // inner field motif: sparse diamond grid
  a.strokeStyle = 'rgba(88,64,44,0.4)';
  a.lineWidth = 2;
  for (let gx = 96; gx < S - 96; gx += 80) {
    for (let gy = 96; gy < S - 96; gy += 80) {
      a.beginPath();
      a.moveTo(gx + 40, gy + 16); a.lineTo(gx + 64, gy + 40);
      a.lineTo(gx + 40, gy + 64); a.lineTo(gx + 16, gy + 40);
      a.closePath(); a.stroke();
    }
  }
  // bump: horizontal weave ridges + noise
  b.fillStyle = '#808080'; b.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 2) {
    b.fillStyle = y % 4 === 0 ? '#9a9a9a' : '#6a6a6a';
    b.fillRect(0, y, 256, 1);
  }
  for (let i = 0; i < 1400; i++) {
    b.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.14)';
    b.fillRect(rnd() * 256, rnd() * 256, 1.5, 1.5);
  }
  _rugSet = { A, B };
  return _rugSet;
}

function rugMaterial(tint = 0x6a5844) {
  const { A, B } = rugSet();
  const bump = texOf(B, { repeat: [7, 7] });
  return new THREE.MeshStandardMaterial({
    color: tint, map: texOf(A, { srgb: true }),
    bumpMap: bump, bumpScale: 0.5,
    roughness: 0.97, metalness: 0, envMapIntensity: 0.1,
  });
}

/** Evening city sky seen through the window: deep blue -> amber horizon,
 * skyline silhouettes with a few lit windows on the lower third. */
let _skyCanvas = null;
function skyCanvasEl() {
  if (_skyCanvas) return _skyCanvas;
  const S = 512;
  const c = canvasOf(S);
  const ctx = c.getContext('2d');
  const rnd = mulberry(3131);
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0.0, '#0e1e46');
  g.addColorStop(0.38, '#274a8c');
  g.addColorStop(0.58, '#5563a4');
  g.addColorStop(0.7, '#a97b93');
  g.addColorStop(0.79, '#e89a54');
  g.addColorStop(0.85, '#ffc884');
  g.addColorStop(0.86, '#2c2f42');
  g.addColorStop(1.0, '#181a26');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  // faint stars up top
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(220,230,255,${0.2 + rnd() * 0.5})`;
    ctx.fillRect(rnd() * S, rnd() * S * 0.32, 1.2, 1.2);
  }
  // skyline silhouettes rising from the horizon (y = 0.85*S)
  const horizon = S * 0.852;
  let x = 0;
  while (x < S) {
    const bw = 22 + rnd() * 46;
    const bh = 24 + rnd() * 92;
    ctx.fillStyle = `rgba(21,29,55,${0.88 + rnd() * 0.12})`;
    ctx.fillRect(x, horizon - bh, bw, bh + 4);
    // lit windows
    const nw = Math.floor(rnd() * 8);
    for (let wI = 0; wI < nw; wI++) {
      const warm = rnd() > 0.3;
      ctx.fillStyle = warm
        ? `rgba(255,205,140,${0.5 + rnd() * 0.5})`
        : `rgba(160,195,255,${0.4 + rnd() * 0.4})`;
      ctx.fillRect(x + 3 + rnd() * (bw - 7), horizon - bh + 4 + rnd() * (bh - 10), 2.2, 2.6);
    }
    x += bw + 2 + rnd() * 8;
  }
  // moon with glow
  const mx = S * 0.7, my = S * 0.17;
  const mg = ctx.createRadialGradient(mx, my, 0, mx, my, 34);
  mg.addColorStop(0, 'rgba(235,240,255,0.95)');
  mg.addColorStop(0.16, 'rgba(220,228,250,0.75)');
  mg.addColorStop(0.35, 'rgba(180,200,240,0.16)');
  mg.addColorStop(1, 'rgba(160,190,240,0)');
  ctx.fillStyle = mg;
  ctx.beginPath(); ctx.arc(mx, my, 34, 0, 7); ctx.fill();
  _skyCanvas = c;
  return _skyCanvas;
}

/** Sheer curtain: soft vertical fold shading, warm ivory. */
let _curtainCanvas = null;
function curtainCanvasEl() {
  if (_curtainCanvas) return _curtainCanvas;
  const S = 256;
  const c = canvasOf(S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let x = 0; x < S; x++) {
    const fx = x / S;
    const fold =
      0.62 +
      0.2 * Math.sin(fx * Math.PI * 2 * 4.2) +
      0.12 * Math.sin(fx * Math.PI * 2 * 9.4 + 1.4) +
      0.06 * Math.sin(fx * Math.PI * 2 * 17.0 + 3.0);
    for (let y = 0; y < S; y++) {
      const fy = y / S;
      const vshade = 1 - 0.18 * fy; // slightly darker toward the hem
      const v = Math.max(0, Math.min(1, fold * vshade));
      const o = (y * S + x) * 4;
      img.data[o] = 235 * v + 20;
      img.data[o + 1] = 228 * v + 18;
      img.data[o + 2] = 214 * v + 16;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  _curtainCanvas = c;
  return _curtainCanvas;
}

/** Single leaf with alpha — a handful of these planes reads as a real plant. */
let _leafCanvas = null;
function leafCanvasEl() {
  if (_leafCanvas) return _leafCanvas;
  const S = 128;
  const c = canvasOf(S);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const g = ctx.createLinearGradient(0, S, 0, 0);
  g.addColorStop(0, '#24401f');
  g.addColorStop(0.55, '#3c6128');
  g.addColorStop(1, '#578438');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(S / 2, S - 4);
  ctx.bezierCurveTo(S * 0.1, S * 0.72, S * 0.12, S * 0.3, S / 2, 6);
  ctx.bezierCurveTo(S * 0.88, S * 0.3, S * 0.9, S * 0.72, S / 2, S - 4);
  ctx.closePath();
  ctx.fill();
  // center vein + side veins
  ctx.strokeStyle = 'rgba(210,230,170,0.5)';
  ctx.lineWidth = 2.4;
  ctx.beginPath(); ctx.moveTo(S / 2, S - 6); ctx.lineTo(S / 2, 10); ctx.stroke();
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = 'rgba(200,225,160,0.3)';
  for (let i = 0; i < 5; i++) {
    const y = S * (0.22 + i * 0.14);
    ctx.beginPath(); ctx.moveTo(S / 2, y + 8); ctx.lineTo(S * 0.24, y - 6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(S / 2, y + 8); ctx.lineTo(S * 0.76, y - 6); ctx.stroke();
  }
  _leafCanvas = c;
  return _leafCanvas;
}

/** Abstract art prints (3 variants) for frames / leaning canvases. */
let _artCanvases = null;
function artCanvasEl(i) {
  if (!_artCanvases) {
    _artCanvases = [];
    // 0: dusk gradient with a sun disc
    {
      const c = canvasOf(256), ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, '#54687f'); g.addColorStop(0.55, '#b08a70');
      g.addColorStop(0.78, '#e8b070'); g.addColorStop(1, '#6a5548');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = 'rgba(238,205,150,0.9)';
      ctx.beginPath(); ctx.arc(150, 118, 42, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(30,26,30,0.55)';
      ctx.fillRect(0, 168, 256, 5);
      ctx.fillRect(0, 186, 256, 2.5);
      _artCanvases.push(c);
    }
    // 1: charcoal field with brass arcs
    {
      const c = canvasOf(256), ctx = c.getContext('2d');
      ctx.fillStyle = '#4a463f'; ctx.fillRect(0, 0, 256, 256);
      const rnd = mulberry(52);
      for (let k = 0; k < 40; k++) {
        ctx.fillStyle = `rgba(255,255,255,${0.03 + rnd() * 0.06})`;
        ctx.fillRect(rnd() * 256, rnd() * 256, 40 + rnd() * 60, 1.5);
      }
      ctx.strokeStyle = 'rgba(196,150,84,0.85)';
      ctx.lineWidth = 7;
      ctx.beginPath(); ctx.arc(96, 150, 62, Math.PI * 0.95, Math.PI * 1.85); ctx.stroke();
      ctx.strokeStyle = 'rgba(150,160,175,0.5)';
      ctx.lineWidth = 3.2;
      ctx.beginPath(); ctx.arc(160, 108, 76, Math.PI * 0.2, Math.PI * 1.05); ctx.stroke();
      ctx.fillStyle = 'rgba(196,150,84,0.9)';
      ctx.beginPath(); ctx.arc(170, 176, 7, 0, 7); ctx.fill();
      _artCanvases.push(c);
    }
    // 2: misty layered hills
    {
      const c = canvasOf(256), ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, '#b8beba'); g.addColorStop(1, '#6d7873');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
      const rnd = mulberry(9);
      for (let band = 0; band < 4; band++) {
        const yb = 96 + band * 38;
        ctx.fillStyle = `rgba(${44 + band * 12},${56 + band * 12},${54 + band * 10},${0.75 - band * 0.1})`;
        ctx.beginPath();
        ctx.moveTo(0, 256);
        ctx.lineTo(0, yb + rnd() * 18);
        for (let x = 0; x <= 256; x += 32) {
          ctx.quadraticCurveTo(x + 16, yb - 14 + rnd() * 30, x + 32, yb + rnd() * 18);
        }
        ctx.lineTo(256, 256);
        ctx.closePath(); ctx.fill();
      }
      _artCanvases.push(c);
    }
    // cream mat border baked into every variant so frames read as art
    for (const c of _artCanvases) {
      const ctx = c.getContext('2d');
      ctx.strokeStyle = '#d8d0c0';
      ctx.lineWidth = 22;
      ctx.strokeRect(11, 11, 234, 234);
      ctx.strokeStyle = 'rgba(30,26,20,0.5)';
      ctx.lineWidth = 2;
      ctx.strokeRect(23, 23, 210, 210);
    }
  }
  return _artCanvases[i % _artCanvases.length];
}

/** Fine boucle-ish fabric bump. */
let _boucleCanvas = null;
function boucleCanvasEl() {
  if (_boucleCanvas) return _boucleCanvas;
  const S = 256;
  const c = canvasOf(S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, S, S);
  const rnd = mulberry(616);
  for (let i = 0; i < 5200; i++) {
    const v = 96 + Math.floor(rnd() * 64);
    ctx.fillStyle = `rgba(${v},${v},${v},0.8)`;
    ctx.beginPath();
    ctx.arc(rnd() * S, rnd() * S, 0.8 + rnd() * 1.6, 0, 7);
    ctx.fill();
  }
  _boucleCanvas = c;
  return _boucleCanvas;
}

/** Striped throw-blanket albedo. */
let _blanketCanvas = null;
function blanketCanvasEl() {
  if (_blanketCanvas) return _blanketCanvas;
  const S = 256;
  const c = canvasOf(S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#b39b78'; ctx.fillRect(0, 0, S, S);
  const rnd = mulberry(88);
  for (let y = 0; y < S; y += 2) {
    ctx.fillStyle = `rgba(70,52,36,${0.06 + (y % 8 === 0 ? 0.08 : 0)})`;
    ctx.fillRect(0, y, S, 1);
  }
  for (let i = 0; i < 1800; i++) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,240,215,0.1)' : 'rgba(50,36,24,0.1)';
    ctx.fillRect(rnd() * S, rnd() * S, 1.5, 1.5);
  }
  // stripes near both ends
  ctx.fillStyle = 'rgba(88,52,38,0.85)';
  ctx.fillRect(0, 14, S, 12);
  ctx.fillRect(0, 34, S, 5);
  ctx.fillRect(0, S - 26, S, 12);
  ctx.fillRect(0, S - 39, S, 5);
  _blanketCanvas = c;
  return _blanketCanvas;
}

/** Subtle straight-grain wood for furniture; near-neutral, tinted by color. */
let _furnWoodCanvas = null;
function furnWoodCanvasEl() {
  if (_furnWoodCanvas) return _furnWoodCanvas;
  const S = 256;
  const c = canvasOf(S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#c9b394'; ctx.fillRect(0, 0, S, S);
  const rnd = mulberry(2718);
  for (let i = 0; i < 46; i++) {
    const y = rnd() * S;
    const dark = rnd() > 0.4;
    ctx.strokeStyle = dark
      ? `rgba(96,66,40,${0.1 + rnd() * 0.16})`
      : `rgba(255,236,200,${0.08 + rnd() * 0.1})`;
    ctx.lineWidth = 0.8 + rnd() * 2.2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(S * 0.3, y + (rnd() - 0.5) * 14, S * 0.7, y + (rnd() - 0.5) * 14, S, y + (rnd() - 0.5) * 6);
    ctx.stroke();
  }
  _furnWoodCanvas = c;
  return _furnWoodCanvas;
}

/** Linear AO gradient (dark at top edge -> clear), for corner-darkening strips. */
let _cornerGradCanvas = null;
function cornerGradCanvasEl() {
  if (_cornerGradCanvas) return _cornerGradCanvas;
  const c = canvasOf(64);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 64, 64);
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.5)');
  g.addColorStop(0.4, 'rgba(0,0,0,0.18)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _cornerGradCanvas = c;
  return _cornerGradCanvas;
}

/* ---- room material + geometry helpers -------------------------------------- */

function fabricMaterial(color) {
  const bump = texOf(boucleCanvasEl(), { repeat: [3, 3] });
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.94, metalness: 0,
    bumpMap: bump, bumpScale: 0.35, envMapIntensity: 0.22,
  });
}

function furnWoodMaterial(color, { roughness = 0.55 } = {}) {
  return new THREE.MeshStandardMaterial({
    color, map: texOf(furnWoodCanvasEl(), { srgb: true, repeat: [1, 1] }),
    roughness, metalness: 0.02, envMapIntensity: 0.45,
  });
}

function paintedMaterial(color, { roughness = 0.4 } = {}) {
  return new THREE.MeshStandardMaterial({
    color, roughness, metalness: 0.05, envMapIntensity: 0.5,
  });
}

function ceramicMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.55, metalness: 0, envMapIntensity: 0.6,
  });
}

function bronzeMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x2a2018, metalness: 0.6, roughness: 0.45, envMapIntensity: 0.6,
  });
}

/** BoxGeometry with rounded edges (clamp-and-project). */
function roundedBoxGeometry(w, h, d, radius, segs = 3) {
  radius = Math.min(radius, w / 2, h / 2, d / 2);
  const geo = new THREE.BoxGeometry(w, h, d, segs, segs, segs);
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const hw = w / 2 - radius, hh = h / 2 - radius, hd = d / 2 - radius;
  const v = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    c.set(
      THREE.MathUtils.clamp(v.x, -hw, hw),
      THREE.MathUtils.clamp(v.y, -hh, hh),
      THREE.MathUtils.clamp(v.z, -hd, hd));
    v.sub(c);
    const len = v.length() || 1;
    v.multiplyScalar(radius / len);
    pos.setXYZ(i, c.x + v.x, c.y + v.y, c.z + v.z);
    nor.setXYZ(i, v.x / radius, v.y / radius, v.z / radius);
  }
  return geo;
}

function rbox(w, h, d, radius, material, segs = 3) {
  // NOTE: furniture skips real shadow receipt — the product's close-range
  // 512px point shadow paints acne on mid-distance surfaces; soft decals
  // (contactOval) carry the grounding instead.
  const m = new THREE.Mesh(roundedBoxGeometry(w, h, d, radius, segs), material);
  return m;
}

/** Tapered round furniture leg, slightly splayed if rx/rz given. */
function taperedLeg(h, rTop, rBot, material, tiltX = 0, tiltZ = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, 8), material);
  m.rotation.x = tiltX;
  m.rotation.z = tiltZ;
  return m;
}

/** Elliptical fake-AO contact decal on the floor (or any horizontal surface). */
function contactOval(sx, sz, opacity = 0.55) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: contactShadowTexture(), transparent: true,
      opacity, depthWrite: false,
    }));
  m.rotation.x = -Math.PI / 2;
  m.scale.set(sx, sz, 1);
  m.renderOrder = 1;
  return m;
}

/** Corner-darkening AO strip. The texture is dark at the strip's local +Y
 * edge, fading to clear at -Y. */
function aoStrip(len, w, opacity = 1) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(len, w),
    new THREE.MeshBasicMaterial({
      map: texOf(cornerGradCanvasEl()), transparent: true,
      opacity, depthWrite: false,
    }));
  m.renderOrder = 1;
  return m;
}

/* ---- architectural shell ---------------------------------------------------- */

/** Vertical wall in the XY plane (x centered, y 0..h) with an optional
 * rectangular window hole; UVs normalized 0..1 so the plaster gradient maps
 * once over the wall height. */
function wallMesh(w, h, material, hole) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(w / 2, h);
  shape.lineTo(-w / 2, h);
  shape.closePath();
  if (hole) {
    const hp = new THREE.Path();
    const x0 = hole.x - hole.w / 2, x1 = hole.x + hole.w / 2;
    const y0 = hole.y - hole.h / 2, y1 = hole.y + hole.h / 2;
    hp.moveTo(x0, y0);
    hp.lineTo(x1, y0);
    hp.lineTo(x1, y1);
    hp.lineTo(x0, y1);
    hp.closePath();
    shape.holes.push(hp);
  }
  const geo = new THREE.ShapeGeometry(shape);
  const uv = geo.attributes.uv, pos = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (pos.getX(i) + w / 2) / w, pos.getY(i) / h);
  }
  return new THREE.Mesh(geo, material);
}

/** A proper room corner: back + left walls (plaster), plank floor, ceiling,
 * baseboards, crown line, baked corner AO. Open toward the camera. */
function buildRoomShell({
  width, depth, height, floorY = 0, frontExtra = 1.4,
  wallTint = 0x8d7c68, ceilTint = 0x81766a, floorDim = 1,
  windows = [], // [{wall:'back'|'side', cx, cy, w, h}] — cut real holes
}) {
  const group = new THREE.Group();
  const halfW = width / 2;
  const backZ = -depth;
  const frontZ = frontExtra;
  const sideX = -halfW;
  const cz = (backZ + frontZ + 3.6) / 2;
  const spanZ = frontZ - backZ + 3.6; // extra run toward the camera

  // floor
  const floorMat = woodFloorMaterial(width, spanZ);
  if (floorDim !== 1) floorMat.color.setScalar(floorDim);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, spanZ), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, floorY, cz);
  floor.receiveShadow = true;
  group.add(floor);

  // walls (single-sided, facing the room; camera is azimuth-clamped).
  // Window rects are cut as REAL holes so the dusk sky + RectAreaLight
  // genuinely sit behind the wall plane.
  const winBack = windows.find((w) => w.wall === 'back');
  const backWall = wallMesh(width, height, plasterMaterial(width, wallTint),
    winBack ? { x: winBack.cx, y: winBack.cy - floorY, w: winBack.w, h: winBack.h } : null);
  backWall.position.set(0, floorY, backZ);
  group.add(backWall);

  const winSide = windows.find((w) => w.wall === 'side');
  const sideWall = wallMesh(spanZ, height, plasterMaterial(spanZ, wallTint),
    winSide ? { x: -(winSide.cx - cz), y: winSide.cy - floorY, w: winSide.w, h: winSide.h } : null);
  sideWall.rotation.y = Math.PI / 2;
  sideWall.position.set(sideX, floorY, cz);
  group.add(sideWall);

  // ceiling (visible when orbiting low) — extends past the walls
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 3, spanZ + 3),
    new THREE.MeshStandardMaterial({
      color: ceilTint, roughness: 0.95, metalness: 0, envMapIntensity: 0.12,
      emissive: 0x17130e, // faint self-light: a dusk ceiling, never a black void
    }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, floorY + height, cz + 0.8);
  group.add(ceil);

  // baseboards: slightly glossy warm white paint
  const bbMat = paintedMaterial(0x9c9184, { roughness: 0.35 });
  const bbH = 0.11, bbD = 0.018;
  const bbBack = new THREE.Mesh(new THREE.BoxGeometry(width, bbH, bbD), bbMat);
  bbBack.position.set(0, floorY + bbH / 2, backZ + bbD / 2);
  group.add(bbBack);
  const bbSide = new THREE.Mesh(new THREE.BoxGeometry(bbD, bbH, spanZ), bbMat);
  bbSide.position.set(sideX + bbD / 2, floorY + bbH / 2, cz);
  group.add(bbSide);

  // crown line near the ceiling
  const crH = 0.055, crD = 0.03;
  const crBack = new THREE.Mesh(new THREE.BoxGeometry(width, crH, crD), bbMat);
  crBack.position.set(0, floorY + height - crH / 2, backZ + crD / 2);
  group.add(crBack);
  const crSide = new THREE.Mesh(new THREE.BoxGeometry(crD, crH, spanZ), bbMat);
  crSide.position.set(sideX + crD / 2, floorY + height - crH / 2, cz);
  group.add(crSide);

  // baked AO: floor strips along both walls + vertical wall-corner strips
  const aoFloorBack = aoStrip(width, 0.5, 0.8);
  aoFloorBack.rotation.x = -Math.PI / 2;
  aoFloorBack.position.set(0, floorY + 0.002, backZ + 0.25);
  group.add(aoFloorBack);
  const aoFloorSide = aoStrip(spanZ, 0.5, 0.8);
  aoFloorSide.rotation.x = -Math.PI / 2;
  aoFloorSide.rotation.z = -Math.PI / 2;
  aoFloorSide.position.set(sideX + 0.25, floorY + 0.002, cz);
  group.add(aoFloorSide);
  const aoWallBack = aoStrip(height, 0.55, 0.65); // on back wall, dark toward corner
  aoWallBack.rotation.z = Math.PI / 2;
  aoWallBack.position.set(sideX + 0.275, floorY + height / 2, backZ + 0.004);
  group.add(aoWallBack);
  const aoWallSide = aoStrip(height, 0.55, 0.65);
  aoWallSide.rotation.y = Math.PI / 2;
  aoWallSide.rotation.z = -Math.PI / 2;
  aoWallSide.position.set(sideX + 0.004, floorY + height / 2, backZ + 0.275);
  group.add(aoWallSide);

  return { group, halfW, sideX, backZ, frontZ, floorY, height, cz, spanZ };
}

/* ---- window ------------------------------------------------------------------ */

/**
 * Evening window with frame + mullions, glowing dusk-sky pane, optional sheer
 * curtain, and a RectAreaLight washing the room in cool light.
 * wall: 'back' (facing +z) or 'side' (facing +x). cx is x on the back wall,
 * z on the side wall; cy is the window center height (world y).
 */
function addWindowAssembly(group, shell, {
  wall = 'back', cx = 0, cy = 0.6, w = 1.0, h = 1.4,
  curtainSide = 0, lightBase = 3.2, lightOffBoost = 0.6,
}) {
  ensureRectAreaLib();
  const g = new THREE.Group();
  const bronze = bronzeMaterial();

  // recessed dusk sky. Slightly oversized so oblique angles never see past its
  // edge through the jamb tunnel (only ~0.03 of parallax is possible through
  // the 0.01 jamb-to-sky gap), but small enough that it can never poke above
  // the wall top: several rooms have as little as 0.11 clearance there, and a
  // larger margin makes the sky visible as a floating strip over the wall.
  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(w + 0.16, h + 0.16),
    new THREE.MeshBasicMaterial({ map: texOf(skyCanvasEl(), { srgb: true }) }));
  sky.position.z = -0.1;
  g.add(sky);

  // reveal (jamb) walls forming the recess
  const jamb = new THREE.MeshStandardMaterial({ color: 0x4c443a, roughness: 0.9, metalness: 0 });
  const jd = 0.09;
  const jTop = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.02, jd), jamb);
  jTop.position.set(0, h / 2 + 0.01, -jd / 2);
  g.add(jTop);
  const jBot = jTop.clone();
  jBot.position.y = -h / 2 - 0.01;
  g.add(jBot);
  const jL = new THREE.Mesh(new THREE.BoxGeometry(0.02, h + 0.02, jd), jamb);
  jL.position.set(-w / 2 - 0.01, 0, -jd / 2);
  g.add(jL);
  const jR = jL.clone();
  jR.position.x = w / 2 + 0.01;
  g.add(jR);

  // dark bronze frame, proud of the wall
  const fw = 0.06, fd = 0.045;
  const fTop = new THREE.Mesh(new THREE.BoxGeometry(w + fw * 2, fw, fd), bronze);
  fTop.position.set(0, h / 2 + fw / 2, 0);
  g.add(fTop);
  const fBot = fTop.clone();
  fBot.position.y = -h / 2 - fw / 2;
  g.add(fBot);
  const fL = new THREE.Mesh(new THREE.BoxGeometry(fw, h, fd), bronze);
  fL.position.set(-w / 2 - fw / 2, 0, 0);
  g.add(fL);
  const fR = fL.clone();
  fR.position.x = w / 2 + fw / 2;
  g.add(fR);

  // mullions: center vertical + upper-third horizontal
  const mull = new THREE.Mesh(new THREE.BoxGeometry(0.028, h, 0.03), bronze);
  mull.position.z = -0.03;
  g.add(mull);
  const mullH = new THREE.Mesh(new THREE.BoxGeometry(w, 0.028, 0.03), bronze);
  mullH.position.set(0, h / 6, -0.03);
  g.add(mullH);

  // sill
  const sill = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.035, 0.13), paintedMaterial(0x8a7f72, { roughness: 0.4 }));
  sill.position.set(0, -h / 2 - fw - 0.018, 0.045);
  g.add(sill);

  // cool dusk RectAreaLight, shining into the room (local -Z after PI turn)
  const ral = new THREE.RectAreaLight(0xa8c2ea, lightBase, w * 1.15, h * 1.15);
  ral.rotation.y = Math.PI;
  ral.position.z = -0.02;
  ral.userData._room = { base: lightBase, offBoost: lightOffBoost };
  g.add(ral);

  // sheer curtain panel to one side (+ rod)
  if (curtainSide) {
    const cw = w * 0.62, ch = h * 1.22;
    const cur = new THREE.Mesh(
      new THREE.PlaneGeometry(cw, ch),
      new THREE.MeshStandardMaterial({
        map: texOf(curtainCanvasEl(), { srgb: true }),
        transparent: true, opacity: 0.55, side: THREE.DoubleSide,
        roughness: 1, metalness: 0, depthWrite: false,
      }));
    cur.position.set(curtainSide * (w / 2 + cw * 0.24), h * 0.06 - (ch - h) * 0.28, 0.11);
    cur.renderOrder = 2;
    g.add(cur);
    const rodLen = w + 0.6 + cw * 0.4;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, rodLen, 8), bronze);
    rod.rotation.z = Math.PI / 2;
    rod.position.set(curtainSide * cw * 0.18, h / 2 + fw + 0.075, 0.11);
    g.add(rod);
    for (const s of [-1, 1]) {
      const fin = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), bronze);
      fin.position.set(curtainSide * cw * 0.18 + s * rodLen / 2, h / 2 + fw + 0.075, 0.11);
      g.add(fin);
    }
  }

  if (wall === 'back') {
    g.position.set(cx, cy, shell.backZ + 0.005);
  } else {
    g.rotation.y = Math.PI / 2;
    g.position.set(shell.sideX + 0.005, cy, cx);
  }
  group.add(g);
  return { group: g, light: ral };
}

/* ---- furniture builders ------------------------------------------------------ */

const WOOD_WALNUT = 0x5a3f28;
const WOOD_OAK = 0x8a663f;
const WOOD_DARK = 0x3a2c1e;

function buildSofa({ width = 1.72, depth = 0.86, color = 0x67604f, legColor = WOOD_DARK } = {}) {
  const g = new THREE.Group();
  const fab = fabricMaterial(color);
  const fabDark = fabricMaterial(new THREE.Color(color).multiplyScalar(0.82).getHex());
  const legs = furnWoodMaterial(legColor);
  const legH = 0.13;

  const base = rbox(width - 0.04, 0.2, depth - 0.06, 0.05, fabDark);
  base.position.y = legH + 0.1;
  base.castShadow = true;
  g.add(base);

  const armW = 0.17, armH = 0.5;
  for (const s of [-1, 1]) {
    const arm = rbox(armW, armH, depth - 0.02, 0.075, fab);
    arm.position.set(s * (width / 2 - armW / 2), legH + armH / 2, 0);
    arm.castShadow = true;
    g.add(arm);
  }

  const backP = rbox(width - 0.04, 0.52, 0.16, 0.06, fab);
  backP.position.set(0, legH + 0.2 + 0.24, -depth / 2 + 0.1);
  backP.castShadow = true;
  g.add(backP);

  // seat + back cushions (visible seam between the pairs)
  const cw = (width - armW * 2 - 0.06) / 2;
  for (const s of [-1, 1]) {
    const seatC = rbox(cw - 0.015, 0.15, depth - armW - 0.22, 0.06, fab);
    seatC.position.set(s * (cw / 2 + 0.008), legH + 0.2 + 0.07, 0.028);
    seatC.castShadow = true;
    g.add(seatC);
    const backC = rbox(cw - 0.015, 0.4, 0.15, 0.065, fab);
    backC.position.set(s * (cw / 2 + 0.008), legH + 0.2 + 0.32, -depth / 2 + 0.235);
    backC.rotation.x = -0.14;
    backC.castShadow = true;
    g.add(backC);
  }

  // tapered legs
  const dx = width / 2 - 0.11, dz = depth / 2 - 0.1;
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = taperedLeg(legH + 0.02, 0.026, 0.017, legs);
    leg.position.set(sx * dx, (legH + 0.02) / 2, sz * dz);
    g.add(leg);
  }
  return g;
}

function buildArmchair({ color = 0x6b5f4e, legColor = WOOD_DARK } = {}) {
  const g = buildSofa({ width: 0.86, depth: 0.8, color, legColor });
  return g;
}

function buildDiningChair({ fabricColor = 0x6a6156, woodColor = WOOD_WALNUT } = {}) {
  const g = new THREE.Group();
  const wood = furnWoodMaterial(woodColor);
  const fab = fabricMaterial(fabricColor);
  const seatH = 0.46;
  const seat = rbox(0.43, 0.05, 0.42, 0.02, wood);
  seat.position.y = seatH - 0.025;
  seat.castShadow = true;
  g.add(seat);
  const pad = rbox(0.39, 0.045, 0.38, 0.022, fab);
  pad.position.y = seatH + 0.018;
  pad.castShadow = true;
  g.add(pad);
  // legs: tapered, slightly splayed
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = taperedLeg(seatH, 0.019, 0.013, wood, sz * -0.05, sx * 0.05);
    leg.position.set(sx * 0.17, seatH / 2 - 0.02, sz * 0.16);
    leg.castShadow = true;
    g.add(leg);
  }
  // back: two stiles + curved-ish top rail + low rail
  for (const s of [-1, 1]) {
    const stile = taperedLeg(0.48, 0.014, 0.017, wood, 0.1, 0);
    stile.position.set(s * 0.17, seatH + 0.22, -0.215);
    stile.castShadow = true;
    g.add(stile);
  }
  const rail = rbox(0.4, 0.13, 0.026, 0.012, wood);
  rail.position.set(0, seatH + 0.4, -0.243);
  rail.rotation.x = 0.1;
  rail.castShadow = true;
  g.add(rail);
  const rail2 = rbox(0.38, 0.05, 0.02, 0.009, wood);
  rail2.position.set(0, seatH + 0.19, -0.222);
  rail2.rotation.x = 0.1;
  g.add(rail2);
  return g;
}

/** Round pedestal dining table; top surface lands at local y=0. */
function buildRoundTable({ radius = 0.8, height = 0.74, color = WOOD_WALNUT } = {}) {
  const g = new THREE.Group();
  const wood = furnWoodMaterial(color, { roughness: 0.42 });
  const topH = 0.042;
  const top = new THREE.Mesh(new THREE.CylinderGeometry(radius - 0.02, radius - 0.02, topH, 48), wood);
  top.position.y = -topH / 2;
  top.castShadow = true;
  g.add(top);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(radius - 0.021, topH / 2, 10, 48), wood);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = -topH / 2;
  g.add(rim);
  // turned pedestal
  const colH = height - topH - 0.05;
  const profile = smoothProfile([
    [0.3, 0], [0.28, 0.015], [0.12, 0.05], [0.07, 0.16],
    [0.055, colH * 0.45], [0.085, colH * 0.72], [0.06, colH * 0.9], [0.1, colH],
  ], 40);
  const ped = new THREE.Mesh(new THREE.LatheGeometry(profile, 28), wood);
  ped.position.y = -height + 0.05 + 0.0;
  ped.scale.y = 1;
  ped.castShadow = true;
  g.add(ped);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.33, 0.05, 36), wood);
  foot.position.y = -height + 0.025;
  foot.castShadow = true;
  g.add(foot);
  return g;
}

/** Rectangular dining table on two pedestal legs; top at local y=0. */
function buildRectTable({ w = 2.0, d = 0.95, height = 0.75, color = 0x4c3322 } = {}) {
  const g = new THREE.Group();
  const wood = furnWoodMaterial(color, { roughness: 0.4 });
  const topH = 0.05;
  const top = rbox(w, topH, d, 0.02, wood);
  top.position.y = -topH / 2;
  top.castShadow = true;
  g.add(top);
  for (const s of [-1, 1]) {
    const leg = rbox(0.1, height - topH - 0.04, d - 0.34, 0.03, wood);
    leg.position.set(s * (w / 2 - 0.3), -(height + topH) / 2 - 0.0 + 0.0, 0);
    leg.position.y = -topH - (height - topH - 0.04) / 2;
    leg.castShadow = true;
    g.add(leg);
    const foot = rbox(0.14, 0.05, d - 0.22, 0.024, wood);
    foot.position.set(s * (w / 2 - 0.3), -height + 0.025, 0);
    g.add(foot);
  }
  return g;
}

/** Console / sideboard, top at local y=0, descending legH+bodyH to floor. */
function buildConsole({ w = 1.5, d = 0.42, bodyH = 0.34, legH = 0.12, color = WOOD_WALNUT } = {}) {
  const g = new THREE.Group();
  const wood = furnWoodMaterial(color, { roughness: 0.45 });
  const woodDark = furnWoodMaterial(new THREE.Color(color).multiplyScalar(0.8).getHex(), { roughness: 0.5 });
  const topH = 0.03;
  const top = rbox(w, topH, d, 0.012, wood);
  top.position.y = -topH / 2;
  top.castShadow = true;
  g.add(top);
  const body = rbox(w - 0.05, bodyH, d - 0.04, 0.02, wood);
  body.position.y = -topH - bodyH / 2;
  body.castShadow = true;
  g.add(body);
  // drawer fronts
  for (const s of [-1, 1]) {
    const dw = (w - 0.14) / 2;
    const drawer = rbox(dw - 0.02, bodyH - 0.08, 0.016, 0.008, woodDark);
    drawer.position.set(s * (dw / 2 + 0.012), -topH - bodyH / 2, d / 2 - 0.026);
    g.add(drawer);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), bronzeMaterial());
    knob.position.set(s * (dw / 2 + 0.012), -topH - bodyH / 2, d / 2 - 0.008);
    g.add(knob);
  }
  const dx = w / 2 - 0.08, dz = d / 2 - 0.06;
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = taperedLeg(legH + 0.01, 0.02, 0.013, wood);
    leg.position.set(sx * dx, -topH - bodyH - (legH + 0.01) / 2 + 0.005, sz * dz);
    g.add(leg);
  }
  return g;
}

/** Office desk: wood top on dark metal legs; top at local y=0. */
function buildDesk({ w = 1.5, d = 0.68, height = 0.72, color = WOOD_OAK } = {}) {
  const g = new THREE.Group();
  const wood = furnWoodMaterial(color, { roughness: 0.45 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x1d1e22, metalness: 0.7, roughness: 0.4, envMapIntensity: 0.7 });
  const topH = 0.04;
  const top = rbox(w, topH, d, 0.016, wood);
  top.position.y = -topH / 2;
  top.castShadow = true;
  g.add(top);
  const legH = height - topH;
  for (const s of [-1, 1]) {
    // trapezoid A-frame: two angled square tubes + floor runner
    const l1 = new THREE.Mesh(new THREE.BoxGeometry(0.035, legH, 0.035), metal);
    l1.position.set(s * (w / 2 - 0.09), -topH - legH / 2, d / 2 - 0.1);
    l1.rotation.x = 0.12;
    l1.castShadow = true;
    g.add(l1);
    const l2 = l1.clone();
    l2.position.z = -d / 2 + 0.1;
    l2.rotation.x = -0.12;
    g.add(l2);
    const runner = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, d - 0.12), metal);
    runner.position.set(s * (w / 2 - 0.09), -height + 0.015, 0);
    g.add(runner);
  }
  // rear stretcher
  const str = new THREE.Mesh(new THREE.BoxGeometry(w - 0.24, 0.05, 0.03), metal);
  str.position.set(0, -topH - 0.12, -d / 2 + 0.1);
  g.add(str);
  return g;
}

/** Simple task chair: rounded cushions on a column + 4-star base. */
function buildTaskChair({ color = 0x4a443c } = {}) {
  const g = new THREE.Group();
  const fab = fabricMaterial(color);
  const metal = new THREE.MeshStandardMaterial({ color: 0x232428, metalness: 0.75, roughness: 0.35, envMapIntensity: 0.8 });
  const seatH = 0.46;
  const seat = rbox(0.44, 0.075, 0.42, 0.035, fab);
  seat.position.y = seatH;
  seat.castShadow = true;
  g.add(seat);
  const back = rbox(0.42, 0.42, 0.07, 0.035, fab);
  back.position.set(0, seatH + 0.3, -0.2);
  back.rotation.x = -0.12;
  back.castShadow = true;
  g.add(back);
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, seatH - 0.08, 12), metal);
  col.position.y = (seatH - 0.08) / 2 + 0.04;
  g.add(col);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.033, 0.028, 0.26), metal);
    spoke.position.set(Math.sin(a) * 0.13, 0.035, Math.cos(a) * 0.13);
    spoke.rotation.y = a;
    g.add(spoke);
    const wheel = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), metal);
    wheel.position.set(Math.sin(a) * 0.24, 0.028, Math.cos(a) * 0.24);
    g.add(wheel);
  }
  return g;
}

/** Low coffee table with rounded wood top. Top at local +height. */
function buildCoffeeTable({ w = 0.95, d = 0.55, height = 0.36, color = WOOD_WALNUT } = {}) {
  const g = new THREE.Group();
  const wood = furnWoodMaterial(color, { roughness: 0.42 });
  const topH = 0.045;
  const top = rbox(w, topH, d, 0.02, wood);
  top.position.y = height - topH / 2;
  top.castShadow = true;
  g.add(top);
  const shelfH = 0.02;
  const shelf = rbox(w - 0.2, shelfH, d - 0.16, 0.01, wood);
  shelf.position.y = height * 0.38;
  g.add(shelf);
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = taperedLeg(height - topH, 0.021, 0.015, wood, sz * -0.04, sx * 0.04);
    leg.position.set(sx * (w / 2 - 0.08), (height - topH) / 2, sz * (d / 2 - 0.07));
    leg.castShadow = true;
    g.add(leg);
  }
  return g;
}

function buildSideTable({ radius = 0.21, height = 0.48, color = WOOD_DARK } = {}) {
  const g = new THREE.Group();
  const wood = furnWoodMaterial(color, { roughness: 0.42 });
  const top = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.028, 28), wood);
  top.position.y = height - 0.014;
  top.castShadow = true;
  g.add(top);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(radius - 0.001, 0.014, 8, 28), wood);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = height - 0.014;
  g.add(rim);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = taperedLeg(height, 0.014, 0.01, wood, Math.cos(a) * 0.09, Math.sin(a) * 0.09);
    leg.position.set(Math.sin(a) * 0.1, height / 2 - 0.01, Math.cos(a) * 0.1);
    g.add(leg);
  }
  return g;
}

/** Thin rug slab with woven texture; sits on the floor at local y=0. */
function buildRug({ w = 2.2, d = 1.5, tint = 0x8a7358 } = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.018, d), rugMaterial(tint));
  m.position.y = 0.009;
  return m;
}

/** Framed art with a painted canvas. */
function buildArtFrame(w, h, variant = 0, { frameColor = 0x241f19 } = {}) {
  const g = new THREE.Group();
  const frameMat = furnWoodMaterial(frameColor, { roughness: 0.5 });
  const bw = 0.035, bd = 0.035;
  const fTop = new THREE.Mesh(new THREE.BoxGeometry(w, bw, bd), frameMat);
  fTop.position.y = h / 2 - bw / 2;
  g.add(fTop);
  const fBot = fTop.clone();
  fBot.position.y = -h / 2 + bw / 2;
  g.add(fBot);
  const fL = new THREE.Mesh(new THREE.BoxGeometry(bw, h - bw * 2, bd), frameMat);
  fL.position.x = -w / 2 + bw / 2;
  g.add(fL);
  const fR = fL.clone();
  fR.position.x = w / 2 - bw / 2;
  g.add(fR);
  const art = new THREE.Mesh(
    new THREE.PlaneGeometry(w - bw * 2, h - bw * 2),
    new THREE.MeshStandardMaterial({
      map: texOf(artCanvasEl(variant), { srgb: true }),
      roughness: 0.7, metalness: 0, envMapIntensity: 0.6,
    }));
  art.position.z = 0.008;
  g.add(art);
  return g;
}

/** Big unframed canvas print leaning against a wall. */
function buildLeaningCanvas(w, h, variant, lean = 0.13) {
  const g = new THREE.Group();
  const edge = new THREE.MeshStandardMaterial({ color: 0xd0c8bc, roughness: 0.9 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.035), [
    edge, edge, edge, edge,
    new THREE.MeshStandardMaterial({
      map: texOf(artCanvasEl(variant), { srgb: true }), roughness: 0.8, metalness: 0, envMapIntensity: 0.45,
    }),
    edge,
  ]);
  body.position.y = h / 2;
  g.add(body);
  g.rotation.x = -lean;
  return g;
}

/** Potted plant: tapered pot + soil + fanned leaf planes. */
function buildPlant({ scale = 1, leaves = 9, seed = 5 } = {}) {
  const g = new THREE.Group();
  const rnd = mulberry(seed);
  const pot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.09, 0.17, 18),
    ceramicMaterial(0x7a6a58));
  pot.position.y = 0.085;
  g.add(pot);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.118, 0.011, 8, 20), ceramicMaterial(0x7a6a58));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.168;
  g.add(rim);
  const soil = new THREE.Mesh(
    new THREE.CylinderGeometry(0.105, 0.105, 0.015, 16),
    new THREE.MeshStandardMaterial({ color: 0x1d140d, roughness: 1 }));
  soil.position.y = 0.155;
  g.add(soil);
  const leafMat = new THREE.MeshStandardMaterial({
    map: texOf(leafCanvasEl(), { srgb: true }),
    alphaTest: 0.4, side: THREE.DoubleSide,
    roughness: 0.8, metalness: 0, envMapIntensity: 0.25,
  });
  const leafGeo = new THREE.PlaneGeometry(0.14, 0.34);
  leafGeo.translate(0, 0.17, 0);
  for (let i = 0; i < leaves; i++) {
    const leaf = new THREE.Mesh(leafGeo, leafMat);
    leaf.position.y = 0.15;
    leaf.rotation.y = i * 2.39996 + rnd() * 0.5; // golden angle fan
    leaf.rotation.x = -(0.35 + rnd() * 0.55);
    const s = 0.75 + rnd() * 0.55;
    leaf.scale.set(s, s, s);
    g.add(leaf);
  }
  g.scale.setScalar(scale);
  return g;
}

/** Stack of 2-3 hardcover books with page blocks. */
function buildBookStack(seed = 11, n = 3) {
  const g = new THREE.Group();
  const rnd = mulberry(seed);
  const colors = [0x5d4238, 0x37454e, 0x655d33, 0x4a3547];
  let y = 0;
  for (let i = 0; i < n; i++) {
    const bw = 0.2 - i * 0.02 + rnd() * 0.02;
    const bh = 0.028 + rnd() * 0.01;
    const bd = 0.14 - i * 0.012;
    const cover = rbox(bw, bh, bd, 0.006, paintedMaterial(colors[(seed + i) % colors.length], { roughness: 0.6 }), 2);
    cover.position.set((rnd() - 0.5) * 0.02, y + bh / 2, (rnd() - 0.5) * 0.02);
    cover.rotation.y = (rnd() - 0.5) * 0.5;
    g.add(cover);
    const pages = new THREE.Mesh(
      new THREE.BoxGeometry(bw - 0.014, bh - 0.01, bd - 0.01),
      new THREE.MeshStandardMaterial({ color: 0xcfc5ae, roughness: 0.9 }));
    pages.position.copy(cover.position);
    pages.position.x += 0.004;
    pages.rotation.y = cover.rotation.y;
    g.add(pages);
    y += bh;
  }
  const c = contactOval(0.32, 0.26, 0.4);
  c.position.y = 0.002;
  g.add(c);
  return g;
}

/** Ceramic bowl / carafe / cup for table styling. */
function buildCeramic(kind = 'bowl', color = 0xcfc3b0) {
  const mat = ceramicMaterial(color);
  mat.side = THREE.DoubleSide;
  let profile;
  if (kind === 'bowl') {
    profile = smoothProfile([[0.03, 0], [0.075, 0.008], [0.1, 0.04], [0.105, 0.075], [0.095, 0.085]], 24);
  } else if (kind === 'carafe') {
    profile = smoothProfile([[0.02, 0], [0.06, 0.005], [0.075, 0.06], [0.06, 0.14], [0.025, 0.2], [0.022, 0.26], [0.03, 0.28]], 28);
  } else { // cup
    profile = smoothProfile([[0.015, 0], [0.035, 0.004], [0.042, 0.04], [0.045, 0.07]], 16);
  }
  const m = new THREE.Mesh(new THREE.LatheGeometry(profile, 20), mat);
  const g = new THREE.Group();
  g.add(m);
  const c = contactOval(kind === 'carafe' ? 0.22 : 0.3, kind === 'carafe' ? 0.22 : 0.3, 0.4);
  c.position.y = 0.002;
  g.add(c);
  return g;
}

/** Closed laptop: two thin rounded slabs. */
function buildLaptop() {
  const g = new THREE.Group();
  const alu = new THREE.MeshStandardMaterial({ color: 0x3f4247, metalness: 0.7, roughness: 0.4, envMapIntensity: 0.9 });
  const base = rbox(0.3, 0.012, 0.21, 0.005, alu, 2);
  base.position.y = 0.006;
  g.add(base);
  const lid = rbox(0.3, 0.01, 0.21, 0.005, alu, 2);
  lid.position.y = 0.017;
  g.add(lid);
  const c = contactOval(0.42, 0.32, 0.4);
  c.position.y = 0.002;
  g.add(c);
  return g;
}

function buildMug(color = 0x8a4a3a) {
  const g = new THREE.Group();
  const mat = ceramicMaterial(color);
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.028, 0.08, 16, 1, true), mat);
  cup.material.side = THREE.DoubleSide;
  cup.position.y = 0.04;
  g.add(cup);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.028, 16), mat);
  bottom.rotation.x = -Math.PI / 2;
  bottom.position.y = 0.004;
  g.add(bottom);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.005, 8, 14, Math.PI * 1.4), mat);
  handle.position.set(0.032, 0.042, 0);
  handle.rotation.z = -Math.PI / 2 + 0.4;
  g.add(handle);
  const c = contactOval(0.12, 0.12, 0.4);
  c.position.y = 0.002;
  g.add(c);
  return g;
}

/** Throw blanket draped over a sofa arm (bent plane, striped fabric). */
function buildThrowBlanket({ armR = 0.1, width = 0.42, hangA = 0.34, hangB = 0.42, tint = 0xa89272 } = {}) {
  const arc = Math.PI * armR;
  const total = hangA + arc + hangB;
  const geo = new THREE.PlaneGeometry(width, total, 5, 22);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const s = v.y + total / 2; // 0..total along the drape
    let y, z;
    if (s < hangA) {
      z = -armR; y = s - hangA;
    } else if (s < hangA + arc) {
      const a = (s - hangA) / armR; // 0..PI
      z = -armR * Math.cos(a); y = armR * Math.sin(a);
    } else {
      z = armR; y = -(s - hangA - arc);
    }
    // slight ripple so it doesn't read as a perfect tube
    const ripple = Math.sin(v.x * 26) * 0.006 + Math.sin(s * 18) * 0.004;
    pos.setXYZ(i, v.x, y + ripple, z + ripple * 0.6);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: tint, map: texOf(blanketCanvasEl(), { srgb: true }),
    bumpMap: texOf(boucleCanvasEl(), { repeat: [2, 3] }), bumpScale: 0.3,
    roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
}

/* ---- lights ------------------------------------------------------------------ */

/** Dim always-on ambience so power-off stays a legible dusk interior. */
function addRoomAmbientLights(group, {
  warmPos = new THREE.Vector3(0.6, 1.1, 0.9), warmColor = 0xffb27a, warmBase = 0.52,
  coolPos = new THREE.Vector3(-2.2, 2.2, 1.6), coolColor = 0x8fb2dd, coolBase = 0.48,
} = {}) {
  const warm = new THREE.PointLight(warmColor, warmBase, 7, 2);
  warm.position.copy(warmPos);
  warm.userData._room = { base: warmBase, offBoost: 0.6 };
  group.add(warm);

  const cool = new THREE.DirectionalLight(coolColor, coolBase);
  cool.position.copy(coolPos);
  cool.userData._room = { base: coolBase, offBoost: 0.8 };
  group.add(cool);

  return [warm, cool];
}

/** Non-casting warm fill that follows the lamp (kelvin-tinted, power-scaled):
 * fakes the first light bounce off the floor/table under the lamp's pool. */
function lampBounceLight(x, y, z, base = 1.0, range = 4.5, colorMix = 0.75) {
  const l = asLight(new THREE.PointLight(0xffffff, 0, range, 2), base, colorMix);
  l.userData._lamp.noRoomScale = true; // room-space fill: exempt from lampScale
  l.position.set(x, y, z);
  return l;
}

/* ---- per-product rooms --------------------------------------------------------
 *
 * Camera framing shares frameCamera()'s fit formula. Rooms are sized
 * generously so the constrained frontal arc keeps the camera on the interior
 * side of both walls at every allowed orbit extreme (verified by
 * screenshotting all four extremes per room).
 * ---------------------------------------------------------------------------- */

const FITSCALE_ROOM = 0.66;

/* Per-room product adjustment. The six products are modeled at hero/studio
 * scale, so each room shrinks the model group to true real-world size and,
 * for the hanging fixtures, lifts it so it hangs correctly above the table
 * (the group scales about its origin = the surface the product rests on).
 * Applied/removed by ProductViewer.setRoom in both directions (snap):
 *   scale      — uniform group scale in room mode
 *   y          — group lift in meters (hanging fixtures only)
 *   lightScale — room-mode multiplier on the product's own light intensities;
 *                positions scale with the group but intensity doesn't, and
 *                ~scale² keeps self-illumination and surface pools physical */

/** Frame proxy for the product AFTER its room adjustment, for camera fitting. */
function adjustedProductFrame(model, adj) {
  return {
    radius: model.radius * adj.scale,
    center: model.center.clone().multiplyScalar(adj.scale)
      .add(new THREE.Vector3(adj.x || 0, adj.y || 0, adj.z || 0)),
  };
}

/** Cord/stem extension from a scaled hanging fixture's top up to the room
 * ceiling, with a small ceiling cap — the product's own rose no longer
 * reaches, so this keeps the "hung from the ceiling" read convincing. */
function addCeilingDrop(group, { x = 0, z = 0, yBottom, yTop, radius = 0.006, material = null }) {
  const mat = material || cordMat();
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, Math.max(0.01, yTop - yBottom), 12), mat);
  rod.position.set(x, (yBottom + yTop) / 2, z);
  group.add(rod);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.042, 0.024, 20), mat);
  cap.position.set(x, yTop - 0.012, z);
  group.add(cap);
}

/** Frame spec fitting product + furniture (walls excluded so the camera
 * doesn't zoom out to swallow the whole wall). */
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
  if (opts.centerBias) center.add(opts.centerBias);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const elevation = opts.elevation ?? 0.22;
  return {
    center, radius: sphere.radius * (opts.radiusScale ?? 1),
    fitScale: opts.fitScale ?? FITSCALE_ROOM,
    azimuth: opts.azimuth ?? 0.45, elevation,
    azimuthSpread: THREE.MathUtils.degToRad(opts.spreadDeg ?? 66),
    minPolar: opts.minPolar ?? 0.95,
    // never clamp-jump the opening frame: keep maxPolar past the initial polar
    maxPolar: Math.max(opts.maxPolar ?? 1.32, Math.PI / 2 - elevation + 0.03),
    minDistScale: opts.minDistScale ?? 0.85, maxDistScale: opts.maxDistScale ?? 1.12,
    autoRotateSpeed: opts.autoRotateSpeed ?? 0.3,
  };
}

/* -- aurora-pendant: dining nook ---------------------------------------------- */
function buildAuroraPendantRoom(model) {
  const floorY = -0.74;
  // dome dia 1.04 -> 0.48m; rim lands ~0.80 above the table top (y=0)
  const adj = { scale: 0.46, y: 0.53, lightScale: 2.0 };
  const shell = buildRoomShell({
    width: 8.6, depth: 2.3, height: 2.38, floorY, frontExtra: 1.7,
    wallTint: 0x8f7d66,
  });
  const group = shell.group;
  const furniture = new THREE.Group();
  group.add(furniture);

  // rug under the dining set
  const rug = buildRug({ w: 2.7, d: 2.2, tint: 0x7d6850 });
  rug.position.set(0, floorY, 0.1);
  furniture.add(rug);

  const table = buildRoundTable({ radius: 0.8, height: 0.74, color: 0x5f4429 });
  furniture.add(table);
  const tableShadow = contactOval(2.0, 2.0, 0.5);
  tableShadow.position.set(0, floorY + 0.028, 0);
  group.add(tableShadow);

  const chairSpecs = [
    { x: -0.78, z: 0.62, ry: -0.5 },
    { x: 0.72, z: 0.7, ry: 0.6 },
    { x: -0.1, z: -1.05, ry: Math.PI + 0.15 },
  ];
  for (const s of chairSpecs) {
    const ch = buildDiningChair({ fabricColor: 0x64594a, woodColor: 0x4c3520 });
    ch.position.set(s.x, floorY, s.z);
    ch.rotation.y = s.ry;
    furniture.add(ch);
    const cs = contactOval(0.62, 0.62, 0.42);
    cs.position.set(s.x, floorY + 0.02, s.z);
    group.add(cs);
  }

  // table styling
  const bowl = buildCeramic('bowl', 0xd6c9b4);
  bowl.position.set(-0.3, 0.0, 0.12);
  furniture.add(bowl);
  const carafe = buildCeramic('carafe', 0xb8a186);
  carafe.position.set(-0.14, 0, -0.14);
  furniture.add(carafe);
  const cup = buildCeramic('cup', 0xd6c9b4);
  cup.position.set(0.34, 0, 0.3);
  furniture.add(cup);

  // window right of the table, curtain to its left
  addWindowAssembly(group, shell, {
    wall: 'back', cx: 1.35, cy: floorY + 1.45, w: 1.0, h: 1.5,
    curtainSide: -1, lightBase: 7.5,
  });

  // side-wall art + plant in the corner
  const art = buildArtFrame(0.62, 0.82, 1);
  art.rotation.y = Math.PI / 2;
  art.position.set(shell.sideX + 0.045, floorY + 1.5, -0.4);
  group.add(art);

  const plant = buildPlant({ scale: 1.7, seed: 21 });
  plant.position.set(shell.sideX + 0.55, floorY, shell.backZ + 0.55);
  group.add(plant);
  const ps = contactOval(0.5, 0.5, 0.45);
  ps.position.set(shell.sideX + 0.55, floorY + 0.024, shell.backZ + 0.55);
  group.add(ps);

  // scaled pendant's rose tops out ~1.28 — extend the cord to the ceiling
  addCeilingDrop(group, {
    yBottom: 1.6 * adj.scale + adj.y, yTop: floorY + 2.38, radius: 0.0055,
  });

  const roomLights = addRoomAmbientLights(group);
  const lampLights = [
    lampBounceLight(0, 0.55, 0, 1.3, 3.6, 0.8), // bounce off the tabletop
    lampBounceLight(0.4, floorY + 0.5, 0.9, 0.5, 4, 0.7),
  ];
  for (const l of lampLights) group.add(l);

  return {
    group, roomLights, lampLights, productAdjust: adj,
    camera: roomCameraFrame(adjustedProductFrame(model, adj), furniture, {
      azimuth: 0.42, elevation: 0.26, spreadDeg: 62, maxDistScale: 1.22,
      centerBias: new THREE.Vector3(0.12, 0.1, 0),
    }),
  };
}

/* -- crystal-chandelier: formal dining -------------------------------------- */
function buildCrystalChandelierRoom(model) {
  const floorY = -0.78;
  // ~1.47m across -> 0.69m; lowest crystal lands ~0.93 above the table top
  const adj = { scale: 0.47, y: 0.85, lightScale: 1.45 };
  const shell = buildRoomShell({
    width: 9.6, depth: 2.6, height: 2.78, floorY, frontExtra: 1.9,
    wallTint: 0x877462,
  });
  const group = shell.group;
  const furniture = new THREE.Group();
  group.add(furniture);

  const rug = buildRug({ w: 3.4, d: 2.5, tint: 0x6f5a46 });
  rug.position.set(0, floorY, 0.1);
  furniture.add(rug);

  const table = buildRectTable({ w: 2.1, d: 1.0, height: 0.76, color: 0x4a3322 });
  furniture.add(table);
  const tableShadow = contactOval(2.6, 1.7, 0.5);
  tableShadow.position.set(0, floorY + 0.028, 0);
  group.add(tableShadow);

  const chairSpecs = [
    { x: -0.55, z: 0.78, ry: -0.12 },
    { x: 0.55, z: 0.78, ry: 0.12 },
    { x: -1.35, z: 0, ry: Math.PI / 2 - 0.1 },
    { x: -0.55, z: -0.85, ry: Math.PI + 0.1 },
    { x: 0.55, z: -0.85, ry: Math.PI - 0.1 },
  ];
  for (const s of chairSpecs) {
    const ch = buildDiningChair({ fabricColor: 0x5d5348, woodColor: 0x422e1c });
    ch.position.set(s.x, floorY, s.z);
    ch.rotation.y = s.ry;
    furniture.add(ch);
  }

  // formal table setting
  const carafe = buildCeramic('carafe', 0xd9cdb9);
  carafe.position.set(0.28, 0, 0.1);
  furniture.add(carafe);
  const bowl = buildCeramic('bowl', 0xc4b49c);
  bowl.position.set(-0.34, 0, -0.05);
  furniture.add(bowl);
  const cup1 = buildCeramic('cup', 0xd9cdb9);
  cup1.position.set(-0.5, 0, 0.42);
  furniture.add(cup1);

  // picture rail (dark, elegant) on both walls
  const railMat = furnWoodMaterial(0x2c2118, { roughness: 0.5 });
  const railBack = new THREE.Mesh(new THREE.BoxGeometry(shell.halfW * 2, 0.04, 0.025), railMat);
  railBack.position.set(0, floorY + 2.08, shell.backZ + 0.017);
  group.add(railBack);
  const railSide = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.04, shell.spanZ), railMat);
  railSide.position.set(shell.sideX + 0.017, floorY + 2.08, shell.cz);
  group.add(railSide);

  // tall window pair on the back wall, sheer curtain
  addWindowAssembly(group, shell, {
    wall: 'back', cx: -1.7, cy: floorY + 1.52, w: 1.05, h: 1.75,
    curtainSide: 1, lightBase: 8.5,
  });

  const art = buildArtFrame(0.9, 1.15, 2);
  art.position.set(1.85, floorY + 1.62, shell.backZ + 0.045);
  group.add(art);

  const plant = buildPlant({ scale: 2.0, seed: 33 });
  plant.position.set(shell.sideX + 0.6, floorY, shell.backZ + 0.7);
  group.add(plant);
  const ps = contactOval(0.55, 0.55, 0.45);
  ps.position.set(shell.sideX + 0.6, floorY + 0.024, shell.backZ + 0.7);
  group.add(ps);

  // brass stem extension from the scaled rose (~1.78) up to the ceiling (2.0)
  addCeilingDrop(group, {
    yBottom: 1.96 * adj.scale + adj.y, yTop: floorY + 2.78, radius: 0.0075,
    material: brassMat(),
  });

  const roomLights = addRoomAmbientLights(group, { warmBase: 0.3 });
  const lampLights = [
    lampBounceLight(0, 0.6, 0, 1.5, 4.2, 0.8),
    lampBounceLight(-0.5, floorY + 0.5, 1.0, 0.5, 4.5, 0.7),
  ];
  for (const l of lampLights) group.add(l);

  return {
    group, roomLights, lampLights, productAdjust: adj,
    camera: roomCameraFrame(adjustedProductFrame(model, adj), furniture, {
      azimuth: 0.4, elevation: 0.24, spreadDeg: 60, autoRotateSpeed: 0.28, maxDistScale: 1.22,
      centerBias: new THREE.Vector3(0.1, 0.12, 0),
    }),
  };
}

/* -- arc-floor: living-room reading corner ----------------------------------- */
function buildArcFloorRoom(model) {
  const floorY = 0;
  // floor lamps really are ~2m, but read better slightly under (2.03 -> 1.79m).
  // Base tucked in the back corner behind the armchair, arc sweeping out
  // over the reading spot — the classic Arco composition.
  const adj = { scale: 0.88, y: 0, x: -3.55, z: -0.78, ry: -0.7, lightScale: 1.7 };
  const shell = buildRoomShell({
    width: 10.2, depth: 2.5, height: 2.5, floorY, frontExtra: 2.0,
    wallTint: 0x8b7a65,
  });
  const group = shell.group;
  const furniture = new THREE.Group();
  group.add(furniture);

  // big area rug under the seating
  const rug = buildRug({ w: 3.2, d: 2.3, tint: 0x77624c });
  rug.position.set(-0.2, floorY, 0.45);
  furniture.add(rug);

  // sofa along the back wall, blanket over the near arm
  const sofa = buildSofa({ width: 1.85, depth: 0.88, color: 0x6b6353 });
  sofa.position.set(-0.75, floorY, shell.backZ + 0.62);
  furniture.add(sofa);
  const sofaShadow = contactOval(2.2, 1.2, 0.5);
  sofaShadow.position.set(-0.75, floorY + 0.022, shell.backZ + 0.62);
  group.add(sofaShadow);
  const blanket = buildThrowBlanket({ tint: 0xa08a68 });
  blanket.position.set(-0.75 - 1.85 / 2 + 0.085, 0.63, shell.backZ + 0.62 + 0.02);
  blanket.rotation.y = Math.PI / 2;
  blanket.rotation.x = 0.04;
  furniture.add(blanket);

  // coffee table under the arc's pool of light
  const coffee = buildCoffeeTable({ w: 1.0, d: 0.6, height: 0.36, color: 0x53381f });
  coffee.position.set(0.55, floorY, 0.75);
  furniture.add(coffee);
  const coffeeShadow = contactOval(1.3, 0.9, 0.45);
  coffeeShadow.position.set(0.55, floorY + 0.024, 0.75);
  group.add(coffeeShadow);
  const books = buildBookStack(7, 3);
  books.position.set(0.38, floorY + 0.36 + 0.001, 0.68);
  furniture.add(books);
  const bowl = buildCeramic('bowl', 0xcbbda6);
  bowl.position.set(0.82, floorY + 0.36, 0.86);
  furniture.add(bowl);

  // armchair on the window side, angled toward the lamp
  const chair = buildArmchair({ color: 0x5d564a });
  chair.position.set(-2.0, floorY, 0.75);
  chair.rotation.y = 0.8;
  furniture.add(chair);
  const chairShadow = contactOval(1.15, 1.15, 0.45);
  chairShadow.position.set(-2.0, floorY + 0.023, 0.75);
  group.add(chairShadow);

  // window on the side wall (the reading corner's second light)
  addWindowAssembly(group, shell, {
    wall: 'side', cx: 0.0, cy: floorY + 1.5, w: 1.1, h: 1.55,
    curtainSide: 1, lightBase: 7.5,
  });

  // art over the sofa + plant on the far side
  const art = buildArtFrame(0.85, 0.6, 0);
  art.position.set(-0.75, floorY + 1.72, shell.backZ + 0.045);
  group.add(art);
  const art2 = buildArtFrame(0.42, 0.6, 1);
  art2.position.set(0.35, floorY + 1.66, shell.backZ + 0.045);
  group.add(art2);

  const plant = buildPlant({ scale: 2.3, seed: 14 });
  plant.position.set(1.75, floorY, shell.backZ + 0.5);
  group.add(plant);
  const ps = contactOval(0.6, 0.6, 0.45);
  ps.position.set(1.75, floorY + 0.024, shell.backZ + 0.5);
  group.add(ps);

  // contact shadow under the lamp's marble base in its corner
  const baseShadow = contactOval(0.7, 0.7, 0.42);
  baseShadow.position.set(adj.x, floorY + 0.021, adj.z);
  group.add(baseShadow);

  const roomLights = addRoomAmbientLights(group, {
    coolPos: new THREE.Vector3(-2.6, 2.0, 0.4),
  });
  const lampLights = [
    lampBounceLight(-2.7, 0.5, 0.0, 1.9, 4, 0.8), // bounce under the arc's pool
  ];
  for (const l of lampLights) group.add(l);

  return {
    group, roomLights, lampLights, productAdjust: adj,
    camera: roomCameraFrame(adjustedProductFrame(model, adj), furniture, {
      azimuth: 0.38, elevation: 0.23, spreadDeg: 58, autoRotateSpeed: 0.28,
      centerBias: new THREE.Vector3(0, 0.1, 0),
    }),
  };
}

/* -- mushroom-table: console lounge ------------------------------------------ */
function buildMushroomTableRoom(model) {
  const floorY = -0.46;
  // 1.05m glass mushroom -> 0.34m table lamp on the console
  const adj = { scale: 0.32, y: 0, lightScale: 0.22 };
  const shell = buildRoomShell({
    width: 9.0, depth: 2.1, height: 2.36, floorY, frontExtra: 1.5,
    wallTint: 0x8a7666,
  });
  const group = shell.group;
  const furniture = new THREE.Group();
  group.add(furniture);

  // console under the lamp, against the back wall
  const console_ = buildConsole({ w: 1.5, d: 0.44, bodyH: 0.32, legH: 0.11, color: 0x54391f });
  furniture.add(console_); // lamp rests at world origin = console top
  const conShadow = contactOval(1.65, 0.62, 0.45);
  conShadow.position.set(0, floorY + 0.02, 0);
  group.add(conShadow);

  // console styling: books + ceramic beside the lamp
  const books = buildBookStack(19, 2);
  books.position.set(-0.52, 0.001, 0.04);
  furniture.add(books);
  const carafe = buildCeramic('carafe', 0xb99f7e);
  carafe.position.set(0.55, 0, -0.05);
  carafe.scale.setScalar(0.85);
  furniture.add(carafe);

  // art pair above the console
  const art = buildArtFrame(0.55, 0.72, 0);
  art.position.set(-0.42, floorY + 1.72, shell.backZ + 0.045);
  group.add(art);
  const art2 = buildArtFrame(0.4, 0.52, 2);
  art2.position.set(0.35, floorY + 1.64, shell.backZ + 0.045);
  group.add(art2);

  // lounge seating to the right, on a rug
  const rug = buildRug({ w: 2.4, d: 1.8, tint: 0x6d5b48 });
  rug.position.set(1.9, floorY, 0.85);
  furniture.add(rug);
  const chair = buildArmchair({ color: 0x655d4e });
  chair.position.set(2.05, floorY, 0.55);
  chair.rotation.y = -0.55;
  furniture.add(chair);
  const chShadow = contactOval(1.15, 1.15, 0.45);
  chShadow.position.set(2.05, floorY + 0.022, 0.55);
  group.add(chShadow);
  const side = buildSideTable({ height: 0.5, color: 0x3d2b19 });
  side.position.set(1.15, floorY, 0.95);
  furniture.add(side);
  const cup = buildCeramic('cup', 0xd0c2ab);
  cup.position.set(1.15, floorY + 0.5, 0.95);
  furniture.add(cup);

  // window on the side wall with curtain
  addWindowAssembly(group, shell, {
    wall: 'side', cx: -0.1, cy: floorY + 1.42, w: 0.95, h: 1.45,
    curtainSide: 1, lightBase: 7.0,
  });

  const plant = buildPlant({ scale: 1.5, seed: 41 });
  plant.position.set(shell.sideX + 0.5, floorY, shell.backZ + 0.5);
  group.add(plant);

  const roomLights = addRoomAmbientLights(group);
  const lampLights = [
    lampBounceLight(0, 0.35, 0.3, 1.0, 3, 0.85), // glow spilling onto the console
    lampBounceLight(0.3, floorY + 0.4, 0.8, 0.45, 4, 0.7),
  ];
  for (const l of lampLights) group.add(l);

  return {
    group, roomLights, lampLights, productAdjust: adj,
    camera: roomCameraFrame(adjustedProductFrame(model, adj), furniture, {
      azimuth: 0.4, elevation: 0.26, spreadDeg: 56, fitScale: 0.58, maxDistScale: 1.22,
      centerBias: new THREE.Vector3(-0.35, 0.12, 0),
    }),
  };
}

/* -- neon-quasar: moody media wall -------------------------------------------- */
function buildNeonQuasarRoom(model) {
  const floorY = -0.36;
  // ~1.2m sculpture -> 0.43m objet on the media console
  const adj = { scale: 0.36, y: 0, lightScale: 0.2 };
  const shell = buildRoomShell({
    width: 9.0, depth: 1.9, height: 2.36, floorY, frontExtra: 1.5,
    wallTint: 0x5e565c, ceilTint: 0x46414a, floorDim: 0.82,
  });
  const group = shell.group;
  const furniture = new THREE.Group();
  group.add(furniture);

  // long low media console under the sculpture
  const console_ = buildConsole({ w: 2.2, d: 0.48, bodyH: 0.25, legH: 0.08, color: 0x2a2320 });
  furniture.add(console_);
  const conShadow = contactOval(2.35, 0.68, 0.5);
  conShadow.position.set(0, floorY + 0.018, 0);
  group.add(conShadow);

  // vinyl/book lean + stack on the console
  const books = buildBookStack(29, 3);
  books.position.set(-0.85, 0.001, 0.02);
  furniture.add(books);

  // oversized prints leaning against the wall beside the console
  const lean1 = buildLeaningCanvas(0.85, 1.15, 1, 0.12);
  lean1.position.set(-1.85, floorY, shell.backZ + 0.3);
  furniture.add(lean1);
  const lean2 = buildLeaningCanvas(0.6, 0.85, 0, 0.15);
  lean2.position.set(1.75, floorY, shell.backZ + 0.28);
  lean2.rotation.y = -0.12;
  furniture.add(lean2);
  const leanShadow = contactOval(1.1, 0.5, 0.5);
  leanShadow.position.set(-1.85, floorY + 0.02, shell.backZ + 0.35);
  group.add(leanShadow);

  // floor uplight can behind the console corner (always-on accent)
  const canMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.06, 0.09, 16),
    new THREE.MeshStandardMaterial({ color: 0x17181c, metalness: 0.6, roughness: 0.4 }));
  canMesh.position.set(1.35, floorY + 0.045, shell.backZ + 0.25);
  group.add(canMesh);
  const uplight = new THREE.PointLight(0xcf9a5c, 0.9, 3.2, 2);
  uplight.position.set(1.35, floorY + 0.5, shell.backZ + 0.3);
  uplight.userData._room = { base: 0.9, offBoost: 0.4 };
  group.add(uplight);

  // beanbag-ish lounge pouf + rug for the media corner
  const rug = buildRug({ w: 2.6, d: 1.7, tint: 0x4e4650 });
  rug.position.set(0.4, floorY, 1.05);
  furniture.add(rug);
  const pouf = rbox(0.62, 0.34, 0.62, 0.14, fabricMaterial(0x413c44));
  pouf.position.set(1.15, floorY + 0.17, 1.1);
  pouf.castShadow = true;
  furniture.add(pouf);
  const poufShadow = contactOval(0.85, 0.85, 0.5);
  poufShadow.position.set(1.15, floorY + 0.022, 1.1);
  group.add(poufShadow);

  // narrow slit window on the side wall — cool dusk edge light
  addWindowAssembly(group, shell, {
    wall: 'side', cx: 0.15, cy: floorY + 1.45, w: 0.5, h: 1.6,
    curtainSide: 0, lightBase: 5.5,
  });

  const plant = buildPlant({ scale: 2.1, seed: 55 });
  plant.position.set(shell.sideX + 0.55, floorY, shell.backZ + 0.55);
  group.add(plant);

  const roomLights = addRoomAmbientLights(group, {
    warmBase: 0.22, coolBase: 0.26,
    coolColor: 0x92a8d6,
  });
  const lampLights = [
    lampBounceLight(0, 0.4, 0.5, 1.2, 3.4, 0.9), // neon wash on the console
    lampBounceLight(0, floorY + 0.5, 1.2, 0.5, 4.5, 0.85),
  ];
  for (const l of lampLights) group.add(l);

  return {
    group, roomLights, lampLights, productAdjust: adj,
    camera: roomCameraFrame(adjustedProductFrame(model, adj), furniture, {
      azimuth: 0.42, elevation: 0.27, spreadDeg: 58, maxDistScale: 1.22,
      centerBias: new THREE.Vector3(0.1, 0.1, 0),
    }),
  };
}

/* -- lumen-desk: home office --------------------------------------------------- */
function buildLumenDeskRoom(model) {
  const floorY = -0.72;
  // ~1.08m anglepoise -> 0.45m task lamp on the desk
  const adj = { scale: 0.42, y: 0, lightScale: 0.2 };
  const shell = buildRoomShell({
    width: 9.0, depth: 1.9, height: 2.36, floorY, frontExtra: 1.5,
    wallTint: 0x87796a,
  });
  const group = shell.group;
  const furniture = new THREE.Group();
  group.add(furniture);

  // desk with the task lamp on it (lamp base at origin, desk center behind)
  const desk = buildDesk({ w: 1.6, d: 0.7, height: 0.72, color: 0x77552f });
  desk.position.set(0.15, 0, -0.02);
  furniture.add(desk);
  const deskShadow = contactOval(2.0, 1.0, 0.5);
  deskShadow.position.set(0.15, floorY + 0.02, -0.02);
  group.add(deskShadow);

  // closed laptop + mug in the lamp's pool
  const laptop = buildLaptop();
  laptop.position.set(0.52, 0.0, 0.08);
  laptop.rotation.y = -0.28;
  furniture.add(laptop);
  const mug = buildMug(0x7d4838);
  mug.position.set(-0.28, 0, 0.22);
  furniture.add(mug);
  const books = buildBookStack(3, 2);
  books.position.set(0.62, 0.001, -0.22);
  furniture.add(books);

  // task chair pulled slightly away
  const chair = buildTaskChair({ color: 0x474139 });
  chair.position.set(0.1, floorY, 0.72);
  chair.rotation.y = Math.PI - 0.35;
  furniture.add(chair);
  const chShadow = contactOval(0.8, 0.8, 0.45);
  chShadow.position.set(0.1, floorY + 0.02, 0.72);
  group.add(chShadow);

  // floating shelf with books + plant above the desk
  const shelfMat = furnWoodMaterial(0x4c3520, { roughness: 0.45 });
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.045, 0.22), shelfMat);
  shelf.position.set(0.15, floorY + 1.62, shell.backZ + 0.13);
  group.add(shelf);
  const shelfBooks = new THREE.Group();
  const bookColors = [0x5d4238, 0x37454e, 0x655d33, 0x2f3a3a, 0x59392f];
  let bx = -0.42;
  const brnd = mulberry(61);
  for (let i = 0; i < 8; i++) {
    const bw = 0.028 + brnd() * 0.02;
    const bh = 0.16 + brnd() * 0.06;
    const b = new THREE.Mesh(
      new THREE.BoxGeometry(bw, bh, 0.13 + brnd() * 0.04),
      paintedMaterial(bookColors[i % bookColors.length], { roughness: 0.65 }));
    b.position.set(bx, bh / 2, 0);
    b.rotation.z = i === 5 ? 0.16 : 0;
    shelfBooks.add(b);
    bx += bw + 0.006;
  }
  shelfBooks.position.set(0.05, floorY + 1.6425, shell.backZ + 0.13);
  group.add(shelfBooks);
  const shelfPlant = buildPlant({ scale: 0.8, seed: 77, leaves: 7 });
  shelfPlant.position.set(0.62, floorY + 1.6425, shell.backZ + 0.13);
  group.add(shelfPlant);

  // pinboard-ish art beside the shelf
  const art = buildArtFrame(0.5, 0.66, 2);
  art.position.set(-0.95, floorY + 1.52, shell.backZ + 0.045);
  group.add(art);

  // window on the side wall lighting the desk from the left
  addWindowAssembly(group, shell, {
    wall: 'side', cx: 0.1, cy: floorY + 1.42, w: 1.0, h: 1.45,
    curtainSide: -1, lightBase: 7.5,
  });

  const plant = buildPlant({ scale: 1.9, seed: 91 });
  plant.position.set(1.7, floorY, shell.backZ + 0.45);
  group.add(plant);
  const ps = contactOval(0.55, 0.55, 0.4);
  ps.position.set(1.7, floorY + 0.022, shell.backZ + 0.45);
  group.add(ps);

  const roomLights = addRoomAmbientLights(group);
  const lampLights = [
    lampBounceLight(0.5, 0.35, 0.5, 1.0, 3, 0.8), // pool on the desk surface
    lampBounceLight(0.2, floorY + 0.4, 0.9, 0.4, 4, 0.7),
  ];
  for (const l of lampLights) group.add(l);

  return {
    group, roomLights, lampLights, productAdjust: adj,
    camera: roomCameraFrame(adjustedProductFrame(model, adj), furniture, {
      azimuth: 0.42, elevation: 0.26, spreadDeg: 58, maxDistScale: 1.22,
      centerBias: new THREE.Vector3(0.08, 0.1, 0),
    }),
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
  // warm bounce fills live with the lamp state (kelvin + power scaled)
  if (room.lampLights) model.lights.push(...room.lampLights);
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
    // real-world product size in room mode; studio always snaps back to
    // exactly scale 1 at the origin (absolute values — repeat-toggle safe)
    const adj = this._roomBundle.productAdjust || { scale: 1, y: 0, lightScale: 1 };
    if (on) {
      model.group.scale.setScalar(adj.scale);
      model.group.position.set(adj.x || 0, adj.y || 0, adj.z || 0);
      model.group.rotation.y = adj.ry || 0;
    } else {
      model.group.scale.setScalar(1);
      model.group.position.set(0, 0, 0);
      model.group.rotation.y = 0;
    }
    this._built.lampScale = on ? (adj.lightScale ?? adj.scale * adj.scale) : 1;
    // in-room the studio rig + env map step back so window/lamp light reads
    this._built.rigScale = on ? 0.34 : 1;
    this._built.envScale = on ? 0.7 : 1;

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
