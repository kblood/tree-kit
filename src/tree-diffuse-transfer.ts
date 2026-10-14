/**
 * Area-associated order-two clamped-cosine transfer coefficients for captured
 * tree texels. This is CPU-side experiment data, not a shipping shader path.
 * Each pixel stores nine RGB moments in Float32 order:
 * A, Nx, Ny, Nz, Qxx, Qyy, Qxy, Qxz, Qyz.
 */
const MOMENTS_PER_CHANNEL = 9;
const CHANNELS = 3;
const VALUES_PER_PIXEL = MOMENTS_PER_CHANNEL * CHANNELS;
const UNIT_TOLERANCE = 1e-3;

function assertSize(size:number):void {
  if(!Number.isInteger(size)||size<=0||size>1024)throw new RangeError('size must be an integer from 1 through 1024');
}

function assertColourAndData(size:number,colour:Float32Array,data:Float32Array):void {
  assertSize(size);
  const expected=size*size*4;
  if(!(colour instanceof Float32Array)||colour.length!==expected)throw new TypeError(`colour must be a Float32Array of ${expected} values`);
  if(!(data instanceof Float32Array)||data.length!==expected)throw new TypeError(`data must be a Float32Array of ${expected} values`);
}

/** Build nine RGB moments per pixel, multiplied by the input alpha coverage. */
export function createTreeDiffuseTransfer(size:number,colour:Float32Array,data:Float32Array):Float32Array {
  assertColourAndData(size,colour,data);
  const result=new Float32Array(size*size*VALUES_PER_PIXEL);
  for(let pixel=0;pixel<size*size;pixel++){
    const c=pixel*4,a=colour[c+3];
    if(!Number.isFinite(a)||a<0||a>1)throw new RangeError(`colour alpha out of range at pixel ${pixel}`);
    if(a===0)continue;
    const r=colour[c],g=colour[c+1],b=colour[c+2];
    if(!Number.isFinite(r)||!Number.isFinite(g)||!Number.isFinite(b)||r<0||g<0||b<0)
      throw new RangeError(`colour RGB must be finite and nonnegative at covered pixel ${pixel}`);
    const d=pixel*4,nx=data[d],ny=data[d+1],nz=data[d+2];
    if(!Number.isFinite(nx)||!Number.isFinite(ny)||!Number.isFinite(nz))
      throw new RangeError(`normal must be finite at covered pixel ${pixel}`);
    const normalLength=Math.hypot(nx,ny,nz);
    if(Math.abs(normalLength-1)>UNIT_TOLERANCE)throw new RangeError(`normal must be unit length at covered pixel ${pixel}`);
    const nxu=nx/normalLength,nyu=ny/normalLength,nzu=nz/normalLength;
    const out=pixel*VALUES_PER_PIXEL;
    const qxx=nxu*nxu,qyy=nyu*nyu,qxy=nxu*nyu,qxz=nxu*nzu,qyz=nyu*nzu;
    for(let channel=0;channel<3;channel++){
      const rgb=(channel===0?r:channel===1?g:b)*a,base=out+channel;
      result[base]=rgb;
      result[base+3]=rgb*nxu;
      result[base+6]=rgb*nyu;
      result[base+9]=rgb*nzu;
      result[base+12]=rgb*qxx;
      result[base+15]=rgb*qyy;
      result[base+18]=rgb*qxy;
      result[base+21]=rgb*qxz;
      result[base+24]=rgb*qyz;
    }
  }
  return result;
}

/** Mean-area reduce a square coefficient image by an exact integer factor. */
export function reduceTreeDiffuseTransfer(size:number,values:Float32Array,factor:number):Float32Array {
  assertSize(size);
  if(!Number.isInteger(factor)||factor<=0||factor>size||size%factor!==0)
    throw new RangeError('factor must be a positive integer that divides size');
  if(!(values instanceof Float32Array)||values.length!==size*size*VALUES_PER_PIXEL)
    throw new TypeError(`values must be a Float32Array of ${size*size*VALUES_PER_PIXEL} values`);
  for(let i=0;i<values.length;i++)if(!Number.isFinite(values[i]))throw new RangeError(`transfer value is not finite at index ${i}`);
  if(factor===1)return values.slice();
  const targetSize=size/factor,target=new Float32Array(targetSize*targetSize*VALUES_PER_PIXEL),area=factor*factor,invArea=1/area;
  for(let y=0;y<targetSize;y++)for(let x=0;x<targetSize;x++){
    const dst=(y*targetSize+x)*VALUES_PER_PIXEL;
    for(let dy=0;dy<factor;dy++)for(let dx=0;dx<factor;dx++){
      const src=(((y*factor+dy)*size)+(x*factor+dx))*VALUES_PER_PIXEL;
      for(let k=0;k<VALUES_PER_PIXEL;k++)target[dst+k]+=values[src+k]*invArea;
    }
  }
  return target;
}

/** Evaluate area-associated transfer under one unit directional light. */
export function evaluateTreeDiffuseTransfer(values:ArrayLike<number>,light:readonly[number,number,number],offset=0):[number,number,number] {
  if(!Number.isInteger(offset)||offset<0||offset+VALUES_PER_PIXEL>values.length)throw new RangeError('offset does not address one complete transfer pixel');
  const [lx,ly,lz]=light;
  if(!Number.isFinite(lx)||!Number.isFinite(ly)||!Number.isFinite(lz))throw new RangeError('light direction must be finite');
  const lightLength=Math.hypot(lx,ly,lz);
  if(Math.abs(lightLength-1)>UNIT_TOLERANCE)throw new RangeError('light direction must be normalized');
  const x=lx/lightLength,y=ly/lightLength,z=lz/lightLength;
  const a=3/32+15/32*z*z,linear=[x/2,y/2,z/2],q=15/32;
  const result:[number,number,number]=[0,0,0];
  for(let channel=0;channel<3;channel++){
    const A=values[offset+channel],Nx=values[offset+3+channel],Ny=values[offset+6+channel],Nz=values[offset+9+channel];
    const Qxx=values[offset+12+channel],Qyy=values[offset+15+channel],Qxy=values[offset+18+channel],Qxz=values[offset+21+channel],Qyz=values[offset+24+channel];
    const irradiance=a*A+linear[0]*Nx+linear[1]*Ny+linear[2]*Nz+
      q*(x*x-z*z)*Qxx+q*(y*y-z*z)*Qyy+2*q*x*y*Qxy+2*q*x*z*Qxz+2*q*y*z*Qyz;
    if(!Number.isFinite(irradiance))throw new RangeError(`transfer evaluation is not finite for channel ${channel}`);
    result[channel]=Math.max(0,irradiance);
  }
  return result;
}
