import { AmbientLight, BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, Group, HemisphereLight, LinearFilter, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, OrthographicCamera, PCFSoftShadowMap, PlaneGeometry, PointLight, Points, PointsMaterial, Scene, Sprite, SpriteMaterial, SRGBColorSpace, TextureLoader, Vector3, WebGLRenderer, type Texture } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Companion } from '../../../shared/companions';
import type { CompanionWorldActor, CompanionWorldScene, CompanionWorldSnapshot } from '../../../shared/companion-world';
import { worldCharacterArt, type WorldArtAction } from '../../../shared/companion-world-art';
import { companionPortrait } from '../CompanionVisuals';
import { createWorldRoomModel } from './world-room-model';
import { interpolateWorldPath, worldActorAnimationFrame, worldArtAction, worldAssetUrl, worldFacingMirrored, worldInterpolationPath, worldPrecipitationHeight } from './world-presentation';
import { worldCameraViewSchema, type WorldCameraView } from './world-observer-preferences';

interface ActorView { group: Group; sprite: Sprite; shadow: Mesh; actor: CompanionWorldActor; path: Array<{ x: number; y: number }>; changedAt: number; texture?: Texture; textureKey?: string; action?: WorldArtAction; animation?: { duration: number; playback: 'loop' | 'transition' }; applyFrame?: (frame: 0 | 1 | 2) => void; pose?: 'ground' | 'seat' | 'bed'; missingAction?: boolean; epoch: number }
export interface WorldViewportEngine {
  update(snapshot: CompanionWorldSnapshot, scene: CompanionWorldScene, companions: Companion[]): void;
  setActive(active: boolean): void;
  reset(): void;
  zoom(amount: number): void;
  rotate(amount: number): void;
  focus(companionId: string): void;
  getView(): WorldCameraView | undefined;
  restoreView(view: WorldCameraView, followId?: string): void;
  dispose(): void;
}

