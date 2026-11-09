import {zstdDecompressSync} from 'node:zlib';

/** DSH v4 appends independent Zstandard frames. The one-shot Node API reads
 * one frame, so a successful first decode alone only proves the header. */
export function decodeDshZstdFrames(bytes:Buffer):Buffer<ArrayBuffer>{
  const frames:Buffer[]=[];let offset=0;
  while(offset<bytes.length){
    // @types/node currently omits the supported info:true result overload.
    const decoded=zstdDecompressSync(bytes.subarray(offset),{info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
    const consumed=decoded.engine.bytesWritten;
    if(!Number.isSafeInteger(consumed)||consumed<=0||consumed>bytes.length-offset)throw Error('Native journal decoder made invalid progress.');
    frames.push(decoded.buffer);offset+=consumed;
  }
  return Buffer.concat(frames);
}
