import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const temporary=path.join(root,'.runtime','test-temp');
await fs.mkdir(temporary,{recursive:true});
const files=(await fs.readdir(path.join(root,'tests'))).filter(name=>name.endsWith('.test.mjs')).map(name=>path.join(root,'tests',name));
const child=spawn(process.execPath,['--test',...files],{cwd:root,stdio:'inherit',env:{...process.env,TEMP:temporary,TMP:temporary,TMPDIR:temporary}});
child.on('exit',code=>process.exitCode=code??1);
