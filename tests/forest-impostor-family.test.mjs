import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {ForestImpostors} from '../src/forest-impostor.ts';
import {packForestPresentation} from '../src/forest-presentation.ts';
import {forestStructuralVariants,forestVariantCrownWeight} from '../src/tree-structural-variant.ts';

function presentation(){return {enabled:true,lod1Profile:{referenceHeightM:16,maxLeafOffsetM:.8,
  bands:Array.from({length:4},(_,i)=>({centerM:[.1,2+i*4,-.1],radiusM:3-i*.5,halfHeightM:1.8,populated:i>0,count:i>0?4:0}))},
  conservativeBounds:{radiusM:26},barkLinearRgb:[.12,.08,.05],foliageLinearRgb:[.025,.085,.014]};}

test('family profile updates uniforms and packed appearance updates only the existing parameter channel',()=>{
  const f=new ForestImpostors(128);
  try{
    f.write(1,new THREE.Vector3(10,20,30),16,new THREE.Quaternion(),.3,120);f.commit();
    const before=[f.positions.version,f.rotations.version,f.ownership.version];
    f.setFamilyPresentation('branching',presentation());
    assert.equal(f.uniforms.treeFamilyBounds.value.x,26);
    assert.equal(f.uniforms.treeFamilyBands.value[0].w,-1,'empty band never draws');
    assert.deepEqual(f.uniforms.treeFamilyBands.value[2].toArray(),[.1,10,-.1,2]);
    assert.deepEqual(f.uniforms.treeFamilyBandExtent.value[2].toArray(),[1.8,.8]);
    const code=packForestPresentation('branching',.95,1.08);
    f.setPresentation(1,code);assert.equal(f.commit(),64*16);
    assert.equal(f.parameters.getZ(1),code);assert.equal(f.familyBoundRadius(1),26);
    assert.deepEqual([f.positions.version,f.rotations.version,f.ownership.version],before);
    f.setPresentation(1,code);assert.equal(f.commit(),0);
    f.setFamilyPresentation('branching',null);assert.equal(f.familyBoundRadius(1),0);
    assert.equal(f.parameters.getZ(1),code,'disabled family falls back through a uniform without clearing every slot');
    f.write(1,new THREE.Vector3(),16,new THREE.Quaternion(),.3,120);assert.equal(f.parameters.getZ(1),0,'reused slot clears old appearance');
    for(const slot of [-1,.5,128,NaN])assert.throws(()=>f.setPresentation(slot,0));
    for(const code of [3,Infinity,262143])assert.throws(()=>f.setPresentation(1,code));
  }finally{f.dispose();}
});

test('invalid profile is rejected before changing the active family uniforms',()=>{
  const f=new ForestImpostors(8);
  try{
    f.setFamilyPresentation('spire',presentation());
    for(const mutate of [p=>p.lod1Profile.referenceHeightM=12,p=>p.lod1Profile.bands[1].radiusM=-1,
      p=>p.conservativeBounds.radiusM=NaN,p=>p.foliageLinearRgb[0]=Infinity]){
      const p=presentation();mutate(p);assert.throws(()=>f.setFamilyPresentation('spire',p));
      assert.equal(f.uniforms.treeFamilyBounds.value.y,26);
    }
    const first=presentation();first.barkLinearRgb=[.8,.2,.1];const second=presentation();second.conservativeBounds.radiusM=NaN;
    const before=f.uniforms.treeFamilyBark.value.map(v=>v.toArray());
    assert.throws(()=>f.setFamilyPresentations(new Map([['branching',first],['spire',second]])));
    assert.deepEqual(f.uniforms.treeFamilyBark.value.map(v=>v.toArray()),before,'invalid second family cannot partially replace the first');
  }finally{f.dispose();}
});

