import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from './disk';
import { contained, safeRelative } from './files';
import { launchCli, terminateOwnedProcess, type RuntimeLaunchPlan } from './instance-process';
import { retryFileOperation } from './runtime-commit';
import { writeSharedWorkspaceAdapter } from './shared-workspace-adapter';
import { runtimeProgramDirectory } from './runtime-sdk';
import { buildPrivateSkillRouting } from './private-skills-routing';

export interface TechnicalRoutingPatch { id: string; config: Record<string, unknown> }
export interface SharedCredentialsMigration {
  format: 'worldlinebox-dsh-credentials-migration-v1';
  sourceInstanceId: string; sourcePath: string; destinationPath: string; runtimeVersion: string;
  importedRefs: string[]; importedRecords: string[];
  identicalRefs: string[]; identicalRecords: string[];
  conflicts: Array<{ section: 'refs' | 'records'; key: string }>;
  sourcePresent: boolean; dryRun: boolean; createdAt: string;
}

export function credentialRoutingPatches(sharedRoot: string): TechnicalRoutingPatch[] {
  return [{ id: 'credentials', config: { path: path.join(path.resolve(sharedRoot), '.credentials.yaml'), watch: true } }];
}

async function ownedDirectory(ownerRoot: string, relativePath: string): Promise<string> {
  const root = await realpath(ownerRoot);
  const directory = contained(root, safeRelative(relativePath));
  let current = root;
  for (const component of path.relative(root, directory).split(path.sep)) {
    current = path.join(current, component);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Launcher adapter metadata requires owned regular directories.');
    if (!info) await mkdir(current, { mode: 0o700 });
    const actual = await realpath(current);
    if (path.relative(root, actual) !== path.relative(root, current)) throw new Error('The launcher adapter directory resolves outside its owned storage.');
  }
  return current;
}

/** Only immutable technical locations are overlays; editable GUI/model fields stay out. */
export async function writeTechnicalRoutingPatch(options: {
  instanceRoot: string; sharedRoot: string; runtimeVersion: string;
  patches?: readonly TechnicalRoutingPatch[]; signal?: AbortSignal; workspacePath?: string; programDirectory?: string;
}): Promise<string> {
  const allowed = new Set(['credentials', 'session-persistence-jsonl', 'attachment-local', 'workspace-controller']);
  const patches = [...credentialRoutingPatches(options.sharedRoot), ...(options.patches ?? [])];
  const ids = new Set<string>();
  for (const patch of patches) {
    if (!allowed.has(patch.id) || ids.has(patch.id)) throw new Error('Unsupported or duplicated technical shared-data routing entry.');
    ids.add(patch.id);
  }
  const directory = await ownedDirectory(options.instanceRoot, 'launcher');
  const skillPatches = options.programDirectory ? await buildPrivateSkillRouting(options.instanceRoot, options.programDirectory, options.runtimeVersion, options.signal) : [];
  const workspaceAdapter = options.workspacePath ? await writeSharedWorkspaceAdapter({ instanceRoot: options.instanceRoot,
    workspacePath: options.workspacePath, runtimeVersion: options.runtimeVersion, signal: options.signal }) : undefined;
  const file = path.join(directory, 'shared-data.patch.yml'); const temporary = `${file}.${randomUUID()}.tmp`;
  options.signal?.throwIfAborted();
  // JSON is a YAML subset. Preset expressions remain inert SDK expression objects;
  // native DSH evaluates its own private composition, while manager-owned rows contain only routing data.
  await writeFile(temporary, `${JSON.stringify([...patches, ...skillPatches, ...(workspaceAdapter ? [{ insert: [{ id: workspaceAdapter.id, name: workspaceAdapter.name, config: workspaceAdapter.config }] }] : [])], null, 2)}\n`, { flag: 'wx', mode: 0o600, signal: options.signal });
  await retryFileOperation(() => rename(temporary, file), { signal: options.signal });
  return file;
}

/**
 * Run the pinned native document parser/atomic writer in its own runtime. This
 * shares the exact .credentials.yaml.lock protocol used by live Harness Hosts;
 * no credentials are materialized into process arguments, environment or logs.
 */
