// The bot's on/off abilities. Each switch changes only its own setting: details set elsewhere in the console
// (the daily share's time and chats, which service draws, who looks at pictures) are left as they are.
export class FeatureControl{
  constructor({runtimeControl,publicContent}){this.control=runtimeControl;this.public=publicContent;}
  async list(){
    const s=await this.control.panel(),c=s.config,p=s.persona;
    const feature=(id,name,enabled,description,available=true,reason='')=>({id,name,enabled:!!enabled,description,available,reason});
    return {features:[
      feature('loop','防机器人互聊',c.loopProtectionEnabled!==false,'只对重复闭环或高置信自动互答对象临时降温，其他人照常聊天。'),
      feature('web','联网',c.onlineEnabled,'搜索、阅读全文、视频内容、天气、时间和计算。'),
      feature('vision','识图',c.visionEnabled,'直接理解收到的图片和动图，不编造没看到的画面。'),
      feature('memory','长期记忆',c.memoryEnabled,'各好友和群分开记，整理放到后台，不挡聊天。'),
      feature('stickers','表情包',p.stickersEnabled,'它自己看语境决定要不要发表情包，不固定每条都发。'),
      feature('artwork','找插画',s.artwork.enabled,'按关键词、作品 ID 或榜单找 Pixiv 公开作品，附作者和出处。'),
      feature('drawing','画图',s.imageGeneration.enabled,'画图独立于聊天模型；用 Claude 聊天时也能画。',!!s.imageCredentials.codex,s.imageCredentials.codex?'':'需载入本机 Codex 网关凭证'),
      feature('daily','每日插画分享',s.artwork.scheduleEnabled,'按设定的时间往选中的会话发一张插画；不补发过期的。'),
      feature('exploration','公开内容探索',this.public.options.explorationEnabled&&c.onlineEnabled,'闲时读取公开内容并留下真实记录，供聊天找话题。需要先开联网。'),
      feature('googleVision','Google 以图找来源',s.visualTools.googleWebEnabled,'有人问“这图出处”时，用 Google Cloud Vision 找来源网页。',!!s.googleVisionCredential,s.googleVisionCredential?'':'尚未配置该服务的 API Key')
    ]};
  }
  // `features` holds only the switches to set; `all` turns every available one on.
  async apply({all=false,features={}}){
    if(typeof all!=='boolean'||!features||typeof features!=='object'||Array.isArray(features)||Object.values(features).some(x=>typeof x!=='boolean'))throw new Error('功能开关参数无效');
    const old=await this.control.panel(),catalog=await this.list();
    if(Object.keys(features).some(key=>!catalog.features.some(x=>x.id===key)))throw new Error('未知功能开关');
    const wanted={};
    for(const item of catalog.features){
      const value=all?true:features[item.id];
      if(value===undefined||value===item.enabled)continue;
      if(value&&!item.available){if(all)continue;throw new Error(`${item.name}：${item.reason}`);}
      wanted[item.id]=value;
    }
    const has=id=>Object.hasOwn(wanted,id),priorOptions={...this.public.options};
    const done=[];
    try{
      const save={};
      if(has('web'))save.onlineEnabled=wanted.web;
      if(has('vision'))save.visionEnabled=wanted.vision;
      if(has('memory'))save.memoryEnabled=wanted.memory;
      if(has('loop'))save.loopProtectionEnabled=wanted.loop;
      if(has('stickers'))save.persona={...old.persona,stickersEnabled:wanted.stickers};
      if(Object.keys(save).length){await this.control.panel('save',save);done.push('save');}
      if(has('artwork')||has('daily')){
        const artwork={...old.artwork};
        if(has('artwork'))artwork.enabled=wanted.artwork;
        if(has('daily')){
          artwork.scheduleEnabled=wanted.daily;
          // Turned on with no chat chosen yet: every enabled chat, so it does not sit there doing nothing.
          if(wanted.daily&&!(artwork.scheduleTargets||[]).length)artwork.scheduleTargets=old.config.targets.filter(t=>t.enabled).map(t=>(t.group?'group:':'private:')+t.number);
        }
        await this.control.panel('saveArtwork',{artwork});done.push('artwork');
      }
      if(has('drawing')){await this.control.panel('saveImageGeneration',{imageGeneration:{...old.imageGeneration,enabled:wanted.drawing},persistImageCredentials:false});done.push('drawing');}
      if(has('googleVision')){await this.control.panel('saveVisualTools',{visualTools:{...old.visualTools,googleWebEnabled:wanted.googleVision},persistVisualCredentials:false});done.push('googleVision');}
      if(has('exploration')){this.public.options.explorationEnabled=wanted.exploration;await this.public.persist();}
      return {message:'已保存',...(await this.list())};
    }catch(error){
      // Put back what this call had already changed.
      this.public.options=priorOptions;try{await this.public.persist();}catch{}
      try{
        if(done.includes('save'))await this.control.panel('save',{onlineEnabled:old.config.onlineEnabled,visionEnabled:old.config.visionEnabled,memoryEnabled:old.config.memoryEnabled,loopProtectionEnabled:old.config.loopProtectionEnabled,persona:old.persona});
        if(done.includes('artwork'))await this.control.panel('saveArtwork',{artwork:old.artwork});
        if(done.includes('drawing'))await this.control.panel('saveImageGeneration',{imageGeneration:old.imageGeneration,persistImageCredentials:false});
        if(done.includes('googleVision'))await this.control.panel('saveVisualTools',{visualTools:old.visualTools,persistVisualCredentials:false});
      }catch{}
      throw error;
    }
  }
}