/** Imperative, bounded renderer. React never receives an animation-frame state update. */
export function createWorldViewport(container: HTMLElement, onFailure: (message: string) => void, onFollowChange?: (id: string | undefined) => void, onViewChange?: () => void): WorldViewportEngine {
  const renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.domElement.setAttribute('aria-label', '伙伴世界三维场景');
  renderer.domElement.setAttribute('role', 'img');
  container.appendChild(renderer.domElement);
  const scene = new Scene(); scene.background = new Color('#d9e1dc');
  const camera = new OrthographicCamera(-16, 16, 13, -13, .1, 600);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = .14; controls.minZoom = .45; controls.maxZoom = 4;
  controls.minPolarAngle = .22; controls.maxPolarAngle = Math.PI / 2 - .08; controls.screenSpacePanning = true;
  const sun = new DirectionalLight('#fff3db', 3); sun.position.set(8, 25, 12); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = -22; sun.shadow.camera.right = 22; sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22; sun.shadow.normalBias = .035; sun.shadow.bias = -.0001;
  const hemisphere = new HemisphereLight('#e6f2ff', '#c1aa8a', 2);
  const ambient = new AmbientLight('#ffdfac', .35); scene.add(sun, sun.target, hemisphere, ambient);
  const practicalLights = new Group(); scene.add(practicalLights);
  const actors = new Map<string, ActorView>();
  const textureCache = new Map<string, Texture>();
  const pendingTextures = new Map<string, Promise<Texture>>();
  const loader = new TextureLoader();
  let room: ReturnType<typeof createWorldRoomModel> | undefined, roomId: string | undefined, latest: CompanionWorldSnapshot | undefined;
  let currentScene: CompanionWorldScene | undefined, contacts: Companion[] = [], disposed = false, active = true, raf: number | undefined, lastFrame = 0, resourceEpoch = 0, following: string | undefined;
  let weather: Points | LineSegments | undefined, weatherGeometry: BufferGeometry | undefined, weatherMaterial: PointsMaterial | LineBasicMaterial | undefined;
  let precipitation: 'rain' | 'snow' | undefined;
  const labelElements = new Map<string, HTMLDivElement>();
  let measureStarted = performance.now(), measuredFrames = 0, totalFrames = 0;
  const drawTimes: number[] = [];
  const project = new Vector3();
  function resize() {
    const { width, height } = container.getBoundingClientRect(); if (width < 1 || height < 1) return;
    const aspect = width / height; camera.left = -13 * aspect; camera.right = 13 * aspect; camera.top = 13; camera.bottom = -13; camera.updateProjectionMatrix();
    renderer.setSize(width, height); renderer.shadowMap.needsUpdate = true;
  }
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  function getView(): WorldCameraView | undefined {
    if (!currentScene || disposed) return;
    const view = { position: { x: camera.position.x, y: camera.position.y, z: camera.position.z }, target: { x: controls.target.x, y: controls.target.y, z: controls.target.z }, zoom: camera.zoom };
    renderer.domElement.dataset.worldCamera = JSON.stringify(view);
    return view;
  }
  function restoreView(value: WorldCameraView, followId?: string) {
    const parsed = worldCameraViewSchema.safeParse(value);
    if (!parsed.success || !currentScene || disposed) return;
    const view = parsed.data;
    following = followId && actors.has(followId) ? followId : undefined;
    camera.position.set(view.position.x, view.position.y, view.position.z); controls.target.set(view.target.x, view.target.y, view.target.z);
    camera.zoom = Math.max(controls.minZoom, Math.min(controls.maxZoom, view.zoom)); camera.updateProjectionMatrix();
    const damping = controls.enableDamping; controls.enableDamping = false; controls.update(); controls.enableDamping = damping; getView();
  }
  function reset() {
    following = undefined;
    if (!currentScene) return;
    const size = Math.max(currentScene.width, currentScene.depth), cx = (currentScene.width - 1) / 2, cz = (currentScene.depth - 1) / 2;
    controls.target.set(cx, 0, cz); camera.position.set(cx + size * .84, size * 1.05, cz + size * 1.08);
    camera.zoom = currentScene.kind === 'home' ? .94 : Math.max(.13, 23 / size); controls.minZoom = currentScene.kind === 'home' ? .45 : .1;
    camera.updateProjectionMatrix(); controls.update();
  }
  function focusActor(id: string) { const actor = actors.get(id); if (!actor) return; following = id; onFollowChange?.(id); const offset = camera.position.clone().sub(controls.target); controls.target.set(actor.actor.position.x, 0, actor.actor.position.y); camera.position.copy(controls.target).add(offset); camera.zoom = Math.max(camera.zoom, 2.1); camera.updateProjectionMatrix(); controls.update(); onViewChange?.(); }
  controls.addEventListener('start', () => { following = undefined; onFollowChange?.(undefined); });
  controls.addEventListener('end', () => onViewChange?.());
  function removeActor(view: ActorView) { view.epoch++; scene.remove(view.group); view.sprite.material.dispose(); view.shadow.geometry.dispose(); (view.shadow.material as MeshBasicMaterial).dispose(); view.texture?.dispose(); labelElements.get(view.actor.companionId)?.remove(); labelElements.delete(view.actor.companionId); }
  function clearTextures() { resourceEpoch++; textureCache.forEach(texture => texture.dispose()); textureCache.clear(); pendingTextures.clear(); }
  function getTexture(url: string) {
    const cached = textureCache.get(url); if (cached) return Promise.resolve(cached);
    let promise = pendingTextures.get(url);
    if (!promise) {
      const epoch = resourceEpoch;
      promise = loader.loadAsync(worldAssetUrl(url)).then(texture => {
        if (disposed || epoch !== resourceEpoch || !currentScene || ![...actors.values()].some(view => view.textureKey === url)) { texture.dispose(); throw new Error('scene released'); }
        texture.colorSpace = SRGBColorSpace; texture.minFilter = LinearFilter; texture.magFilter = LinearFilter; texture.generateMipmaps = false;
        textureCache.set(url, texture); if (pendingTextures.get(url) === promise) pendingTextures.delete(url); return texture;
      }).catch(error => { if (pendingTextures.get(url) === promise) pendingTextures.delete(url); throw error; });
      pendingTextures.set(url, promise);
    }
    return promise;
  }
  function fallbackTexture(companion: Companion | undefined) {
    // Custom characters keep their actual avatar marker instead of borrowing another character's body.
    const portrait = companion && companionPortrait(companion);
    if (portrait) { const texture = loader.load(portrait); texture.colorSpace = SRGBColorSpace; return texture; }
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128; const ctx = canvas.getContext('2d');
    if (ctx) { ctx.fillStyle = '#8da0af'; ctx.beginPath(); ctx.arc(64, 64, 52, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff9f0'; ctx.font = '52px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(companion?.name.slice(0, 1) ?? '客', 64, 68); }
    const texture = new TextureLoader().load(canvas.toDataURL()); texture.colorSpace = SRGBColorSpace; return texture;
  }
  function updateSprite(view: ActorView, companion: Companion | undefined) {
    const art = companion ? worldCharacterArt(companion.avatar) : undefined;
    const action = worldArtAction(view.actor), sheet = art?.actions[action];
    view.missingAction = Boolean(art && !sheet);
    if (!art || !sheet) {
      if (view.textureKey !== 'custom') { view.texture?.dispose(); view.texture = fallbackTexture(companion); view.textureKey = 'custom'; view.sprite.material.map = view.texture; view.sprite.material.needsUpdate = true; }
      view.sprite.scale.set(1.7, 1.7, 1); view.sprite.center.set(.5, 0); view.sprite.visible = true; view.animation = undefined; view.applyFrame = undefined; view.pose = 'ground'; return;
    }
    const apply = (frameIndex: 0 | 1 | 2) => {
      if (!view.texture) return;
      const frame = sheet.frames[frameIndex], mirrored = worldFacingMirrored(view.actor.facing, { x: camera.matrixWorld.elements[0]!, z: camera.matrixWorld.elements[2]! });
      const lying = frame.contacts.posture === 'lying' || frame.contacts.posture === 'transition' && frame.contacts.bed !== null;
      const sitting = frame.contacts.posture === 'sitting' || frame.contacts.posture === 'transition' && frame.contacts.seat !== null;
      const contact = lying ? frame.contacts.bed ?? frame.contacts.origin : sitting ? frame.contacts.seat ?? frame.contacts.origin : sheet.defaultOrigin ?? art.defaultOrigin;
      view.pose = lying ? 'bed' : sitting ? 'seat' : 'ground';
      const scale = art.heightTiles / Math.max(1, sheet.neutralHeightPixels ?? art.neutralHeightPixels);
      view.sprite.scale.set(sheet.frameWidth * scale, sheet.frameHeight * scale, 1);
      view.sprite.center.set(mirrored ? 1 - contact.x / sheet.frameWidth : contact.x / sheet.frameWidth, 1 - contact.y / sheet.frameHeight);
      view.texture.repeat.set((mirrored ? -1 : 1) / 3, 1); view.texture.offset.set((frameIndex + (mirrored ? 1 : 0)) / 3, 0);
    };
    const transitionDuration = view.actor.transitionEndsAtReal ? Date.parse(view.actor.transitionEndsAtReal) - Date.parse(view.actor.activityStartedAtReal) : undefined;
    view.applyFrame = apply; view.animation = { duration: transitionDuration && transitionDuration > 0 ? transitionDuration : sheet.durationMs, playback: view.actor.transitionEndsAtReal ? 'transition' : sheet.playback };
    if (view.textureKey !== sheet.url) {
      view.textureKey = sheet.url; const epoch = ++view.epoch; view.texture?.dispose(); view.texture = undefined; view.sprite.visible = false;
      void getTexture(sheet.url).then(texture => { if (disposed || view.epoch !== epoch) return; view.texture = texture.clone(); view.sprite.material.map = view.texture; view.sprite.material.needsUpdate = true; view.sprite.visible = true; view.applyFrame?.(view.actor.frame); }).catch(() => { /* A missing asset must not replace the host's actor state. */ });
    } else apply(view.actor.frame);
  }
  function buildWeather(kind: CompanionWorldSnapshot['environment']['weather']) {
    if (weather) { scene.remove(weather); weatherGeometry?.dispose(); weatherMaterial?.dispose(); weather = undefined; weatherGeometry = undefined; weatherMaterial = undefined; }
    precipitation = undefined;
    if (!currentScene || currentScene.kind !== 'commons' || kind !== 'rain' && kind !== 'snow') return;
    precipitation = kind;
    const rain = kind === 'rain', count = rain ? 320 : 240, stride = rain ? 6 : 3;
    const positions = new Float32Array(count * stride); const w = currentScene.width, d = currentScene.depth;
    for (let i = 0; i < count; i++) {
      const index = i * stride, x = ((i * 73 % 337) / 337) * w, z = (i * 53 % 331) / 331 * d;
      positions[index] = x; positions[index + 2] = z;
      if (rain) { positions[index + 3] = x - .28; positions[index + 5] = z; }
    }
    weatherGeometry = new BufferGeometry(); weatherGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    if (rain) { const material = new LineBasicMaterial({ color: '#6e95b2', transparent: true, opacity: .7, depthWrite: false }); weatherMaterial = material; weather = new LineSegments(weatherGeometry, material); }
    else { const material = new PointsMaterial({ color: '#f8ffff', size: 2.8, sizeAttenuation: false, transparent: true, opacity: .85, depthWrite: false }); weatherMaterial = material; weather = new Points(weatherGeometry, material); }
    // Vertices move inside the same bounded volume; do not cull against the
    // initial all-zero heights or recompute a bounding sphere every frame.
    weather.frustumCulled = false; scene.add(weather);
  }
  function update(snapshot: CompanionWorldSnapshot, selectedScene: CompanionWorldScene, companions: Companion[]) {
    if (disposed) return;
    const sceneChanged = roomId !== selectedScene.id;
    const weatherChanged = latest?.environment.weather !== snapshot.environment.weather;
    latest = snapshot; contacts = companions; currentScene = selectedScene;
    if (sceneChanged) {
      actors.forEach(removeActor); actors.clear(); clearTextures();
      if (room) { scene.remove(room.group); room.dispose(); }
      room = createWorldRoomModel(selectedScene, snapshot.scenes); roomId = selectedScene.id; scene.add(room.group); reset();
      practicalLights.clear();
      for (const object of selectedScene.objects.filter(object => object.kind === 'desk' || object.kind === 'bed' || object.kind === 'bench')) {
        const lamp = new PointLight('#ffd49a', 1, 9, 2);
        lamp.position.set(object.position.x + (object.kind === 'desk' ? .95 : .2), object.kind === 'desk' ? 1.45 : object.kind === 'bench' ? 2.3 : 1.2, object.position.y + (object.kind === 'desk' ? .8 : -.3)); practicalLights.add(lamp);
      }
      sun.target.position.set(selectedScene.width / 2, 0, selectedScene.depth / 2); sun.position.set(selectedScene.width / 2 - 12, 28, selectedScene.depth / 2 + 9);
      sun.castShadow = selectedScene.kind === 'home'; renderer.shadowMap.needsUpdate = true;
    }
    const light = snapshot.environment.light;
    room?.setNight(!snapshot.clock.daylight);
    scene.background = new Color().lerpColors(new Color('#303f56'), new Color('#dae3dc'), Math.max(.15, light));
    sun.intensity = selectedScene.kind === 'home' ? 1.1 + light * 2.5 : .25 + light * 2.8;
    hemisphere.intensity = selectedScene.kind === 'home' ? .65 + light * .7 : 1.1 + light * 1.1; ambient.intensity = selectedScene.kind === 'home' ? .14 : .12;
    practicalLights.children.forEach(lamp => { (lamp as PointLight).intensity = snapshot.clock.daylight ? 1.5 : 15; });
    if (weatherChanged || sceneChanged) buildWeather(snapshot.environment.weather);
    const visible = snapshot.actors.filter(actor => actor.sceneId === selectedScene.id);
    for (const [id, view] of actors) if (!visible.some(actor => actor.companionId === id)) { removeActor(view); actors.delete(id); }
    for (const actor of visible) {
      let view = actors.get(actor.companionId);
      if (!view) {
        const sprite = new Sprite(new SpriteMaterial({ transparent: true, depthWrite: false, alphaTest: .015 }));
        const shadow = new Mesh(new PlaneGeometry(1.2, .65), new MeshBasicMaterial({ color: '#5e665a', transparent: true, opacity: .16, depthWrite: false })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = .07;
        const group = new Group(); group.add(sprite, shadow); scene.add(group);
        view = { group, sprite, shadow, actor, path: [actor.position], changedAt: performance.now(), epoch: 0 }; actors.set(actor.companionId, view);
        const label = document.createElement('div'); label.className = 'companion-world-actor-label'; label.setAttribute('role', 'button'); label.tabIndex = 0; label.addEventListener('click', () => focusActor(actor.companionId)); label.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusActor(actor.companionId); } }); labelElements.set(actor.companionId, label); container.appendChild(label);
      } else {
        view.path = worldInterpolationPath(view.actor, actor.position); view.changedAt = performance.now(); view.actor = actor;
      }
      const companion = contacts.find(item => item.id === actor.companionId); updateSprite(view, companion);
      const label = labelElements.get(actor.companionId)!; label.textContent = (companion?.name ?? '伙伴') + (view.missingAction ? ' · 动作图待补' : ''); label.setAttribute('aria-label', '近看' + (companion?.name ?? '伙伴')); label.dataset.activity = actor.activity;
    }
    for (const [url, texture] of textureCache) if (![...actors.values()].some(view => view.textureKey === url)) { texture.dispose(); textureCache.delete(url); }
  }
  function frame(time: number) {
    if (disposed || !active || document.hidden) { raf = undefined; return; }
    raf = requestAnimationFrame(frame);
    const frameInterval = 1000 / 24;
    if (time - lastFrame < frameInterval) return;
    lastFrame = time - (time - lastFrame) % frameInterval;
    const drawStarted = performance.now();
    controls.update();
    if (following) { const target = actors.get(following); if (target) { const position = interpolateWorldPath(target.path, time - target.changedAt), offset = camera.position.clone().sub(controls.target); controls.target.set(position.x, 0, position.y); camera.position.copy(controls.target).add(offset); controls.update(); } }
    camera.updateMatrixWorld();
    for (const view of actors.values()) {
      if (view.animation) view.applyFrame?.(worldActorAnimationFrame(view.actor, view.animation, latest?.backlog ?? false, Date.now()));
      const position = interpolateWorldPath(view.path, time - view.changedAt);
      const furniture = currentScene?.objects.find(item => item.id === view.actor.furnitureId);
      const lying = view.pose === 'bed' && furniture?.kind === 'bed';
      const couch = (furniture?.kind === 'sofa' || furniture?.kind === 'bench') && view.pose === 'seat';
      const x = lying || couch ? furniture.position.x + (furniture.width - 1) / 2 + (couch ? .2 : 0) : position.x, z = lying || couch ? furniture.position.y + (furniture.depth - 1) / 2 : position.y;
      view.group.position.set(x, 0, z);
      view.sprite.position.y = lying ? .56 : view.pose === 'seat' ? .57 : .04;
      view.shadow.visible = !lying;
      project.set(x, 2.1, z).project(camera);
      const label = labelElements.get(view.actor.companionId)!; const width = container.clientWidth, height = container.clientHeight;
      label.style.transform = `translate(${(project.x + 1) * width / 2}px,${(1 - project.y) * height / 2}px) translate(-50%, -100%)`;
      label.hidden = project.z < -1 || project.z > 1 || Math.abs(project.x) > 1.1 || Math.abs(project.y) > 1.1;
    }
    // These particles illustrate the host's weather, never advance the simulation clock.
    if (weatherGeometry && precipitation) {
      const position = weatherGeometry.getAttribute('position'), rain = precipitation === 'rain';
      for (let i = 0; i < position.count / (rain ? 2 : 1); i++) {
        const height = worldPrecipitationHeight(i, time, precipitation);
        if (rain) { position.setY(i * 2, height); position.setY(i * 2 + 1, height - 1.35); }
        else position.setY(i, height);
      }
      position.needsUpdate = true;
    }
    renderer.render(scene, camera);
    drawTimes.push(performance.now() - drawStarted); if (drawTimes.length > 120) drawTimes.shift();
    renderer.domElement.dataset.worldReady = 'true'; renderer.domElement.dataset.worldLoadedActors = String([...actors.values()].filter(view => view.sprite.visible && view.texture).length);
    measuredFrames++; totalFrames++;
    if (time - measureStarted >= 1000) {
      const sortedTimes = [...drawTimes].sort((a, b) => a - b);
      Object.assign(renderer.domElement.dataset, { worldFps: (measuredFrames * 1000 / (time - measureStarted)).toFixed(1), worldDrawMsMedian: sortedTimes[Math.floor(sortedTimes.length / 2)]?.toFixed(2), worldDrawMs95: sortedTimes[Math.floor(sortedTimes.length * .95)]?.toFixed(2), worldDrawCalls: String(renderer.info.render.calls), worldTriangles: String(renderer.info.render.triangles), worldTextures: String(renderer.info.memory.textures), worldGeometries: String(renderer.info.memory.geometries), worldFrames: String(totalFrames) });
      measureStarted = time; measuredFrames = 0;
    }
  }
  function start() { if (!disposed && active && !document.hidden && raf === undefined) { lastFrame = 0; measureStarted = performance.now(); measuredFrames = 0; raf = requestAnimationFrame(frame); } }
  function onVisibility() { if (document.hidden) { if (raf !== undefined) cancelAnimationFrame(raf); raf = undefined; } else start(); }
  function contextLost(event: Event) { event.preventDefault(); if (raf !== undefined) cancelAnimationFrame(raf); raf = undefined; onFailure('画面暂时中断，请重新打开世界。世界仍会按真实状态继续。'); }
  document.addEventListener('visibilitychange', onVisibility); renderer.domElement.addEventListener('webglcontextlost', contextLost); start();
  return { update, getView, restoreView, reset() { onFollowChange?.(undefined); reset(); onViewChange?.(); }, setActive(value) { active = value; if (!value) { if (raf !== undefined) cancelAnimationFrame(raf); raf = undefined; } else start(); }, zoom(amount) { camera.zoom = Math.max(controls.minZoom, Math.min(controls.maxZoom, camera.zoom * amount)); camera.updateProjectionMatrix(); onViewChange?.(); }, rotate(amount) { const offset = camera.position.clone().sub(controls.target); offset.applyAxisAngle(new Vector3(0, 1, 0), amount); camera.position.copy(controls.target).add(offset); controls.update(); onViewChange?.(); }, focus: focusActor, dispose() {
    disposed = true; if (raf !== undefined) cancelAnimationFrame(raf); observer.disconnect(); controls.dispose(); document.removeEventListener('visibilitychange', onVisibility); renderer.domElement.removeEventListener('webglcontextlost', contextLost);
    actors.forEach(removeActor); actors.clear(); clearTextures(); room?.dispose(); weatherGeometry?.dispose(); weatherMaterial?.dispose(); sun.shadow.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); scene.clear();
  } };
}
