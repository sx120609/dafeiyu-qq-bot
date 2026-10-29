import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {publicAddress,publicFetch,calculate,PublicContent} from '../bridge/public-content.mjs';
test('public tools reject private, loopback and non-web destinations',async()=>{
  for(const address of ['127.0.0.1','10.0.0.1','192.168.1.1','172.16.0.1','169.254.169.254','100.64.1.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','ff02::1'])assert.equal(publicAddress(address),false,address);
  assert.equal(publicAddress('1.1.1.1'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
  for(const address of ['file:///etc/passwd','http://127.0.0.1/secret','http://2130706433/secret','http://user:pass@example.com/'])await assert.rejects(publicFetch(address));
});
test('Bilibili video links are read as videos, not scraped as script-drawn pages',async()=>{
  const content=new PublicContent({runtime:os.tmpdir()}),seen=[];
  content.video=async raw=>{seen.push(raw);return {title:'video'};};
  for(const url of ['https://www.bilibili.com/video/BV1GJ411x7h7/?p=1','https://m.bilibili.com/video/av80433022','https://b23.tv/AbC123'])
    assert.equal((await content.execute('read_webpage',{url})).title,'video');
  assert.equal(seen.length,3);
});
test('calculator follows precedence without evaluating code',()=>{
  assert.equal(calculate('(17+23)*6'),240);assert.equal(calculate('2^3^2'),512);assert.equal(calculate('-2^2'),-4);assert.equal(calculate('2^-2'),0.25);
  for(const input of ['process.exit()','1/0','2^99999','E2','1e+','1 2','(()'])assert.throws(()=>calculate(input));
});
