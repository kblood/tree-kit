/** Dense GPU slots with canonical identity. Surviving slots stay in place;
 * removal fills only the hole from the tail. Selection order remains the
 * caller's responsibility, so compaction cannot change capacity winners. */
export class CompactInstanceSlots<T,S> {
  readonly items:T[]=[];
  readonly states:S[]=[];
  private indices=new Map<string,number>();
  private wanted=new Set<string>();
  readonly capacity:number;
  private key:(item:T)=>string;
  constructor(capacity:number,key:(item:T)=>string){
    if(!Number.isSafeInteger(capacity)||capacity<0)throw new Error('Invalid slot capacity');
    this.capacity=capacity;this.key=key;
  }
  /** Partition retained identities without changing demand/capacity winners.
   * swapRows must validate before mutating and swap the complete GPU row.
   * A stable partition needs no writes; only misplaced pairs are exchanged. */
  partition(selected:(item:T)=>boolean,swapRows:(a:number,b:number)=>void):number{
    let front=0,back=this.items.length-1;
    while(front<=back){
      if(selected(this.items[front])){front++;continue;}
      while(back>front&&!selected(this.items[back]))back--;
      if(back===front)break;
      swapRows(front,back);
      const item=this.items[front],state=this.states[front];
      this.items[front]=this.items[back];this.states[front]=this.states[back];
      this.items[back]=item;this.states[back]=state;
      this.indices.set(this.key(this.items[front]),front);this.indices.set(this.key(item),back);
      front++;back--;
    }
    return front;
  }
  reconcile(items:readonly T[],write:(index:number,item:T,previous:S|undefined)=>S):number{
    if(items.length>this.capacity)throw new Error('Compact instance capacity exceeded');
    this.wanted.clear();
    for(const item of items){
      const id=this.key(item);
      if(this.wanted.has(id))throw new Error(`Duplicate compact instance ${id}`);
      this.wanted.add(id);
    }
    for(let index=this.items.length-1;index>=0;index--){
      const id=this.key(this.items[index]);if(this.wanted.has(id))continue;
      this.indices.delete(id);
      const last=this.items.length-1;
      if(index!==last){
        const moved=this.items[last];
        this.states[index]=write(index,moved,this.states[index]);
        this.items[index]=moved;this.indices.set(this.key(moved),index);
      }
      this.items.pop();this.states.pop();
    }
    for(const item of items){
      const id=this.key(item),index=this.indices.get(id)??this.items.length;
      this.states[index]=write(index,item,this.states[index]);
      this.items[index]=item;this.indices.set(id,index);
    }
    return this.items.length;
  }
  /** reconcile() without hashing a key per item: the same slots, writes and
   * write order, for a caller that already knows (a) whether a retained item's
   * identity is wanted in this pass and (b) a candidate slot for each wanted
   * item, verified here against `items`. The caller guarantees `items` holds
   * no duplicate identity; reconcile() is the checked general form. */
  reconcileMarked(items:readonly T[],write:(index:number,item:T,previous:S|undefined)=>S,
    retained:(item:T)=>boolean,slotHint:(item:T)=>number):number{
    if(items.length>this.capacity)throw new Error('Compact instance capacity exceeded');
    for(let index=this.items.length-1;index>=0;index--){
      if(retained(this.items[index]))continue;
      this.indices.delete(this.key(this.items[index]));
      const last=this.items.length-1;
      if(index!==last){
        const moved=this.items[last];
        this.states[index]=write(index,moved,this.states[index]);
        this.items[index]=moved;this.indices.set(this.key(moved),index);
      }
      this.items.pop();this.states.pop();
    }
    for(const item of items){
      // A hinted slot holding this very item already maps its identity there.
      const hint=slotHint(item);let index:number;
      if(hint>=0&&hint<this.items.length&&this.items[hint]===item)index=hint;
      else{const id=this.key(item);index=this.indices.get(id)??this.items.length;this.indices.set(id,index);}
      this.states[index]=write(index,item,this.states[index]);
      this.items[index]=item;
    }
    return this.items.length;
  }
}
