(() => {
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.ready(); tg.expand(); try { tg.setHeaderColor('#090d27'); tg.setBackgroundColor('#090d27'); } catch {} }
  const $ = id => document.getElementById(id);
  const state = { tasks: [], completed: false, checking: false };
  const initData = () => tg?.initData || '';
  async function api(url, options={}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type':'application/json', 'X-Telegram-Init-Data':initData(), ...(options.headers||{}) } });
    const body = await response.json().catch(()=>({error:'Сервер повернув некоректну відповідь.'}));
    if (!response.ok && !body.tasks) throw new Error(body.error || 'Не вдалося виконати запит.');
    if (!response.ok) body.requestError = body.error || 'Не вдалося перевірити всі канали.';
    return body;
  }
  function notice(message, success=false, target='notice') { const el=$(target); el.textContent=message; el.classList.toggle('success',success); el.hidden=!message; }
  function render(data) {
    state.tasks=data.tasks||[]; state.completed=!!data.completed;
    $('progressText').textContent=`${data.progress ?? 0}%`;
    $('progressBar').style.width=`${data.progress ?? 0}%`;
    $('bladeFill').style.height=`${data.progress ?? 0}%`;
    $('bladeFill').style.borderRadius='0 0 5px 5px';
    $('bladeFill').style.boxShadow=(data.progress>0)?'0 0 18px #5af5ff':'none';
    document.querySelector('.blade-spark').style.opacity=data.progress>0?'1':'0';
    $('progressHint').textContent=state.completed?'Усі завдання виконано — меч заряджено!':`Підтверджено ${data.done||0} із ${data.total||0} обов’язкових підписок`;
    $('questCount').textContent=`${data.total||0} ЗАВДАНЬ`;
    const list=$('sponsors'); list.replaceChildren();
    if (!state.tasks.length) { const empty=document.createElement('div');empty.className='loading-card';empty.textContent='Обов’язкових завдань поки немає.';list.append(empty); }
    state.tasks.forEach(task=>{
      const card=document.createElement('article');card.className='sponsor-card';
      const icon=document.createElement('div');icon.className='sponsor-icon';icon.textContent=task.icon||'⭐';
      const info=document.createElement('div');info.className='sponsor-info';
      const name=document.createElement('h3');name.textContent=task.name;
      const desc=document.createElement('p');desc.textContent=task.confirmed?'Підписку підтверджено ✓':(task.description||'Підпишись і повернись для перевірки');
      info.append(name,desc);
      const link=document.createElement('a');link.className='sponsor-action'+(task.confirmed?' done':'');link.href=task.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=task.confirmed?'✓ ПІДТВЕРДЖЕНО':'ПІДПИСАТИСЯ';
      link.addEventListener('click',()=>{ try { tg?.openTelegramLink?.(task.url); } catch {} });
      card.append(icon,info,link);list.append(card);
    });
    if (state.completed) { $('checkLabel').textContent='УСІ ЗАВДАННЯ ВИКОНАНО'; $('sword').style.filter='drop-shadow(0 0 20px #65f8ff)'; if (!document.body.classList.contains('show-completion')) setTimeout(showCompletion,650); }
    else $('checkLabel').textContent='ПЕРЕВІРИТИ ПІДПИСКУ';
  }
  function showCompletion(){document.body.classList.add('show-completion');$('completionScreen').setAttribute('aria-hidden','false');}
  async function load() {
    try { const data=await api('/api/me');render(data); }
    catch(e) { $('sponsors').innerHTML='<div class="loading-card">'+escapeHtml(e.message)+'</div>'; notice('Відкрий цей застосунок через Telegram Mini App, щоб сервер міг перевірити твій обліковий запис.'); }
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  $('checkButton').addEventListener('click',async()=>{
    if(state.checking)return;state.checking=true;$('checkButton').disabled=true;$('checkLabel').textContent='ПЕРЕВІРЯЄМО...';notice('');
    const old=$('checkButton').querySelector('.sword-icon');if(old)old.innerHTML='<span class="loader"></span>';
    try { const data=await api('/api/check',{method:'POST',body:'{}'});render(data);
      if(data.requestError) notice(data.requestError+' Канали з помилками: '+(data.failedIds||[]).join(', '));
      else if(data.completed) notice('Чудово! Усі підписки підтверджено.',true);
      else {const missing=data.tasks.filter(t=>!t.confirmed).map(t=>t.name);notice('Ти виконав не всі завдання. Перевір підписки на решту каналів: '+missing.join(', '));}
    } catch(e) {notice(e.message);}
    finally {state.checking=false;$('checkButton').disabled=false;$('checkLabel').textContent=state.completed?'УСІ ЗАВДАННЯ ВИКОНАНО':'ПЕРЕВІРИТИ ПІДПИСКУ';const icon=$('checkButton').querySelector('.sword-icon');if(icon)icon.textContent='⚔';}
  });
  $('telegramButton').addEventListener('click',async()=>{
    try {const data=await api('/api/telegram-link'); if(tg?.openTelegramLink)tg.openTelegramLink(data.url);else window.open(data.url,'_blank','noopener,noreferrer');notice('',false,'ownerNotice');}
    catch(e){notice(e.message,false,'ownerNotice');}
  });
  $('recheckButton').addEventListener('click',()=>{document.body.classList.remove('show-completion');$('completionScreen').setAttribute('aria-hidden','true');load();});
  load();
})();
