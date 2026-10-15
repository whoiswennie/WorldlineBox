import { BoxGeometry, BufferGeometry, CanvasTexture, CatmullRomCurve3, Color, CylinderGeometry, ExtrudeGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, PlaneGeometry, Shape, SphereGeometry, SRGBColorSpace, TorusGeometry, TubeGeometry, Vector3, type Material } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CompanionWorldScene } from '../../../shared/companion-world';
import { CATALOGUE_COMPANION_PROFILES } from '../../../shared/companion-catalogue';

type Furniture = CompanionWorldScene['objects'][number];
type Surface = 'plaster' | 'ivory' | 'wood' | 'oak' | 'darkWood' | 'sage' | 'blue' | 'linen' | 'rose' | 'metal' | 'screen' | 'glass' | 'soil' | 'leaf' | 'grass' | 'path' | 'tile' | 'light';
const COLORS: Record<Surface, string> = { plaster: '#f0e7dc', ivory: '#fff9ed', wood: '#bf8f67', oak: '#e5c7a0', darkWood: '#765442', sage: '#94bda9', blue: '#829fbf', linen: '#f3e8d4', rose: '#d4a4a0', metal: '#4c5a62', screen: '#7fb8be', glass: '#bbdfdf', soil: '#9b7e65', leaf: '#608d72', grass: '#a9c29d', path: '#ddd4c2', tile: '#d2ded1', light: '#ffe5ab' };

