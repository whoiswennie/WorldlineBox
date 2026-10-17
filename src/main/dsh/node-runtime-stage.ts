import path from 'node:path';
import { lstat, mkdir, readdir, rename } from './disk';
import { assertOwnedDirectory, copyTree, safeRelative } from './files';
import { isFileBusyError, retryFileOperation } from './runtime-commit';
import type { OperationContext } from './operations';

/** Promote the owned installation rather than copying and deleting 60,000 files. */
export async function promoteNodeInstallation(staging: string, source: string, destination: string, operation: OperationContext): Promise<void> {
  await assertOwnedDirectory(staging, source);
  await assertOwnedDirectory(staging, path.dirname(destination));
  const existing = await lstat(destination).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(existing)throw Error('Installed runtime destination already exists.');
  let active=0;let count=0;let needsCopy=false;
  const queue: Array<() => void> = [];
  const limit = async <T>(work: () => Promise<T>): Promise<T> => {
    if(active>=32)await new Promise<void>(resolve=>queue.push(resolve));else active++;
    try{operation.signal.throwIfAborted();return await work();}
    finally{const waiting=queue.shift();if(waiting)waiting();else active--;}
  };
  const walk=async(directory:string,prefix:string):Promise<void>=>{
    const entries=await limit(()=>readdir(directory,{withFileTypes:true}));
    const results=await Promise.allSettled(entries.map(async entry=>{
      const relative=prefix?`${prefix}/${entry.name}`:entry.name;safeRelative(relative);
      if(++count>150_000)throw Error('Too many entries in installed runtime.');
      const file=path.join(directory,entry.name);const info=await limit(()=>lstat(file));
      if(info.isSymbolicLink()){needsCopy=true;return;}
      if(info.isDirectory())await walk(file,relative);
      else if(info.isFile()){if(info.nlink>1)needsCopy=true;}
      else throw Error('Unsupported installed runtime file.');
    }));
    const failure=results.find(result=>result.status==='rejected');
    if(failure?.status==='rejected')throw failure.reason;
  };
  await walk(source,'');operation.signal.throwIfAborted();
  if(!needsCopy){
    let moved=false;
    try{
      await retryFileOperation(()=>rename(source,destination),{signal:operation.signal});
      moved=true;
    }catch(error){
      operation.signal.throwIfAborted();
      if((error as NodeJS.ErrnoException).code!=='EXDEV'&&!isFileBusyError(error))throw error;
      await operation.log(`Installation directory move unavailable (${(error as NodeJS.ErrnoException).code??'error'}); using verified copy.`);
    }
    if(moved){await operation.log(`Promoted ${count} owned installation entries without copying; final SHA-256 sealing follows.`);return;}
  }
  // A link must be flattened to prevent any live relationship with another cache or directory.
  await mkdir(destination); // Exclusive creation: never merge after a Windows rename denial.
  await copyTree(source,destination,{signal:operation.signal,concurrency:16});
}
