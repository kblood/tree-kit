/** Opt-in diagnostics. GPU queries are polled on later frames; never wait for
 * the GPU, finish(), or read back pixels to produce a timing measurement. */
type TimerExtension={TIME_ELAPSED_EXT:number;GPU_DISJOINT_EXT:number};
type GPUFrame={id:number;pending:number;sum:number;valid:boolean;sealed:boolean};
type Pending={query:WebGLQuery;name:string;frame:GPUFrame};
const DEFAULT_HISTORY=600,MAX_HISTORY=36000,MAX_PENDING=48,MAX_AGE_FRAMES=240;
/** Per-system CPU attribution. Every profiled frame records one sample per
 * listed system (0 when the system did no work), so the histograms describe
 * frames, not calls. `terrainTiles` is the planet update remainder after the
 * other planet systems are subtracted; `submission` is scene/atlas/reflection
 * render CPU minus the shadow-map share; `other` is frame work not attributed
 * to any listed system (input, flight, labels, UI, bookkeeping). */
export const CPU_SYSTEMS=['terrainTiles','sky','forest','canopy','flora','lifeScatter','fauna','rocks','clouds','submission','shadow','other'] as const;
export type CpuSystem=typeof CPU_SYSTEMS[number];
/** Cheap wall-clock accumulator used by thin hooks inside planet systems.
 * `start()` returns 0 while disabled so the hot path stays a branch. */
export class SystemTimer {
  enabled=false;
  private totals=new Map<string,number>();
  start(){return this.enabled?performance.now():0;}
  stop(name:string,started:number){if(this.enabled&&started>0)this.add(name,performance.now()-started);}
  add(name:string,ms:number){if(this.enabled&&Number.isFinite(ms)&&ms>0)this.totals.set(name,(this.totals.get(name)??0)+ms);}
  get(name:string){return this.totals.get(name)??0;}
  take(){const out=Object.fromEntries(this.totals);this.totals.clear();return out as Record<string,number>;}
}
export const systemTimer=new SystemTimer();

export function profileSummary(values:readonly number[]){
  if(!values.length)return {samples:0,p50:null,p95:null,p99:null,max:null};
  const sorted=[...values].sort((a,b)=>a-b),at=(q:number)=>sorted[Math.min(sorted.length-1,Math.ceil(q*sorted.length)-1)];
  return {samples:sorted.length,p50:at(.5),p95:at(.95),p99:at(.99),max:sorted[sorted.length-1]};
}

