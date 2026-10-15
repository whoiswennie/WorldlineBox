import { forwardRef, useId, useImperativeHandle, useRef, useState } from 'react';
import type { Companion } from '../../../shared/companions';
import type { CompanionWorldScene, CompanionWorldSnapshot } from '../../../shared/companion-world';
import { Avatar } from '../CompanionVisuals';
import { worldActorStatus } from './world-presentation';
import { worldMapActors, worldMapGarden, worldNeighborhoodLayout, worldOutdoorRoute } from './world-map-layout';

type Contact = Pick<Companion, 'id' | 'name' | 'avatar' | 'avatarAttachmentId'>;
export interface WorldNeighborhoodMapHandle { zoom(factor: number): void; reset(): void; focus(id: string): void }
export const WorldNeighborhoodMap = forwardRef<WorldNeighborhoodMapHandle, {
  snapshot: CompanionWorldSnapshot; scene: CompanionWorldScene; companions: readonly Contact[]; followId?: string; onOpenHome(id: string): void; onFollow(id?: string): void;
}>(function WorldNeighborhoodMap({ snapshot, scene, companions, followId, onOpenHome, onFollow }, ref) {
  const layout = worldNeighborhoodLayout(scene, snapshot.scenes), actors = worldMapActors(snapshot, scene.id);
  const garden = worldMapGarden(scene);
  const [camera, setCamera] = useState({ x: layout.width / 2, y: layout.height / 2, zoom: 1 });
  const gesture = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | undefined>(undefined);
  const svg = useRef<SVGSVGElement>(null), id = useId().replaceAll(':', '');
  const contact = (ownerId: string) => companions.find(item => item.id === ownerId);
  const label = (ownerId: string) => contact(ownerId)?.name ?? snapshot.residents.find(item => item.companionId === ownerId)?.name ?? '伙伴';
  const zoom = (factor: number) => setCamera(value => ({ ...value, zoom: Math.max(1, Math.min(4, value.zoom * factor)) }));
  useImperativeHandle(ref, () => ({ zoom, reset: () => setCamera({ x: layout.width / 2, y: layout.height / 2, zoom: 1 }), focus: ownerId => {
    const actor = actors.find(item => item.companionId === ownerId); if (actor) setCamera(value => ({ x: actor.position.x, y: actor.position.y, zoom: Math.max(1.8, value.zoom) }));
  } }));
  const followed = actors.find(actor => actor.companionId === followId);
  const viewCamera = followed ? { x: followed.position.x, y: followed.position.y, zoom: Math.max(1.8, camera.zoom) } : camera;
  const width = layout.width / viewCamera.zoom, height = layout.height / viewCamera.zoom;
  return <div className="companion-world-map" data-world-map-ready="true" data-world-map-scene={scene.id}>
    <svg ref={svg} role="img" aria-label="伙伴街区地图，家庭与真实出行路线" viewBox={`${viewCamera.x - width / 2 - 2} ${viewCamera.y - height / 2 - 2} ${width + 4} ${height + 4}`}
      onWheel={event => { event.preventDefault(); zoom(Math.exp(-event.deltaY * .001)); }}
      onPointerDown={event => { if (event.button !== 0 || (event.target as Element).closest('button')) return; setCamera(viewCamera); onFollow(undefined); gesture.current = { x: event.clientX, y: event.clientY, cx: viewCamera.x, cy: viewCamera.y, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { const start = gesture.current, box = svg.current?.getBoundingClientRect(); if (!start || !box) return; const scale = Math.max(width / box.width, height / box.height); const dx = event.clientX - start.x, dy = event.clientY - start.y; if (Math.hypot(dx, dy) > 3) start.moved = true; setCamera(value => ({ ...value, x: start.cx - dx * scale, y: start.cy - dy * scale })); }}
      onPointerUp={event => { gesture.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { gesture.current = undefined; }}>
      <defs><pattern id={id + '-dots'} width="4" height="4" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".08" fill="currentColor" /></pattern><pattern id={id + '-green'} width="3" height="3" patternUnits="userSpaceOnUse"><path d="M1 1.5v-.4m-.3.2.3-.2.3.2" fill="none" stroke="currentColor" strokeWidth=".09" /></pattern></defs>
      <rect className="world-map-paper" x="-5000" y="-5000" width="10000" height="10000" />
      <rect className="world-map-grain" x="0" y="0" width={layout.width} height={layout.height} rx="2" fill={`url(#${id}-dots)`} />
      <g className="world-map-streets">{layout.streets.vertical.map(x => <path key={'v' + x} d={`M${x} 0V${layout.height}`} />)}{layout.streets.horizontal.map(y => <path key={'h' + y} d={`M0 ${y}H${layout.width}`} />)}</g>
      <g className="world-map-street-marks">{layout.streets.vertical.map(x => <path key={'v' + x} d={`M${x} 0V${layout.height}`} />)}{layout.streets.horizontal.map(y => <path key={'h' + y} d={`M0 ${y}H${layout.width}`} />)}</g>
      {garden && <g className="world-map-garden" role="group" aria-label="公共花园，真实树木和长椅" data-world-map-garden="true">
        <rect className="world-map-lawn" x={garden.x} y={garden.y} width={garden.width} height={garden.height} rx="3" />
        <rect className="world-map-lawn-grass" x={garden.x + .6} y={garden.y + .6} width={garden.width - 1.2} height={garden.height - 1.2} rx="2.5" fill={`url(#${id}-green)`} />
        <text className="world-map-garden-name" x={garden.x + 2.5} y={garden.y + 3}>公共花园</text>
        <text className="world-map-garden-subtitle" x={garden.x + 2.5} y={garden.y + 4.8}>散步 · 歇脚</text>
        {garden.benches.length > 0 && <g className="world-map-garden-paths"><path d={`M${garden.x} ${garden.y + garden.height - 3} Q${garden.x + 5} ${garden.y + garden.height - 3} ${garden.benches[0]!.anchor.x} ${garden.benches[0]!.anchor.y} ${garden.benches.slice(1).map(bench => `L${bench.anchor.x} ${bench.anchor.y}`).join(' ')}`} />{garden.benches.map(bench => <path key={bench.id} d={`M${bench.anchor.x} ${bench.anchor.y}v-1.2`} />)}</g>}
        {[{ x: garden.x + 3, y: garden.y + garden.height - 6 }, { x: garden.x + garden.width * .48, y: garden.y + 4 }, { x: garden.x + garden.width - 4, y: garden.y + garden.height - 6 }].map((patch, index) => <g key={index} className="world-map-flowers" transform={`translate(${patch.x} ${patch.y})`}>{[[-.7, .4], [.8, -.4], [1.5, .7], [-.8, -1]].map(([x, y], i) => <g key={i} transform={`translate(${x} ${y})`}><path d="M0 .5v-.5" /><circle cy="-.13" r=".25" /><circle cy="-.13" r=".08" /></g>)}</g>)}
        {garden.benches.map(bench => <g key={bench.id} className="world-map-bench" data-world-map-furniture={bench.id} transform={`translate(${bench.position.x} ${bench.position.y})`}><title>{bench.name}</title><rect className="world-map-bench-back" x="0" y="-.25" width={bench.width} height=".45" rx=".12" /><rect x="-.1" y=".35" width={bench.width + .2} height=".65" rx=".15" /><path d={`M.35 1v.55M${bench.width - .35} 1v.55M.2 .65H${bench.width - .2}`} /></g>)}
        {garden.trees.map(tree => { const cx = tree.position.x + tree.width / 2, cy = tree.position.y + tree.depth / 2; return <g key={tree.id} className="world-map-tree" data-world-map-furniture={tree.id}><title>{tree.name}</title><path d={`M${cx} ${cy + 1.7}v-1.5`} /><ellipse cx={cx} cy={cy + 1.6} rx="1.5" ry=".35" /><circle cx={cx - .75} cy={cy - .1} r="1.15" /><circle cx={cx + .75} cy={cy - .1} r="1.15" /><circle cx={cx} cy={cy - 1} r="1.3" /><path className="world-map-tree-leaf" d={`M${cx - .4} ${cy - 1.4}q.45-.4 .9 .05`} /></g>; })}
      </g>}
      {layout.homes.map(home => { const inside = snapshot.actors.filter(actor => actor.sceneId === home.sceneId); return <g key={home.sceneId}>
        <path className="world-map-door-path" d={`M${home.center.x} ${home.center.y}L${home.entrance.x} ${home.entrance.y}`} />
        <rect className="world-map-home-lot" x={home.bounds.x + .7} y={home.bounds.y + .7} width={home.bounds.width - 1.4} height={home.bounds.height - 1.4} rx="2" />
        <foreignObject x={home.bounds.x + 1} y={home.bounds.y + 1} width={home.bounds.width - 2} height={home.bounds.height - 2}>
          <button className="world-map-home" aria-label={'观察' + label(home.ownerId) + '的小屋'} data-world-map-home={home.ownerId} onClick={() => onOpenHome(home.sceneId)}>
            <Avatar companion={contact(home.ownerId)} showPresence={false} /><strong>{label(home.ownerId)}</strong><span>{inside.length ? `${inside.length} 位在家` : '此刻外出'}</span>
          </button>
        </foreignObject><circle className="world-map-door" cx={home.entrance.x} cy={home.entrance.y} r=".5" />
      </g>; })}
      {actors.map(actor => { const points = worldOutdoorRoute(actor, scene.id); return points.length > 1 && <polyline key={actor.companionId} className={'world-map-route' + (actor.locomotion === 'run' ? ' is-urgent' : '')} data-world-map-route={actor.companionId} points={points.map(point => `${point.x},${point.y}`).join(' ')} />; })}
      {actors.map(actor => { const behavior = worldActorStatus(actor, snapshot, companions); return <foreignObject key={actor.companionId} x={actor.position.x - 3} y={actor.position.y - 3.5} width="6" height="7" overflow="visible">
        <button className={'world-map-person' + (actor.locomotion === 'run' ? ' is-running' : '')} aria-label={label(actor.companionId) + '，' + behavior.label} title={label(actor.companionId) + ' · ' + behavior.label}
          data-world-map-actor={actor.companionId} data-world-position={`${actor.position.x},${actor.position.y}`} data-world-facing={actor.facing} onClick={() => onFollow(actor.companionId)}>
          <Avatar companion={contact(actor.companionId)} showPresence={false} /><i className={'is-' + actor.facing} /><span>{label(actor.companionId)}</span>
        </button>
      </foreignObject>; })}
    </svg>
    <div className="world-map-legend"><span><i />家</span><span><i />实际位置</span><span><i />接下来的路线</span></div>
  </div>;
});
