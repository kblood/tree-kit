import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CompactInstanceSlots} from '../src/compact-instance-slots.ts';

const fixture=()=>{
 const pool=new CompactInstanceSlots(8,x=>x.id),gpu=[],writes=[];
 const write=(i,x,old)=>{assert.ok(i<=gpu.length,'no initial GPU slot gaps');
  if(old!==x){gpu[i]=x.id;writes.push([i,x.id]);}return x;};
 const apply=items=>{const count=pool.reconcile(items,write);return gpu.slice(0,count);};
 return{pool,gpu,writes,apply};
};
test('dense slots preserve identities through reorder, departures and replacement',()=>{
 const {pool,writes,apply}=fixture(),a={id:'a'},b={id:'b'},c={id:'c'},d={id:'d'};
 assert.deepEqual(apply([a,b,c,d]),['a','b','c','d']);writes.length=0;
 assert.deepEqual(apply([d,c,b,a]),['a','b','c','d']);assert.equal(writes.length,0);
 assert.deepEqual(apply([a,c,d]),['a','d','c']);assert.deepEqual(writes,[[1,'d']]);
 assert.deepEqual(apply([{id:'d'},a]),['a','d']);
 assert.deepEqual(apply([]),[]);assert.equal(pool.states.length,0);
 assert.deepEqual(apply([c]),['c']);
});
test('duplicate and over-capacity demand is rejected before changing slots',()=>{
 const {pool,apply}=fixture(),a={id:'a'};apply([a]);
 assert.throws(()=>apply([a,a]),/Duplicate/);assert.deepEqual(pool.items,[a]);
 assert.throws(()=>apply(Array.from({length:9},(_,i)=>({id:String(i)}))),/capacity/);
 assert.deepEqual(pool.items,[a]);
});
test('randomized demand retains exact membership with contiguous initialized slots',()=>{
 const {pool,apply}=fixture(),all=Array.from({length:8},(_,i)=>({id:String(i)}));
 let seed=1234;const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32);
 for(let n=0;n<1000;n++){
  const wanted=all.filter(()=>random()>.4).sort(()=>random()-.5);
  const gpu=apply(wanted);assert.deepEqual([...gpu].sort(),wanted.map(x=>x.id).sort());
  assert.equal(new Set(gpu).size,gpu.length);assert.equal(pool.states.length,gpu.length);
 }
});
test('marked reconcile matches keyed reconcile slot for slot, write for write',()=>{
 // Identities are re-created with fresh objects sometimes, as the forest's
 // habitat cache replaces residents; hints are sometimes stale or wrong.
 let seed=99;const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32);
 const keyed=new CompactInstanceSlots(12,x=>x.id),marked=new CompactInstanceSlots(12,x=>x.id);
 const log=[[],[]],writer=k=>(i,x,old)=>{log[k].push([i,x.id,x.v,old?.id??null,old?.v??null]);return x;};
 let current=new Map(Array.from({length:16},(_,i)=>[String(i),{id:String(i),v:0}]));
 for(let n=0;n<2000;n++){
  if(random()<.3){const id=String(Math.floor(random()*16));current.set(id,{id,v:n});}
  const wanted=[...current.values()].filter(()=>random()>.45).sort(()=>random()-.5).slice(0,12);
  const ids=new Set(wanted.map(x=>x.id));
  keyed.reconcile(wanted,writer(0));
  marked.reconcileMarked(wanted,writer(1),x=>ids.has(x.id),x=>random()<.2?Math.floor(random()*14)-1:marked.items.indexOf(x));
  assert.deepEqual(log[1],log[0]);assert.deepEqual(marked.items,keyed.items);assert.deepEqual(marked.states,keyed.states);
  log[0].length=0;log[1].length=0;
 }
});