export async function migrateSharedCredentials(options: {
  instanceRoot: string; sourceInstanceId: string; sharedRoot: string; runtimeVersion: string;
  sourceRelativePath?: string; dryRun?: boolean; plan: RuntimeLaunchPlan; env: NodeJS.ProcessEnv; signal?: AbortSignal;
}): Promise<SharedCredentialsMigration> {
  safeRelative(options.sourceInstanceId);
  const root = await realpath(options.instanceRoot);
  const sourceRelative = safeRelative(options.sourceRelativePath ?? 'home/.credentials.yaml');
  const source = contained(root, sourceRelative);
  const sourceStat = await lstat(source).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (sourceStat && (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 8 * 1024 * 1024)) throw new Error('The source credentials document is not an owned regular file within the size limit.');
  if (sourceStat && await realpath(source) !== source) throw new Error('The source credentials document resolves outside its private home.');
  await mkdir(options.sharedRoot, { recursive: true, mode: 0o700 });
  const sharedStat = await lstat(options.sharedRoot);
  if (!sharedStat.isDirectory() || sharedStat.isSymbolicLink()) throw new Error('Shared credential storage must be an owned regular directory.');
  const sharedRoot = await realpath(options.sharedRoot);
  const destination = path.join(sharedRoot, '.credentials.yaml');
  if (source.toLowerCase() === destination.toLowerCase()) throw new Error('Credential migration requires a distinct private source and shared destination.');
  const target = await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (target && (!target.isFile() || target.isSymbolicLink() || target.size > 8 * 1024 * 1024)) throw new Error('The shared credentials document is not an owned regular file within the size limit.');
  // A sealed backup may be the source: write tooling and provenance under the
  // destination owner, never add files to the source inventory.
  const directory = await ownedDirectory(sharedRoot, '.migration-tools');
  const recordsDirectory = await ownedDirectory(sharedRoot, 'migration-records/credentials');
  const script = path.join(directory, `credential-migration-${randomUUID()}.mjs`);
  const scriptTemporary = `${script}.${randomUUID()}.tmp`;
  await writeFile(scriptTemporary, NATIVE_CREDENTIAL_MIGRATION_SOURCE, { mode: 0o600, flag: 'wx', signal: options.signal });
  await retryFileOperation(() => rename(scriptTemporary, script), { signal: options.signal });
  const receipt = path.join(recordsDirectory, `credentials-migration-${randomUUID()}.json`);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(65_000)]);
  signal.throwIfAborted();
  const child = await launchCli({ ...options.plan, cli: script },
    [runtimeProgramDirectory(options.plan.executable), source, destination, receipt, options.sourceInstanceId, options.runtimeVersion, options.dryRun ? '1' : '0'],
    options.env, root);
  const abort = () => { void terminateOwnedProcess(child).catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  // Error text from a supplied YAML document can contain secrets. The child
  // emits only a fixed diagnostic class; arbitrary output is drained privately.
  child.stdout.resume(); child.stderr.resume();
  try {
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (signal.aborted) abort();
    const code = await exited; signal.throwIfAborted();
    if (code !== 0) throw new Error('Native credential migration was refused; the source document and existing shared credentials were preserved.');
    const report = JSON.parse(await readFile(receipt, 'utf8')) as SharedCredentialsMigration;
    if (report.format !== 'worldlinebox-dsh-credentials-migration-v1' || report.sourceInstanceId !== options.sourceInstanceId
      || report.destinationPath !== destination || report.dryRun !== Boolean(options.dryRun)) throw new Error('Credential migration returned an invalid provenance receipt.');
    return report;
  } finally {
    signal.removeEventListener('abort', abort); await terminateOwnedProcess(child);
    // The receipt is intentionally retained for provenance; the adapter has no secret values.
    await rm(script, { force: true }).catch(() => undefined);
  }
}

export const NATIVE_CREDENTIAL_MIGRATION_SOURCE = `
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const [program,source,destination,receipt,instanceId,runtimeVersion,dryRunFlag]=process.argv.slice(2);
const dryRun=dryRunFlag==='1';
const sdk=existsSync(join(program,'node-runtime.json'))?join(program,'dsh/node_modules'):join(program,'resources/app.asar/dsh/node_modules');
const load=createRequire(join(sdk,'@deepseek-ai/dsh/package.json'));
const {withFileLock,writeFileAtomic}=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-atomic-write')));
const {parseCredentialsDocument,renderFlatLayoutMigration}=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-credentials-local')));
const {parseDocument,isMap}=load('yaml');
async function readOwned(file) {
  const stat=await lstat(file).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(!stat)return undefined;
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw new Error('CREDENTIAL_FILE_REFUSED');
  return readFile(file,'utf8');
}
function parse(text,file) {
  const accepted=renderFlatLayoutMigration(text)??text;
  return {text:accepted,data:parseCredentialsDocument(accepted,file)};
}
try {
  const sourceText=await withFileLock(source,()=>readOwned(source),{waitMs:30000});
  const original=parse(sourceText??'',source);
  const report={format:'worldlinebox-dsh-credentials-migration-v1',sourceInstanceId:instanceId,sourcePath:source,destinationPath:destination,runtimeVersion,sourcePresent:sourceText!==undefined,dryRun,importedRefs:[],importedRecords:[],identicalRefs:[],identicalRecords:[],conflicts:[],createdAt:new Date().toISOString()};
  await mkdir(dirname(destination),{recursive:true,mode:0o700});
  await withFileLock(destination,async()=>{
    const targetText=await readOwned(destination);const current=parse(targetText??'',destination);
    const document=parseDocument(current.text,{uniqueKeys:true});
    if(!isMap(document.contents))document.contents=document.createNode({version:1});
    document.set('version',1);
    for(const section of ['refs','records']) {
      const sourceEntries=original.data[section],targetEntries=current.data[section];
      for(const [key,value] of sourceEntries) {
        if(targetEntries.has(key)) {
          if(isDeepStrictEqual(targetEntries.get(key),value))report[section==='refs'?'identicalRefs':'identicalRecords'].push(key);
          else report.conflicts.push({section,key});
        } else {
          if(!isMap(document.get(section,true)))document.set(section,document.createNode({}));
          document.setIn([section,key],document.createNode(value));
          report[section==='refs'?'importedRefs':'importedRecords'].push(key);
        }
      }
    }
    const next=String(document);parseCredentialsDocument(next,destination);
    if(!dryRun&&next!==targetText)await writeFileAtomic(destination,next,{mode:0o600,dirMode:0o700});
    await writeFileAtomic(receipt,JSON.stringify(report,null,2)+'\\n',{mode:0o600,dirMode:0o700});
  },{waitMs:30000});
} catch {
  // YAML errors and provider records can quote input values: never forward them.
  console.error('CREDENTIAL_MIGRATION_REFUSED');process.exitCode=1;
}
`;
