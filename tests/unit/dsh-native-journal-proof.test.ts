import {expect,it} from 'vitest';
import {zstdCompressSync} from 'node:zlib';
import {decodeDshZstdFrames} from '../helpers/dsh-native-journal';
it('reads native events in every appended frame rather than verifying only a session header',()=>{
  const header='{"type":"session"}\n',body='{"type":"session/title","data":{"title":"renamed"}}\n',tail='{"type":"assistant/message"}\n';
  expect(decodeDshZstdFrames(Buffer.concat([zstdCompressSync(header),zstdCompressSync(body),zstdCompressSync(tail)])).toString()).toBe(header+body+tail);
});
it('rejects an incomplete appended frame rather than reporting an absent native title as success',()=>{
  const frame=zstdCompressSync('a native event\n');expect(()=>decodeDshZstdFrames(frame.subarray(0,frame.length-2))).toThrow();
});