test('Lambert shader composes family shape, linear color and conservative bounds with legacy fallback',()=>{
  const f=new ForestImpostors(8);
  try{
    const shader={uniforms:{},vertexShader:THREE.ShaderLib.lambert.vertexShader,fragmentShader:THREE.ShaderLib.lambert.fragmentShader};
    f.mesh.material.onBeforeCompile(shader,{capabilities:{logarithmicDepthBuffer:true,reversedDepthBuffer:false}});
    for(const source of [shader.vertexShader,shader.fragmentShader]){
      assert.equal((source.match(/float familyCode=forestFamilyCode\(treeData.z\);/g)||[]).length,1);
      assert.match(source,/uniform vec4 treeFamilyBands\[8\]/);
    }
    assert.match(shader.vertexShader,/boundCentre=treeFamilyCenter\[familyIndex\]\*h;extent=treeFamilyExtent\[familyIndex\]\*h;/);
    assert.match(shader.vertexShader,/treeAllometryBox\(boundCentre,extent,vec2\(max\(allometry\.x,atlasStretch\),allometry\.y\),boundLean\);\s*extent\+=vec3\(boundMargin\);/,'allometry (and the wider atlas stretch) maps the box before the metric card margin');
    assert.match(shader.fragmentShader,/source=treeAllometryPoint\(band\.xyz\/16\.0,treeFamilyTrunk\[familyIndex\]\.y,allometry\)/,'bands follow the near radial map');
    assert.match(shader.fragmentShader,/treeFamilyConeSpan\(bandRo,bandRd,vec3\(0\),radii/);
    assert.match(shader.fragmentShader,/vec3 centre=atlasVariantPoint\(source,1\.0,variantA,variantB\)/,'far bands use the detailed variant transform');
    assert.match(shader.fragmentShader,/forestFamilyVariant\(treeData.z\)/);
    assert.match(shader.fragmentShader,/exp\(-density\[i\]\*cardScale\*cardScale\/volume\*span.y\*heightM\*clump\)/,'crowns are porous Beer-Lambert volumes with scaled card area');
    assert.match(shader.fragmentShader,/float numerator=1\.0-dot\(n,o\)/,'integer cone plane distances are emitted as GLSL floats');
    assert.doesNotMatch(shader.fragmentShader,/float numerator=-?\d+-dot\(n,o\)/);
    assert.match(shader.fragmentShader,/treeFamilyFoliage\[familyIndex\]\*brightness.y/);
    assert.match(shader.fragmentShader,/treeFamilyMargin\[familyIndex\]\/treeRootHeight.w/,'ray shift uses the same metric family box');
    assert.match(shader.fragmentShader,/fwidth\(remaining\)/,'ellipsoid edge coverage follows the AA contract');
    assert.doesNotMatch(shader.fragmentShader,/familyCode==1.0&&best<1e20\)treeCoverage=1.0/);
    assert.ok(!shader.fragmentShader.includes('baseCoverage'),'atlas occupancy is not treated as tree opacity');
    assert.match(f.mesh.material.customProgramCacheKey(),/forest-presentation-3\/forest-structural-variant-1\/.*\/tree-allometry-2$/);
  }finally{f.dispose();}
});

function structured(kind='branching'){
  return {...presentation(),foliageProjectedAreaM2:[0,300,500,120],trunk:{heightM:14.7,baseRadiusM:.31,topRadiusM:.25},
    structuralVariants:forestStructuralVariants(kind)};
}
const rotate=([x,y,z],theta)=>{const c=Math.cos(theta),s=Math.sin(theta);return [c*x+s*z,y,-s*x+c*z];};

