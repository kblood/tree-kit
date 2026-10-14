import type {BufferAttribute} from 'three';

/** Bounded slot blocks keep unrelated patch edits from uploading the gap
 * between them. Pending driver ranges survive frames in which no draw occurs. */
export class ForestDirtyBlocks {
  private blocks:Uint8Array;private dirty=false;private capacity:number;private blockSize:number;
  constructor(capacity:number,blockSize=64){this.capacity=capacity;this.blockSize=blockSize;this.blocks=new Uint8Array(Math.ceil(capacity/blockSize));}
  get byteLength(){return this.blocks.byteLength;}
  mark(index:number){this.blocks[Math.floor(index/this.blockSize)]=1;this.dirty=true;}
  clear(){this.blocks.fill(0);this.dirty=false;}
  flush(attribute:BufferAttribute){
    if(!this.dirty)return 0;
    for(const range of attribute.updateRanges){
      const first=Math.floor(range.start/attribute.itemSize/this.blockSize),end=Math.ceil((range.start+range.count)/attribute.itemSize/this.blockSize);
      for(let i=first;i<end;i++)this.blocks[i]=1;
    }
    attribute.clearUpdateRanges();let first=-1,bytes=0;
    for(let i=0;i<=this.blocks.length;i++){
      if(i<this.blocks.length&&this.blocks[i]){if(first<0)first=i;this.blocks[i]=0;}
      else if(first>=0){
        const start=first*this.blockSize,count=Math.min(i*this.blockSize,this.capacity)-start;
        attribute.addUpdateRange(start*attribute.itemSize,count*attribute.itemSize);
        bytes+=count*attribute.itemSize*attribute.array.BYTES_PER_ELEMENT;first=-1;
      }
    }
    attribute.needsUpdate=true;this.dirty=false;return bytes;
  }
}
