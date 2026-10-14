import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';

export const baselineCommit='4a05bacd960bbb6dc9e5f77201c8294e486cdd86';
export const kitRoot=fileURLToPath(new URL('../../',import.meta.url));
export const baselineSource=execFileSync('git',['show',`${baselineCommit}:src/instance-update-ranges.ts`],{
  cwd:kitRoot,encoding:'utf8',maxBuffer:1024*1024,
});
export const candidateSource=readFileSync(new URL('../../src/instance-update-ranges.ts',import.meta.url),'utf8');
export const sha256=source=>createHash('sha256').update(source).digest('hex');
// Execute the exact committed class, with only Node's built-in type erasure.
const source=stripTypeScriptTypes(baselineSource,{mode:'strip'});
export const {InstanceUpdateRanges:BaselineInstanceUpdateRanges}=await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
