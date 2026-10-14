import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {buildTreeFoliageMipPixels,installTreeFoliageCoverageMipmaps,TREE_FOLIAGE_MIPS_VERSION} from '../src/tree-foliage-mips.ts';

const makePixels=(w,h,fn)=>{
  const data=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)data.set(fn(x,y),(y*w+x)*4);
  return data;
};
const coverage=(data,w,h,cutoff=128)=>{
  let count=0;for(let i=3;i<data.length;i+=4)if(data[i]>=cutoff)count++;
  return count/(w*h);
};
const cellCoverage=(level,columns=4,rows=4,cutoff=128)=>{
  const cw=level.width/columns,ch=level.height/rows,out=[];
  for(let cy=0;cy<rows;cy++)for(let cx=0;cx<columns;cx++){
    let n=0;for(let y=cy*ch;y<(cy+1)*ch;y++)for(let x=cx*cw;x<(cx+1)*cw;x++)if(level.data[(y*level.width+x)*4+3]>=cutoff)n++;
    out.push(n/(cw*ch));
  }
  return out;
};

test('builds deterministic explicit mip levels and preserves base pixels and per-cell coverage where representable',()=>{
  const width=32,height=32,source=makePixels(width,height,(x,y)=>{
    const cellX=Math.floor(x/8),cellY=Math.floor(y/8),on=(x%8)<4;
    return [40+cellX*35,70+cellY*25,120,on?255:0];
  });
  const before=new Uint8ClampedArray(source);
  const chain=buildTreeFoliageMipPixels(width,height,source);
  const again=buildTreeFoliageMipPixels(width,height,source);
  assert.equal(TREE_FOLIAGE_MIPS_VERSION,'tree-foliage-coverage-mips-1');
  assert.deepEqual([...source],[...before]);
  assert.deepEqual(chain.levels.map(x=>[x.width,x.height]),[[32,32],[16,16],[8,8],[4,4],[2,2],[1,1]]);
  assert.deepEqual(chain.levels.map(level=>[...level.data]),again.levels.map(level=>[...level.data]));
  assert.deepEqual(chain.report.map(x=>x.mode),['per-cell','per-cell','per-cell','per-cell','global-tail','global-tail']);
  assert.deepEqual(chain.baseCellCoverage,Array(16).fill(.5));
	for(let level=1;level<=2;level++)assert.deepEqual(cellCoverage(chain.levels[level]),Array(16).fill(.5));
	assert.ok(chain.report.slice(1,3).every(x=>x.perCellCoverage.every(value=>value===.5)));
	assert.ok(chain.report[3].perCellCoverage.every(value=>value===0),'one texel per cell cannot represent 50%; exact ties prefer undercoverage');
  assert.ok(chain.report.slice(4).every(x=>x.perCellCoverage.every(value=>value===null)));
});

test('small cells choose the nearest representable coverage and prefer undercoverage at exact ties',()=>{
  const source=makePixels(8,8,()=>[255,0,0,0]);
  for(let cy=0;cy<4;cy++)for(let cx=0;cx<4;cx++)source[((cy*2)*8+cx*2)*4+3]=255;
	const chain=buildTreeFoliageMipPixels(8,8,source);
  assert.equal(chain.baseCoverage,.25);
  const lastPerCell=chain.levels[1];
  assert.ok(lastPerCell.width>=4);
  const next=chain.levels[2];
  assert.deepEqual(cellCoverage(next),Array(16).fill(0),'a one-pixel cell cannot represent 25% and ties resolve downward');
  assert.ok(chain.report[2].coverageError<=0);
});

test('filters RGB in linear light with alpha weighting and avoids transparent-color halos',()=>{
  const source=makePixels(8,8,(x,y)=>{
    const blockX=Math.floor(x/2),blockY=Math.floor(y/2),block=blockY*4+blockX;
    const opaqueCount=block<8?2:block===8?0:4,inside=(y%2)*2+(x%2);
    return inside<opaqueCount?[0,0,0,255]:[255,255,255,0];
  });
  const chain=buildTreeFoliageMipPixels(8,8,source,{cellColumns:1,cellRows:1});
  const first=chain.levels[1].data;
  const p=Array.from({length:first.length/4},(_,index)=>index*4).find(index=>first[index+3]>=128);
  assert.notEqual(p,undefined,'the remapped target retains some opaque samples');
	assert.equal(first[p],0);assert.equal(first[p+1],0);assert.equal(first[p+2],0);
	assert.ok(first[p+3]>=128,'coverage remap makes representative pixels pass the authored cutoff');
  // Three transparent texels are white; alpha-weighting keeps their RGB out.
});

test('supports clamped and ordinary byte arrays while rejecting malformed dimensions and options',()=>{
  const clamped=makePixels(8,8,()=>[10,20,30,255]);
  assert.equal(buildTreeFoliageMipPixels(8,8,clamped).levels.length,4);
  assert.equal(buildTreeFoliageMipPixels(8,8,new Uint8Array(clamped)).levels.length,4);
  for(const args of [
    [8,4,clamped,{}],[12,12,new Uint8ClampedArray(12*12*4),{}],[8,8,new Uint8Array(12),{}],
    [8,8,clamped,{alphaCutoff:0}],[8,8,clamped,{alphaCutoff:1}],[8,8,clamped,{cellColumns:3}],
    [8,8,clamped,{cellRows:3}],[8,8,clamped,{cellColumns:0}],[8,8,clamped,{alphaCutoff:NaN}],
  ])assert.throws(()=>buildTreeFoliageMipPixels(...args));
});

class MockCanvas {
  constructor(width,height){this.width=width;this.height=height;this.pixels=new Uint8ClampedArray(width*height*4);this.uploads=[];}
  getContext(){
    const canvas=this;
    return {
      drawImage(image){canvas.pixels.set(image.pixels);},
      getImageData(){return {data:new Uint8ClampedArray(canvas.pixels)};},
      createImageData(width,height){return {data:new Uint8ClampedArray(width*height*4)};},
      putImageData(image){canvas.pixels.set(image.data);},
    };
  }
}

test('installs regular mip image sources on the same texture and restores it on dispose',async()=>{
  const old=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=MockCanvas;
  try{
    const image=new MockCanvas(16,16);image.pixels=makePixels(16,16,(x,y)=>[20+x,50+y,90,((x+y)%2)?255:0]);
    const texture=new THREE.Texture(image);texture.generateMipmaps=true;texture.mipmaps=[];
    const oldMipmaps=texture.mipmaps,version=texture.version;
    const installed=await installTreeFoliageCoverageMipmaps(texture);
    await assert.rejects(()=>installTreeFoliageCoverageMipmaps(texture),/already installed/);
    assert.ok(texture.version>version);
    assert.equal(texture.generateMipmaps,false);
    assert.equal(texture.mipmaps.length,5);
    assert.equal(texture.mipmaps[0],image);
    assert.deepEqual(texture.mipmaps.slice(1).map(level=>[level.width,level.height]),[[8,8],[4,4],[2,2],[1,1]]);
    assert.ok(texture.mipmaps.slice(1).every(level=>level instanceof MockCanvas));
    assert.equal(installed.cellGrid[0],4);
    const mipSources=texture.mipmaps;
    installed.dispose();
    assert.equal(texture.mipmaps,oldMipmaps);
    assert.equal(texture.generateMipmaps,true);
    assert.ok(mipSources.slice(1).every(level=>level.width===0&&level.height===0));
    installed.dispose();
    const reinstalled=await installTreeFoliageCoverageMipmaps(texture);
    reinstalled.dispose();
  }finally{globalThis.OffscreenCanvas=old;}
});
