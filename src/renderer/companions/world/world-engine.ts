import logo from '../../../../assets/icons/startup-logo.png';
import { startupMarkup } from '../../../shared/startup-presentation';
import { prepareWorldResources } from './world-preparation';
import { AmbientLight, BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, Group, HemisphereLight, LinearFilter, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, OrthographicCamera, PCFSoftShadowMap, PlaneGeometry, PointLight, Points, PointsMaterial, Scene, Sprite, SpriteMaterial, SRGBColorSpace, TextureLoader, Vector3, WebGLRenderer, type Texture } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CompanionWorldContact } from '../../../shared/companion-world-window';
import type { CompanionWorldActor, CompanionWorldScene, CompanionWorldSnapshot } from '../../../shared/companion-world';
import { worldCharacterArt, type WorldArtAction } from '../../../shared/companion-world-art';
import { getCompanionWorldFramePlacement } from '../../../shared/companion-world-art-calibration';
import { companionPortrait } from '../CompanionVisuals';
import { createWorldRoomModel } from './world-room-model';
import { createWorldParkModel } from './world-park-model';
import { companionWorldParkLayout, companionWorldParkContains, type CompanionWorldParkBounds } from '../../../shared/companion-world-park';
import { layoutWorldLabels, type WorldLabelAnchor } from './world-label-layout';
import { interpolateWorldPath, worldActorAnimationFrame, worldActorStatus, worldArtAction, worldAssetUrl, worldFacingMirrored, worldInterpolationPath, worldPrecipitationHeight } from './world-presentation';
import { worldCameraViewSchema, type WorldCameraView } from './world-observer-preferences';
import { worldAdvanceFrameClock, worldAnimationWakeDelay, worldArrivalPresentationDuration, worldContinuePath, worldNextRenderDelay, worldScenePreparationGate, worldSnapshotInterpolationDuration, worldTargetFrameRate } from './world-render-timing';

