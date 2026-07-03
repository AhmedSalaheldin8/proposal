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
  const podium = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 1.02, 0.06, 64),
    new THREE.MeshStandardMaterial({
      color: 0x1a1c22, metalness: 0.15, roughness: 0.32, envMapIntensity: 0.4,
    }));
  podium.position.y = -0.031;
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
  addPodium(scene, model.podiumRadius);
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
}

function frameCamera(camera, model) {
  const fovV = THREE.MathUtils.degToRad(camera.fov);
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
  const dist = (model.radius / Math.tan(Math.min(fovV, fovH) / 2)) * 1.12 * (model.fitScale ?? 1);
  const azim = model.azimuth ?? 0.6;
  const elev = model.elevation ?? 0.3;
  camera.position.set(
    model.center.x + dist * Math.cos(elev) * Math.sin(azim),
    model.center.y + dist * Math.sin(elev),
    model.center.z + dist * Math.cos(elev) * Math.cos(azim));
  camera.lookAt(model.center);
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
   * @param {{interactive?: boolean, autoRotate?: boolean, transparent?: boolean}} [opts]
   */
  constructor(canvas, productKey, opts = {}) {
    const { interactive = true, autoRotate = true, transparent = true } = opts;
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

    // state
    this._power = true;
    this._powerLevel = 1;
    this._intensity = 1;
    this._kelvin = 3000;
    this._color = this._lampColor(3000);

    // camera + controls
    this._camera = new THREE.PerspectiveCamera(34, 1, 0.05, 60);
    this._camera.aspect = Math.max(0.1, (canvas.clientWidth || 640) / (canvas.clientHeight || 480));
    const dist = frameCamera(this._camera, this._built.model);
    this._controls = null;
    this._fallbackSpin = autoRotate;
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
    if (this._controls) this._controls.autoRotate = !!on;
    else this._fallbackSpin = !!on;
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

      if (this._controls) this._controls.update();
      else if (this._fallbackSpin) model.group.rotation.y += dt * 0.35;

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