test('far family carries the same bounded variant pool, measured trunk and porous density',()=>{
  const f=new ForestImpostors(8);
  try{
    f.setFamilyPresentation('spire',structured('spire'));
    const pool=forestStructuralVariants('spire');
    for(const v of pool){
      assert.deepEqual(f.uniforms.treeFamilyVariantA.value[8+v.index].toArray(),[...v.crownScale,...v.lean].map(Math.fround));
      assert.deepEqual(f.uniforms.treeFamilyVariantB.value[8+v.index].toArray(),[v.twistRad,v.thinning,v.clumpRefM,0].map(Math.fround));
    }
    assert.deepEqual(f.uniforms.treeFamilyVariantA.value[0].toArray(),[1,1,0,0],'other family stays identity');
    assert.deepEqual(f.uniforms.treeFamilyDensity.value[1].toArray(),[0,300,500,120]);
    assert.deepEqual(f.uniforms.treeFamilyTrunk.value[1].toArray(),[14.7/16,.31/16,.25/16]);
    assert.equal(f.uniforms.treeFamilyClump.value.y,pool[0].clumpRefM);
    // Wrong-family pools are rejected before either family changes.
    const before=f.uniforms.treeFamilyVariantA.value.map(v=>v.toArray());
    assert.throws(()=>f.setFamilyPresentations(new Map([['branching',structured('branching')],['spire',structured('branching')]])));
    assert.deepEqual(f.uniforms.treeFamilyVariantA.value.map(v=>v.toArray()),before);
    const bad=structured('spire');bad.foliageProjectedAreaM2=[0,1,NaN,1];assert.throws(()=>f.setFamilyPresentation('spire',bad));
    const badTrunk=structured('spire');badTrunk.trunk.heightM=0;assert.throws(()=>f.setFamilyPresentation('spire',badTrunk));
    // Load failure / disabled family: explicit identity, legacy trunk, solid legacy crowns.
    f.setFamilyPresentation('spire',null);
    assert.deepEqual(f.uniforms.treeFamilyVariantA.value[8+3].toArray(),[1,1,0,0]);
    assert.deepEqual(f.uniforms.treeFamilyDensity.value[1].toArray(),[0,0,0,0]);
    assert.deepEqual(f.uniforms.treeFamilyTrunk.value[1].toArray(),[0,0,0]);
    assert.equal(f.uniforms.treeFamilyBounds.value.y,0);
  }finally{f.dispose();}
});

test('far proxy box encloses every variant-transformed crown band and trunk at supported heights',()=>{
  for(const kind of ['branching','spire']){
    const f=new ForestImpostors(8),p=structured(kind),pool=p.structuralVariants;
    try{
      f.setFamilyPresentation(kind,p);
      for(const heightM of [10,16,22])for(const v of pool){
        f.write(0,new THREE.Vector3(),heightM,new THREE.Quaternion(),.3,0);
        f.setPresentation(0,packForestPresentation(kind,1,1,v.index));
        const centre=new THREE.Vector3(),extent=new THREE.Vector3();f.proxyBounds(0,centre,extent);
        const inside=([x,y,z])=>Math.abs(x-centre.x)<=extent.x+1e-9&&Math.abs(y-centre.y)<=extent.y+1e-9&&Math.abs(z-centre.z)<=extent.z+1e-9;
        for(const band of p.lod1Profile.bands){
          if(!band.populated)continue;
          // Mirrors the far fragment shader: band centre transform plus rotated anisotropic radii.
          const level=Math.min(1,Math.max(0,band.centerM[1]/16)),theta=v.twistRad*level;
          const w=forestVariantCrownWeight(level);
          const sx=1+(v.crownScale[0]-1)*w,sz=1+(v.crownScale[1]-1)*w;
          const margin=p.lod1Profile.maxLeafOffsetM/heightM*(kind==='spire'?Math.SQRT1_2:1);
          const radii=[band.radiusM/16*sx+margin,band.halfHeightM/16+margin,band.radiusM/16*sz+margin];
          const source=band.centerM.map(x=>x/16),turned=rotate([source[0]*sx,source[1],source[2]*sz],theta);
          const c=[turned[0]+v.lean[0]*level*level,source[1],turned[2]+v.lean[1]*level*level];
          for(let i=0;i<64;i++){
            const a=i*2.399963,b=Math.acos(1-2*(i+.5)/64);
            const r=rotate([Math.sin(b)*Math.cos(a)*radii[0],Math.cos(b)*radii[1],Math.sin(b)*Math.sin(a)*radii[2]],theta);
            assert.ok(inside([(c[0]+r[0])*heightM,(c[1]+r[1])*heightM,(c[2]+r[2])*heightM]),`${kind} ${heightM} m variant ${v.index} band escapes the far box`);
          }
        }
        const top=p.trunk.heightM/16,radius=p.trunk.baseRadiusM/16;
        for(const y of [0,top])for(let i=0;i<8;i++){
          const angle=i*Math.PI/4,x=Math.cos(angle)*radius+v.lean[0]*top*y,z=Math.sin(angle)*radius+v.lean[1]*top*y;
          assert.ok(inside([x*heightM,y*heightM,z*heightM]),`${kind} trunk escapes the far box`);
        }
      }
    }finally{f.dispose();}
  }
});
