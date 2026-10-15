import { AdditiveBlending, BoxGeometry, BufferGeometry, CatmullRomCurve3, CircleGeometry, Color, CylinderGeometry, ExtrudeGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Points, ShaderMaterial, Shape, ShapeGeometry, SphereGeometry, TorusGeometry, TubeGeometry, Vector3 } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CompanionWorldScene } from '../../../shared/companion-world';
import { companionWorldParkCircuit, companionWorldParkLayout } from '../../../shared/companion-world-park';

type Furniture = CompanionWorldScene['objects'][number];
type Finish = 'stone' | 'garden' | 'foliage' | 'timber' | 'metal' | 'lantern' | 'water';
const PALETTE = {
  plinth: '#b1bca9', edge: '#c7c7ae', grass: '#94aa82', grassLight: '#9baf89', grassShade: '#8ba17c',
  paving: '#b0a68b', pavingEdge: '#8f9a83', gravel: '#adae96', slate: '#8a9d91',
  oak: '#bc9570', oakLight: '#d3b18a', bark: '#977657', barkLight: '#b18d64',
  iron: '#536c64', leaf: '#81a786', leafLight: '#a7c29b', leafDark: '#638e77', leafMint: '#95b49c',
  soil: '#968877', cream: '#f6ecd3', pink: '#dfa5ad', lilac: '#b5a5c6', yellow: '#e8ca88', glow: '#ffe6b0',
} as const;

/**
 * A static, batched garden diorama in the host's outdoor coordinates.
 * Trunks, bench supports and arbor feet only occupy existing blocking furniture.
 * Everything elsewhere is flush paving or groundcover, never a hidden obstacle.
 */
