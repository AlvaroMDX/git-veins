import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {}, getState() {}, setState() {} };

const SP = 1.1; // vertical distance between commits
const LW = 1.7; // distance between lanes
const TILT = -0.42;
const MAIN = '#2b55a6';
const BLUES = ['#2a4f9f', '#3567b5', '#1e3a78', '#4a7fc4', '#34508f'];
const REDS = ['#b4212b', '#cc3a2d', '#951b24', '#d5523b', '#a9283f'];
const GOLD = '#e0b04a';
const MAX_LABELS = 45;
const WIDE = 1.5; // aspect above which history runs left to right (bottom panel)

const tilt = () => (camera.aspect > WIDE ? -Math.PI / 2 : TILT);
const wideSpan = () => (camera.aspect > WIDE ? 40 : 48);

const $ = (id) => document.getElementById(id);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 6000);
scene.add(camera);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.autoRotateSpeed = 0.7;
controls.screenSpacePanning = true;

scene.add(new THREE.HemisphereLight('#fff4e0', '#7a5a3c', 1.25));
const key = new THREE.DirectionalLight('#ffffff', 1.9);
const keyTarget = new THREE.Object3D();
key.position.set(-3, 4, 2);
keyTarget.position.set(0, 0, -5);
camera.add(key, keyTarget);
key.target = keyTarget;
const rim = new THREE.DirectionalLight('#ffd9b0', 0.45);
rim.position.set(10, -6, -8);
scene.add(rim);

const outlineMat = (color) => new THREE.ShaderMaterial({
  uniforms: { c: { value: new THREE.Color(color).multiplyScalar(0.28) }, w: { value: 0.035 } },
  vertexShader: 'uniform float w; void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * w, 1.0); }',
  fragmentShader: 'uniform vec3 c; void main(){ gl_FragColor = vec4(c, 1.0); }',
  side: THREE.BackSide,
});

function rngFrom(str) {
  let a = 2166136261;
  for (let i = 0; i < str.length; i++) a = Math.imul(a ^ str.charCodeAt(i), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// TubeGeometry whose rings are scaled by taper(t) around the curve
function tube(curve, radius, segments, radial, taper) {
  const g = new THREE.TubeGeometry(curve, segments, radius, radial, false);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const f = taper(t);
    curve.getPointAt(t, p);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, k).sub(p).multiplyScalar(f).add(p);
      pos.setXYZ(k, v.x, v.y, v.z);
    }
  }
  pos.needsUpdate = true;
  return g;
}

// smooth field that bends straight lane runs into meandering vessels
function warp(v) {
  const lane = v.x / LW;
  v.x += Math.sin(v.y * 0.13 + lane * 1.7) * 0.55 + Math.sin(v.y * 0.041 + lane) * 0.9;
  v.z += Math.cos(v.y * 0.11 + lane * 2.9) * 0.7;
  return v;
}

function curveOf(points, organic = false) {
  const clean = [points[0]];
  for (const p of points.slice(1)) {
    const prev = clean[clean.length - 1];
    if (p.distanceToSquared(prev) <= 1e-4) continue;
    const steps = organic ? Math.floor(prev.distanceTo(p) / 2.2) : 0;
    for (let s = 1; s <= steps; s++) clean.push(prev.clone().lerp(p, s / (steps + 1)));
    clean.push(p);
  }
  if (organic) clean.forEach(warp);
  if (clean.length < 2) clean.push(clean[0].clone().add(V(0, -SP, 0)));
  return new THREE.CatmullRomCurve3(clean, false, 'centripetal');
}

function shortRefs(d) {
  if (!d) return null;
  let head = false;
  const parts = d.split(', ').filter((r) => r && r !== 'origin/HEAD').map((r) => {
    if (r.startsWith('HEAD -> ')) {
      head = true;
      return r.slice(8);
    }
    if (r === 'HEAD') {
      head = true;
      return 'HEAD';
    }
    return r.startsWith('tag: ') ? '⚑ ' + r.slice(5) : r;
  });
  const local = new Set(parts);
  const names = parts.filter((r) => !(r.startsWith('origin/') && local.has(r.slice(7))));
  if (!names.length) return null;
  const text = names.slice(0, 3).join(' · ') + (names.length > 3 ? ` +${names.length - 3}` : '');
  return { text, head };
}

