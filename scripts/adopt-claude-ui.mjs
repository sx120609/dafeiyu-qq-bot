import fs from 'node:fs';
const before=fs.readFileSync('console/index.html','utf8');
const after=fs.readFileSync('.runtime/claude-ui/index.html','utf8');
const ids=s=>[...s.matchAll(/id="([^"]+)"/g)].map(m=>m[1]);
const missing=ids(before).filter(id=>!ids(after).includes(id));
const duplicates=ids(after).filter((id,i,a)=>a.indexOf(id)!==i);
if(missing.length||duplicates.length)throw Error(JSON.stringify({missing,duplicates}));
fs.mkdirSync('.runtime/ui-before-claude',{recursive:true});
for(const file of ['index.html','style.css']){
  const backup='.runtime/ui-before-claude/'+file;
  if(!fs.existsSync(backup))fs.copyFileSync('console/'+file,backup);
  fs.copyFileSync('.runtime/claude-ui/'+file,'console/'+file);
}
const receipt=JSON.parse(fs.readFileSync('.runtime/claude-ui/result.json','utf8'));
console.log(JSON.stringify({idsPreserved:true,rewriter:Object.keys(receipt.modelUsage),changed:['index.html','style.css']}));
