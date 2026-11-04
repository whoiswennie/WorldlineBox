import { AmbientLight, CanvasTexture, Color, DirectionalLight, Group, HemisphereLight, LinearFilter, Mesh, MeshBasicMaterial, OrthographicCamera,
  PCFSoftShadowMap, Plane, PlaneGeometry, Raycaster, Scene, Sprite, SpriteMaterial, SRGBColorSpace, TextureLoader, Vector2, Vector3, WebGLRenderer, type Texture } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createWorldRoomModel } from '../companions/world/world-room-model';
import { createWorldParkModel } from '../companions/world/world-park-model';
import { worldCharacterArt, type WorldArtAction, type WorldArtSheet, type WorldCharacterArt } from '../../shared/companion-world-art';
import { getCompanionWorldFramePlacement } from '../../shared/companion-world-art-calibration';
import { advanceWorldActor } from '../../shared/world-physics';
import type { BotWorldActor, BotWorldScene, BotWorldSnapshot } from '../../shared/companion-bot-world';
import { DEFAULT_BOT_COMPANION_ID } from '../../shared/builtin-bot-companions';

type Model = ReturnType<typeof createWorldRoomModel> | ReturnType<typeof createWorldParkModel>;
type ActorView = { actor: BotWorldActor; group: Group; sprite: Sprite; label: Sprite; shadow: Mesh; texture?: Texture; key?: string; epoch: number;
  art?: WorldCharacterArt; sheet?: WorldArtSheet; pose: 'ground' | 'seat' | 'bed' };
const actionFor: Record<BotWorldActor['activity'], WorldArtAction> = { idle: 'idle', walking: 'walk', sitting: 'sit', sleeping: 'sleep', resting: 'rest', working: 'work', eating: 'eat', reading: 'read' };
const avatarFor = (actor: BotWorldActor) => actor.companionId === DEFAULT_BOT_COMPANION_ID ? 'sister' : actor.companionId;
export interface BotWorldViewport {
  update(snapshot: BotWorldSnapshot, scene: BotWorldScene): void; setActive(value: boolean): void; dispose(): void;
}