const branchRefs = (d) => (d || '').split(', ')
  .map((r) => r.replace(/^HEAD -> /, ''))
  .filter((r) => r && r !== 'HEAD' && r !== 'origin/HEAD' && !r.startsWith('tag: '));
const bareName = (r) => r.replace(/^(remotes\/)?origin\//, '');
const MERGE_RE = /^Merge (?:remote-tracking )?branch '([^']+)'(?: of \S+)?(?: into '?([^'\s]+)'?)?/;

// gives every vessel a branch name, where it was born and where it drains, from refs and merge subjects
function nameBranches(commits, byHash, paths) {
  const mergedBy = new Map();
  for (const c of commits) for (const h of c.p.slice(1)) if (!mergedBy.has(h)) mergedBy.set(h, c);

  for (const P of paths) {
    const first = P.commits[0];
    const refs = branchRefs(first.d);
    const local = refs.find((r) => !r.startsWith('origin/'));
    P.name = local || (refs[0] && bareName(refs[0])) || null;
    P.open = refs.length > 0;
    const m = mergedBy.get(first.h);
    if (m) {
      P.mergeCommit = m;
      const hit = MERGE_RE.exec(m.s);
      if (!P.name && hit) P.name = bareName(hit[1]);
      if (hit?.[2]) P.intoName = bareName(hit[2]);
    }
    if (P.main) {
      const named = P.commits.map((c) => branchRefs(c.d)).flat();
      P.name = ['develop', 'master', 'main'].find((n) => named.some((r) => bareName(r) === n)) || P.name || (named[0] && bareName(named[0])) || null;
    }
    const task = /(?:^|\/)(\d{4,6})(?:$|[-_])/.exec(P.name || '');
    P.task = task ? task[1] : null;
  }
  for (const P of paths) {
    const parent = byHash.get(P.commits[P.commits.length - 1].p[0]);
    P.fromName = parent ? paths[parent.path].name || 'una rama sin nombre' : null;
    P.fromDate = parent?.t;
    if (P.mergeCommit) P.intoName = P.intoName || paths[P.mergeCommit.path].name || 'una rama sin nombre';
  }
}

let world = null;
let nodes = null;
let model = null;
let hovered = null;
let lastEv = null;
let vessels = [];
const issues = new Map();
let labels = [];
let fitted = null;
const ui = { caps: true, tags: !!vscode.getState()?.tags };

function dispose(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) [].concat(o.material).forEach((m) => m.dispose());
  });
}

function layout(commits) {
  const byHash = new Map();
  commits.forEach((c, i) => {
    c.i = i;
    byHash.set(c.h, c);
  });

  const lanes = [];
  const free = (except) => {
    for (let j = 0; j < lanes.length; j++) if (lanes[j] === null && j !== except) return j;
    lanes.push(null);
    return lanes.length - 1;
  };
  let maxLane = 0;
  for (const c of commits) {
    let idx = lanes.indexOf(c.h);
    if (idx < 0) idx = free(-1);
    for (let j = 0; j < lanes.length; j++) if (j !== idx && lanes[j] === c.h) lanes[j] = null;
    c.lane = idx;
    maxLane = Math.max(maxLane, idx);
    lanes[idx] = byHash.has(c.p[0]) ? c.p[0] : null;
    for (const p of c.p.slice(1)) if (byHash.has(p) && !lanes.includes(p)) lanes[free(idx)] = p;
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  }

  const paths = [];
  for (const c of commits) {
    if (c.path === undefined) {
      c.path = paths.length;
      paths.push({ id: paths.length, commits: [] });
    }
    paths[c.path].commits.push(c);
    const p = byHash.get(c.p[0]);
    if (p && p.lane === c.lane && p.path === undefined) p.path = c.path;
  }

  const rng = rngFrom(commits.length ? commits[commits.length - 1].h : 'x');
  for (const c of commits) {
    c.raw = V(
      c.lane * LW + (rng() - 0.5) * 0.35,
      -c.i * SP,
      Math.sin(c.lane * 2.3) * LW * 0.9 + Math.cos(c.i * 0.07 + c.lane) * 0.35,
    );
    c.pos = warp(c.raw.clone());
  }

  const maxLen = Math.max(1, ...paths.map((p) => p.commits.length));
  const main = paths.reduce((a, b) => (b.commits.length > a.commits.length ? b : a), paths[0]);
  let reds = 0;
  let blues = 0;
  for (const P of paths) {
    const r = rngFrom(P.commits[0].h);
    P.main = P === main;
    P.r = P.main ? 0.5 : 0.07 + 0.3 * Math.sqrt(P.commits.length / maxLen);
    if (P.main) P.color = MAIN;
    else if (r() < 0.5) P.color = REDS[reds++ % REDS.length];
    else P.color = BLUES[blues++ % BLUES.length];
  }
  nameBranches(commits, byHash, paths);
  return { byHash, paths, maxLane };
}

