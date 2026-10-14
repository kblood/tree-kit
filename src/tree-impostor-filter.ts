import {DataUtils} from 'three';

/** GPU-only packing experiment. Review captures remain linear/unassociated.
 * Weight all interpolated attributes by the SAME quantized coverage so texture
 * filtering cannot pull a covered surface toward transparent padding values.
 * The shader must divide every sampled attribute by sampled colour alpha. */
export function packTreeCaptureLayer(colour:Float32Array,data:Float32Array,classification:Float32Array){
  if(!(colour instanceof Float32Array)||!(data instanceof Float32Array)||!(classification instanceof Float32Array)||colour.length===0||colour.length%4||data.length!==colour.length||classification.length!==colour.length/4)throw new Error('Invalid capture layer shape');
  const rgba=new Uint8Array(colour.length),surface=new Uint16Array(data.length),leaf=new Uint8Array(colour.length);
  for(let p=0;p<colour.length;p+=4){
    for(let c=0;c<4;c++)if(!Number.isFinite(colour[p+c])||colour[p+c]<0||colour[p+c]>1.00001||!Number.isFinite(data[p+c])||Math.abs(data[p+c])>1.001)throw new Error('Invalid capture material value');
    const fraction=classification[p/4];if(!Number.isFinite(fraction)||fraction<0||fraction>1.00001)throw new Error('Invalid leaf fraction');
    const byte=Math.round(Math.min(1,colour[p+3])*255),coverage=byte/255;rgba[p+3]=byte;
    if(byte===0)continue;
    for(let c=0;c<3;c++){
      const linear=Math.min(1,colour[p+c])*coverage;
      rgba[p+c]=Math.round(255*(linear<=.0031308?12.92*linear:1.055*linear**(1/2.4)-.055));
    }
    for(let c=0;c<4;c++)surface[p+c]=DataUtils.toHalfFloat(data[p+c]*coverage);
    leaf[p]=Math.round(Math.min(1,fraction)*byte);
  }
  return {colour:rgba,data:surface,classification:leaf};
}