/** This is a view of the host's footprints, never a second collision or furniture model. */
export function createWorldRoomModel(scene: CompanionWorldScene, neighborhood: CompanionWorldScene[] = []) {
  const group = new Group();
  const buckets = new Map<Surface, BufferGeometry[]>();
  const resources: { geometry: BufferGeometry[]; materials: Material[]; textures: CanvasTexture[] } = { geometry: [], materials: [], textures: [] };
  let verticalScale = 1;
  const colorIndex = [...(scene.ownerId ?? '')].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;
  const accent: Surface = (['sage', 'blue', 'rose', 'blue'] as const)[colorIndex]!;
  function part(shape: BufferGeometry, material: Surface, x: number, height: number, z: number, sx = 1, sy = 1, sz = 1, ry = 0) {
    if (shape.index) { const nonIndexed = shape.toNonIndexed(); shape.dispose(); shape = nonIndexed; }
    shape.scale(sx, sy * verticalScale, sz); shape.rotateY(ry); shape.translate(x, height * verticalScale, z);
    const list = buckets.get(material) ?? []; list.push(shape); buckets.set(material, list);
  }
  const box = (material: Surface, x: number, h: number, z: number, w: number, height: number, d: number, radius = .07) => part(radius ? new RoundedBoxGeometry(1, 1, 1, 3, radius) : new BoxGeometry(1, 1, 1), material, x, h, z, w, height, d);
  const cylinder = (material: Surface, x: number, h: number, z: number, radius: number, height: number) => part(new CylinderGeometry(radius, radius, height, 10), material, x, h, z);
  const ball = (material: Surface, x: number, h: number, z: number, sx: number, sy: number, sz: number) => part(new SphereGeometry(1, 16, 12), material, x, h, z, sx, sy, sz);
  const pipe = (material: Surface, points: Array<[number, number, number]>, radius: number, x: number, h: number, z: number) => part(new TubeGeometry(new CatmullRomCurve3(points.map(point => new Vector3(...point))), 12, radius, 6, false), material, x, h, z);
  function lamp(x: number, h: number, z: number, scale = 1) {
    cylinder('metal', x, h, z, .24 * scale, .065 * scale);
    pipe('metal', [[0, 0, 0], [0, .55 * scale, 0], [.26 * scale, .82 * scale, 0]], .04 * scale, x, h, z);
    part(new CylinderGeometry(.16 * scale, .34 * scale, .31 * scale, 20, 1, true), 'ivory', x + .26 * scale, h + .8 * scale, z);
    ball('light', x + .26 * scale, h + .71 * scale, z, .16 * scale, .05 * scale, .16 * scale);
  }
  function quilt(x: number, h: number, z: number, w: number, d: number) {
    const geometry = new BufferGeometry(), positions: number[] = [], uv: number[] = [], indices: number[] = [];
    for (let j = 0; j <= 10; j++) for (let i = 0; i <= 16; i++) {
      const u = i / 16, v = j / 10, edge = Math.pow(Math.abs(v - .5) * 2, 5);
      positions.push((u - .5) * w, .07 * Math.sin(u * 15 + v * 4) + .035 * Math.cos(v * 22) - edge * .14, (v - .5) * d); uv.push(u, v);
      if (i < 16 && j < 10) { const k = j * 17 + i; indices.push(k, k + 17, k + 1, k + 1, k + 17, k + 18); }
    }
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3)); geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2)); geometry.setIndex(indices); geometry.computeVertexNormals(); part(geometry, accent, x, h, z);
    for (let i = 0; i < 5; i++) box('ivory', x - w / 2 + .2 + i * .3, h + .06, z, .018, .015, d - .03, 0);
  }
  function plant(x: number, z: number, scale = 1) {
    cylinder('ivory', x, .38 * scale, z, .34 * scale, .65 * scale);
    cylinder('soil', x, .72 * scale, z, .29 * scale, .04);
    for (let i = 0; i < 7; i++) { const a = i * 2.4; ball(i % 3 ? 'leaf' : 'sage', x + Math.cos(a) * .24 * scale, (1 + i * .10) * scale, z + Math.sin(a) * .24 * scale, .22 * scale, .42 * scale, .15 * scale); }
  }
  function legs(x: number, z: number, w: number, d: number, height: number, material: Surface = 'wood') {
    for (const dx of [-1, 1]) for (const dz of [-1, 1]) box(material, x + dx * Math.max(.15, w / 2 - .22), height / 2, z + dz * Math.max(.15, d / 2 - .22), .13, height, .13);
  }
  function books(x: number, h: number, z: number) {
    for (let i = 0; i < 3; i++) box((['sage', 'rose', 'linen'] as const)[i]!, x + i * .19, h, z, .13, .53 - i * .05, .42);
  }
  function furniture(object: Furniture) {
    verticalScale = object.kind === 'tree' ? 1 : .5;
    const x = object.position.x + (object.width - 1) / 2, z = object.position.y + (object.depth - 1) / 2, w = object.width, d = object.depth;
    switch (object.kind) {
      case 'desk':
        box('oak', x, 1.72, z, w, .2, d); legs(x, z, w - .15, d - .15, 1.65);
        box('wood', x + w / 2 - .6, .85, z, .94, 1.6, d * .86);
        for (let i = 0; i < 3; i++) { box('oak', x + w / 2 - .6, .48 + i * .46, z + d * .44, .8, .39, .06); box('darkWood', x + w / 2 - .6, .48 + i * .46, z + d * .48, .24, .045, .04); }
        books(x - w / 2 + .35, 2.07, z - .45); cylinder('ivory', x - .9, 1.98, z + .33, .16, .28);
        part(new TorusGeometry(.12, .035, 6, 14), 'ivory', x - .7, 1.98, z + .33);
        lamp(x - w / 2 + .7, 1.87, z + .3, .85);
        box('ivory', x - .55, 1.85, z + .65, .65, .035, .4); box(accent, x - .45, 1.89, z + .65, .025, .015, .32, 0);
        break;
      case 'computer':
        box('metal', x, 2.42, z, 1.55, 1.02, .11); box('screen', x, 2.44, z + .065, 1.37, .84, .025);
        box('metal', x, 1.98, z, .11, .48, .1); box('metal', x, 1.85, z + .12, .75, .06, .48);
        box('linen', x, 1.87, z + .75, 1.1, .05, .38); ball('ivory', x + .77, 1.89, z + .76, .1, .07, .16);
        for (let row = 0; row < 3; row++) for (let key = 0; key < 10; key++) box('metal', x - .46 + key * .1, 1.9, z + .63 + row * .09, .07, .012, .06, 0);
        box('ivory', x - .2, 2.62, z + .086, .7, .055, .014, 0); box('blue', x - .2, 2.37, z + .088, .7, .32, .016); box('ivory', x + .45, 2.37, z + .09, .22, .26, .014);
        break;
      case 'chair':
        cylinder('metal', x, .54, z, .09, .9); box('blue', x, 1.04, z, 1.0, .22, .95);
        box(accent, x, 1.61, z + .45, 1.02, 1.15, .18, .16); box('metal', x, .13, z, 1.0, .08, .13); box('metal', x, .13, z, .13, .08, 1.0);
        for (const side of [-1, 1]) { box('metal', x + side * .43, 1.1, z, .06, .52, .06); box('metal', x + side * .43, 1.38, z, .1, .08, .65); ball('metal', x + side * .45, .11, z + .05, .11, .16, .11); }
        break;
      case 'bed':
        box('wood', x, .38, z, w, .65, d); box('ivory', x, .81, z, w - .12, .42, d - .1);
        quilt(x + .35, 1.14, z, w - .75, d + .03); ball('linen', x - w / 2 + .49, 1.12, z, .37, .22, d * .4);
        box('wood', x - w / 2, .9, z, .13, 1.52, d + .1);
        lamp(x - w / 2 + .15, 1.72, z - d / 2 + .2, .55); break;
      case 'kitchen':
        box('sage', x, .86, z, w, 1.7, d); box('ivory', x, 1.77, z, w + .1, .15, d + .08);
        for (let i = 0; i < 3; i++) { box('sage', x - w / 2 + (i + .5) * w / 3, .87, z + d / 2 + .035, w / 3 - .06, 1.45, .05); box('metal', x - w / 2 + (i + .5) * w / 3, 1.27, z + d / 2 + .08, .25, .035, .035); }
        box('metal', x - .75, 1.86, z, .75, .035, .75); cylinder('metal', x - .75, 2.02, z, .24, .25);
        box('metal', x + .68, 1.85, z, .78, .03, .62); box('glass', x + .68, 1.87, z, .6, .035, .45);
        pipe('metal', [[0, 0, 0], [0, .48, 0], [0, .54, .23], [0, .42, .33]], .045, x + .68, 1.86, z - .35);
        box('ivory', x, 2.55, z - d / 2 + .09, w, 1.6, .08);
        for (const side of [-1, 1]) { box('sage', x + side * .73, 3.5, z - d / 2 + .3, 1.4, .85, .55); box('metal', x + side * .73, 3.4, z - d / 2 + .6, .2, .035, .04); }
        cylinder('ivory', x + .15, 2.04, z + .5, .11, .35); cylinder('wood', x + .15, 2.3, z + .5, .03, .5);
        box('wood', x - .65, 1.87, z + .6, .75, .045, .4); ball('rose', x - .62, 1.98, z + .6, .12, .16, .1);
        break;
      case 'dining':
        box('oak', x, 1.45, z, w, .18, d); legs(x, z, w, d, 1.38);
        box('linen', x, 1.56, z, .6, .04, d - .15); cylinder('ivory', x, 1.6, z, .3, .05);
        for (const offset of [-.7, .7]) { box('wood', x + offset, .75, z + d / 2 + .55, .7, .13, .65); legs(x + offset, z + d / 2 + .55, .68, .63, .7); box('wood', x + offset, 1.16, z + d / 2 + .85, .7, .84, .09); }
        plant(x - w / 2 + .35, z - d / 2 + .1, .36); break;
      case 'sofa':
        box('sage', x, .48, z, w, .72, d); box('sage', x - w / 2 + .15, 1.08, z, .42, 1.6, d);
        for (let i = -1; i <= 1; i++) ball('linen', x + .14, .99, z + i * (d - .6) / 3, (w - .45) / 2, .22, (d - .35) / 6);
        box('sage', x, 1.0, z - d / 2 + .12, w, .92, .3); box('sage', x, 1.0, z + d / 2 - .12, w, .92, .3);
        ball('rose', x + .24, 1.26, z - .64, .35, .36, .32); break;
      case 'habit':
        box('blue', x, .035, z, w, .04, d); box('ivory', x - w / 2 + .3, .09, z, .08, .07, d - .2); cylinder('sage', x + w / 2 - .35, .22, z, .16, .37); break;
      case 'tree':
        cylinder('wood', x, 1.5, z, .22, 3); for (let i = 0; i < 7; i++) { const a = i * 2.4; ball(i % 3 ? 'leaf' : 'sage', x + Math.cos(a) * .65, 3.5 + Math.sin(i * 1.6) * .55, z + Math.sin(a) * .65, .95, 1.15, .9); } break;
      case 'bench':
        for (let i = 0; i < 3; i++) box('wood', x, .95, z - .3 + i * .3, w, .13, .23);
        legs(x, z, w - .2, d, .9, 'metal'); box('wood', x, 1.53, z - .5, w, .8, .14);
        cylinder('metal', x - w / 2 + .25, 2.2, z - .3, .05, 4.4); ball('light', x - w / 2 + .25, 4.5, z - .3, .22, .4, .22);
        box('metal', x - w / 2 + .25, 4.95, z - .3, .6, .1, .6); break;
      case 'door':
        if (scene.kind === 'home') { box('wood', x, .04, z, 1.65, .07, 1.3); box('linen', x, .09, z - .05, 1.24, .03, .8); }
        break;
    }
    verticalScale = 1;
  }
  if (scene.kind === 'home') {
    const cx = (scene.width - 1) / 2, cz = (scene.depth - 1) / 2;
    box('plaster', cx, -.42, cz, scene.width + 1, .8, scene.depth + 1, .08);
    box('oak', cx, -.04, cz, scene.width, .12, scene.depth);
    for (let i = 1; i < scene.depth; i++) box('wood', cx, .025, i - .5, scene.width - .1, .008, .018, 0);
    for (let j = 0; j < scene.depth; j++) for (let i = 1; i < scene.width / 3; i++) box('wood', i * 3 + j % 2 * 1.5 - .5, .03, j, .014, .009, .92, 0);
    box('plaster', cx, 1.65, -.7, scene.width + .4, 3.3, .3);
    box('plaster', -.7, 1.65, cz, .3, 3.3, scene.depth + .4);
    box('ivory', cx, .18, -.5, scene.width, .3, .11); box('ivory', -.5, .18, cz, .11, .3, scene.depth);
    // Rugs and wall art are decorative; every solid footprint above comes from snapshot.objects.
    box('linen', 3.8, .04, 7.8, 5.4, .035, 5.2); box('rose', 14.9, .045, 3.4, 4.5, .035, 3.6);
    box('tile', 15.8, .045, 11.5, 5.0, .035, 4.2);
    cylinder('linen', 9.1, .045, 8.1, 2.0, .025);
    for (const radius of [1.7, 1.85]) { const border = new TorusGeometry(radius, .012, 4, 64); border.rotateX(-Math.PI / 2); part(border, accent, 9.1, .065, 8.1); }
    box('wood', 9.5, 2.15, -.48, 2.7, 1.25, .08); box('glass', 9.5, 2.17, -.42, 2.5, 1.1, .03);
    box('ivory', 9.5, 2.15, -.38, .055, 1.15, .055); box('ivory', 9.5, 2.15, -.38, 2.5, .055, .055);
    for (const side of [-1, 1]) for (let fold = 0; fold < 5; fold++) {
      cylinder(accent, 9.5 + side * (1.38 + fold * .1), 2.1, -.36 + Math.sin(fold) * .035, .075, 1.65);
    }
    box('darkWood', 9.5, 2.99, -.37, 4.0, .045, .06);
    for (const height of [2.2, 2.95]) { box('oak', 3.7, height, -.35, 4.7, .12, .45); books(1.7, height + .32, -.33); books(3.6, height + .32, -.33); }
    const pictureCanvas = document.createElement('canvas'); pictureCanvas.width = 320; pictureCanvas.height = 240;
    const picture = pictureCanvas.getContext('2d');
    if (picture) {
      picture.fillStyle = '#f6f0dd'; picture.fillRect(0, 0, 320, 240);
      const subject = scene.ownerId === 'deepseek-sister' ? '海与安静的日子' : scene.ownerId === 'deepseek-flash' ? '音乐与小发现' : CATALOGUE_COMPANION_PROFILES.find(profile => profile.id === scene.ownerId)?.preferences[0]?.subject ?? '小小的日常';
      if (scene.ownerId === 'deepseek-sister') {
        picture.fillStyle = '#aed5d7'; picture.fillRect(18, 18, 284, 145); picture.fillStyle = '#7aabb8'; picture.beginPath(); picture.moveTo(18, 104); for (let x = 18; x <= 302; x++) picture.lineTo(x, 106 + Math.sin(x / 28) * 10); picture.lineTo(302, 163); picture.lineTo(18, 163); picture.fill(); picture.fillStyle = '#f4d39c'; picture.beginPath(); picture.arc(242, 54, 20, 0, Math.PI * 2); picture.fill();
      } else if (['deepseek-flash', 'phrolova', 'minimax'].includes(scene.ownerId ?? '')) {
        picture.strokeStyle = COLORS[accent]; picture.lineWidth = 10; picture.beginPath(); picture.moveTo(123, 130); picture.lineTo(123, 55); picture.lineTo(206, 37); picture.lineTo(206, 112); picture.stroke(); picture.fillStyle = COLORS[accent]; for (const [x, y] of [[108, 132], [191, 114]]) { picture.beginPath(); picture.ellipse(x!, y!, 22, 14, -.3, 0, Math.PI * 2); picture.fill(); }
      } else {
        for (let i = 0; i < 4; i++) { picture.fillStyle = [COLORS[accent], '#d7c6a7', '#b1c7b4', '#e3c1ae'][i]!; picture.beginPath(); picture.arc(90 + i * 43, 90 + Math.sin(i * 2) * 24, 28 - i * 3, 0, Math.PI * 2); picture.fill(); }
      }
      picture.fillStyle = '#6c786d'; picture.font = '19px sans-serif'; picture.textAlign = 'center'; picture.fillText(subject, 160, 209);
    }
    const pictureTexture = new CanvasTexture(pictureCanvas); pictureTexture.colorSpace = SRGBColorSpace;
    const pictureMaterial = new MeshStandardMaterial({ map: pictureTexture, roughness: .9 }); const pictureGeometry = new PlaneGeometry(2.7, 2.0);
    const pictureMesh = new Mesh(pictureGeometry, pictureMaterial); pictureMesh.position.set(13.1, 2.1, -.455); group.add(pictureMesh);
    resources.geometry.push(pictureGeometry); resources.materials.push(pictureMaterial); resources.textures.push(pictureTexture);
    box('wood', 13.1, 2.1, -.52, 2.88, 2.18, .08);
    plant(.1, 13.8, 1.15); plant(18.7, .1, .95);
    box('wood', -.35, 1.5, 5.7, .12, 1.25, 1.0); box('ivory', -.26, 1.5, 5.7, .05, 1.08, .83);
    box('rose', -.22, 1.57, 5.7, .035, .35, .42);
  } else {
    box('grass', scene.width / 2, -.3, scene.depth / 2, scene.width + 5, .5, scene.depth + 5);
    for (let x = 26; x < scene.width; x += 24) { box('linen', x, -.012, scene.depth / 2, 4.35, .05, scene.depth); box('path', x, .005, scene.depth / 2, 4, .05, scene.depth); }
    for (let z = 23; z < scene.depth; z += 22) { box('linen', scene.width / 2, -.01, z, scene.width, .055, 4.35); box('path', scene.width / 2, .012, z, scene.width, .06, 4); }
    // The reserved park is described by actual trees/benches; paving is walkable decoration.
    const parkObjects = scene.objects.filter(object => object.kind === 'tree' || object.kind === 'bench');
    if (parkObjects.length) {
      const minX = Math.min(...parkObjects.map(object => object.position.x)) - 3, maxX = Math.max(...parkObjects.map(object => object.position.x + object.width)) + 3, minZ = Math.min(...parkObjects.map(object => object.position.y)) - 3, maxZ = Math.max(...parkObjects.map(object => object.position.y + object.depth)) + 3;
      box('tile', (minX + maxX) / 2, .023, (minZ + maxZ) / 2, maxX - minX, .04, maxZ - minZ, .15);
      part(new CylinderGeometry(1, 1, .03, 48), 'path', (minX + maxX) / 2, .047, (minZ + maxZ) / 2, (maxX - minX) / 2 - 1, 1, (maxZ - minZ) / 2 - 1);
    }
    for (const [index, home] of neighborhood.filter(item => item.kind === 'home').entries()) {
      const x = home.origin.x + home.width / 2 - .5, z = home.origin.y + home.depth / 2 - .5;
      const facade = (['plaster', 'ivory', 'linen'] as const)[index % 3]!, roofColor = (['sage', 'blue', 'rose'] as const)[index % 3]!;
      box(facade, x, 1.8, z, home.width, 3.6, home.depth);
      const profile = new Shape(); profile.moveTo(-home.depth / 2 - .35, 0); profile.lineTo(0, 3.2); profile.lineTo(home.depth / 2 + .35, 0); profile.closePath();
      const roof = new ExtrudeGeometry(profile, { depth: home.width + .7, bevelEnabled: false }); roof.rotateY(Math.PI / 2); roof.translate(-(home.width + .7) / 2, 0, 0);
      part(roof, roofColor, x, 3.62, z);
      box('plaster', x - home.width / 2 + 3, 5.0, z - 2.2, 1.2, 3.2, 1.2); box('ivory', x - home.width / 2 + 3, 6.6, z - 2.2, 1.4, .2, 1.4);
      box('wood', home.origin.x + home.door.x, 1.1, home.origin.y + home.depth - .4, 1.7, 2.2, .12);
      box('path', home.origin.x + home.door.x, .035, home.origin.y + home.depth + 1, 1.7, .035, 2.4);
      box('metal', home.origin.x + home.door.x + 1.7, 2.4, home.origin.y + home.depth - .36, .4, .65, .25); ball('light', home.origin.x + home.door.x + 1.7, 2.4, home.origin.y + home.depth - .2, .12, .22, .08);
      cylinder('ivory', home.origin.x + home.door.x + .5, 1.1, home.origin.y + home.depth - .3, .06, .1);
      for (const dx of [-5.5, 5.5]) { box('wood', x + dx, 2.0, home.origin.y + home.depth - .4, 2.9, 1.7, .12); box('glass', x + dx, 2.0, home.origin.y + home.depth - .3, 2.6, 1.4, .08); box('ivory', x + dx, 2.0, home.origin.y + home.depth - .24, .1, 1.4, .08); box('ivory', x + dx, 2.0, home.origin.y + home.depth - .24, 2.6, .08, .08); }
      plant(home.origin.x + 1, home.origin.y + home.depth + .6, 1.1);
    }
  }
  scene.objects.forEach(furniture);
  for (const [surface, geometries] of buckets) {
    const geometry = mergeGeometries(geometries, false); geometries.forEach(item => item.dispose());
    if (!geometry) continue;
    const material = new MeshStandardMaterial({ color: new Color(COLORS[surface]), roughness: surface === 'glass' ? .2 : .84, metalness: surface === 'metal' ? .3 : 0, ...(surface === 'screen' ? { emissive: '#77aaa8', emissiveIntensity: .3 } : surface === 'light' ? { emissive: '#ffcf87', emissiveIntensity: .8 } : {}) });
    material.userData.surface = surface;
    const mesh = new Mesh(geometry, material); mesh.castShadow = surface !== 'glass'; mesh.receiveShadow = true;
    group.add(mesh); resources.geometry.push(geometry); resources.materials.push(material);
  }
  // A faint contact disc grounds the diorama without a costly postprocessing pass.
  if (scene.kind === 'home') {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    if (context) { const gradient = context.createRadialGradient(32, 32, 4, 32, 32, 32); gradient.addColorStop(0, 'rgba(78,66,53,.16)'); gradient.addColorStop(1, 'rgba(78,66,53,0)'); context.fillStyle = gradient; context.fillRect(0, 0, 64, 64); }
    const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace;
    const material = new MeshStandardMaterial({ map: texture, transparent: true, depthWrite: false, roughness: 1 });
    const geometry = new PlaneGeometry(scene.width * 1.4, scene.depth * 1.4); geometry.rotateX(-Math.PI / 2);
    const shadow = new Mesh(geometry, material); shadow.position.set((scene.width - 1) / 2, -.86, (scene.depth - 1) / 2); group.add(shadow);
    resources.geometry.push(geometry); resources.materials.push(material); resources.textures.push(texture);
  }
  group.traverse(object => { object.updateMatrix(); object.matrixAutoUpdate = false; });
  let previousNight: boolean | undefined;
  return { group, setNight(night: boolean) { if (previousNight === night) return; previousNight = night; resources.materials.forEach(material => { if (material instanceof MeshStandardMaterial && material.userData.surface === 'light') material.emissiveIntensity = night ? 1.4 : .18; }); }, dispose() { resources.geometry.forEach(item => item.dispose()); resources.materials.forEach(item => item.dispose()); resources.textures.forEach(item => item.dispose()); group.clear(); } };
}