function build(data) {
  if (world) {
    dispose(world);
    scene.remove(world);
  }
  labels.forEach((l) => l.el.remove());
  labels = [];
  hovered = null;
  vessels = [];

  const commits = data.commits;
  const { byHash, paths, maxLane } = layout(commits);
  model = { ...data, byHash, paths, maxLane };

  world = new THREE.Group();
  world.rotation.z = tilt();
  scene.add(world);
  const inner = new THREE.Group();
  inner.position.x = -(maxLane * LW) / 2;
  world.add(inner);
  model.inner = inner;

  // vessels: one tube per lane run, plus one per merge edge
  for (const P of paths) {
    const rng = rngFrom(P.commits[0].h + 'p');
    const first = P.commits[0];
    const last = P.commits[P.commits.length - 1];
    const pts = [first.raw.clone().add(V(0, SP * 0.45, 0))];
    P.commits.forEach((c, k) => {
      const prev = P.commits[k - 1];
      if (prev && c.i - prev.i > 2) {
        const mid = prev.raw.clone().lerp(c.raw, 0.5);
        mid.x += (rng() - 0.5) * 0.6;
        mid.z += (rng() - 0.5) * 0.6;
        pts.push(mid);
      }
      pts.push(c.raw.clone());
    });
    const parent = byHash.get(last.p[0]);
    const joins = !!parent;
    if (parent) {
      const drop = Math.min(SP * 0.9, (last.raw.y - parent.raw.y) * 0.5);
      pts.push(V(last.raw.x, parent.raw.y + drop, last.raw.z), parent.raw.clone());
    } else if (last.p.length) {
      pts.push(last.raw.clone().add(V((rng() - 0.5) * 0.4, -SP * 2, (rng() - 0.5) * 0.4)));
    }
    const curve = curveOf(pts, true);
    const len = curve.getLength();
    const tip = Math.min(0.35, 1.4 / len);
    const end = Math.min(0.3, 1.1 / len);
    const geo = tube(curve, P.r, Math.min(3000, Math.max(12, Math.ceil(len * 3))), P.main ? 18 : 12, (t) => {
      let f = 0.18 + 0.82 * smooth(0, tip, t);
      if (joins) f *= 1 - 0.35 * smooth(1 - end, 1, t);
      return f;
    });
    P.mat = new THREE.MeshPhongMaterial({ color: P.color, specular: '#ffffff', shininess: 70 });
    const mesh = new THREE.Mesh(geo, P.mat);
    mesh.add(new THREE.Mesh(geo, outlineMat(P.color)));
    mesh.userData.path = P.id;
    vessels.push(mesh);
    inner.add(mesh);
  }

  for (const c of commits) {
    for (const h of c.p.slice(1)) {
      const p = byHash.get(h);
      if (!p) continue;
      const P = paths[p.path];
      const rise = Math.min(SP * 0.9, (c.raw.y - p.raw.y) * 0.5);
      const curve = curveOf([p.raw.clone(), V(p.raw.x, c.raw.y - rise, p.raw.z), c.raw.clone()], true);
      const len = curve.getLength();
      const r = Math.max(0.05, P.r * 0.75);
      const geo = tube(curve, r, Math.max(12, Math.ceil(len * 3)), 10, (t) => 1 - 0.4 * smooth(0.75, 1, t));
      const mesh = new THREE.Mesh(geo, P.mat);
      mesh.add(new THREE.Mesh(geo, outlineMat(P.color)));
      mesh.userData.path = P.id;
      vessels.push(mesh);
      inner.add(mesh);
    }
  }

  // capillaries: decorative branching around each commit, merged per colour
  const capGeos = new Map();
  const addCap = (color, g) => {
    if (!capGeos.has(color)) capGeos.set(color, []);
    capGeos.get(color).push(g);
  };
  const grow = (rng, color, start, dir, len, r0, depth) => {
    const pts = [start.clone()];
    const d = dir.clone();
    let p = start.clone();
    for (let s = 0; s < 4; s++) {
      d.add(V(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(0.9)).normalize();
      p = p.clone().addScaledVector(d, len / 4);
      pts.push(p);
    }
    const curve = curveOf(pts);
    addCap(color, tube(curve, r0, 10, 5, (t) => 1 - 0.85 * t));
    if (depth < 2) {
      const kids = 1 + Math.floor(rng() * 2);
      for (let k = 0; k < kids; k++) {
        const at = pts[1 + Math.floor(rng() * 3)];
        grow(rng, color, at, d.clone().add(V(rng() - 0.5, rng() - 0.5, rng() - 0.5)).normalize(), len * 0.6, r0 * 0.6, depth + 1);
      }
    }
  };
  for (const c of commits) {
    const rng = rngFrom(c.h);
    if (rng() < 0.45) continue;
    const P = paths[c.path];
    const n = 1 + Math.floor(rng() * 2.4);
    for (let k = 0; k < n; k++) {
      const a = rng() * Math.PI * 2;
      const dir = V(Math.cos(a), (rng() - 0.5) * 0.9, Math.sin(a)).normalize();
      const start = c.pos.clone().addScaledVector(dir, P.r * 0.7);
      grow(rng, P.color, start, dir, 0.9 + rng() * 1.8 + P.r * 2, Math.min(0.075, P.r * 0.4), 0);
    }
  }
  const caps = new THREE.Group();
  caps.name = 'caps';
  caps.visible = ui.caps;
  for (const [color, geos] of capGeos) {
    const merged = mergeGeometries(geos);
    geos.forEach((g) => g.dispose());
    caps.add(new THREE.Mesh(merged, new THREE.MeshPhongMaterial({ color, specular: '#ffe9d0', shininess: 30 })));
  }
  inner.add(caps);

  // commit nodes
  nodes = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 14, 10),
    new THREE.MeshPhongMaterial({ specular: '#ffffff', shininess: 90 }),
    Math.max(1, commits.length),
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const white = new THREE.Color('#fff3dc');
  commits.forEach((c, k) => {
    const P = paths[c.path];
    c.size = P.r * 1.08 + 0.07;
    m.compose(c.pos, q, V(c.size, c.size, c.size));
    nodes.setMatrixAt(k, m);
    nodes.setColorAt(k, c.p.length > 1 ? new THREE.Color(GOLD) : new THREE.Color(P.color).lerp(white, 0.4));
  });
  nodes.count = commits.length;
  inner.add(nodes);

  // ref labels on the newest decorated commits
  for (const c of commits) {
    if (labels.length >= MAX_LABELS) break;
    const ref = shortRefs(c.d);
    if (!ref) continue;
    const el = document.createElement('div');
    el.className = 'lbl' + (ref.head ? ' head' : '');
    el.textContent = ref.text;
    $('labels').appendChild(el);
    labels.push({ el, c });
  }

  const time = $('time');
  time.max = String(Math.max(0, commits.length - 1));
  time.value = time.max;

  $('repoName').textContent = data.name;
  $('sub').textContent = `${commits.length} commits · ${paths.length} vasos · rama ${data.branch || '—'}`;
  const sel = $('limit');
  sel.innerHTML = data.limits.map((l) => `<option value="${l}" ${l === data.limit ? 'selected' : ''}>${l} commits</option>`).join('');
  $('msg').hidden = commits.length > 0;
  $('msg').textContent = 'Este repositorio aún no tiene historia que diseccionar.';

  world.updateMatrixWorld(true);
  if (fitted !== data.repo) {
    fitted = data.repo;
    fit();
  }
}

