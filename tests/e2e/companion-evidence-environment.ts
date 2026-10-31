import {createHash} from 'node:crypto';
import {createReadStream,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {extractFile} from '@electron/asar';
import {expect,type ElectronApplication} from '@playwright/test';
import {resolveElectronAppPath} from './electron-test-helpers';

export const companionEvidenceName=(name:string)=>process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE?'packaged-'+name:name;
export function developmentCompanionToolHost():string{const value:unknown=createRequire(path.resolve('package.json'))('electron');if(typeof value!=='string')throw new Error('Development Electron tool host unavailable');return value;}
async function fileHash(file:string):Promise<string>{const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes as Buffer);return hash.digest('hex');}
export async function companionEvidenceEnvironment(application:ElectronApplication,profile:string){
  const actual=await application.evaluate(({app})=>({isPackaged:app.isPackaged,appPath:app.getAppPath(),userData:app.getPath('userData'),executablePath:app.getPath('exe'),electronVersion:process.versions.electron}));
  const packaged=!!process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE;expect(actual.isPackaged).toBe(packaged);expect(path.resolve(actual.userData)).toBe(path.resolve(profile));
  if(packaged){expect(actual.appPath).toMatch(/app\.asar$/u);expect(path.resolve(actual.executablePath)).toBe(path.resolve(process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE!));}
  else expect(path.resolve(actual.appPath)).toBe(path.resolve(resolveElectronAppPath()));
  // @electron/asar walks archive keys with the current platform's path.sep.
  const workerRelative=path.join('.vite','build','companion_worker.js'),worker=packaged?extractFile(actual.appPath,workerRelative):readFileSync(path.join(actual.appPath,workerRelative));
  return{...actual,appAsarHash:packaged?await fileHash(actual.appPath):undefined,companionWorkerPath:path.join(actual.appPath,workerRelative),companionWorkerHash:createHash('sha256').update(worker).digest('hex'),isolatedProfile:true};
}
export type CompanionEvidenceEnvironment=Awaited<ReturnType<typeof companionEvidenceEnvironment>>;
