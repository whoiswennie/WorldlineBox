import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { COMPANION_WORLD_ART_ACTIONS } from '../src/shared/companion-world-actions.ts';
import { calibrateCompanionWorldSheet, companionWorldFramePose } from '../src/shared/companion-world-art-calibration.ts';

const root = process.cwd();
const manifestFile = path.join(root, 'src/shared/companion-world-art-data.json');
const assetRoot = path.join(root, 'public/companion-world/characters');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const command = process.argv[2];
const point = (value, scale) => value ? { x: +(value.x * scale).toFixed(3), y: +(value.y * scale).toFixed(3) } : null;
const bounds = (value, scale) => ({ x: +(value.x * scale).toFixed(3), y: +(value.y * scale).toFixed(3), width: +(value.width * scale).toFixed(3), height: +(value.height * scale).toFixed(3) });
async function writeManifest(data) {
  const temporary = manifestFile + '.' + process.pid + '.writing';
  try { await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n'); await fs.rename(temporary, manifestFile); }
  finally { await fs.rm(temporary, { force: true }); }
}
function calibrateAsset(asset, action, pixels, info) {
  const extracted = asset.frames.map((frame, index) => {
    const rgba = new Uint8Array(asset.frameWidth * asset.frameHeight * 4);
    let minX=asset.frameWidth,minY=asset.frameHeight,maxX=-1,maxY=-1;
    for(let y=0;y<asset.frameHeight;y++)for(let x=0;x<asset.frameWidth;x++){
      const source=(y*info.width+index*asset.frameWidth+x)*4,target=(y*asset.frameWidth+x)*4;
      rgba.set(pixels.subarray(source,source+4),target);
      if(pixels[source+3]>16){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
    }
    frame.bounds={x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1};
    return {rgba,width:asset.frameWidth,height:asset.frameHeight};
  });
  const result=calibrateCompanionWorldSheet(asset,action,extracted);
  for(let index=0;index<3;index++)asset.frames[index].registration=result.registrations[index];
  return {...result,extracted};
}

if (command === 'import') {
  const sourceRoot = path.resolve(process.argv[3] || '');
  if (!process.argv[3]) throw new Error('Supply the user-approved source project directory.');
  const oldArt = path.join(sourceRoot, 'assets/characters/standard-v1');
  const data = {};
  for (const directory of await fs.readdir(oldArt, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const authoring = JSON.parse(await fs.readFile(path.join(oldArt, directory.name, 'art-qa-manifest.json'), 'utf8'));
    const avatar = directory.name === 'deepseek' ? 'sister' : directory.name;
    const actions = {};
    for (const asset of authoring.assets) {
      if (asset.group === 'basinHat') continue;
      const source = path.resolve(sourceRoot, asset.file);
      if (!source.startsWith(sourceRoot + path.sep)) throw new Error('Source art path escapes the selected project.');
      const input = await fs.readFile(source);
      if (digest(input) !== asset.sha256) throw new Error(`Source digest mismatch: ${avatar}/${asset.group}`);
      const metadata = await sharp(input).metadata();
      if (!metadata.hasAlpha || metadata.width !== metadata.height * 3) throw new Error(`Expected one transparent three-frame sheet: ${source}`);
      const target = path.join(assetRoot, avatar, 'actions', asset.group + '.webp');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await sharp(input).resize(1152, 384).webp({ quality: 92, alphaQuality: 100, effort: 6 }).toFile(target);
      const scale = 384 / asset.cell.height;
      const imported = {
        url: `companion-world/characters/${avatar}/actions/${asset.group}.webp`,
        frameCount: 3, frameWidth: 384, frameHeight: 384,
        durationMs: asset.durationMs, playback: asset.mode,
        sha256: digest(await fs.readFile(target)),
        source: { kind: 'user-project', character: directory.name, action: asset.group, sha256: digest(input) },
        frames: asset.frames.map(frame => ({ bounds: bounds(frame.bounds, scale),
          contacts: Object.fromEntries(Object.entries(frame.contacts).map(([key, value]) => [key, key === 'posture' ? value : point(value, scale)])) })),
      };
      const decoded = await sharp(target).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      calibrateAsset(imported,asset.group,decoded.data,decoded.info); actions[asset.group]=imported;
    }
    const idle = actions.idle.frames[0].bounds;
    data[avatar] = { id: avatar, cell: { width: 384, height: 384 }, heightTiles: ['guga', 'gugugaga', 'doro'].includes(avatar) ? 1.35 : 1.8,
      neutralHeightPixels: idle.height, defaultOrigin: point(authoring.defaultOrigin, 384 / authoring.cell.height), actions };
  }
  await writeManifest(data);
  console.log(`Imported ${Object.keys(data).length} character sets and ${Object.values(data).reduce((n, c) => n + Object.keys(c.actions).length, 0)} independent action sheets.`);
} else if (command === 'register') {
  if (!process.argv[3]) throw new Error('Supply a JSON array of independently generated actions with input, avatar, action and prompt.');
  const records = JSON.parse(await fs.readFile(path.resolve(process.argv[3]), 'utf8'));
  if (!Array.isArray(records) || !records.length) throw new Error('Expected at least one action declaration.');
  const data = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const prepared = [], identities = new Set(), sources = new Set();
  const neutralActions = new Set(['idle', 'standingRead', 'communicate', 'think', 'tired', 'pleased', 'troubled', 'sad', 'angry', 'surprised', 'handle', 'phoneTypingStanding', 'phoneCallingStanding', 'exercise', 'turn', 'cook']);
  for (const record of records) {
    const identity = `${record.avatar}/${record.action}`;
    if (!data[record.avatar] || !COMPANION_WORLD_ART_ACTIONS.includes(record.action) || identities.has(identity)) throw new Error(`Unknown or duplicated action: ${identity}`);
    identities.add(identity);
    if (typeof record.prompt !== 'string' || !record.prompt.trim()) throw new Error(`Keep the full generation prompt: ${identity}`);
    const input = await fs.readFile(path.resolve(record.input)), sourceHash = digest(input);
    if (sources.has(sourceHash)) throw new Error(`Each action must have an independently authored source: ${identity}`);
    sources.add(sourceHash);
    const metadata = await sharp(input).metadata();
    if (!metadata.hasAlpha || Math.abs(metadata.width / metadata.height - 3) > .025) throw new Error(`Expected one transparent three-frame row: ${identity}`);
    const buffer = await sharp(input).resize(1152, 384).webp({ quality: 92, alphaQuality: 100, effort: 4 }).toBuffer();
    const { data: pixels, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const frames = [];
    for (let index = 0; index < 3; index++) {
      let minX = 384, minY = 384, maxX = -1, maxY = -1, edges = 0;
      for (let y = 0; y < 384; y++) for (let x = 0; x < 384; x++) if (pixels[(y * info.width + index * 384 + x) * 4 + 3] > 16) {
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        if (x === 0 || x === 383 || y === 0 || y === 383) edges++;
      }
      if (maxX < 0 || edges > 8) throw new Error(`Empty or clipped frame: ${identity}/${index}, edge pixels ${edges}`);
      const posture = record.postures?.[index] ?? 'standing', measured = record.contacts?.[index];
      if (!['standing', 'sitting', 'lying', 'transition'].includes(posture) || posture !== 'standing' && !measured) throw new Error(`Supply visually reviewed posture contacts: ${identity}/${index}`);
      const contacts = { posture, origin: { x: 192, y: 377 }, foot: null, seat: null, pelvis: null, bed: null, back: null, ...measured };
      if (posture === 'standing') contacts.foot = { x: 192, y: maxY };
      if (posture === 'sitting' && !contacts.seat || posture === 'lying' && !contacts.bed) throw new Error(`Missing furniture contact: ${identity}/${index}`);
      for (const point of Object.values(contacts)) if (point && typeof point === 'object' && (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > 384 || point.y > 384)) throw new Error(`Invalid contact coordinates: ${identity}/${index}`);
      frames.push({ bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, contacts });
    }
    const standing = frames.filter(frame => frame.contacts.posture === 'standing');
    const durationMs = record.durationMs ?? (record.action === 'run' ? 540 : 2200), playback = record.playback ?? 'loop';
    if (!Number.isFinite(durationMs) || durationMs < 100 || !['loop', 'transition'].includes(playback)) throw new Error(`Invalid playback: ${identity}`);
    const asset = { url: `companion-world/characters/${record.avatar}/actions/${record.action}.webp`, frameCount: 3, frameWidth: 384, frameHeight: 384, durationMs, playback,
      ...(standing.length ? { defaultOrigin: { x: 192, y: Math.max(...standing.map(frame => frame.contacts.foot.y)) } } : {}),
      ...(neutralActions.has(record.action) && frames[0].contacts.posture === 'standing' ? { neutralHeightPixels: frames[0].bounds.height } : {}),
      sha256: digest(buffer), source: { kind: 'builtin-imagegen', action: record.action, sha256: sourceHash, prompt: record.prompt }, frames };
    calibrateAsset(asset,record.action,pixels,info);
    data[record.avatar].actions[record.action] = asset;
    if (record.action === 'idle') data[record.avatar].neutralHeightPixels = frames[0].bounds.height;
    prepared.push({ target: path.join(root, 'public', asset.url), buffer });
  }
  // Validate the entire batch before replacing any production image or its manifest.
  for (const { target, buffer } of prepared) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, buffer); }
  await writeManifest(data);
  console.log(`Registered ${prepared.length} independent action sheets.`);
} else if (command === 'calibrate') {
  const data=JSON.parse(await fs.readFile(manifestFile,'utf8')), report=[], output=path.resolve(process.argv[3]||'.tools/world-art-calibration');
  await fs.mkdir(output,{recursive:true});
  for(const [avatar,character]of Object.entries(data)){
    const panels=[];
    for(const[action,asset]of Object.entries(character.actions)){
      const image=await fs.readFile(path.join(root,'public',asset.url));
      if(digest(image)!==asset.sha256)throw new Error(`Asset changed without declaration: ${avatar}/${action}`);
      const decoded=await sharp(image).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      const result=calibrateAsset(asset,action,decoded.data,decoded.info);
      const oldAnchor=frame=>companionWorldFramePose(frame)==='ground'?asset.defaultOrigin??character.defaultOrigin:companionWorldFramePose(frame)==='seat'?frame.contacts.seat:frame.contacts.bed;
      const xs=result.matches.map((match,index)=>match.dx-(oldAnchor(asset.frames[index]).x-oldAnchor(asset.frames[0]).x));
      const ys=result.matches.map((match,index)=>match.dy-(oldAnchor(asset.frames[index]).y-oldAnchor(asset.frames[0]).y));
      const entry={avatar,action,bodyCoreRangeBefore:{x:Math.max(...xs)-Math.min(...xs),y:Math.max(...ys)-Math.min(...ys)},registrations:result.registrations,matches:result.matches};
      report.push(entry);
      const images=await Promise.all(result.extracted.map(frame=>sharp(frame.rgba,{raw:{width:frame.width,height:frame.height,channels:4}}).resize(96,96).png().toBuffer()));
      let panel=`<text x="5" y="14" font-size="12" fill="#e6edf3">${action}</text>`;
      for(let row=0;row<2;row++)for(let index=0;index<3;index++){
        const anchor=row?asset.frames[index].registration.anchor:oldAnchor(asset.frames[index]), x=index*112+56-anchor.x/4,y=20+row*100+90-anchor.y/4;
        panel+=`<clipPath id="c${panels.length}_${row}_${index}"><rect x="${index*112}" y="${20+row*100}" width="112" height="100"/></clipPath><g clip-path="url(#c${panels.length}_${row}_${index})"><path d="M${index*112+56} ${20+row*100}v100M${index*112} ${20+row*100+90}h112" stroke="${row?'#63d49b':'#e17d75'}" opacity=".45"/><image href="data:image/png;base64,${images[index].toString('base64')}" x="${x}" y="${y}" width="96" height="96"/></g>`;
      }
      panels.push(panel);
    }
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1344" height="${Math.ceil(panels.length/4)*224}"><rect width="100%" height="100%" fill="#17212b"/>${panels.map((panel,index)=>`<g transform="translate(${index%4*336} ${Math.floor(index/4)*224})">${panel}</g>`).join('')}</svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(output,avatar+'.png'));
  }
  await writeManifest(data);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({sheets:report.length,frames:report.length*3,maximumHorizontalDriftBefore:Math.max(...report.map(row=>row.bodyCoreRangeBefore.x)),over8px:report.filter(row=>row.bodyCoreRangeBefore.x>8).length,highResidual:report.filter(row=>row.matches.some(match=>match.score>40)).map(row=>row.avatar+'/'+row.action),output},null,2));
} else if (command === 'verify' || command === 'inspect') {
  const data = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  let count = 0, bytes = 0;
  const missing = [];
  const paths = new Set();
  const sourceActions = new Map();
  for (const [id, character] of Object.entries(data)) {
    for (const action of COMPANION_WORLD_ART_ACTIONS) if (!character.actions[action]) missing.push(`${id}/${action}`);
    for (const [action, asset] of Object.entries(character.actions)) {
      if (paths.has(asset.url) || !asset.url.endsWith(`/${id}/actions/${action}.webp`)) throw new Error(`Action must own one independent file: ${id}/${action}`);
      paths.add(asset.url);
      if (asset.source?.action !== action || !asset.source?.sha256 || sourceActions.has(asset.source.sha256)) throw new Error(`Missing or reused action source: ${id}/${action}`);
      sourceActions.set(asset.source.sha256, `${id}/${action}`);
      const file = path.join(root, 'public', asset.url);
      const buffer = await fs.readFile(file);
      if (digest(buffer) !== asset.sha256) throw new Error(`Asset digest changed without its manifest: ${id}/${action}`);
      const { data: pixels, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== asset.frameWidth * 3 || info.height !== asset.frameHeight || asset.frameCount !== 3 || asset.frames.length !== 3) throw new Error(`Expected exactly three equal frames: ${id}/${action}`);
      for (let frame = 0; frame < 3; frame++) {
        let opaque = 0, transparent = 0, edge = 0;
        for (let y = 0; y < info.height; y++) for (let x = frame * asset.frameWidth; x < (frame + 1) * asset.frameWidth; x++) {
          const alpha = pixels[(y * info.width + x) * 4 + 3];
          if (alpha > 16) { opaque++; if (x === frame * asset.frameWidth || x === (frame + 1) * asset.frameWidth - 1 || y === 0 || y === info.height - 1) edge++; } else transparent++;
        }
        if (opaque < 100 || transparent < 100) throw new Error(`Empty frame or opaque backdrop: ${id}/${action}/${frame}`);
        if (edge > 8) throw new Error(`Clipped frame: ${id}/${action}/${frame}, edge pixels ${edge}`);
        const contacts = asset.frames[frame].contacts;
        const registration=asset.frames[frame].registration;
        if(!registration||!Number.isFinite(registration.anchor.x)||!Number.isFinite(registration.anchor.y))throw new Error(`Missing frame registration: ${id}/${action}/${frame}`);
        if (contacts.posture === 'standing' && !contacts.foot || contacts.posture === 'sitting' && !contacts.seat || contacts.posture === 'lying' && !contacts.bed) throw new Error(`Missing posture contact: ${id}/${action}/${frame}`);
      }
      count++; bytes += buffer.length;
    }
  }
  for (const id of ['sister', 'flash', 'huan-white', 'huan-black', 'gemini', 'gpt', 'grok', 'kimi', 'minimax', 'qwen', 'gugugaga', 'guga', 'doro', 'phoebe', 'phrolova']) if (!data[id]) missing.push(id);
  console.log(JSON.stringify({ characters: Object.keys(data).length, sheets: count, frames: count * 3, bytes, allIndependent: true, alpha: true, missing }, null, 2));
  if (command === 'verify' && missing.length) throw new Error(`${missing.length} required character/action sheets remain incomplete.`);
} else {
  throw new Error('Usage: node scripts/companion-world-art.mjs import <approved-source-project> | register <actions.json> | calibrate [report-directory] | verify | inspect');
}