interface ActorView { group: Group; sprite: Sprite; shadow: Mesh; actor: CompanionWorldActor; path: Array<{ x: number; y: number }>; changedAt: number; duration: number; texture?: Texture; textureKey?: string; action?: WorldArtAction; animation?: { duration: number; playback: 'loop' | 'transition' }; applyFrame?: (frame: 0 | 1 | 2) => boolean; pose?: 'ground' | 'seat' | 'bed'; missingAction?: boolean; epoch: number; appliedFrame?: number; appliedMirrored?: boolean; labelPosition?: string }
export interface WorldViewportEngine {
  update(snapshot: CompanionWorldSnapshot, scene: CompanionWorldScene, companions: CompanionWorldContact[], view?: 'park'): void;
  setActive(active: boolean): void;
  setVisibleWindowCount(count: number): void;
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
  const renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.domElement.setAttribute('aria-label', '伙伴世界三维场景');
  renderer.domElement.setAttribute('role', 'img');
  container.appendChild(renderer.domElement);
  const preparing = document.createElement('div'); preparing.className = 'companion-world-loading startup-world'; preparing.innerHTML = startupMarkup(logo, '正在准备三维场景', '搭建空间与伙伴形象', true); container.appendChild(preparing);
  let preparingStarted = performance.now(), preparingController = new AbortController();
  const preparingTimer = setInterval(() => { if (preparing.isConnected) preparing.querySelector('[data-startup-elapsed]')!.textContent = ((performance.now() - preparingStarted) / 1000).toFixed(1) + ' 秒'; }, 250);
  const preparation = worldScenePreparationGate();
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
  let room: { group: Group; setNight(night: boolean): void; animate?(timeMs: number): boolean; dispose(): void } | undefined, roomId: string | undefined, latest: CompanionWorldSnapshot | undefined;
  let parkBounds: CompanionWorldParkBounds | undefined;
  let currentScene: CompanionWorldScene | undefined, contacts: CompanionWorldContact[] = [], disposed = false, active = true, raf: number | undefined, timer: ReturnType<typeof setTimeout> | undefined, scheduledAt = Infinity, lastFrame = -Infinity, resourceEpoch = 0, following: string | undefined;
  let dirty = true, interacting = false, evaluatingCamera = false, visibleWindowCount = 1, viewportWidth = 0, viewportHeight = 0, environmentKey = '';
  let weather: Points | LineSegments | undefined, weatherGeometry: BufferGeometry | undefined, weatherMaterial: PointsMaterial | LineBasicMaterial | undefined;
  let precipitation: 'rain' | 'snow' | undefined;
  const labelElements = new Map<string, HTMLDivElement>();
  const labelLines = new Map<string, HTMLDivElement>(), labelSizes = new Map<string, { width: number; height: number }>();
  const labelObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).dataset.worldActorId;
      const box = entry.borderBoxSize[0], width = box?.inlineSize ?? entry.contentRect.width + 24, height = box?.blockSize ?? entry.contentRect.height + 15;
      if (id && width > 0 && height > 0) labelSizes.set(id, { width, height });
    }
    invalidate();
  });
  let measureStarted = performance.now(), measuredFrames = 0, totalFrames = 0;
  const drawTimes: number[] = [];
  const project = new Vector3();
  function cancelFrame() { if (raf !== undefined) cancelAnimationFrame(raf); if (timer !== undefined) clearTimeout(timer); raf = undefined; timer = undefined; scheduledAt = Infinity; }
  function schedule(delay = 0) {
    if (disposed || !active || document.hidden) return;
    const due = performance.now() + delay;
    if (due >= scheduledAt - .5) return;
    cancelFrame(); scheduledAt = due;
    if (delay <= 0) raf = requestAnimationFrame(frame);
    else timer = setTimeout(() => { timer = undefined; raf = requestAnimationFrame(frame); }, Math.max(0, delay - 8));
  }
  function invalidate() { dirty = true; schedule(); }
  function resize() {
    const { width, height } = container.getBoundingClientRect(); if (width < 1 || height < 1) return;
    const aspect = width / height; camera.left = -13 * aspect; camera.right = 13 * aspect; camera.top = 13; camera.bottom = -13; camera.updateProjectionMatrix();
    viewportWidth = width; viewportHeight = height; renderer.setSize(width, height); invalidate();
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
    const damping = controls.enableDamping; controls.enableDamping = false; controls.update(); controls.enableDamping = damping; getView(); invalidate();
  }
  function reset() {
    following = undefined;
    if (!currentScene) return;
    if (parkBounds) {
      const { x, y, width, height } = parkBounds, cx = x + width / 2, cz = y + height / 2, size = Math.max(width, height);
      controls.target.set(cx, .5, cz); camera.position.set(cx + size * .48, size * .75, cz + size * .85);
      controls.minZoom = .2; camera.zoom = 1; camera.updateProjectionMatrix(); controls.update(); camera.updateMatrixWorld();
      let maxX = 0, maxY = 0;
      for (const px of [x - 1, x + width + 1]) for (const pz of [y - 1, y + height + 1]) for (const py of [-1, 7]) {
        project.set(px, py, pz).project(camera); maxX = Math.max(maxX, Math.abs(project.x)); maxY = Math.max(maxY, Math.abs(project.y));
      }
      camera.zoom = Math.max(controls.minZoom, Math.min(1.6, .88 / Math.max(maxX, maxY))); camera.updateProjectionMatrix(); invalidate(); return;
    }
    const size = Math.max(currentScene.width, currentScene.depth), cx = (currentScene.width - 1) / 2, cz = (currentScene.depth - 1) / 2;
    controls.target.set(cx, 0, cz); camera.position.set(cx + size * .84, size * 1.05, cz + size * 1.08);
    camera.zoom = currentScene.kind === 'home' ? .94 : Math.max(.13, 23 / size); controls.minZoom = currentScene.kind === 'home' ? .45 : .1;
    camera.updateProjectionMatrix(); controls.update(); invalidate();
  }
  function focusActor(id: string) { const actor = actors.get(id); if (!actor) return; following = id; onFollowChange?.(id); const offset = camera.position.clone().sub(controls.target); controls.target.set(actor.actor.position.x, 0, actor.actor.position.y); camera.position.copy(controls.target).add(offset); camera.zoom = Math.max(camera.zoom, 2.1); camera.updateProjectionMatrix(); controls.update(); invalidate(); onViewChange?.(); }
  controls.addEventListener('start', () => { following = undefined; interacting = true; onFollowChange?.(undefined); invalidate(); });
  controls.addEventListener('change', () => { if (!evaluatingCamera) invalidate(); });
  controls.addEventListener('end', () => { interacting = false; invalidate(); onViewChange?.(); });
  function removeActor(view: ActorView) { view.epoch++; scene.remove(view.group); view.sprite.material.dispose(); view.shadow.geometry.dispose(); (view.shadow.material as MeshBasicMaterial).dispose(); view.texture?.dispose(); const label = labelElements.get(view.actor.companionId); if (label) labelObserver.unobserve(label); label?.remove(); labelElements.delete(view.actor.companionId); labelLines.get(view.actor.companionId)?.remove(); labelLines.delete(view.actor.companionId); labelSizes.delete(view.actor.companionId); }
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
  function fallbackTexture(companion: CompanionWorldContact | undefined) {
    // Custom characters keep their actual avatar marker instead of borrowing another character's body.
    const portrait = companion && companionPortrait(companion);
    if (portrait) { const texture = loader.load(portrait, invalidate); texture.colorSpace = SRGBColorSpace; return texture; }
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128; const ctx = canvas.getContext('2d');
    if (ctx) { ctx.fillStyle = '#8da0af'; ctx.beginPath(); ctx.arc(64, 64, 52, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff9f0'; ctx.font = '52px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(companion?.name.slice(0, 1) ?? '客', 64, 68); }
    const texture = new TextureLoader().load(canvas.toDataURL(), invalidate); texture.colorSpace = SRGBColorSpace; return texture;
  }
  function updateSprite(view: ActorView, companion: CompanionWorldContact | undefined) {
    const art = companion ? worldCharacterArt(companion.avatar) : undefined;
    const action = worldArtAction(view.actor), sheet = art?.actions[action];
    view.missingAction = Boolean(art && !sheet);
    if (!art || !sheet) {
      if (view.textureKey !== 'custom') { view.epoch++; view.texture?.dispose(); view.texture = fallbackTexture(companion); view.textureKey = 'custom'; view.sprite.material.map = view.texture; view.sprite.material.needsUpdate = true; invalidate(); }
      view.sprite.scale.set(1.7, 1.7, 1); view.sprite.center.set(.5, 0); view.sprite.visible = true; view.animation = undefined; view.applyFrame = undefined; view.pose = 'ground'; return;
    }
    const apply = (frameIndex: 0 | 1 | 2) => {
      if (!view.texture) return false;
      const mirrored = worldFacingMirrored(view.actor.facing, { x: camera.matrixWorld.elements[0]!, z: camera.matrixWorld.elements[2]! });
      if (view.appliedFrame === frameIndex && view.appliedMirrored === mirrored) return false;
      view.appliedFrame = frameIndex; view.appliedMirrored = mirrored;
      const { source, sourceImage, anchor, scale, pose } = getCompanionWorldFramePlacement(art, sheet, frameIndex);
      view.pose = pose;
      view.sprite.scale.set(source.width * scale, source.height * scale, 1);
      view.sprite.center.set(mirrored ? 1 - anchor.x / source.width : anchor.x / source.width, 1 - anchor.y / source.height);
      // Inset by half a source texel so linear filtering cannot sample an adjacent cell.
      view.texture.repeat.set((mirrored ? -1 : 1) * (source.width - 1) / sourceImage.width, (source.height - 1) / sourceImage.height);
      view.texture.offset.set((source.x + (mirrored ? source.width - .5 : .5)) / sourceImage.width, 1 - (source.y + source.height - .5) / sourceImage.height);
      return true;
    };
    const transitionDuration = view.actor.transitionEndsAtReal ? Date.parse(view.actor.transitionEndsAtReal) - Date.parse(view.actor.activityStartedAtReal) : undefined;
    view.applyFrame = apply; view.animation = { duration: transitionDuration && transitionDuration > 0 ? transitionDuration : sheet.durationMs, playback: view.actor.transitionEndsAtReal ? 'transition' : sheet.playback };
    if (view.textureKey !== sheet.url) {
      view.textureKey = sheet.url; view.appliedFrame = undefined; view.appliedMirrored = undefined; const epoch = ++view.epoch; view.texture?.dispose(); view.texture = undefined; view.sprite.visible = false; invalidate();
      void getTexture(sheet.url).then(texture => { if (disposed || view.epoch !== epoch) return; view.texture = texture.clone(); view.sprite.material.map = view.texture; view.sprite.material.needsUpdate = true; view.sprite.visible = true; view.applyFrame?.(view.actor.frame); invalidate(); }).catch(() => { /* A missing asset must not replace the host's actor state. */ });
    }
  }
  function buildWeather(kind: CompanionWorldSnapshot['environment']['weather']) {
    invalidate();
    if (weather) { scene.remove(weather); weatherGeometry?.dispose(); weatherMaterial?.dispose(); weather = undefined; weatherGeometry = undefined; weatherMaterial = undefined; }
    precipitation = undefined;
    if (!currentScene || currentScene.kind !== 'commons' || kind !== 'rain' && kind !== 'snow') return;
    precipitation = kind;
    const rain = kind === 'rain', count = rain ? 320 : 240, stride = rain ? 6 : 3;
    const positions = new Float32Array(count * stride); const w = parkBounds?.width ?? currentScene.width, d = parkBounds?.height ?? currentScene.depth;
    for (let i = 0; i < count; i++) {
      const index = i * stride, x = (parkBounds?.x ?? 0) + ((i * 73 % 337) / 337) * w, z = (parkBounds?.y ?? 0) + (i * 53 % 331) / 331 * d;
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
  function update(snapshot: CompanionWorldSnapshot, selectedScene: CompanionWorldScene, companions: CompanionWorldContact[], view?: 'park') {
    if (disposed) return;
    const viewId = selectedScene.id + (view === 'park' ? ':park' : '');
    const sceneChanged = roomId !== viewId;
    const scenePreparation = sceneChanged ? preparation.begin() : undefined;
    const weatherChanged = latest?.environment.weather !== snapshot.environment.weather;
    const previousAt = latest?.clock.realNow;
    latest = snapshot; contacts = companions; currentScene = selectedScene;
    if (sceneChanged) {
      preparingController.abort(); preparingController = new AbortController(); preparingStarted = performance.now();
      if (!preparing.isConnected) container.appendChild(preparing);
      container.setAttribute('aria-busy', 'true'); renderer.domElement.dataset.worldReady = 'false';
      actors.forEach(removeActor); actors.clear(); clearTextures();
      if (room) { scene.remove(room.group); room.dispose(); }
      parkBounds = view === 'park' ? companionWorldParkLayout(selectedScene) : undefined;
      room = parkBounds ? createWorldParkModel(selectedScene) : createWorldRoomModel(selectedScene, snapshot.scenes); roomId = viewId; scene.add(room.group); reset();
      renderer.domElement.dataset.worldView = parkBounds ? 'park' : 'home'; renderer.domElement.dataset.worldScene = selectedScene.id;
      if (parkBounds) renderer.domElement.dataset.worldParkBounds = JSON.stringify(parkBounds); else delete renderer.domElement.dataset.worldParkBounds;
      practicalLights.clear();
      for (const object of selectedScene.objects.filter(object => !parkBounds && (object.kind === 'desk' || object.kind === 'bed' || object.kind === 'bench'))) {
        const lamp = new PointLight('#ffd49a', 1, 9, 2);
        lamp.position.set(object.position.x + (object.kind === 'desk' ? .95 : .2), object.kind === 'desk' ? 1.45 : object.kind === 'bench' ? 2.3 : 1.2, object.position.y + (object.kind === 'desk' ? .8 : -.3)); practicalLights.add(lamp);
      }
      if (parkBounds) for (const object of selectedScene.objects.filter(object => object.kind === 'lamp')) {
        const lamp = new PointLight('#ffd99e', 0, 9, 2); lamp.position.set(object.position.x + (object.width - 1) / 2, 3.1, object.position.y + (object.depth - 1) / 2); practicalLights.add(lamp);
      }
      const cx = parkBounds ? parkBounds.x + parkBounds.width / 2 : selectedScene.width / 2, cz = parkBounds ? parkBounds.y + parkBounds.height / 2 : selectedScene.depth / 2;
      sun.target.position.set(cx, 0, cz); sun.position.set(cx - 12, 28, cz + 9);
      const shadowSize = parkBounds ? Math.max(parkBounds.width, parkBounds.height) * .65 : 22;
      sun.shadow.camera.left = -shadowSize; sun.shadow.camera.right = shadowSize; sun.shadow.camera.top = shadowSize; sun.shadow.camera.bottom = -shadowSize; sun.shadow.camera.updateProjectionMatrix();
      sun.castShadow = selectedScene.kind === 'home' || !!parkBounds; renderer.shadowMap.needsUpdate = true;
    }
    const nextEnvironment = viewId + ':' + snapshot.clock.daylight + ':' + Math.round(snapshot.environment.light * 100);
    if (nextEnvironment !== environmentKey) {
      environmentKey = nextEnvironment; const light = snapshot.environment.light;
      room?.setNight(!snapshot.clock.daylight);
      scene.background = parkBounds ? new Color().setRGB((25 + 195 * light) / 255, (46 + 184 * light) / 255, (56 + 164 * light) / 255, SRGBColorSpace)
        : new Color().lerpColors(new Color('#303f56'), new Color('#dae3dc'), Math.max(.15, light));
      sun.intensity = selectedScene.kind === 'home' ? 1.1 + light * 2.5 : .25 + light * 2.8;
      hemisphere.intensity = parkBounds ? .35 + light * 1.5 : selectedScene.kind === 'home' ? .65 + light * .7 : 1.1 + light * 1.1; ambient.intensity = selectedScene.kind === 'home' ? .14 : .08;
      if (parkBounds) sun.intensity = .08 + light * 2;
      practicalLights.children.forEach(lamp => { (lamp as PointLight).intensity = snapshot.clock.daylight ? parkBounds ? 0 : 1.5 : parkBounds ? 30 : 15; });
      renderer.domElement.dataset.worldLampCount = String(practicalLights.children.length); renderer.domElement.dataset.worldLampsOn = String(!snapshot.clock.daylight); renderer.domElement.dataset.worldLampRadius = parkBounds ? '9' : '';
      renderer.shadowMap.needsUpdate = true; invalidate();
    }
    if (weatherChanged || sceneChanged) buildWeather(snapshot.environment.weather);
    const visible = snapshot.actors.filter(actor => actor.sceneId === selectedScene.id && (!parkBounds || companionWorldParkContains(parkBounds, actor.position)));
    for (const [id, view] of actors) if (!visible.some(actor => actor.companionId === id)) { removeActor(view); actors.delete(id); invalidate(); }
    for (const actor of visible) {
      let view = actors.get(actor.companionId);
      if (!view) {
        const sprite = new Sprite(new SpriteMaterial({ transparent: true, depthWrite: false, alphaTest: .015 }));
        const shadow = new Mesh(new PlaneGeometry(1.2, .65), new MeshBasicMaterial({ color: '#5e665a', transparent: true, opacity: .16, depthWrite: false })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = .07;
        const group = new Group(); group.add(sprite, shadow); scene.add(group);
        view = { group, sprite, shadow, actor, path: [actor.position], changedAt: performance.now(), duration: 0, epoch: 0 }; actors.set(actor.companionId, view);
        const label = document.createElement('div'); label.className = 'companion-world-actor-label'; label.dataset.worldActorId = actor.companionId; label.setAttribute('role', 'button'); label.tabIndex = 0; label.append(document.createElement('small'), document.createElement('strong')); label.addEventListener('click', () => focusActor(actor.companionId)); label.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusActor(actor.companionId); } }); labelElements.set(actor.companionId, label); container.appendChild(label); labelObserver.observe(label);
        const line = document.createElement('div'); line.className = 'companion-world-actor-leader'; line.hidden = true; labelLines.set(actor.companionId, line); container.appendChild(line); invalidate();
      } else {
        const positionChanged = actor.position.x !== view.actor.position.x || actor.position.y !== view.actor.position.y;
        if (positionChanged || snapshot.backlog || actor.activity !== 'walking' && view.path.length > 1) {
          const now = performance.now(), received = worldInterpolationPath(view.actor, actor.position);
          const continued = worldContinuePath(view.path, now - view.changedAt, view.duration, received);
          const arrivalDuration = !snapshot.backlog && view.actor.activity === 'walking' ? worldArrivalPresentationDuration(actor.activity, continued, actor.movementSpeed) : 0;
          view.path = !snapshot.backlog && (actor.activity === 'walking' || arrivalDuration > 0) ? continued : [actor.position];
          view.changedAt = now; view.duration = actor.activity === 'walking' ? worldSnapshotInterpolationDuration(previousAt, snapshot.clock.realNow) : arrivalDuration; invalidate();
        }
        if (view.actor.facing !== actor.facing || view.actor.artAction !== actor.artAction || snapshot.backlog && view.actor.frame !== actor.frame || view.actor.activity !== actor.activity) invalidate();
        view.actor = actor;
      }
      const companion = contacts.find(item => item.id === actor.companionId); updateSprite(view, companion);
      const label = labelElements.get(actor.companionId)!, status = worldActorStatus(actor, snapshot, contacts), name = companion?.name ?? '伙伴';
      const behavior = status.label + (view.missingAction ? ' · 动作图待补' : '');
      if (label.firstElementChild!.textContent !== name) label.firstElementChild!.textContent = name;
      if (label.lastElementChild!.textContent !== behavior) label.lastElementChild!.textContent = behavior;
      const ariaLabel = '近看' + name + '，' + status.label;
      if (label.getAttribute('aria-label') !== ariaLabel) label.setAttribute('aria-label', ariaLabel);
      if (label.title !== (status.detail ?? '')) label.title = status.detail ?? '';
      if (label.dataset.worldBehavior !== status.label) label.dataset.worldBehavior = status.label;
      if (label.dataset.kind !== status.kind) label.dataset.kind = status.kind;
      if (label.dataset.activity !== actor.activity) label.dataset.activity = actor.activity;
      label.dataset.worldActorId = actor.companionId; label.dataset.worldHostPosition = `${actor.position.x},${actor.position.y}`;
    }
    for (const [url, texture] of textureCache) if (![...actors.values()].some(view => view.textureKey === url)) { texture.dispose(); textureCache.delete(url); }
    if (sceneChanged) {
      // Only the selected scene's initial assets enter the first-draw gate.
      // Background animation variants never repeatedly hide an already drawn scene.
      void prepareWorldResources({ compile: renderer.compileAsync(scene, camera), assets: [...pendingTextures.values()], signal: preparingController.signal,
        onProgress: value => {
          preparing.querySelector('[data-startup-detail]')!.textContent = value.compiled ? '画面已准备 · 装载伙伴形象' : '准备光照、材质与显卡绘制';
          preparing.querySelector('[data-startup-stage]')!.textContent = `形象资源 ${value.completed} / ${value.total}${value.compiled ? ' · 材质已就绪' : ''}`;
        },
      }).then(result => {
        if (disposed || result.cancelled || !preparation.complete(scenePreparation!)) return;
        if (result.timedOut || result.compileFailed || result.failedAssets) onFailure(result.timedOut ? '场景资源载入较慢，已先显示可用画面。未完成的形象会继续载入。' : '部分场景资源未能装载，仍可查看伙伴的真实状态。');
        preparing.querySelector('[data-startup-detail]')!.textContent = '资源已检查 · 正在绘制第一帧';
        invalidate();
      });
    }
    schedule();
  }
  function frame(time: number) {
    raf = undefined; scheduledAt = Infinity;
    if (disposed || !active || document.hidden) return;
    if (!preparation.ready) { controls.update(); return; }
    const frameInterval = 1000 / worldTargetFrameRate(visibleWindowCount);
    if (time - lastFrame < frameInterval - .5) { schedule(frameInterval - (time - lastFrame)); return; }
    const drawStarted = performance.now();
    let changed = dirty, continuous = interacting || Boolean(precipitation), nextAnimationMs = Infinity;
    dirty = false;
    if (room?.animate?.(time)) { changed = true; continuous = true; }
    evaluatingCamera = true;
    const cameraChanged = controls.update(); changed ||= cameraChanged; continuous ||= cameraChanged;
    if (following) { const target = actors.get(following); if (target) { const position = interpolateWorldPath(target.path, time - target.changedAt, target.duration), offset = camera.position.clone().sub(controls.target); if (Math.abs(controls.target.x - position.x) > .00001 || Math.abs(controls.target.z - position.y) > .00001) { controls.target.set(position.x, 0, position.y); camera.position.copy(controls.target).add(offset); controls.update(); changed = true; } } }
    camera.updateMatrixWorld();
    evaluatingCamera = false;
    const realNow = Date.now();
    const labelAnchors: WorldLabelAnchor[] = [];
    for (const view of actors.values()) {
      if (view.animation) {
        changed = Boolean(view.applyFrame?.(worldActorAnimationFrame(view.actor, view.animation, latest?.backlog ?? false, realNow))) || changed;
        nextAnimationMs = Math.min(nextAnimationMs, worldAnimationWakeDelay(view.actor.artStartedAtReal ?? view.actor.activityStartedAtReal, view.animation.duration, view.animation.playback, realNow, latest?.backlog ?? false));
      }
      const position = interpolateWorldPath(view.path, time - view.changedAt, view.duration);
      continuous ||= !latest?.backlog && view.path.length > 1 && time - view.changedAt < view.duration;
      const furniture = currentScene?.objects.find(item => item.id === view.actor.furnitureId);
      const lying = view.pose === 'bed' && furniture?.kind === 'bed';
      const couch = (furniture?.kind === 'sofa' || furniture?.kind === 'bench') && view.pose === 'seat';
      const x = lying || couch ? furniture.position.x + (furniture.width - 1) / 2 + (couch ? .2 : 0) : position.x, z = lying || couch ? furniture.position.y + (furniture.depth - 1) / 2 : position.y;
      const height = lying ? .56 : view.pose === 'seat' ? .57 : .04;
      if (view.group.position.x !== x || view.group.position.z !== z || view.sprite.position.y !== height || view.shadow.visible !== !lying) { view.group.position.set(x, 0, z); view.sprite.position.y = height; view.shadow.visible = !lying; changed = true; }
      // SpriteMaterial is unlit. Sample the same finite-range practical lamps
      // explicitly so a night walker also enters/leaves their warm light pools.
      const base = parkBounds ? .4 + .6 * (latest?.environment.light ?? 1) : 1;
      let red = base, green = base, blue = base;
      if (parkBounds && latest && !latest.clock.daylight) for (const light of practicalLights.children as PointLight[]) {
        const distance = Math.hypot(x - light.position.x, height + .8 - light.position.y, z - light.position.z);
        if (distance >= light.distance) continue;
        const cutoff = Math.max(0, 1 - Math.pow(distance / light.distance, 4));
        const exposure = .12 * light.intensity * cutoff * cutoff / Math.max(1, distance * distance);
        red += exposure; green += exposure * .79; blue += exposure * .49;
      }
      red = Math.min(1, red); green = Math.min(1, green); blue = Math.min(1, blue);
      const tint = view.sprite.material.color;
      if (tint.r !== red || tint.g !== green || tint.b !== blue) { tint.setRGB(red, green, blue); changed = true; }
      project.set(x, 2.1, z).project(camera);
      const label = labelElements.get(view.actor.companionId)!;
      label.dataset.worldRenderPosition = `${x},${z}`;
      const hidden = project.z < -1 || project.z > 1 || Math.abs(project.x) > 1.1 || Math.abs(project.y) > 1.1;
      if (label.hidden !== hidden) label.hidden = hidden;
      if (!hidden) labelAnchors.push({ id: view.actor.companionId, x: Math.round((project.x + 1) * viewportWidth / 2), y: Math.round((1 - project.y) * viewportHeight / 2), ...labelSizes.get(view.actor.companionId) ?? { width: 180, height: 50 } });
      else labelLines.get(view.actor.companionId)!.hidden = true;
    }
    for (const placement of layoutWorldLabels(labelAnchors, viewportWidth, viewportHeight)) {
      const label = labelElements.get(placement.id)!, view = actors.get(placement.id)!, line = labelLines.get(placement.id)!;
      const transform = `translate(${placement.x}px,${placement.y}px) translate(-50%, -100%)`;
      if (view.labelPosition !== transform) { label.style.transform = transform; view.labelPosition = transform; }
      const dx = placement.anchorX - placement.x, dy = placement.anchorY - placement.y, distance = Math.hypot(dx, dy);
      line.hidden = distance < 8;
      label.dataset.worldDisplaced = String(!line.hidden);
      if (!line.hidden) { line.style.width = distance + 'px'; line.style.transform = `translate(${placement.x}px,${placement.y}px) rotate(${Math.atan2(dy, dx)}rad)`; }
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
      changed = true;
    }
    if (changed) {
      renderer.render(scene, camera);
      if (preparing.isConnected) { preparing.remove(); container.setAttribute('aria-busy', 'false'); console.info('startup.world.ready', JSON.stringify({ sceneId: currentScene?.id, elapsedMs: Math.round(performance.now() - preparingStarted) })); }
      lastFrame = worldAdvanceFrameClock(lastFrame, time, visibleWindowCount);
      drawTimes.push(performance.now() - drawStarted); if (drawTimes.length > 120) drawTimes.shift();
      renderer.domElement.dataset.worldReady = 'true'; renderer.domElement.dataset.worldLoadedActors = String([...actors.values()].filter(view => view.sprite.visible && view.texture).length);
      measuredFrames++; totalFrames++; renderer.domElement.dataset.worldFrames = String(totalFrames);
    }
    if (time - measureStarted >= 1000) {
      const sortedTimes = [...drawTimes].sort((a, b) => a - b);
      Object.assign(renderer.domElement.dataset, { worldFps: (measuredFrames * 1000 / (time - measureStarted)).toFixed(1), worldTargetFps: String(worldTargetFrameRate(visibleWindowCount)), worldDrawMsMedian: sortedTimes[Math.floor(sortedTimes.length / 2)]?.toFixed(2), worldDrawMs95: sortedTimes[Math.floor(sortedTimes.length * .95)]?.toFixed(2), worldDrawCalls: String(renderer.info.render.calls), worldTriangles: String(renderer.info.render.triangles), worldTextures: String(renderer.info.memory.textures), worldGeometries: String(renderer.info.memory.geometries), worldFrames: String(totalFrames), worldSourceTextures: String(textureCache.size), worldPendingTextures: String(pendingTextures.size) });
      measureStarted = time; measuredFrames = 0;
    }
    const delay = worldNextRenderDelay({ active: active && !document.hidden, dirty, continuous, visibleWindowCount, sinceLastDrawMs: performance.now() - lastFrame, nextAnimationMs });
    if (delay !== undefined) schedule(delay);
  }
  function start() { if (!disposed && active && !document.hidden) { measureStarted = performance.now(); measuredFrames = 0; invalidate(); } }
  function onVisibility() { if (document.hidden) cancelFrame(); else start(); }
  function contextLost(event: Event) { event.preventDefault(); cancelFrame(); onFailure('画面暂时中断，请重新打开世界。世界仍会按真实状态继续。'); }
  document.addEventListener('visibilitychange', onVisibility); renderer.domElement.addEventListener('webglcontextlost', contextLost); start();
  return { update, getView, restoreView, reset() { onFollowChange?.(undefined); reset(); onViewChange?.(); }, setActive(value) { if (active === value) return; active = value; if (!value) cancelFrame(); else start(); }, setVisibleWindowCount(count) { const next = Number.isFinite(count) ? Math.max(1, count) : 1; if (next !== visibleWindowCount) { visibleWindowCount = next; invalidate(); } }, zoom(amount) { camera.zoom = Math.max(controls.minZoom, Math.min(controls.maxZoom, camera.zoom * amount)); camera.updateProjectionMatrix(); invalidate(); onViewChange?.(); }, rotate(amount) { const offset = camera.position.clone().sub(controls.target); offset.applyAxisAngle(new Vector3(0, 1, 0), amount); camera.position.copy(controls.target).add(offset); controls.update(); invalidate(); onViewChange?.(); }, focus: focusActor, dispose() {
    disposed = true; cancelFrame(); observer.disconnect(); labelObserver.disconnect(); controls.dispose(); document.removeEventListener('visibilitychange', onVisibility); renderer.domElement.removeEventListener('webglcontextlost', contextLost);
    preparingController.abort(); clearInterval(preparingTimer);
    actors.forEach(removeActor); actors.clear(); clearTextures(); room?.dispose(); weatherGeometry?.dispose(); weatherMaterial?.dispose(); sun.shadow.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); preparing.remove(); scene.clear();
  } };
}
