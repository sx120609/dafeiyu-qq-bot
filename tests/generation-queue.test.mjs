import test from 'node:test';
import assert from 'node:assert/strict';
import {GenerationQueue} from '../bridge/generation-queue.mjs';
const tick=()=>new Promise(setImmediate);
test('two chats run beside memory; queued chats are prioritized and cancellable',async()=>{
  const queue=new GenerationQueue();const started=[],release={};
  const task=name=>()=>new Promise(r=>{started.push(name);release[name]=r;});
  const jobs=[queue.run(task('memory'),{background:true}),queue.run(task('chat1')),queue.run(task('chat2'))];
  await tick();assert.deepEqual(started,['memory','chat1','chat2']);
  const cancel=new AbortController();const cancelled=queue.run(task('cancelled'),{signal:cancel.signal});cancel.abort();await assert.rejects(cancelled,/取消/);
  jobs.push(queue.run(task('memory2'),{background:true}),queue.run(task('chat3')));
  release.chat1();await tick();assert.equal(started.at(-1),'chat3');
  release.memory();await tick();assert.equal(started.at(-1),'memory2');
  release.chat2();release.chat3();release.memory2();await Promise.all(jobs);await tick();
  assert.equal(queue.busy,false);assert.ok(!started.includes('cancelled'));
});
