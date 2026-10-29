import fs from 'node:fs/promises';
import {startGateway} from './gateway.mjs';
const file=process.env.DAFEIYU_BRIDGE_CONFIG;
const config=JSON.parse(await fs.readFile(file,'utf8'));
if(!config.token||config.token.length<32)throw new Error('Missing private adapter token');
await fs.mkdir(config.tempRoot,{recursive:true,mode:0o700});
await startGateway(config,file);