function axisPoint(i) {
  const lanes = model.commits.slice(Math.max(0, i - 10), i + 10);
  const x = lanes.reduce((s, c) => s + c.pos.x, 0) / Math.max(1, lanes.length);
  return V(x, -i * SP, 0).applyMatrix4(model.inner.matrixWorld);
}

function fit() {
  if (!model?.commits.length) return;
  const n = model.commits.length;
  let focus = Math.min(22, Math.floor(n / 2));
  const wide = world.rotation.z !== TILT;
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const span = Math.min(n, wideSpan()) * SP;
  let dist = span / (2 * tan * (wide ? camera.aspect * 0.85 : 1));
  let target = axisPoint(focus);
  if (wide) {
    const recent = model.commits.slice(0, Math.min(n, 50)).map((c) => c.lane);
    const lo = Math.min(...recent);
    const hi = Math.max(...recent);
    dist = Math.max(dist, ((hi - lo) * LW + 4) / (2 * tan * 0.85));
    focus = Math.min(Math.floor(n / 2), Math.floor(dist * tan * camera.aspect / SP) - 4);
    target = V((lo + hi) / 2 * LW, -focus * SP, 0).applyMatrix4(model.inner.matrixWorld);
  }
  controls.target.copy(target);
  camera.position.copy(target).add(wide ? V(0, -dist * 0.12, dist) : V(dist * 0.28, dist * 0.12, dist));
  controls.update();
  $('time').value = String(n - 1 - focus);
}

