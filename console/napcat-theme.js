'use strict';
// NapCat's WebUI keeps its theme in localStorage "theme" ("light"/"dark", JSON-encoded) and re-reads it on
// "storage" events. Loaded before NapCat's own scripts, this makes it follow the system setting like the console.
(()=>{
  const media=matchMedia('(prefers-color-scheme: dark)');
  const apply=()=>{
    const theme=media.matches?'dark':'light',value=JSON.stringify(theme);
    try{
      if(localStorage.getItem('theme')!==value){
        localStorage.setItem('theme',value);
        window.dispatchEvent(new StorageEvent('storage',{key:'theme',newValue:value,storageArea:localStorage}));
      }
    }catch{}
    document.documentElement.classList.remove('light','dark');document.documentElement.classList.add(theme);
    document.documentElement.style.colorScheme=theme;
  };
  apply();media.addEventListener('change',apply);
})();
