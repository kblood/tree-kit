import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {BufferAttribute} from 'three';
import {InstanceUpdateRanges} from '../src/instance-update-ranges.ts';
import {BaselineInstanceUpdateRanges,baselineCommit,baselineSource,candidateSource,sha256} from '../tests/helpers/instance-update-ranges-baseline.mjs';

// Fixed, precomputed row edits: timing includes include/flush/renderer clearing,
// but excludes generation, attributes, parity assertions and JSON reporting.
let seed=0x74726565;
const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32);
const frames=(count,batches,indices,consume)=>Array.from({length:count},(_,frame)=>({
  batches:Array.from({length:batches},(_,batch)=>Uint32Array.from(indices(frame,batch))),consume:consume(frame),
}));
const workloads=[
  {name:'sequential-immediate-flush',itemSize:4,ArrayType:Float32Array,
    frames:frames(16,256,(f,b)=>[b],()=>true)},
  {name:'sparse-immediate-flush',itemSize:16,ArrayType:Float32Array,
    frames:frames(16,64,()=>[Math.floor(random()*4096)],()=>true)},
  {name:'multi-include-row-swaps',itemSize:3,ArrayType:Float32Array,
    frames:frames(16,128,(f,b)=>[b,255-b],()=>true)},
  {name:'hidden-frame-retained-uploads',itemSize:2,ArrayType:Uint16Array,
    frames:frames(24,128,(f,b)=>[(f*128+b)%4096],f=>f%8===7)},
  {name:'zero-work-retained-upload',itemSize:4,ArrayType:Float32Array,
    frames:frames(24,128,()=>[],()=>false)},
];

function driver(Class,workload){
  const ranges=new Class(),attribute=new BufferAttribute(new workload.ArrayType(4096*workload.itemSize),workload.itemSize);
  if(workload.name.startsWith('zero-work')){attribute.addUpdateRange(12,8);attribute.needsUpdate=true;}
  return {ranges,attribute};
}
function run(context,workload,iterations){
  const {ranges,attribute}=context;let bytes=0;
  for(let iteration=0;iteration<iterations;iteration++)for(const frame of workload.frames){
    for(const indices of frame.batches){
      for(let j=0;j<indices.length;j++)ranges.include(indices[j],workload.itemSize);
      bytes+=ranges.flush(attribute);
    }
    if(frame.consume)attribute.clearUpdateRanges();
  }
  return bytes;
}
const snapshot=context=>({ranges:context.attribute.updateRanges.map(range=>({...range})),
  version:context.attribute.version,pending:context.ranges.ranges.map(range=>({...range})),
  data:Buffer.from(context.attribute.array.buffer)});
function parity(workload){
  const pair=[BaselineInstanceUpdateRanges,InstanceUpdateRanges].map(Class=>driver(Class,workload));
  let batches=0;
  for(const frame of workload.frames){
    for(const indices of frame.batches){
      const bytes=pair.map(context=>{
        for(const index of indices)context.ranges.include(index,workload.itemSize);
        return context.ranges.flush(context.attribute);
      });
      assert.equal(bytes[1],bytes[0]);assert.deepEqual(snapshot(pair[1]),snapshot(pair[0]));batches++;
    }
    if(frame.consume)for(const context of pair)context.attribute.clearUpdateRanges();
    assert.deepEqual(snapshot(pair[1]),snapshot(pair[0]));
  }
  return batches;
}
function measured(Class,workload,iterations){
  const context=driver(Class,workload),start=performance.now();
  const bytes=run(context,workload,iterations),elapsedMs=performance.now()-start;
  return {elapsedMs,bytes,context};
}
function paired(workload,iterations,candidateFirst){
  let baseline,candidate;
  if(candidateFirst){candidate=measured(InstanceUpdateRanges,workload,iterations);baseline=measured(BaselineInstanceUpdateRanges,workload,iterations);}
  else {baseline=measured(BaselineInstanceUpdateRanges,workload,iterations);candidate=measured(InstanceUpdateRanges,workload,iterations);}
  // Checks happen after both timers have stopped.
  assert.equal(candidate.bytes,baseline.bytes);assert.deepEqual(snapshot(candidate.context),snapshot(baseline.context));
  return {order:candidateFirst?'candidate/baseline':'baseline/candidate',baselineMs:baseline.elapsedMs,
    candidateMs:candidate.elapsedMs,ratio:candidate.elapsedMs/baseline.elapsedMs,bytes:baseline.bytes,
    version:baseline.context.attribute.version};
}
const median=values=>{const sorted=values.toSorted((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];};
const iterations=Number(process.env.TREE_RANGE_BENCH_ITERATIONS??40);
const trials=Number(process.env.TREE_RANGE_BENCH_TRIALS??11);
const warmupPairs=4;
assert.ok(Number.isInteger(iterations)&&iterations>=1,'iterations must be a positive integer');
assert.ok(Number.isInteger(trials)&&trials>=9,'at least nine paired trials are required');
const results=[];
const threeEntry=import.meta.resolve('three');
const threeVersion=JSON.parse(readFileSync(new URL('../package.json',threeEntry),'utf8')).version;
for(const [index,workload] of workloads.entries()){
  const parityBatches=parity(workload);
  for(let warmup=0;warmup<warmupPairs;warmup++)paired(workload,iterations,(warmup+index)%2===1);
  const raw=Array.from({length:trials},(_,trial)=>({trial:trial+1,...paired(workload,iterations,(trial+index)%2===1)}));
  const baselineMedianMs=median(raw.map(row=>row.baselineMs)),candidateMedianMs=median(raw.map(row=>row.candidateMs));
  results.push({name:workload.name,itemSize:workload.itemSize,arrayType:workload.ArrayType.name,
    frames:workload.frames.length,batchesPerIteration:parityBatches,
    includesPerIteration:workload.frames.reduce((n,f)=>n+f.batches.reduce((m,b)=>m+b.length,0),0),
    workloadSha256:sha256(JSON.stringify(workload.frames.map(f=>({batches:f.batches.map(b=>[...b]),consume:f.consume})))),
    baselineMedianMs,candidateMedianMs,medianPairedRatio:median(raw.map(row=>row.ratio)),
    medianPairedChangePercent:100*(median(raw.map(row=>row.ratio))-1),raw});
}
process.stdout.write(JSON.stringify({benchmark:'InstanceUpdateRanges include/flush CPU bookkeeping',
  baselineCommit,sourceHashes:{baselineSha256:sha256(baselineSource),candidateSha256:sha256(candidateSource),
    harnessSha256:sha256(readFileSync(new URL(import.meta.url)))},
  environment:{node:process.version,v8:process.versions.v8,three:threeVersion,
    platform:process.platform,arch:process.arch,os:os.release(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,
    totalMemoryBytes:os.totalmem(),execArgv:process.execArgv},
  iterations,trials,warmupPairs,seed:'0x74726565',
  method:'One process; precomputed workloads; four excluded alternating warmup pairs per workload; alternating trial order; setup and parity outside timers; no forced GC. Milliseconds measure include/flush and simulated renderer clearing, not GPU work.',
  results},null,2)+'\n');