function moveTo(i) {
  const next = axisPoint(i);
  camera.position.add(next.clone().sub(controls.target));
  controls.target.copy(next);
}

function resize() {
  const w = innerWidth;
  const h = innerHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (world && world.rotation.z !== tilt()) {
    world.rotation.z = tilt();
    world.updateMatrixWorld(true);
    fit();
  }
}

const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const tip = $('tip');

function pick(ev) {
  if (!nodes || !model) return null;
  mouse.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObject(nodes)[0];
  return hit ? model.commits[hit.instanceId] : null;
}

// a commit node wins over the vessel behind it
function pickAny(ev) {
  const c = pick(ev);
  if (c) return c;
  const hit = model ? ray.intersectObjects(vessels, false)[0] : null;
  return hit ? model.paths[hit.object.userData.path] : null;
}

const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
const day = (t) => new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

function issueLine(P) {
  if (!P.task) return '';
  const issue = issues.get(P.task);
  if (!issue) {
    issues.set(P.task, { loading: true });
    vscode.postMessage({ type: 'issue', id: P.task });
  }
  if (!issue || issue.loading) return `<div class="m">#${P.task} · consultando Redmine…</div>`;
  if (issue.error) return '';
  return `<div class="t">#${P.task} · ${esc(issue.subject)}</div>`
    + `<div class="m">${esc(issue.status || '')}${issue.assignee ? ' · ' + esc(issue.assignee) : ''}</div>`;
}

function branchCard(P) {
  const first = P.commits[0];
  const last = P.commits[P.commits.length - 1];
  const n = P.commits.length;
  const authors = [...new Set(P.commits.map((c) => c.a))];
  const kind = P.main ? 'Vena principal' : P.mergeCommit ? 'Rama fusionada' : P.open ? 'Rama abierta' : 'Rama';
  const lines = [
    `<div class="h">${kind}</div>`,
    `<div class="s"><b>${esc(P.name || 'rama sin nombre (ya borrada)')}</b></div>`,
    issueLine(P),
    `<div class="m">${n} commit${n > 1 ? 's' : ''} · ${esc(authors.slice(0, 2).join(', '))}${authors.length > 2 ? ` y ${authors.length - 2} más` : ''}</div>`,
    `<div class="m">${n > 1 ? `del ${day(last.t)} al ${day(first.t)}` : day(first.t)}</div>`,
    P.fromName ? `<div class="m">nace de <b>${esc(P.fromName)}</b></div>` : '',
    P.mergeCommit ? `<div class="m">desemboca en <b>${esc(P.intoName)}</b> el ${day(P.mergeCommit.t)}</div>` : '',
    `<div class="m">último: ${esc(first.s)}</div>`,
  ];
  return lines.join('');
}

function commitCard(c) {
  const P = model.paths[c.path];
  const date = new Date(c.t).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
  return `<div class="h">${c.h.slice(0, 10)}${c.p.length > 1 ? ' · merge' : ''} · ${esc(P.name || 'rama sin nombre')}</div>`
    + `<div class="s">${esc(c.s)}</div><div class="m">${esc(c.a)} · ${date}</div>`
    + (c.d ? `<div class="r">${esc(c.d)}</div>` : '');
}