/** One bounded renderer consumes physical snapshots; it owns no conversation, memory or world authority. */
export function createBotWorldViewport(container: HTMLElement, onFailure: (message: string) => void, onMove: (x: number, y: number) => void): BotWorldViewport {
  const renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; renderer.domElement.setAttribute('role', 'img'); renderer.domElement.setAttribute('aria-label', '伙伴世界三维场景');
  container.appendChild(renderer.domElement);
  const scene = new Scene(); scene.background = new Color('#dce5e3');
  const camera = new OrthographicCamera(-15, 15, 12, -12, .1, 300);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * .47;
  controls.minDistance = 5; controls.maxDistance = 120; controls.minZoom = .4; controls.maxZoom = 3;
  const sun = new DirectionalLight('#fff0da', 2.7); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
  scene.add(new AmbientLight('#e9efff', .6), new HemisphereLight('#fff4e2', '#7a8d78', 1.7), sun, sun.target);
  const actors = new Map<string, ActorView>(), loader = new TextureLoader(), textures = new Map<string, Promise<Texture>>();
  let model: Model | undefined, selected: BotWorldScene | undefined, latest: BotWorldSnapshot | undefined, receivedAt = 0;
  let disposed = false, active = true, frame: number | undefined, lastDraw = -Infinity;
  const draw = (time: number) => {
    if (disposed || !active || document.hidden) { frame = undefined; return; }
    frame = requestAnimationFrame(draw); if (time - lastDraw < 1000 / 30 || !selected) return; lastDraw = time;
    controls.update(); if (model && 'animate' in model) model.animate(time);
    for (const view of actors.values()) {
      const actor = view.actor.activity === 'walking' ? advanceWorldActor(view.actor, Math.min(1000, Math.max(0, time - receivedAt))).actor : view.actor;
      view.group.position.set(actor.position.x, 0, actor.position.y);
      if (view.texture && view.art && view.sheet) {
        const index = Math.floor(time / (view.sheet.durationMs / 3)) % 3;
        const { source, sourceImage, anchor, scale, pose } = getCompanionWorldFramePlacement(view.art, view.sheet, index);
        const mirrored = actor.facing === 'west'; view.pose = pose;
        view.sprite.scale.set(source.width * scale, source.height * scale, 1);
        view.sprite.center.set(mirrored ? 1 - anchor.x / source.width : anchor.x / source.width, 1 - anchor.y / source.height);
        view.texture.repeat.set((mirrored ? -1 : 1) * (source.width - 1) / sourceImage.width, (source.height - 1) / sourceImage.height);
        view.texture.offset.set((source.x + (mirrored ? source.width - .5 : .5)) / sourceImage.width, 1 - (source.y + source.height - .5) / sourceImage.height);
      }
      view.sprite.position.y = view.pose === 'bed' ? .56 : view.pose === 'seat' ? .57 : .04; view.shadow.visible = view.pose !== 'bed';
    }
    try {
      renderer.render(scene, camera); renderer.domElement.dataset.worldReady = 'true';
      Object.assign(renderer.domElement.dataset, { worldDrawCalls: String(renderer.info.render.calls), worldTriangles: String(renderer.info.render.triangles), worldActors: String(actors.size), worldRevision: String(latest?.revision ?? 0) });
    } catch (error) { onFailure(error instanceof Error ? error.message : '3D渲染失败'); }
  };
  const resume = () => { if (!disposed && active && !document.hidden && frame === undefined) frame = requestAnimationFrame(draw); };
  const pause = () => { if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined; };
  const resize = () => {
    if (disposed) return; const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height); const vertical = selected ? Math.max(selected.width, selected.depth) * .52 : 15, aspect = width / height;
    camera.left = -vertical * aspect; camera.right = vertical * aspect; camera.top = vertical; camera.bottom = -vertical; camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize); observer.observe(container);
  const visibility = () => { if (document.hidden) pause(); else resume(); }; document.addEventListener('visibilitychange', visibility);
  const contextLost = (event: Event) => { event.preventDefault(); pause(); onFailure('3D图形上下文已中断。'); };
  renderer.domElement.addEventListener('webglcontextlost', contextLost);
  const pointer = (event: MouseEvent) => {
    if (!selected) return; const bounds = renderer.domElement.getBoundingClientRect();
    const ray = new Raycaster(); ray.setFromCamera(new Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1), camera);
    const point = ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), new Vector3()); if (!point) return;
    const x = Math.round(point.x), y = Math.round(point.z); if (x >= 0 && y >= 0 && x < selected.width && y < selected.depth) onMove(x, y);
  };
  renderer.domElement.addEventListener('dblclick', pointer);
  function removeActor(view: ActorView) {
    view.epoch++; scene.remove(view.group); view.texture?.dispose(); view.sprite.material.dispose(); view.label.material.map?.dispose(); view.label.material.dispose();
    view.shadow.geometry.dispose(); (view.shadow.material as MeshBasicMaterial).dispose(); view.group.clear();
  }
  function canvasTexture(name: string, label = false): CanvasTexture {
    const canvas = document.createElement('canvas'); canvas.width = label ? 384 : 128; canvas.height = label ? 96 : 128; const context = canvas.getContext('2d');
    if (context) {
      if (!label) { context.fillStyle = '#6a90a4'; context.beginPath(); context.arc(64, 64, 54, 0, Math.PI * 2); context.fill(); }
      context.font = label ? '500 36px sans-serif' : '54px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
      context.lineWidth = 5; context.strokeStyle = label ? '#fffaf2' : '#6a90a4'; context.fillStyle = label ? '#263c47' : '#fffaf2';
      const value = label ? name.slice(0, 20) : name.slice(0, 1); context.strokeText(value, canvas.width / 2, canvas.height / 2); context.fillText(value, canvas.width / 2, canvas.height / 2);
    }
    const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace; return texture;
  }
  function configureSprite(view: ActorView) {
    const art = worldCharacterArt(avatarFor(view.actor)), sheet = art?.actions[actionFor[view.actor.activity]];
    const key = sheet?.url ?? `custom:${view.actor.name}`; if (view.key === key) return;
    view.key = key; view.art = undefined; view.sheet = undefined; view.pose = 'ground'; view.texture?.dispose(); view.texture = undefined; const epoch = ++view.epoch;
    view.sprite.scale.set(1.8, 1.8, 1); view.sprite.center.set(.5, 0);
    const placeholder = canvasTexture(view.actor.name); view.texture = placeholder; view.sprite.material.map = placeholder; view.sprite.material.needsUpdate = true;
    if (!sheet) return;
    let loading = textures.get(sheet.url);
    if (!loading) { loading = loader.loadAsync(new URL(sheet.url, document.baseURI).href).then(texture => {
      texture.colorSpace = SRGBColorSpace; texture.minFilter = texture.magFilter = LinearFilter; texture.generateMipmaps = false; if (disposed) texture.dispose(); return texture;
    }); textures.set(sheet.url, loading);
      if (textures.size > 64) { const oldest = textures.keys().next().value!; const removed = textures.get(oldest)!; textures.delete(oldest); void removed.then(texture => texture.dispose(), () => undefined); }
    }
    void loading.then(texture => {
      if (disposed || view.epoch !== epoch) return;
      view.texture?.dispose(); view.texture = texture.clone(); view.art = art; view.sheet = sheet; view.sprite.material.map = view.texture; view.sprite.material.needsUpdate = true;
    }).catch(() => { if (!disposed && view.epoch === epoch) { view.art = undefined; view.sheet = undefined; } });
  }
  return {
    update(snapshot, nextScene) {
      if (disposed) return;
      latest = snapshot; receivedAt = performance.now();
      if (selected?.id !== nextScene.id) {
        if (model) { scene.remove(model.group); model.dispose(); }
        actors.forEach(removeActor); actors.clear(); selected = nextScene;
        model = nextScene.kind === 'park' ? createWorldParkModel(nextScene) : createWorldRoomModel(nextScene); scene.add(model.group);
        const size = Math.max(nextScene.width, nextScene.depth), center = new Vector3((nextScene.width - 1) / 2, 0, (nextScene.depth - 1) / 2);
        controls.target.copy(center); camera.position.copy(center).add(new Vector3(size * .65, size * .75, size * .8)); controls.update();
        sun.position.copy(center).add(new Vector3(-15, 30, 15)); sun.target.position.copy(center);
        sun.shadow.camera.left = sun.shadow.camera.bottom = -size; sun.shadow.camera.right = sun.shadow.camera.top = size; sun.shadow.camera.updateProjectionMatrix();
        renderer.domElement.dataset.worldScene = nextScene.id; renderer.domElement.dataset.worldView = nextScene.kind; resize();
      }
      selected = nextScene; model?.setNight(new Date(snapshot.observedAt).getHours() < 6 || new Date(snapshot.observedAt).getHours() >= 18);
      const visible = snapshot.actors.filter(actor => actor.sceneId === nextScene.id);
      for (const [id, view] of actors) if (!visible.some(actor => actor.companionId === id)) { removeActor(view); actors.delete(id); }
      for (const actor of visible) {
        let view = actors.get(actor.companionId);
        if (!view) {
          const sprite = new Sprite(new SpriteMaterial({ transparent: true, depthWrite: false, alphaTest: .015 }));
          const label = new Sprite(new SpriteMaterial({ map: canvasTexture(actor.name, true), transparent: true, depthWrite: false })); label.position.y = 2.6; label.scale.set(3, .75, 1);
          const shadow = new Mesh(new PlaneGeometry(1.2, .7), new MeshBasicMaterial({ color: '#44584b', transparent: true, opacity: .18, depthWrite: false })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = .03;
          const group = new Group(); group.add(sprite, label, shadow); scene.add(group); view = { actor, group, sprite, label, shadow, epoch: 0, pose: 'ground' }; actors.set(actor.companionId, view);
        }
        if (view.actor.name !== actor.name) { view.label.material.map?.dispose(); view.label.material.map = canvasTexture(actor.name, true); view.label.material.needsUpdate = true; }
        view.actor = actor; configureSprite(view);
      }
      renderer.domElement.dataset.worldArt = visible.map(actor => `${actor.companionId}:${avatarFor(actor)}`).join(',');
      renderer.shadowMap.needsUpdate = true; resume();
    },
    setActive(value) { active = value; if (value) resume(); else pause(); },
    dispose() {
      if (disposed) return; disposed = true; pause(); observer.disconnect(); controls.dispose(); document.removeEventListener('visibilitychange', visibility);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost); renderer.domElement.removeEventListener('dblclick', pointer);
      actors.forEach(removeActor); actors.clear(); for (const texture of textures.values()) void texture.then(value => value.dispose(), () => undefined); textures.clear();
      model?.dispose(); sun.shadow.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); scene.clear();
    },
  };
}
