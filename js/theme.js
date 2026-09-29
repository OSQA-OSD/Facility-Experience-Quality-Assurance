/* Appearance: the person's choice (kept on their account, remembered here for the first paint),
   or the device's own setting. Loaded at the top of <head>, so a page never flashes the wrong theme. */
(function(){ try{ var t=localStorage.getItem('qa-theme'); if(t==='light'||t==='dark') document.documentElement.dataset.theme=t; }catch(e){} })();
