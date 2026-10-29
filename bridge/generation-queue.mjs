// A memory summarization never occupies the interactive lane. Queued work is cancellable.
export class GenerationQueue {
  constructor({limit=24}={}){this.limit=limit;this.pending=[];this.active=0;this.background=0;}
  get busy(){return this.active>0||this.pending.length>0;}
  snapshot(){return {active:this.active,background:this.background,queued:this.pending.length};}
  run(fn,{background=false,signal}={}){
    if(signal?.aborted)return Promise.reject(new Error('请求已取消'));
    if(this.pending.length>=this.limit)return Promise.reject(Object.assign(new Error('请求队列已满，请稍后再试'),{status:429}));
    return new Promise((resolve,reject)=>{
      const item={fn,background,signal,resolve,reject,started:false};
      item.abort=()=>{if(item.started)return;this.pending=this.pending.filter(x=>x!==item);reject(new Error('请求已取消'));};
      signal?.addEventListener('abort',item.abort,{once:true});
      this.pending.push(item);this.drain();
    });
  }
  drain(){
    while(this.active<3){
      let i=this.active-this.background<2?this.pending.findIndex(x=>!x.background):-1;
      if(i<0&&this.background<1)i=this.pending.findIndex(x=>x.background);
      if(i<0)return;
      const item=this.pending.splice(i,1)[0];item.signal?.removeEventListener('abort',item.abort);
      if(item.signal?.aborted){item.reject(new Error('请求已取消'));continue;}
      item.started=true;this.active++;if(item.background)this.background++;
      Promise.resolve().then(item.fn).then(item.resolve,item.reject).finally(()=>{this.active--;if(item.background)this.background--;this.drain();});
    }
  }
}