export function createWorldParkModel(scene: CompanionWorldScene) {
  const bounds = companionWorldParkLayout(scene);
  const group = new Group(); group.name = 'public-garden';
  const buckets = new Map<Finish, BufferGeometry[]>();
  const geometries: BufferGeometry[] = [], materials: Array<MeshStandardMaterial | MeshBasicMaterial | ShaderMaterial> = [], lamps: Array<{ x: number; z: number }> = [];
  let lightPools: Mesh | undefined, spray: Points<BufferGeometry, ShaderMaterial> | undefined;
  let disposed = false, previousNight: boolean | undefined;
  const color = new Color();

  function part(geometry: BufferGeometry, finish: Finish, tint: string, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rotation = 0) {
    if (geometry.index) { const expanded = geometry.toNonIndexed(); geometry.dispose(); geometry = expanded; }
    // Every bucket uses an identical attribute layout, including generated ribbons.
    geometry.deleteAttribute('tangent'); geometry.deleteAttribute('uv1');
    geometry.scale(sx, sy, sz); geometry.rotateY(rotation); geometry.translate(x, y, z);
    color.set(tint);
    const vertices = geometry.getAttribute('position').count, colors = new Float32Array(vertices * 3);
    for (let index = 0; index < vertices; index++) { colors[index * 3] = color.r; colors[index * 3 + 1] = color.g; colors[index * 3 + 2] = color.b; }
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    const list = buckets.get(finish) ?? []; list.push(geometry); buckets.set(finish, list);
  }
  const box = (finish: Finish, tint: string, x: number, y: number, z: number, width: number, height: number, depth: number, radius = .035) => part(radius > 0 ? new RoundedBoxGeometry(width, height, depth, 2, Math.min(radius, height / 2, width / 2, depth / 2)) : new BoxGeometry(width, height, depth), finish, tint, x, y, z);
  const ball = (finish: Finish, tint: string, x: number, y: number, z: number, sx: number, sy: number, sz: number) => part(new SphereGeometry(1, Math.max(sx, sy, sz) < .25 ? 6 : 12, Math.max(sx, sy, sz) < .25 ? 4 : 8), finish, tint, x, y, z, sx, sy, sz);
  const cylinder = (finish: Finish, tint: string, x: number, y: number, z: number, top: number, bottom: number, height: number, segments = 10) => part(new CylinderGeometry(top, bottom, height, segments), finish, tint, x, y, z);
  function disc(finish: Finish, tint: string, x: number, z: number, rx: number, rz: number, y = .018, segments = 48) {
    const shape = new CircleGeometry(1, segments); shape.rotateX(-Math.PI / 2); part(shape, finish, tint, x, y, z, rx, 1, rz);
  }
  function roundedGround(width: number, depth: number, radius: number) {
    const shape = new Shape(), left = -width / 2, right = width / 2, top = -depth / 2, bottom = depth / 2;
    shape.moveTo(left + radius, top); shape.lineTo(right - radius, top); shape.quadraticCurveTo(right, top, right, top + radius);
    shape.lineTo(right, bottom - radius); shape.quadraticCurveTo(right, bottom, right - radius, bottom);
    shape.lineTo(left + radius, bottom); shape.quadraticCurveTo(left, bottom, left, bottom - radius);
    shape.lineTo(left, top + radius); shape.quadraticCurveTo(left, top, left + radius, top); shape.closePath(); return shape;
  }
  function ribbon(points: Vector3[], width: number, tint: string, y = .036) {
    const curve = new CatmullRomCurve3(points, false, 'centripetal'), samples = curve.getPoints(90), positions: number[] = [], normals: number[] = [], uv: number[] = [];
    for (let index = 0; index < samples.length - 1; index++) {
      const a = samples[index]!, b = samples[index + 1]!;
      const before = samples[Math.max(0, index - 1)]!, after = samples[Math.min(samples.length - 1, index + 2)]!;
      const av = new Vector3(a.z - b.z, 0, b.x - a.x).normalize().multiplyScalar(width / 2);
      const bv = new Vector3(before.z - after.z, 0, after.x - before.x).normalize().multiplyScalar(width / 2);
      for (const p of [a.clone().add(av), b.clone().add(bv), a.clone().sub(av), a.clone().sub(av), b.clone().add(bv), b.clone().sub(bv)]) {
        positions.push(p.x, y, p.z); normals.push(0, 1, 0); uv.push(p.x / 4, p.z / 4);
      }
    }
    const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(positions, 3)); geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3)); geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    part(geometry, 'stone', tint, 0, 0, 0);
  }
  function lantern(x: number, z: number, height = 2.8) {
    lamps.push({ x, z });
    cylinder('metal', PALETTE.iron, x, .06, z, .16, .2, .12);
    cylinder('metal', PALETTE.iron, x, height / 2, z, .045, .055, height);
    cylinder('metal', PALETTE.iron, x, height + .19, z, .24, .24, .04);
    cylinder('lantern', PALETTE.glow, x, height + .04, z, .16, .12, .27, 12);
    cylinder('metal', PALETTE.iron, x, height - .12, z, .2, .2, .055);
    for (let index = 0; index < 4; index++) { const angle = index * Math.PI / 2 + Math.PI / 4; cylinder('metal', PALETTE.iron, x + Math.cos(angle) * .145, height + .04, z + Math.sin(angle) * .145, .014, .014, .27, 5); }
  }
  function tree(object: Furniture, index: number) {
    const x = object.position.x + (object.width - 1) / 2, z = object.position.y + (object.depth - 1) / 2;
    const radius = Math.min(object.width, object.depth) / 2 - .08;
    disc('garden', PALETTE.grassShade, x, z, radius, radius, .024);
    disc('garden', PALETTE.soil, x, z, radius - .04, radius - .04, .04);
    const rim = new TorusGeometry(radius - .055, .048, 6, 28); rim.rotateX(-Math.PI / 2); part(rim, 'stone', PALETTE.pavingEdge, x, .095, z);
    cylinder('timber', PALETTE.bark, x, 1.18, z, .12, .22, 2.36);
    // Shallow roots and a narrow base stay within the host's solid tree footprint.
    for (let root = 0; root < 4; root++) {
      const angle = root * Math.PI / 2 + .4;
      const geometry = new CylinderGeometry(.035, .12, .64, 7); geometry.rotateZ(.48); geometry.rotateY(angle);
      part(geometry, 'timber', PALETTE.barkLight, x + Math.sin(angle) * .17, .28, z + Math.cos(angle) * .17);
    }
    for (let limb = 0; limb < 3; limb++) {
      const angle = limb * 2.09 + index * .8;
      const points = [new Vector3(0, 1.55, 0), new Vector3(Math.cos(angle) * .38, 2.08, Math.sin(angle) * .38), new Vector3(Math.cos(angle) * .8, 2.7, Math.sin(angle) * .8)];
      part(new TubeGeometry(new CatmullRomCurve3(points), 5, .075, 6, false), 'timber', PALETTE.bark, x, 0, z);
    }
    // Soft, sculpted broadleaf clusters; high canopy leaves routes unobstructed below.
    const shades = index === 0 ? ['#d7a4b9', '#e2bace', '#b787a7', '#d0a2c2'] : [PALETTE.leaf, PALETTE.leafLight, PALETTE.leafDark, PALETTE.leafMint];
    ball('foliage', shades[index % shades.length]!, x, 3.28, z, 1.6, 1.38, 1.45);
    for (let cluster = 0; cluster < 7; cluster++) {
      const angle = cluster * 2.399 + index * .5, spread = .97 + cluster % 2 * .23;
      ball('foliage', shades[(cluster + index) % shades.length]!, x + Math.cos(angle) * spread, 3.18 + Math.sin(cluster * 1.7) * .55, z + Math.sin(angle) * spread, 1.08, .95 + cluster % 2 * .18, 1.03);
    }
    ball('foliage', index === 0 ? '#e4c2d3' : PALETTE.leafLight, x - .3, 4.18, z + .12, .83, .67, .77);
    // These small flowers are inside the solid trunk planter, not on a walking cell.
    for (let flower = 0; flower < 14; flower++) {
      const angle = flower * 2.399, r = radius * (.64 + flower % 3 * .085), fx = x + Math.cos(angle) * r, fz = z + Math.sin(angle) * r;
      cylinder('foliage', PALETTE.leafDark, fx, .2, fz, .014, .014, .34, 5);
      ball('foliage', PALETTE.leaf, fx + .03, .14, fz, .07, .08, .045);
      for (let petal = 0; petal < 5; petal++) { const a = petal * Math.PI * .4; ball('garden', [PALETTE.cream, PALETTE.pink, PALETTE.lilac][flower % 3]!, fx + Math.cos(a) * .065, .38, fz + Math.sin(a) * .065, .065, .025, .052); }
      ball('garden', PALETTE.yellow, fx, .39, fz, .03, .015, .03);
    }
    group.userData[object.id] = { kind: 'tree', position: { x, y: z }, footprint: { ...object.position, width: object.width, depth: object.depth } };
  }
  function bench(object: Furniture, index: number) {
    const x = object.position.x + (object.width - 1) / 2, z = object.position.y + (object.depth - 1) / 2, width = object.width;
    disc('stone', PALETTE.gravel, x, z + .35, width / 2 + .45, 1.15, .038);
    for (const side of [-1, 1]) {
      box('metal', PALETTE.iron, x + side * (width / 2 - .37), .29, z, .09, .55, .64);
      box('metal', PALETTE.iron, x + side * (width / 2 - .37), .51, z - .455, .075, .82, .07);
      box('metal', PALETTE.iron, x + side * (width / 2 - .22), .73, z + .06, .055, .4, .055);
      box('timber', PALETTE.oakLight, x + side * (width / 2 - .22), .94, z + .02, .13, .075, .77);
    }
    // Matches the engine's .57 seat reference, so sitting never floats above a bench.
    for (let slat = 0; slat < 4; slat++) box('timber', slat % 2 ? PALETTE.oakLight : PALETTE.oak, x, .53, z - .3 + slat * .2, width, .08, .165);
    // A low .925 backrest fits the .57 chibi seat without crossing billboard faces.
    // Real depth testing remains enabled; the rail stays within the solid footprint.
    for (let slat = 0; slat < 3; slat++) box('timber', slat % 2 ? PALETTE.oak : PALETTE.oakLight, x, .66 + slat * .11, z - .455, width, .09, .07);
    if (index % 2) {
      // An arbor belongs to this bench. All four feet remain in its blocking cells.
      const radius = Math.max(.7, width / 2 - .18), spring = 1.85;
      for (const offset of [-.3, .3]) {
        for (const side of [-1, 1]) cylinder('metal', PALETTE.iron, x + side * radius, spring / 2, z + offset, .035, .045, spring);
        part(new TorusGeometry(radius, .036, 6, 30, Math.PI), 'metal', PALETTE.iron, x, spring, z + offset);
      }
      for (let slat = 0; slat < 9; slat++) {
        const angle = .13 + slat * (Math.PI - .26) / 8;
        box('timber', PALETTE.oak, x + Math.cos(angle) * radius, spring + Math.sin(angle) * radius, z, .065, .06, 1.1);
      }
      for (let leaf = 0; leaf < 11; leaf++) { const angle = .3 + leaf * .18; ball('foliage', leaf % 2 ? PALETTE.leaf : PALETTE.leafMint, x + Math.cos(angle) * radius, spring + Math.sin(angle) * radius + .05, z - .26, .15, .1, .2); }
    }
    group.userData[object.id] = { kind: 'bench', position: { x, y: z }, anchor: { ...object.anchor }, seatHeight: .57, footprint: { ...object.position, width: object.width, depth: object.depth } };
  }
  function fountain(object: Furniture) {
    const x = object.position.x + (object.width - 1) / 2, z = object.position.y + (object.depth - 1) / 2;
    const radius = Math.min(object.width, object.depth) / 2 - .12;
    cylinder('stone', PALETTE.pavingEdge, x, .14, z, radius, radius + .01, .28, 48);
    cylinder('stone', PALETTE.edge, x, .39, z, radius - .08, radius - .02, .5, 48);
    const lip = new TorusGeometry(radius - .12, .12, 8, 48); lip.rotateX(-Math.PI / 2); part(lip, 'stone', PALETTE.edge, x, .7, z);
    disc('water', '#76b8bc', x, z, radius - .24, radius - .24, .65, 64);
    cylinder('stone', PALETTE.edge, x, .96, z, .21, .34, .7, 16);
    cylinder('stone', PALETTE.edge, x, 1.36, z, .8, .33, .24, 32);
    disc('water', '#90c9c9', x, z, .73, .73, 1.49, 48);
    const crown = new TorusGeometry(.75, .065, 6, 40); crown.rotateX(-Math.PI / 2); part(crown, 'stone', PALETTE.edge, x, 1.5, z);
    for (let jet = 0; jet < 8; jet++) {
      const angle = jet * Math.PI / 4, points: Vector3[] = [];
      for (let step = 0; step <= 12; step++) { const t = step / 12, distance = .12 + t * (radius - .5); points.push(new Vector3(Math.cos(angle) * distance, 1.5 * (1 - t) + .66 * t + 2.6 * 4 * t * (1 - t), Math.sin(angle) * distance)); }
      part(new TubeGeometry(new CatmullRomCurve3(points), 22, .013, 4, false), 'water', '#acdadd', x, 0, z);
    }
    const particleCount = 216, positions = new Float32Array(particleCount * 3), phases = new Float32Array(particleCount), directions = new Float32Array(particleCount * 2);
    for (let index = 0; index < particleCount; index++) { const angle = index % 8 * Math.PI / 4; phases[index] = Math.floor(index / 8) / 27; directions[index * 2] = Math.cos(angle); directions[index * 2 + 1] = Math.sin(angle); }
    const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(positions, 3)); geometry.setAttribute('aPhase', new Float32BufferAttribute(phases, 1)); geometry.setAttribute('aDirection', new Float32BufferAttribute(directions, 2));
    const material = new ShaderMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uRadius: { value: radius - .5 } },
      vertexShader: `attribute float aPhase; attribute vec2 aDirection; uniform float uTime; uniform float uRadius; varying float vAlpha;
        void main() { float t = fract(aPhase + uTime * .63); float radial = .12 + t * uRadius;
          vec3 p = vec3(aDirection.x * radial, mix(1.5, .66, t) + 2.6 * 4.0 * t * (1.0 - t), aDirection.y * radial);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); gl_PointSize = 3.2; vAlpha = .8 - t * .35; }`,
      fragmentShader: `varying float vAlpha; void main() { float r = length(gl_PointCoord - .5); if (r > .5) discard; gl_FragColor = vec4(.65, .91, 1.0, (1.0 - smoothstep(.08, .5, r)) * vAlpha); }`,
    });
    spray = new Points(geometry, material); spray.name = 'garden-fountain-spray'; spray.position.set(x, 0, z); spray.frustumCulled = false; spray.updateMatrix(); spray.matrixAutoUpdate = false;
    group.add(spray); geometries.push(geometry); materials.push(material);
    group.userData[object.id] = { kind: 'fountain', position: { x, y: z }, footprint: { ...object.position, width: object.width, depth: object.depth } };
  }

  if (bounds) {
    const { x, y: z, width, height: depth } = bounds, cx = x + width / 2, cz = z + depth / 2;
    const base = new ExtrudeGeometry(roundedGround(width, depth, 2.4), { depth: .34, steps: 1, bevelEnabled: true, bevelSegments: 2, bevelSize: .08, bevelThickness: .045, curveSegments: 10 }); base.rotateX(-Math.PI / 2);
    part(base, 'stone', PALETTE.plinth, cx, -.44, cz);
    const border = new ShapeGeometry(roundedGround(width - .15, depth - .15, 2.35), 12); border.rotateX(-Math.PI / 2); part(border, 'stone', PALETTE.edge, cx, -.015, cz);
    const lawn = new ShapeGeometry(roundedGround(width - .7, depth - .7, 2.1), 12); lawn.rotateX(-Math.PI / 2); part(lawn, 'garden', PALETTE.grass, cx, 0, cz);
    // Quiet lawn embroidery replaces large contrasting circles. Every blade is flush.
    for (let tuft = 0; tuft < 100; tuft++) {
      const px = x + 4 + ((tuft * 17) % 97) / 97 * (width - 8), pz = z + 4 + ((tuft * 31) % 89) / 89 * (depth - 9);
      for (const side of [-1, 0, 1]) disc('garden', tuft % 3 ? PALETTE.grassShade : PALETTE.grassLight, px + side * .06, pz + Math.abs(side) * .05, .028, .13, .009, 5);
    }
    const circuit = companionWorldParkCircuit(scene);
    if (circuit.length === 4) {
      const left = Math.min(...circuit.map(point => point.x)), right = Math.max(...circuit.map(point => point.x));
      const top = Math.min(...circuit.map(point => point.y)), bottom = Math.max(...circuit.map(point => point.y));
      for (const [breadth, tint, height] of [[2.1, PALETTE.pavingEdge, .021], [1.82, PALETTE.paving, .027]] as const) {
        const shape = roundedGround(right - left + breadth, bottom - top + breadth, 1.8);
        shape.holes.push(roundedGround(right - left - breadth, bottom - top - breadth, .8));
        const geometry = new ShapeGeometry(shape, 12); geometry.rotateX(-Math.PI / 2);
        part(geometry, 'stone', tint, (left + right) / 2, height, (top + bottom) / 2);
      }
    }
    const ordered = [...bounds.benches].sort((a, b) => a.anchor.x - b.anchor.x);
    const pathZ = Math.min(z + depth - 2, ordered[0]?.anchor.y ?? cz + depth * .24);
    const promenade = [new Vector3(x - .15, 0, pathZ + .8), ...ordered.map(object => new Vector3(object.anchor.x, 0, object.anchor.y)), new Vector3(x + width + .15, 0, pathZ + .25)];
    ribbon(promenade, 2.8, PALETTE.pavingEdge, .025); ribbon(promenade, 2.56, PALETTE.paving, .03);
    // Broad shallow paths reach every actual tree anchor. They are view-only surfaces.
    for (const [index, object] of bounds.trees.entries()) {
      const ax = object.anchor.x, az = object.anchor.y;
      const points = [new Vector3(ax - 2.4 + index % 2 * 4.8, 0, pathZ), new Vector3(ax - 1.5, 0, (az + pathZ) / 2), new Vector3(ax, 0, az)];
      ribbon(points, 1.62, PALETTE.pavingEdge, .026); ribbon(points, 1.4, PALETTE.paving, .031);
    }
    // A plaza surrounds the authoritative solid fountain footprint, never a fake pond.
    const actualFountain = scene.objects.find(object => object.kind === 'fountain');
    const courtX = actualFountain ? actualFountain.position.x + (actualFountain.width - 1) / 2 : x + width * .51, courtZ = actualFountain ? actualFountain.position.y + (actualFountain.depth - 1) / 2 : z + depth * .32;
    disc('stone', PALETTE.pavingEdge, courtX, courtZ, 3.9, 3.4, .014, 64); disc('stone', PALETTE.paving, courtX, courtZ, 3.72, 3.22, .019, 64);
    for (let index = 0; index < 12; index++) { const angle = index * Math.PI / 6; disc('stone', index % 2 ? PALETTE.slate : PALETTE.cream, courtX + Math.cos(angle) * 2.9, courtZ + Math.sin(angle) * 2.45, .18, .18, .022, 8); }
    if (!actualFountain) { const medallion = new TorusGeometry(.95, .025, 4, 48); medallion.rotateX(-Math.PI / 2); part(medallion, 'stone', PALETTE.grassShade, courtX, .025, courtZ); }
    // Paired, flat flower embroidery stays below the actor's .04 ground reference.
    for (const [px, pz] of [[x + 4, z + depth - 3.4], [x + width * .68, z + 3.2], [x + width - 4.4, z + depth - 3.2]]) {
      disc('garden', PALETTE.grassShade, px!, pz!, 2.25, .8, .011);
      for (let flower = 0; flower < 16; flower++) {
        const angle = flower * 2.399, r = .28 + flower * .095, fx = px! + Math.cos(angle) * r, fz = pz! + Math.sin(angle) * r * .4;
        for (let petal = 0; petal < 5; petal++) { const a = petal * Math.PI * .4; disc('garden', [PALETTE.cream, PALETTE.pink, PALETTE.lilac][flower % 3]!, fx + Math.cos(a) * .07, fz + Math.sin(a) * .07, .07, .045, .017, 6); }
        disc('garden', PALETTE.yellow, fx, fz, .025, .025, .019, 6);
      }
    }
    bounds.trees.forEach(tree); bounds.benches.forEach(bench);
    if (actualFountain) fountain(actualFountain);
    for (const object of scene.objects.filter(item => item.kind === 'lamp')) {
      const lx = object.position.x + (object.width - 1) / 2, lz = object.position.y + (object.depth - 1) / 2;
      lantern(lx, lz, 3.1); group.userData[object.id] = { kind: 'lamp', position: { x: lx, y: lz }, height: 3.1 };
    }
  }

  for (const [finish, parts] of buckets) {
    const geometry = mergeGeometries(parts, false); parts.forEach(item => item.dispose());
    if (!geometry) throw new Error('Public garden geometry could not be batched.');
    const material = new MeshStandardMaterial({ vertexColors: true, roughness: finish === 'metal' ? .65 : finish === 'water' ? .22 : .92, metalness: finish === 'metal' ? .28 : finish === 'water' ? .08 : 0,
      ...(finish === 'lantern' ? { emissive: '#ffcb7d', emissiveIntensity: 0 } : {}) });
    const mesh = new Mesh(geometry, material); mesh.name = 'garden-' + finish; mesh.castShadow = !['garden', 'stone', 'lantern', 'water'].includes(finish); mesh.receiveShadow = true;
    mesh.updateMatrix(); mesh.matrixAutoUpdate = false; group.add(mesh); geometries.push(geometry); materials.push(material);
  }
  // dispose() releases GPU allocations; drop the temporary CPU part arrays now too.
  buckets.clear();
  if (lamps.length) {
    const positions: number[] = [], colors: number[] = [], indices: number[] = [], steps = 32, warm = new Color('#f8cd87');
    for (const lamp of lamps) {
      const base = positions.length / 3;
      positions.push(lamp.x, .054, lamp.z); colors.push(warm.r, warm.g, warm.b, .38);
      for (const [radius, alpha] of [[.55, .34], [1.3, .23], [2.3, .1], [3.7, 0]]) {
        for (let index = 0; index < steps; index++) {
          const angle = index * Math.PI * 2 / steps;
          const px = lamp.x + Math.cos(angle) * radius!, pz = lamp.z + Math.sin(angle) * radius!;
          positions.push(bounds ? Math.max(bounds.x + .35, Math.min(bounds.x + bounds.width - .35, px)) : px, .054, bounds ? Math.max(bounds.y + .35, Math.min(bounds.y + bounds.height - .35, pz)) : pz);
          colors.push(warm.r, warm.g, warm.b, alpha!);
        }
      }
      for (let index = 0; index < steps; index++) {
        const next = (index + 1) % steps; indices.push(base, base + 1 + next, base + 1 + index);
        for (let ring = 0; ring < 3; ring++) {
          const a = base + 1 + ring * steps + index, b = base + 1 + ring * steps + next, c = a + steps, d = b + steps;
          indices.push(a, d, c, a, b, d);
        }
      }
    }
    const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(positions, 3)); geometry.setAttribute('color', new Float32BufferAttribute(colors, 4)); geometry.setIndex(indices);
    const material = new MeshBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    lightPools = new Mesh(geometry, material); lightPools.name = 'garden-light-pools'; lightPools.visible = false; lightPools.updateMatrix(); lightPools.matrixAutoUpdate = false; group.add(lightPools); geometries.push(geometry); materials.push(material);
  }
  const stats = { drawCalls: group.children.length, triangles: group.children.reduce((sum, object) => sum + (object instanceof Mesh ? (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3 : 0), 0),
    waterParticles: spray?.geometry.getAttribute('position').count ?? 0, furnitureCount: bounds ? scene.objects.filter(object => ['tree', 'bench', 'fountain', 'lamp'].includes(object.kind)).length : 0 };
  group.userData.parkStats = stats;
  return { group, bounds, stats,
    animate(time: number) { if (disposed || !spray) return false; spray.material.uniforms.uTime!.value = time / 1000; return true; },
    setNight(night: boolean) { if (disposed || previousNight === night) return; previousNight = night; if (lightPools) lightPools.visible = night; materials.forEach(material => { if (material instanceof MeshStandardMaterial && material.emissive.getHex() !== 0) material.emissiveIntensity = night ? 1.15 : 0; }); },
    dispose() { if (disposed) return; disposed = true; geometries.forEach(item => item.dispose()); materials.forEach(item => item.dispose()); buckets.clear(); group.clear(); },
  };
}
