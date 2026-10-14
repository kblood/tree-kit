/** Adapter for the pinned Three.ez reference; the vendored source stays untouched. */
export type ReferenceShader = {vertexShader:string;fragmentShader:string};

// Keep offsets and newlines so a match in live GLSL can be replaced in the original.
export function liveGlsl(source:string):string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, comment=>comment.replace(/[^\r\n]/g,' '));
}

export function auditImpostorShader(shader:ReferenceShader) {
  const vertex=liveGlsl(shader.vertexShader),fragment=liveGlsl(shader.fragmentShader);
  const includes=(source:string,name:string)=>(source.match(new RegExp('^[ \\t]*#include[ \\t]+<'+name+'>','gm'))??[]).length;
  const impostorTransformDeclarations=(vertex.match(/\buniform\s+mat4\s+impostorTransform\s*;/g)??[]).length;
  const blendedColorDeclarations=(fragment.match(/\bvec4\s+blendedColor\b/g)??[]).length;
  return {
    impostorTransform:impostorTransformDeclarations===1,
    blendedColor:blendedColorDeclarations===1,
    impostorTransformDeclarations,blendedColorDeclarations,
    blendedColorApplied:(fragment.match(/\bdiffuseColor\s*\*=\s*blendedColor\s*;/g)??[]).length,
    liveProjectIncludes:includes(vertex,'project_vertex'),
    liveMapIncludes:includes(fragment,'map_fragment'),
    liveNormalMapIncludes:includes(fragment,'normal_fragment_maps'),
  };
}

export function adaptImpostorShader(shader:ReferenceShader,repairMapInclude:boolean) {
  const before=auditImpostorShader(shader);
  if(!before.impostorTransform||!before.blendedColor||before.liveProjectIncludes||before.liveNormalMapIncludes)
    throw new Error('Pinned impostor shader hooks changed');
  if(repairMapInclude){
    // Upstream String.replace hits its own commented include before the real one.
    // Replace only the one live include, using comment-stripped source offsets.
    if(before.liveMapIncludes!==1||before.blendedColorApplied!==0)
      throw new Error('Unexpected pinned map-fragment state');
    const match=/^[ \t]*#include[ \t]+<map_fragment>/m.exec(liveGlsl(shader.fragmentShader))!;
    shader.fragmentShader=shader.fragmentShader.slice(0,match.index)+'diffuseColor *= blendedColor;'+shader.fragmentShader.slice(match.index+match[0].length);
  }
  const after=auditImpostorShader(shader);
  if(repairMapInclude&&(after.liveMapIncludes!==0||after.blendedColorApplied!==1))
    throw new Error('Impostor map repair did not apply exactly once');
  return {repairMapInclude,before,after};
}
