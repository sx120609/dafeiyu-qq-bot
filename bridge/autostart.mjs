import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {runProcess} from './providers.mjs';

const key='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const valueName='Dafeiyu';
const reg='/mnt/c/Windows/System32/reg.exe';

// Windows sign-in start for the tray launcher, toggled from the console. Only this one
// fixed Run value is ever read or written.
export class Autostart{
  constructor({root,execute=runProcess,launcher}){
    this.execute=execute;
    this.launcher=launcher??(()=>{try{return execFileSync('wslpath',['-w',path.join(root,'Dafeiyu.exe')],{encoding:'utf8'}).trim();}catch{return null;}})();
    this.launcherFile=path.join(root,'Dafeiyu.exe');
  }
  get command(){return `"${this.launcher}" --autostart`;}
  async status(){
    const installed=await fs.access(this.launcherFile).then(()=>true,()=>false);
    if(!this.launcher)return {supported:false,enabled:false,installed,reason:'无法定位启动器路径'};
    try{
      const output=await this.execute(reg,['query',key,'/v',valueName],'',{timeout:15000});
      return {supported:true,installed,enabled:output.includes(this.launcher),registered:true};
    }catch{return {supported:true,installed,enabled:false,registered:false};}
  }
  async set(enabled){
    if(typeof enabled!=='boolean')throw new Error('开机自启参数无效');
    if(enabled){
      if(!(await fs.access(this.launcherFile).then(()=>true,()=>false)))throw new Error('启动器 Dafeiyu.exe 尚未生成，无法设置开机自启');
      await this.execute(reg,['add',key,'/v',valueName,'/t','REG_SZ','/d',this.command,'/f'],'',{timeout:15000});
    }else{
      try{await this.execute(reg,['delete',key,'/v',valueName,'/f'],'',{timeout:15000});}catch{}
    }
    return this.status();
  }
}
