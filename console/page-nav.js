'use strict';
// Shown only when a management page is opened in its own window; inside the console it is embedded.
if(window.top===window&&!document.getElementById('dafeiyu-return')){
  const link=document.createElement('a');link.id='dafeiyu-return';link.href='/console/#overview';link.textContent='← 大肥鱼控制台';
  link.setAttribute('aria-label','返回大肥鱼控制台');document.body.append(link);
}
