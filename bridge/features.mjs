export class FeatureControl{
  constructor({runtimeControl,publicContent}){this.control=runtimeControl;this.public=publicContent;}
  async list(){
    const s=await this.control.panel(),c=s.config,p=s.persona;
    const feature=(id,name,enabled,description,available=true,reason='')=>({id,name,enabled:!!enabled,description,available,reason});
    return {features:[
      feature('loop','防机器人互聊',c.loopProtectionEnabled!==false,'只对重复闭环或高置信自动互答对象临时降温，其他人照常聊天。'),
      feature('web','联网与常用工具',c.onlineEnabled,'搜索、阅读全文、视频内容、天气、时间和计算。'),
      feature('vision','图片 / GIF 理解',c.visionEnabled,'直接理解收到的图片和表情，不编造未看到的画面。'),
      feature('memory','独立长期记忆',c.memoryEnabled,'各好友和群独立记录，整理放到后台，不挡聊天。'),
      feature('stickers','语境表情',p.stickersEnabled,'根据当前语气选择表情，不固定每条都发。'),
      feature('artwork','找图与插画',s.artwork.enabled,'按关键词、作品ID或榜单找公开图片，附带来源。'),
      feature('drawing','Codex 官方绘图',s.imageGeneration.enabled,'绘图独立于聊天模型；Claude 聊天时也由 Codex 生图。',!!s.imageCredentials.codex,s.imageCredentials.codex?'':'需载入本机 Codex 网关凭证'),
      feature('daily','每日插画分享',s.artwork.scheduleEnabled,'现有白名单每日 19:00 分享一次；不补发过期任务。'),
      feature('exploration','公开内容探索',this.public.options.explorationEnabled&&c.onlineEnabled,'闲时读取公开内容并留下真实记录，供聊天找话题。'),
      feature('googleVision','Google 以图找来源',s.visualTools.googleWebEnabled,'使用 Google Cloud Vision 查找图片来源。',!!s.googleVisionCredential,s.googleVisionCredential?'':'尚未配置该服务的 API Key')
    ]};
  }
  async apply({all=false,features={}}){
    if(typeof all!=='boolean'||!features||typeof features!=='object'||Array.isArray(features)||Object.values(features).some(x=>typeof x!=='boolean'))throw new Error('功能开关参数无效');
    const old=await this.control.panel(),catalog=await this.list();
    if(Object.keys(features).some(key=>!catalog.features.some(x=>x.id===key)))throw new Error('未知功能开关');
    const priorOptions={...this.public.options};
    const selected={};for(const item of catalog.features)selected[item.id]=item.available?(all?true:(features[item.id]??item.enabled)):false;
    // The engine saves settings while replies run, so nothing pauses around this.
    try{
      const persona={...old.persona,stickersEnabled:selected.stickers};
      await this.control.panel('save',{onlineEnabled:selected.web,visionEnabled:selected.vision,memoryEnabled:selected.memory,
        loopProtectionEnabled:selected.loop,persona});
      const artwork={...old.artwork,enabled:selected.artwork,scheduleEnabled:selected.daily&&selected.artwork,scheduleTimeZone:'Asia/Singapore',
        scheduleHour:19,scheduleMinute:0,scheduleFrequency:'daily',scheduleTargets:old.config.targets.filter(t=>t.enabled).map(t=>(t.group?'group:':'private:')+t.number)};
      await this.control.panel('saveArtwork',{artwork});
      await this.control.panel('saveImageGeneration',{imageGeneration:{...old.imageGeneration,enabled:selected.drawing,primary:'codex',fallbackEnabled:!!(old.imageCredentials.zhipu||old.imageCredentials.cloudflare)},persistImageCredentials:false});
      await this.control.panel('saveVisualTools',{visualTools:{...old.visualTools,provider:'deepseek',googleWebEnabled:selected.googleVision},persistVisualCredentials:false});
      this.public.options.explorationEnabled=selected.exploration&&selected.web;await this.public.persist();
      return {message:'可用功能已应用，未配置凭证的项目没有伪装成已开启。',...(await this.list())};
    }catch(error){
      this.public.options=priorOptions;try{await this.public.persist();}catch{}
      try{
        await this.control.panel('save',{ai:old.config.ai,persona:old.persona,onlineEnabled:old.config.onlineEnabled,visionEnabled:old.config.visionEnabled,memoryEnabled:old.config.memoryEnabled,loopProtectionEnabled:old.config.loopProtectionEnabled});
        await this.control.panel('saveArtwork',{artwork:old.artwork});
        await this.control.panel('saveImageGeneration',{imageGeneration:old.imageGeneration,persistImageCredentials:false});
        await this.control.panel('saveVisualTools',{visualTools:old.visualTools,persistVisualCredentials:false});
      }catch{}
      throw error;
    }
  }
}
