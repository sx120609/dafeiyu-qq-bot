'use strict';
(async()=>{
  const status=document.getElementById('integration-auth-status');
  try{
    const response=await fetch('/console/integrations/napcat/credential',{cache:'no-store'});
    const data=await response.json();if(!response.ok||!data.credential)throw new Error(data.error||'自动认证失败');
    // This is the existing NapCat WebUI session format, not the raw WebUI key.
    localStorage.setItem('token',JSON.stringify(data.credential));
    location.replace('/webui/');
  }catch(error){status.textContent=error.message+'。请点击控制台上方“重新连接”。';}
})();
