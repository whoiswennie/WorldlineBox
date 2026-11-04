import path from 'node:path';
import {verifyBotStickers} from './bot-stickers-lib.mjs';
const root=path.resolve(process.argv.find(value=>value.startsWith('--root='))?.slice(7)||'resources/bot-stickers');
console.log(JSON.stringify(await verifyBotStickers(root)));