export class RenderProfile {
  enabled=false;
  private extension:TimerExtension|null=null;
  private pending:Pending[]=[];
  private series=new Map<string,number[]>();
  private frame:GPUFrame|null=null;
  private frameId=0;
  private start=0;
  private activeQuery=false;
  private lost=false;
  private skipped=0;
  private disjoint=0;
  private disjointNow=false;
  private expired=0;
  private draws=0;
  private triangles=0;
  private history=DEFAULT_HISTORY;
  private frameCpu=new Map<string,number>();
  private hitches={frames:0,over33:0,over50:0,over100:0,maxIntervalMs:0};
  constructor(private gl:WebGL2RenderingContext){}
  setEnabled(enabled:boolean){
    if(enabled===this.enabled)return;
    this.clear();this.enabled=enabled;systemTimer.enabled=enabled;systemTimer.take();
    this.extension=enabled&&!this.gl.isContextLost()?this.gl.getExtension('EXT_disjoint_timer_query_webgl2'):null;
  }
  clear(){
    for(const entry of this.pending)this.gl.deleteQuery(entry.query);
    this.pending=[];this.series.clear();this.frame=null;this.frameId=0;
    this.skipped=0;this.disjoint=0;this.disjointNow=false;this.expired=0;this.draws=0;this.triangles=0;
    this.hitches={frames:0,over33:0,over50:0,over100:0,maxIntervalMs:0};systemTimer.take();
  }
  /** Raise the per-metric history for long scripted captures (bounded). */
  setHistoryLimit(limit:number){
    this.history=Math.max(1,Math.min(MAX_HISTORY,Math.floor(limit)||DEFAULT_HISTORY));
    for(const values of this.series.values())if(values.length>this.history)values.splice(0,values.length-this.history);
  }
  /** Raw retained samples for the named metrics (oldest first). */
  samples(names:readonly string[]){return Object.fromEntries(names.map(name=>[name,[...(this.series.get(name)??[])]]));}
  metricNames(){return [...this.series.keys()];}
  private record(name:string,value:number){
    if(!Number.isFinite(value)||value<0)return;
    let values=this.series.get(name);if(!values){values=[];this.series.set(name,values);}
    values.push(value);if(values.length>this.history)values.splice(0,values.length-this.history);
  }
  beginFrame(intervalMs:number){
    if(!this.enabled)return;
    this.start=performance.now();this.frameId++;
    if(this.gl.isContextLost()){
      if(!this.lost){this.clear();this.lost=true;}this.extension=null;
    }else if(this.lost){this.lost=false;this.extension=this.gl.getExtension('EXT_disjoint_timer_query_webgl2');}
    this.poll();this.frameCpu.clear();
    this.frame={id:this.frameId,pending:0,sum:0,valid:!!this.extension&&!this.disjointNow,sealed:false};
    this.record('frameIntervalMs',intervalMs);
    if(Number.isFinite(intervalMs)&&intervalMs>=0){
      const h=this.hitches;h.frames++;if(intervalMs>33)h.over33++;if(intervalMs>50)h.over50++;if(intervalMs>100)h.over100++;
      h.maxIntervalMs=Math.max(h.maxIntervalMs,intervalMs);
    }
  }
  private finishGPU(frame:GPUFrame){
    if(frame.sealed&&frame.pending===0&&frame.valid)this.record('gpu/framePassSumMs',frame.sum);
  }
  private poll(){
    const ext=this.extension;this.disjointNow=!!ext&&!!this.gl.getParameter(ext.GPU_DISJOINT_EXT);if(!ext)return;
    if(this.disjointNow){
      for(const entry of this.pending){entry.frame.valid=false;this.gl.deleteQuery(entry.query);}
      this.disjoint+=this.pending.length;this.pending=[];return;
    }
    let count=0;
    while(this.pending.length&&count++<12){
      const entry=this.pending[0];
      const available=this.gl.getQueryParameter(entry.query,this.gl.QUERY_RESULT_AVAILABLE);
      if(!available&&this.frameId-entry.frame.id<MAX_AGE_FRAMES)break;
      this.pending.shift();entry.frame.pending--;
      if(available){
        const value=Number(this.gl.getQueryParameter(entry.query,this.gl.QUERY_RESULT))/1e6;
        if(Number.isFinite(value)&&value>=0){this.record('gpu/'+entry.name+'Ms',value);entry.frame.sum+=value;}
        else entry.frame.valid=false;
      }else{entry.frame.valid=false;this.expired++;}
      this.gl.deleteQuery(entry.query);this.finishGPU(entry.frame);
    }
  }
  cpu<T>(name:string,work:()=>T):T{
    if(!this.enabled)return work();
    const start=performance.now();try{return work();}finally{
      const ms=performance.now()-start;this.record('cpu/'+name+'Ms',ms);this.frameCpu.set(name,(this.frameCpu.get(name)??0)+ms);
    }
  }
  pass<T>(name:string,work:()=>T):T{
    if(!this.enabled)return work();
    const ext=this.extension,frame=this.frame;
    // Timer queries cannot nest. An external browser harness may own one.
    if(!ext||!frame||this.disjointNow||this.activeQuery||this.pending.length>=MAX_PENDING||
      this.gl.getQuery(ext.TIME_ELAPSED_EXT,this.gl.CURRENT_QUERY)){
      this.skipped++;if(frame)frame.valid=false;return this.cpu(name,work);
    }
    const query=this.gl.createQuery();
    if(!query){this.skipped++;frame.valid=false;return this.cpu(name,work);}
    this.gl.beginQuery(ext.TIME_ELAPSED_EXT,query);this.activeQuery=true;
    try{return this.cpu(name,work);}catch(error){frame.valid=false;throw error;}
    finally{
      this.gl.endQuery(ext.TIME_ELAPSED_EXT);this.activeQuery=false;
      frame.pending++;this.pending.push({query,name,frame});
    }
  }
  /** CPU time of the named cpu()/pass() work in the current frame. */
  frameCpuMs(name:string){return this.frameCpu.get(name)??0;}
  /** Ends the frame. `systems` (optional) are this frame's non-overlapping
   * per-system CPU times; `other` is derived as the unattributed remainder. */
  endFrame(draws:number,triangles:number,systems?:Partial<Record<CpuSystem,number>>){
    if(!this.enabled)return;
    const work=performance.now()-this.start;
    this.record('cpu/frameWorkMs',work);
    if(systems){
      let attributed=0;
      for(const name of CPU_SYSTEMS){
        if(name==='other')continue;
        const value=Math.max(0,systems[name]??0);attributed+=value;this.record('cpu/system/'+name+'Ms',value);
      }
      this.record('cpu/system/otherMs',Math.max(0,work-attributed));
    }
    this.draws=draws;this.triangles=triangles;this.record('drawCalls',draws);this.record('triangles',triangles);
    if(this.frame){this.frame.sealed=true;this.finishGPU(this.frame);this.frame=null;}
  }
  diagnostics(){return {
    enabled:this.enabled,gpuAvailable:!!this.extension,historyLimit:this.history,
    hitches:{...this.hitches},cpuSystems:CPU_SYSTEMS,
    method:'Non-overlapping EXT_disjoint_timer_query_webgl2 passes; delayed availability polling',
    gpuTotalMeaning:'Sum of instrumented rendering passes from complete frames; excludes CPU work and presentation wait',
    pendingQueries:this.pending.length,pendingLimit:MAX_PENDING,skippedQueries:this.skipped,disjointQueries:this.disjoint,expiredQueries:this.expired,
    lastDrawCalls:this.draws,lastTriangles:this.triangles,
    statistics:Object.fromEntries([...this.series].map(([name,values])=>[name,profileSummary(values)])),
  };}
}
