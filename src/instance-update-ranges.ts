import type {BufferAttribute} from 'three';

/** Component ranges, not byte ranges. Pending GPU uploads survive invisible
 * frames. Keep at most eight ranges by merging the smallest gaps. */
export class InstanceUpdateRanges {
  private ranges:{start:number;end:number}[]=[];
  include(index:number,components:number){
    this.merge(index*components,(index+1)*components);
  }
  private merge(start:number,end:number){
    for(let i=this.ranges.length-1;i>=0;i--){
      const range=this.ranges[i];if(range.end<start||range.start>end)continue;
      start=Math.min(start,range.start);end=Math.max(end,range.end);this.ranges.splice(i,1);
    }
    this.ranges.push({start,end});this.ranges.sort((a,b)=>a.start-b.start);
    while(this.ranges.length>8){
      let closest=0;
      for(let i=1;i<this.ranges.length-1;i++)if(this.ranges[i+1].start-this.ranges[i].end<this.ranges[closest+1].start-this.ranges[closest].end)closest=i;
      this.ranges[closest].end=this.ranges[closest+1].end;this.ranges.splice(closest+1,1);
    }
  }
  flush(attribute:BufferAttribute){
    if(!this.ranges.length)return 0;
    for(const range of attribute.updateRanges)this.merge(range.start,range.start+range.count);
    attribute.clearUpdateRanges();let components=0;
    for(const range of this.ranges){attribute.addUpdateRange(range.start,range.end-range.start);components+=range.end-range.start;}
    attribute.needsUpdate=true;this.ranges.length=0;
    return components*attribute.array.BYTES_PER_ELEMENT;
  }
}
