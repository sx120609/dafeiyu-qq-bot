import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {promisify} from 'node:util';

const scrypt=promisify(crypto.scrypt);
export const COOKIE='dafeiyu_management';
const lifetime=7*24*60*60*1000;
const keyLength=64;

// Console password and browser sessions. Sessions are HMAC-signed cookies bound to the
// password generation, so setting or changing the password signs out every other browser.
export class ConsoleAuth{
  constructor({runtime,secret}){
    this.file=path.join(runtime,'console-auth.json');this.secret=secret||crypto.randomBytes(32);
    this.record=null;this.failures=0;this.lockedUntil=0;this.lockouts=0;
  }
  async load(){try{this.record=JSON.parse(await fs.readFile(this.file,'utf8'));}catch{this.record=null;}return this;}
  get passwordSet(){return !!this.record?.hash;}
  get generation(){return this.record?.generation||0;}
  async persist(){await fs.writeFile(this.file+'.tmp',JSON.stringify(this.record),{mode:0o600});await fs.rename(this.file+'.tmp',this.file);}
  static validate(password){
    if(typeof password!=='string'||password.length<6||password.length>128)throw Object.assign(new Error('密码需要 6 到 128 个字符'),{status:400});
  }
  async setPassword(password){
    ConsoleAuth.validate(password);
    const salt=crypto.randomBytes(16);const hash=await scrypt(password,salt,keyLength);
    this.record={salt:salt.toString('base64'),hash:hash.toString('base64'),generation:this.generation+1,updatedAt:new Date().toISOString()};
    await this.persist();
  }
  async verify(password){
    if(Date.now()<this.lockedUntil)throw Object.assign(new Error(`尝试次数过多，请 ${Math.ceil((this.lockedUntil-Date.now())/1000)} 秒后再试`),{status:429});
    if(!this.passwordSet||typeof password!=='string'||password.length>128)return false;
    const expected=Buffer.from(this.record.hash,'base64');
    const actual=await scrypt(password,Buffer.from(this.record.salt,'base64'),expected.length);
    const ok=crypto.timingSafeEqual(actual,expected);
    // Each lockout in a row doubles, up to an hour: the console can be reachable through a tunnel.
    if(ok){this.failures=0;this.lockouts=0;}
    else if(++this.failures>=5){this.failures=0;this.lockedUntil=Date.now()+Math.min(3600000,30000*2**this.lockouts++);}
    return ok;
  }
  issue(res){
    const payload=Buffer.from(JSON.stringify({expires:Date.now()+lifetime,generation:this.generation,nonce:crypto.randomBytes(12).toString('hex')})).toString('base64url');
    const id=payload+'.'+crypto.createHmac('sha256',this.secret).update(payload).digest('base64url');
    res.setHeader('Set-Cookie',`${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetime/1000}`);
  }
  clear(res){res.setHeader('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);}
  session(req){
    const id=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
    if(!id||id.length>512)return false;
    try{
      const [payload,signature,extra]=id.split('.');if(extra||!payload||!signature)return false;
      const expected=crypto.createHmac('sha256',this.secret).update(payload).digest();
      const supplied=Buffer.from(signature,'base64url');
      if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))return false;
      const value=JSON.parse(Buffer.from(payload,'base64url').toString());
      // Before a password exists, sessions come from the launcher's private token (generation 0).
      return Number.isFinite(value.expires)&&value.expires>Date.now()&&value.generation===this.generation;
    }catch{return false;}
  }
}