function setHover(target, ev) {
  if (ev) lastEv = ev;
  const pathOf = (x) => (x ? (x.commits ? x : model.paths[x.path]) : null);
  if (hovered !== target) {
    if (hovered) pathOf(hovered).mat.emissive.set('#000000');
    hovered = target;
    if (target) pathOf(target).mat.emissive.set('#4a2c08');
    canvas.style.cursor = target?.h ? 'pointer' : '';
  }
  if (!target) {
    tip.hidden = true;
    return;
  }
  tip.innerHTML = target.commits ? branchCard(target) : commitCard(target);
  tip.hidden = false;
  ev = lastEv;
  const x = Math.min(ev.clientX + 16, innerWidth - tip.offsetWidth - 8);
  const y = Math.min(ev.clientY + 16, innerHeight - tip.offsetHeight - 8);
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}

let downAt = null;
canvas.addEventListener('pointerdown', (ev) => (downAt = [ev.clientX, ev.clientY]));
canvas.addEventListener('pointermove', (ev) => setHover(pickAny(ev), ev));
canvas.addEventListener('pointerleave', () => setHover(null));
canvas.addEventListener('click', (ev) => {
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4) return;
  const c = pick(ev);
  if (c) vscode.postMessage({ type: 'copy', hash: c.h });
});
canvas.addEventListener('dblclick', (ev) => {
  const c = pick(ev);
  if (c) vscode.postMessage({ type: 'show', hash: c.h });
});

const toggle = (id, fn) => $(id).addEventListener('click', () => {
  const on = $(id).classList.toggle('on');
  fn(on);
});
toggle('spin', (on) => (controls.autoRotate = on));
toggle('caps', (on) => {
  ui.caps = on;
  const caps = model?.inner.getObjectByName('caps');
  if (caps) caps.visible = on;
});
$('tags').checked = ui.tags;
$('tags').addEventListener('change', (ev) => {
  ui.tags = ev.target.checked;
  vscode.setState({ ...vscode.getState(), tags: ui.tags });
});
$('fit').addEventListener('click', fit);
$('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
$('repo').addEventListener('click', () => vscode.postMessage({ type: 'repo' }));
$('limit').addEventListener('change', (ev) => vscode.postMessage({ type: 'limit', value: ev.target.value }));
$('time').addEventListener('input', (ev) => {
  if (model?.commits.length) moveTo(model.commits.length - 1 - Number(ev.target.value));
});

window.addEventListener('message', ({ data }) => {
  if (data.type === 'data') build(data);
  if (data.type === 'issue') {
    issues.set(data.id, data);
    if (hovered?.task === data.id) setHover(hovered);
  }
  if (data.type === 'error') {
    $('msg').hidden = false;
    $('msg').textContent = 'No se pudo leer el historial: ' + data.message;
  }
});

addEventListener('resize', resize);
resize();

const tmp = new THREE.Vector3();
// names stay hidden unless the checkbox is on or the branch is under the pointer
function placeLabels() {
  if (!model) return;
  const w = innerWidth;
  const h = innerHeight;
  const hp = hovered ? (hovered.commits ? hovered : model.paths[hovered.path]) : null;
  const shown = labels.filter((l) => ui.tags || l.c.path === hp?.id);
  for (const l of labels) if (!shown.includes(l)) l.el.style.display = 'none';
  const hoverLbl = $('hoverLbl');
  hoverLbl.hidden = !(hp?.name && !shown.length);
  if (!hoverLbl.hidden) {
    hoverLbl.textContent = hp.name;
    shown.push({ el: hoverLbl, c: hp.commits[0] });
  }
  for (const { el, c } of shown) {
    tmp.copy(c.pos).applyMatrix4(model.inner.matrixWorld);
    const depth = tmp.distanceTo(camera.position);
    tmp.project(camera);
    if (tmp.z > 1 || Math.abs(tmp.x) > 1.1 || Math.abs(tmp.y) > 1.1) {
      el.style.display = 'none';
      continue;
    }
    el.style.display = '';
    const px = (tmp.x + 1) / 2 * w + 6;
    const py = (1 - tmp.y) / 2 * h - 8;
    el.style.transform = `translate(${px}px, ${py}px)`;
    el.style.opacity = String(Math.max(0.25, Math.min(1, 90 / depth)));
  }
}

(function loop() {
  requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
  placeLabels();
})();

vscode.postMessage({ type: 'ready' });

