'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const epoch = () => performance.timeOrigin + performance.now();
const percent = v => v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%';
const uid = () => crypto.randomUUID().replaceAll('-', '');
const english = new URLSearchParams(location.search).get('lang') === 'en';
const t = (ko, en) => english ? en : ko;
const sharedDemo = Boolean(window.ie416DemoRequest);
const home = sharedDemo ? location.pathname : '/';
const demoSetupOnly = sharedDemo || english;
const STORE = t('ie416-supervision-session-v1', 'ie416-supervision-demo-en-v1');
let auth = null, state = null, map = null, protocol = null, busy = false, renderKey = '', pollTimer = null;
let countdown = null, selectedOrder = [], clockOffset = 0, pendingEvents = [], eventTimer = null, errorTimer = null;
let tlxTouched = new Set(), previewFrame = null, lastRequest = null;

async function api(path, body, {blob = false} = {}) {
  if (sharedDemo) return window.ie416DemoRequest(path, body);
  const response = await fetch(path, {method: body ? 'POST' : 'GET',
    headers: {'Content-Type':'application/json', ...(auth ? {Authorization:'Bearer ' + auth.token} : {})},
    ...(body ? {body:JSON.stringify(body)} : {})});
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const fallback = t('서버 응답 오류 ', 'Server error ') + response.status;
    throw new Error(data.error && !(english && /[가-힣]/.test(data.error)) ? data.error : fallback);
  }
  $('save-state').textContent = protocol?.collection ? '수집 서버 연결됨' : t('로컬 기록 연결됨', 'Local storage connected');
  $('save-state').classList.remove('save-warning');
  return blob ? response.blob() : response.json();
}
function reportError(error) {
  $('error').textContent = error.message || String(error); $('error').hidden = false;
  $('save-state').textContent = t('연결 상태 확인 필요', 'Check connection'); $('save-state').classList.add('save-warning');
  clearTimeout(errorTimer); errorTimer = setTimeout(() => $('error').hidden = true, 12000);
}
function remember() {
  if (sharedDemo) return;
  try {localStorage.setItem(STORE,JSON.stringify(auth));} catch (_) {}
}
function queueEvent(event, extra = {}) {
  if (sharedDemo || !auth) return;
  pendingEvents.push({event, client_epoch_ms:epoch(), trial_id:state?.trial_id || null, ...extra});
  clearTimeout(eventTimer);eventTimer=setTimeout(flushEvents, 200);
}
async function flushEvents() {
  if (!auth || !pendingEvents.length) return;
  const batch = pendingEvents.splice(0,100), currentAuth = {...auth};
  try { await api(`/api/study/sessions/${currentAuth.id}/events`,{events:batch}); }
  catch (error) { pendingEvents.unshift(...batch);reportError(error); }
}
function layoutMarker() {
  if (!auth || !state?.trial_id) return;
  const areas=[...document.querySelectorAll('[data-aoi]')].map(el=>{
    const b=el.getBoundingClientRect();return {id:el.dataset.aoi,x:b.x,y:b.y,width:b.width,height:b.height};
  });
  queueEvent('layout',{phase:state.phase,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
    screen_origin:{x:window.screenX,y:window.screenY},areas});
}
async function action(name, payload = {}, retryRequest = null) {
  if (busy || !auth) return;
  busy=true;document.querySelectorAll('[data-submit]').forEach(el=>el.disabled=true);
  const body = retryRequest || {action:name, request_id:uid(), trial_id:state.trial_id,
    client_epoch_ms:epoch(), ...payload};
  lastRequest = body;
  try { const next=await api(`/api/study/sessions/${auth.id}/action`,body);lastRequest=null;install(next); }
  catch (error) {
    reportError(error);
    // A response can be lost after the server saved it. Recover its state
    // instead of submitting a new answer against a stale question.
    try {if(name!=='survey')renderKey='';install(await api(`/api/study/sessions/${auth.id}`));}
    catch (_) {clearTimeout(pollTimer);pollTimer=setTimeout(refresh,2500);}
  }
  finally {busy=false;document.querySelectorAll('[data-submit]').forEach(el=>el.disabled=false);}
}
function button(label, actionName, extra='', classes='primary') {
  return `<button type="button" class="btn ${classes}" data-submit data-action="${actionName}" ${extra}>${label}</button>`;
}
function bindActions() {
  document.querySelectorAll('[data-action]').forEach(el=>el.onclick=()=>{
    if(el.dataset.action==='judge') action('judge',{judgment:el.dataset.choice});
    else if(el.dataset.action==='confirm') action('confirm',{order:selectedOrder});
    else if(el.dataset.action==='start' && state.consent_required) {
      if ($('consent-confirmed').checked) action('start',{consent_confirmed:true});
    }
    else action(el.dataset.action);
  });
}
function install(next) {
  state=next;clockOffset=next.server_epoch_ms-epoch();
  const key=[state.phase,state.trial_id,state.question_index,state.judgment,state.completed_main].join(':');
  if(key!==renderKey) {renderKey=key;render();queueEvent('screen',{phase:state.phase,question:state.question_index});requestAnimationFrame(layoutMarker);}
  armTimers();
}
function now() { return epoch()+clockOffset; }
function armTimers() {
  clearTimeout(pollTimer); clearInterval(countdown);
  if(!state) return;
  let end=null;
  if(state.phase==='prelude')end=state.event_epoch_ms;
  if(state.phase==='review')end=state.review_end_epoch_ms;
  if(state.phase==='question')end=state.question_end_epoch_ms;
  if(['decision','reorder'].includes(state.phase))end=state.decision_end_epoch_ms;
  const update=()=>{
    const remaining=end===null?null:Math.max(0,Math.ceil((end-now())/1000));
    document.querySelectorAll('[data-countdown]').forEach(el=>el.textContent=`${remaining ?? '—'}${t('초', ' s')}`);
  };
  update();countdown=setInterval(update,200);
  if(end!==null)pollTimer=setTimeout(async()=>{
    if(state.phase==='question')return action('answer',{question_index:state.question_index,answer:null});
    await refresh();
  },Math.max(40,end-now()+30));
}
async function refresh() {
  if(!auth||busy)return;
  try {install(await api(`/api/study/sessions/${auth.id}`));}
  catch(error){reportError(error);pollTimer=setTimeout(refresh,2500);}
}

function demoSetup() {
  const adminLink = sharedDemo
    ? `<a class="btn soft demo-link" href="http://127.0.0.1:8767/admin" rel="noreferrer">${t('관리자 로그인 (로컬)','Admin login (local)')}</a>`
    : '';
  return `<div class="intro"><div class="eyebrow">IE416 · ${sharedDemo?t('공유 데모','Public demo'):'English demo'}</div>
    <h1>${t('AI의 추천 순서를 검토해 보세요','Review an AI recommendation')}</h1>
    <p>${t('창고 로봇 세 대의 도움 요청을 감독합니다. 창고 상황이 바뀌면 기존 추천 순서로 모든 마감을 지킬 수 있는지 판단하세요.','Supervise three robots, review a change in the warehouse, and decide whether the recommended order still meets every deadline.')}</p>${adminLink}</div>
    <div class="setup-grid">
      <form class="panel setup-form" id="setup"><div class="eyebrow">${t('데모 설정','Demo setup')}</div><h2>${t('화면 형식 선택','Choose an interface')}</h2>
        <div class="field"><label for="condition">${t('화면 형식','Interface')}</label><select id="condition"><option value="node">${t('노드링크','Node-link view')}</option><option value="table">${t('표 형식','Table view')}</option></select></div>
        <button type="submit" class="btn primary wide" id="create">${t('안내 보기 →','Continue to instructions →')}</button>
        <p class="subtle form-note">${sharedDemo?t('응답은 이 탭에서 처리됩니다. 완료 후 결과를 내려받을 수 있습니다.','Responses stay in this tab. You can download your results at the end.'):'Responses are saved locally as demo data.'}</p>
      </form>
      <section class="panel overview-panel">
        <div class="panel-heading"><div><h2>${t('6회 체험','Six-trial walkthrough')}</h2><p>${t('순서 판단 3회와 상황인식 확인 3회','Three decisions and three situation awareness checks')}</p></div></div>
        <div class="overview-content"><div class="overview-flow">
          <div class="flow-step"><span class="step-num">1</span><h3>${t('기존 추천 확인','Read the recommendation')}</h3><p>${t('처음 추천 순서와 마감을 확인합니다.','Check the starting order and deadlines.')}</p></div>
          <div class="flow-step"><span class="step-num">2</span><h3>${t('상황 업데이트 검토','Review the update')}</h3><p>${t('추천 순서로 마감을 지킬 수 있는지 확인합니다.','Check whether the order still works.')}</p></div>
          <div class="flow-step"><span class="step-num">3</span><h3>${t('판단 또는 문항 응답','Respond')}</h3><p>${t('최종 순서를 확정하거나 화면이 가려진 뒤 세 문항에 답합니다.','Confirm an order or answer three questions with the display hidden.')}</p></div>
        </div></div>
      </section>
    </div>`;
}

function enrollmentSetup(mode, code) {
  const key = STORE + '-enrollment-' + mode;
  let browserKey = uid();
  try {browserKey = localStorage.getItem(key) || browserKey;} catch (_) {}
  $('app').innerHTML = `<section class="panel center-stage"><div class="eyebrow">IE416 · ${mode === 'pilot' ? '파일럿' : '본 실험'}</div>
    <h1>로봇 감독 실험에 참여하기</h1>
    <p>이름이나 연락처를 입력할 필요가 없습니다. 응답은 서버에서 만든 세션 번호로 저장됩니다.</p>
    <form id="enroll"><label class="check-line"><input type="checkbox" required>
      <span>연구자가 제공한 안내를 읽고 별도 동의 절차를 완료했습니다.</span></label>
      <button class="btn primary" type="submit">실험 안내 보기 →</button></form></section>`;
  $('enroll').onsubmit = async event => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {localStorage.setItem(key, browserKey);} catch (_) {}
    const previous = auth;
    auth = null;
    try {
      const next = await api('/api/collection/enroll',{mode,code,browser_key:browserKey,consent_confirmed:true});
      auth = {id:next.view.id,token:next.token};
      remember();
      history.replaceState(null,'',location.pathname + location.search);
      install(next.view);
      if (next.view.phase !== 'instructions') queueEvent('reload',{phase:next.view.phase});
    } catch (error) {
      auth = previous;
      reportError(error);
      submit.disabled = false;
    }
  };
}

function setup() {
  clearTimeout(pollTimer);clearInterval(countdown);cancelAnimationFrame(previewFrame);
  state = null;
  if (sharedDemo) auth = null;
  const resume = auth ? `<div class="resume"><div><strong>${t('저장된 세션이 있습니다.', 'A demo is saved.')}</strong><p>${esc(auth.id)} · ${t('화면을 다시 열어 이어갈 수 있습니다.', 'You can continue from where you left off.')}</p></div><button class="btn small" id="resume">${t('세션 이어가기', 'Resume demo')}</button></div>` : '';
  if (protocol?.collection) {
    const link = /^#study=(pilot|main)\.([a-f0-9]{64})$/.exec(location.hash);
    if (link) return enrollmentSetup(link[1],link[2]);
    $('app').innerHTML = resume + `<section class="panel center-stage"><div class="eyebrow">IE416 · 참가자 접속</div>
      <h1>로봇 감독 실험</h1><p>연구자에게 받은 공용 참가 링크를 열어 주세요.</p>
      <a class="btn small" href="/admin">연구자 로그인</a></section>`;
    if (auth) $('resume').onclick = async () => {renderKey='';await refresh();queueEvent('reload',{phase:state?.phase});};
    return;
  }
  $('app').innerHTML=resume+(demoSetupOnly ? demoSetup() : `
    <div class="intro"><div class="eyebrow">Study workbench / IE416</div><h1>AI의 추천을,<br>현재 상황으로 다시 판단하기</h1><p>상황 변화로 부적절해진 개입 순서를 발견하고 수정하는 감독 실험입니다. 동일한 정보를 표와 노드링크로 제공하고 이해·예측과 의사결정을 기록합니다.</p><a class="btn soft demo-link" href="/?lang=en">영어 데모 <span aria-hidden="true">→</span></a></div>
    <div class="setup-grid"><form class="panel setup-form" id="setup"><div class="eyebrow">연구자 설정</div><h2>실험 세션 만들기</h2>
      <div class="field"><label for="participant">참가자 코드</label><input id="participant" name="participant" autocomplete="off" placeholder="예: P001" pattern="[A-Za-z0-9_-]{1,32}" required maxlength="32"><small class="subtle">이름 대신 익명 코드를 사용하세요.</small></div>
      <div class="field-row"><div class="field"><label for="mode">실행 모드</label><select id="mode"><option value="demo">데모 · 6시행</option><option value="pilot" selected>파일럿 · 연습 4 + 본 36</option><option value="main">본 실험 · 연습 4 + 본 36</option></select></div><div class="field"><label for="condition">UI 조건</label><select id="condition"><option value="auto">자동 균형 배정</option><option value="table">표 형식</option><option value="node">노드링크</option></select></div></div>
      <div class="field"><label for="seed">시나리오 시드</label><input id="seed" type="number" min="0" max="2147483647" value="416" required><small class="subtle">SA는 문서 v2의 고정 12세트입니다. 같은 시드에서는 두 UI의 시행 순서와 행동 문제도 같습니다.</small></div>
      <details class="details"><summary>검토 시간 설정</summary><div class="field-row"><div class="field"><label for="prelude_s">변화 전 제시 초</label><input id="prelude_s" type="number" min="1" max="30" value="4" required></div><div class="field"><label for="review_s">변화 후 검토 초</label><input id="review_s" type="number" min="5" max="120" value="20" required></div></div><div class="field-row"><div class="field"><label for="question_s">문항당 응답 초</label><input id="question_s" type="number" min="10" max="120" value="25" required></div><div class="field"><label for="decision_s">행동 응답 제한 초</label><input id="decision_s" type="number" min="20" max="300" value="90" required></div></div><p>두 평가 유형 모두 같은 고정 검토시간 후 응답합니다. 판단 시간에는 고정 검토시간이 포함되고, 이후 시간도 별도 저장됩니다.</p></details>
      <label class="check-line"><input id="ready" type="checkbox" required><span>연구 안내와 동의 절차를 별도로 확인하고 실험을 시작합니다. 데모는 기능 확인용입니다.</span></label>
      <button type="submit" class="btn primary wide" id="create">세션 준비 →</button><p class="subtle form-note">응답은 이 컴퓨터의 study-data에 저장됩니다. 시선 장비는 별도 연결이 필요합니다.</p>
    </form>
    <section class="panel overview-panel"><div class="panel-heading"><div><h2>실험 구성</h2><p>단일요인 · 피험자 간 설계 · 가상 물류 창고</p></div><span class="tag">파일럿용 구현</span></div>
      <div class="stat-strip"><div><span class="stat-label">판단 대상</span><strong class="stat-value">3 <span class="stat-unit">개입 요청</span></strong></div><div><span class="stat-label">상황인식</span><strong class="stat-value">12 <span class="stat-unit">시행</span></strong></div><div><span class="stat-label">행동 평가</span><strong class="stat-value">24 <span class="stat-unit">시행</span></strong></div></div>
      <div class="overview-content"><div class="overview-flow"><div class="flow-step"><span class="step-num">1</span><h3>기존 추천 확인</h3><p>처음에는 마감을 충족하는 순서</p></div><span class="flow-arrow">→</span><div class="flow-step"><span class="step-num">2</span><h3>상황 변화 검토</h3><p>마감 또는 개입 시간 갱신</p></div><span class="flow-arrow">→</span><div class="flow-step"><span class="step-num">3</span><h3>판단 또는 SA 응답</h3><p>유지·수정 / 화면 차폐 후 질문</p></div></div>
        <table class="protocol-table"><thead><tr><th>시행 유형</th><th>추천 부적절</th><th>변화 후 적절</th><th>변화 없음</th></tr></thead><tbody><tr><td>상황인식</td><td>6</td><td>4</td><td>2</td></tr><tr><td>행동 평가</td><td>12</td><td>8</td><td>4</td></tr></tbody></table>
        <div class="design-list"><div><h3>추천 결과와 상태를 분리합니다</h3><p>모의 AI 추천은 유지하고 현재 값으로 예상 결과만 갱신합니다. 수정 정답을 보여주지 않습니다.</p></div><div><h3>같은 정보, 다른 표현</h3><p>수치·변화·관계·예측·강조를 맞추고 표와 연결 표현을 비교합니다. 지도는 두 조건에 공통입니다.</p></div><div><h3>분석 가능한 시행별 기록</h3><p>지각·이해·회상·대안 예측, 적중·오탐, 최종 순서, 응답 시간과 화면 전환을 CSV와 JSON으로 내보냅니다.</p></div></div>
        <details class="details"><summary>구현 범위와 파일럿 점검</summary><p>문항 원본: ${esc(protocol.sa_bank_version)}. ${esc(protocol.limits)} 실험용 가상 창고에서 사전 정의한 개입 사건을 제시합니다. 개입 시간은 AMR 주행 물리 엔진에서 추정한 값이 아닌 통제된 실험 자극입니다. 실제 시선은 수집하지 않으며 화면 좌표와 이벤트만 제공합니다. 표본 수·문항·제한 시간·Raw TLX 채점은 본 실험 전에 확정하세요.</p></details>
      </div></section></div>`);
  if(auth)$('resume').onclick=async()=>{renderKey='';await refresh();queueEvent('reload',{phase:state?.phase});};
  if(!demoSetupOnly) $('mode').onchange=()=>{
    const demo=$('mode').value==='demo';
    for(const [id,value,min] of [['prelude_s',demo?2:4,1],['review_s',demo?5:20,demo?1:5],['question_s',demo?15:25,demo?3:10],['decision_s',demo?30:90,demo?5:20]]){$(id).value=value;$(id).min=min;}
    if(demo&&!$('participant').value)$('participant').value='DEMO';
  };
  $('setup').onsubmit=async event=>{
    event.preventDefault();$('create').disabled=true;
    try{
      if(auth)await flushEvents();
      const body={condition:$('condition').value};
      if(demoSetupOnly) {
        Object.assign(body,{participant:t('DEMO','DEMO-EN'),mode:'demo',language:t('ko','en'),
          seed:416,prelude_s:2,review_s:sharedDemo?15:5,question_s:sharedDemo?25:15,decision_s:sharedDemo?60:30});
      } else {
        for(const id of ['participant','mode'])body[id]=$(id).value;
        for(const id of ['seed','prelude_s','review_s','question_s','decision_s'])body[id]=Number($(id).value);
      }
      const next=await api('/api/study/sessions',body);
      if (sharedDemo && !history.state?.ie416DemoCondition) {
        history.pushState({ie416DemoCondition:body.condition}, '');
      }
      auth={id:next.view.id,token:next.token};remember();renderKey='';install(next.view);
    }catch(error){reportError(error);$('create').disabled=false;}
  };
}

function restoreDemoPage() {
  const condition = history.state?.ie416DemoCondition;
  const previous = state?.config.condition;
  setup();
  if (['table','node'].includes(condition)) {
    $('condition').value = condition;
    $('setup').requestSubmit();
  } else if (previous) {
    $('condition').value = previous;
  }
}

function returnToSetup() {
  if (sharedDemo && history.state?.ie416DemoCondition) history.back();
  else setup();
}

function demoInstructions() {
  $('app').innerHTML = `<section class="panel instructions">
    <div class="eyebrow">${t('데모 안내','Demo instructions')}</div>
    <h1>${t('추천 순서로 모두 제시간에 끝낼 수 있을까요?','Will the recommended order meet every deadline?')}</h1>
    <p>${t('당신은 창고의 현장 담당자입니다. 로봇 A, B, C가 작업을 계속하기 위해 동시에 도움을 요청했습니다. 한 번에 한 대씩 도울 수 있으므로 처리 순서를 정해야 합니다.','You are the warehouse operator on duty. Robots A, B, and C have all asked for help so they can get back to work. You can help one robot at a time, so you need to decide whom to help first.')}</p>
    <section class="demo-example" aria-labelledby="demo-example-title">
      <h2 id="demo-example-title">${t('연습 예제 · 시간 제한 없음','Practice example · No time limit')}</h2>
      <p>${t('AI가 처음에 추천한 순서는','The AI originally recommended')} <strong>A → B → C</strong>${t('입니다.','.')}</p>
      <p>${t('B가 다음 운반을 시작하려면 먼저 당신이 통로를 확인해 줘야 합니다. 운반 일정이 앞당겨져서 통로 확인을 마쳐야 하는 시각이 9분에서 6분으로 바뀌었습니다.','Before robot B can start its next delivery, you need to check its aisle. The delivery was moved up, so the aisle check is now due at minute 6. The original deadline was minute 9.')}</p>
      <table class="demo-example-table">
        <thead><tr>
          <th scope="col">${t('로봇','Robot')}</th><th scope="col">${t('소요 시간','Duration')}</th>
          <th scope="col">${t('현재 마감','Current deadline')}</th><th scope="col">${t('예상 완료','Expected finish')}</th>
        </tr></thead>
        <tbody>
          <tr><th scope="row">A</th><td>4</td><td>10</td><td>4</td></tr>
          <tr class="example-changed"><th scope="row">B</th><td>4</td><td><strong>6</strong></td><td><strong>8</strong></td></tr>
          <tr><th scope="row">C</th><td>3</td><td>13</td><td>11</td></tr>
        </tbody>
      </table>
      <p class="subtle">${t('표의 단위는 분입니다. 예상 완료가 현재 마감과 같거나 빠르면 제시간입니다.','All times are in minutes. An expected finish at or before the current deadline is on time.')}</p>
      <p><strong>${t('이 순서를 그대로 유지해도 될까요?','Can you keep this order?')}</strong></p>
      <div class="actions">
        <button type="button" class="btn soft" data-example-choice="keep">${t('유지 가능','Keep the order')}</button>
        <button type="button" class="btn soft" data-example-choice="change">${t('수정 필요','Revise the order')}</button>
      </div>
      <div class="demo-example-feedback" id="demo-example-feedback" role="status"></div>
    </section>
    <ol class="demo-steps">
      <li><strong>${t('먼저 상태 업데이트를 확인하세요.','Check the status update.')}</strong> ${t('표나 노드링크 카드에서 예상 완료와 현재 마감을 비교합니다. 마감 값이 9 → 6처럼 표시되면 오른쪽이 현재 값입니다.','Compare the expected finish and current deadline in the table or on the robot cards. For a value like 9 → 6, use the number on the right.')}</li>
      <li><strong>${t('유지 또는 수정을 고르세요.','Choose whether to keep or revise the order.')}</strong> ${t('하나라도 늦으면 수정이 필요합니다. 다음 화면에서 ↑ ↓로 순서를 맞춘 뒤 최종 순서를 확정합니다. 유지라면 그대로 확정하세요.','Revise the order if any request finishes late. On the next screen, use ↑ and ↓ to arrange the robots and confirm. If you chose to keep the order, confirm it as shown.')}</li>
      <li><strong>${t('화면이 가려지면 세 문항에 답하세요.','If the display is hidden, answer three questions.')}</strong> ${t('일부 시행은 순서 결정 대신 방금 본 변화나 순서에 대해 묻습니다. 답을 고르면 다음 문항이 나옵니다.','Some trials ask what you saw or what would happen under a different order. Select an answer to move to the next question.')}</li>
    </ol>
    <button type="button" class="btn soft" id="demo-back">${t('← 설정으로','← Back to setup')}</button>
    ${button(t('데모 시작 →','Begin demo →'),'start')}
  </section>`;
  $('demo-back').onclick = returnToSetup;
  document.querySelectorAll('[data-example-choice]').forEach(choice => {
    choice.onclick = () => {
      const correct = choice.dataset.exampleChoice === 'change';
      $('demo-example-feedback').innerHTML = `
        <strong>${correct?t('맞아요. 수정이 필요합니다.','Correct. Revise the order.'):t('이 경우에는 수정이 필요합니다.','This order needs to be revised.')}</strong>
        <p>${t('B는 마감 6분보다 늦은 8분에 끝납니다. B → A → C로 바꾸면 B는 4분, A는 8분, C는 11분에 끝나 모두 마감을 지킵니다.','B finishes at 8 min, two minutes past its deadline. With B → A → C, B finishes at 4 min, A at 8 min, and C at 11 min. All three meet their deadlines.')}</p>`;
    };
  });
  bindActions();
}

function instructions(){
  if(state.config.mode === 'demo') {
    demoInstructions();
    return;
  }
  const requiresConsent = protocol?.collection && state.consent_required;
  $('app').innerHTML=`<section class="panel instructions"><div class="eyebrow">참가자 안내 / 실험 세션</div><h1>세 로봇의 개입 순서를 검토하세요</h1><p>한 사람이 세 개입 요청을 한 번에 하나씩 처리합니다. 시스템의 추천을 참고하되, 현재 상황에 맞는지 직접 판단하세요.</p>
    <ol><li><strong>완료 마감이 기준입니다.</strong><p>개입을 시작하는 시각이 아니라 끝내는 시각이 마감 이내여야 합니다. 처리 순서에 따라 기다리는 시간이 달라집니다.</p></li><li><strong>처음 추천은 적절하지만 상황이 달라질 수 있습니다.</strong><p>마감이 앞당겨지거나 개입 시간이 늘어납니다. 변화가 있어도 기존 순서가 계속 적절할 수 있고, 변화가 없는 시행도 있습니다.</p></li><li><strong>화면 검토 후 질문에 응답합니다.</strong><p>일부 시행은 화면을 가린 뒤 3개 객관식 질문이 나옵니다. 다른 시행은 기존 순서의 유지 가능 여부를 판단하고 최종 순서를 정합니다. 본 시행 중 정답은 제공되지 않습니다.</p></li></ol>
    <div class="rule-inline">예: 예상 완료 <strong>12분</strong>, 마감 <strong>12분</strong>이면 허용됩니다.<br>예상 완료 <strong>13분</strong>, 마감 <strong>12분</strong>이면 마감 위반입니다.</div>
    <p class="subtle">표시된 시간은 변화 시점부터의 모의 분입니다. 화면 검토 중에는 상태와 모의 시간이 고정됩니다. 화면의 지도는 공통 맥락이며 개입 소요시간을 이동 거리로 계산하지 않습니다.</p>
    <p class="subtle">${state.total_practice?`연습 ${state.total_practice}시행 후 본 ${state.total_main}시행을 진행합니다. 본 시행 12회마다 휴식 화면이 나옵니다.`:'데모 6시행을 진행합니다. 데모 기록은 본 실험과 구분됩니다.'}</p>
    ${requiresConsent ? `<p><strong>세션 코드 ${esc(state.config.participant)}</strong></p>
      <label class="check-line"><input type="checkbox" id="consent-confirmed">
      <span>연구자가 제공한 안내를 읽고 별도 동의 절차를 완료했습니다.</span></label>` : ''}
    ${button(state.total_practice?'연습 시작 →':'데모 시작 →','start',requiresConsent?'disabled':'')}</section>`;
  bindActions();
  if (requiresConsent) $('consent-confirmed').onchange = event => {
    document.querySelector('[data-action="start"]').disabled = !event.target.checked;
  };
}
function sessionTop(){
  const practice=state.practice;
  const done=practice?state.completed_practice:state.completed_main,total=practice?state.total_practice:state.total_main;
  const title = practice ? t('연습 시행', 'Practice trial') : t('개입 우선순위 검토', 'Review intervention priority');
  const guidance = practice ? t('연습에는 정답 피드백이 제공됩니다.', 'Feedback is shown during practice.') : t('현재 상황을 기준으로 판단하세요.', 'Use the current status to make your decision.');
  return `<div class="session-top"><div><div class="eyebrow">${practice?'Practice':t('Supervisory review', 'English demo')}</div><h1>${title}</h1><p class="session-sub">${t('참가자', 'Participant')} ${esc(state.config.participant)} · ${esc(state.trial_id||'')} · ${guidance}</p></div><div class="progress-wrap">${practice?t('연습','Practice'):t('본 시행','Trial')} ${Math.min(total,done+1)} / ${total}<div class="progress-track"><div class="progress-fill" style="width:${done/total*100}%"></div></div></div></div>`;
}
function valueMarkup(value,previous,changedClass='changed-value'){
  return `<span class="${value!==previous?changedClass:''}">${previous} → ${value}</span>`;
}
function relationships(row,event){
  const parts=[row.predecessor
    ? t(`${row.predecessor} 완료 이후 ${row.robot} 시작`, `${row.robot} starts after ${row.predecessor} finishes`)
    : t(`${row.robot}는 처음 시작`, `${row.robot} starts first`)];
  if(event?.robot===row.robot)parts.push(event.kind==='deadline'
    ? t('상태 변화 → 마감 단축', 'Update → earlier deadline')
    : t('상태 변화 → 소요 증가', 'Update → longer duration'));
  parts.push(t('완료와 마감 비교 → 초과량', 'Finish vs. deadline → overrun'));
  return parts.join('<br>');
}
function tableMarkup(stimulus){
  const labels = [t('로봇','Robot'),t('소요<br>이전 → 현재','Duration<br>Old → New'),t('마감<br>이전 → 현재','Deadline<br>Old → New'),
    t('예상<br>시작','Est.<br>start'),t('예상<br>완료','Est.<br>finish'),t('마감<br>초과','Overrun'),t('관련 관계','Dependencies')];
  return `<table class="state-table" aria-label="${t('로봇 개입 상태와 예상 결과','Robot interventions and predicted outcomes')}"><colgroup><col style="width:7%"><col style="width:15%"><col style="width:15%"><col style="width:10%"><col style="width:10%"><col style="width:10%"><col style="width:33%"></colgroup><thead><tr>${labels.map(label=>`<th>${label}</th>`).join('')}</tr></thead><tbody>${stimulus.rows.map(r=>`<tr><td><strong>${r.robot}</strong></td><td data-aoi="${r.robot}-duration">${valueMarkup(r.duration,r.previous_duration)}</td><td data-aoi="${r.robot}-deadline">${valueMarkup(r.deadline,r.previous_deadline)}</td><td data-aoi="${r.robot}-start">${r.start}</td><td data-aoi="${r.robot}-finish">${r.finish}</td><td data-aoi="${r.robot}-outcome"><span class="${r.overrun?'violation-value':''}">${r.overrun}</span></td><td class="relationship" data-aoi="${r.robot}-relations">${relationships(r,stimulus.event)}</td></tr>`).join('')}</tbody></table>`;
}
function graphMarkup(stimulus){
  const ordered=stimulus.order.map(robot=>stimulus.rows.find(r=>r.robot===robot));
  return `<div class="graph" id="relationship-graph" role="group" aria-label="${t('로봇 개입 순서, 상태 변화와 예상 마감 초과의 연결','Intervention order, changes, and predicted deadline overruns')}"><svg class="graph-links" aria-hidden="true"></svg>${ordered.map(r=>`<article class="graph-node" data-robot="${r.robot}"><h3>${t('로봇','Robot')} ${r.robot}</h3><div class="node-row" data-aoi="${r.robot}-duration" data-anchor="${r.robot}-duration"><span>${t('소요','Duration')}</span>${valueMarkup(r.duration,r.previous_duration)}</div><div class="node-row" data-aoi="${r.robot}-deadline" data-anchor="${r.robot}-deadline"><span>${t('마감','Deadline')}</span>${valueMarkup(r.deadline,r.previous_deadline)}</div><div class="node-row" data-aoi="${r.robot}-start" data-anchor="${r.robot}-start"><span>${t('예상 시작','Est. start')}</span><span>${r.start}</span></div><div class="node-row" data-aoi="${r.robot}-finish" data-anchor="${r.robot}-finish"><span>${t('예상 완료','Est. finish')}</span><span>${r.finish}</span></div></article>`).join('')}${ordered.map(r=>`<div class="result-node ${r.overrun?'bad':''}" data-aoi="${r.robot}-outcome" data-anchor="${r.robot}-outcome">${r.robot} ${t('마감 초과','overrun')}<strong>${r.overrun}${t('분',' min')}</strong></div>`).join('')}</div>`;
}
function review(){
  const s=state.stimulus;
  const condition=state.config.condition;
  const initial=state.phase==='prelude';
  const demo = state.config.mode === 'demo';
  const eventText=initial?t('세 요청이 가용합니다. 현재 추천과 상태를 확인하세요.','Three requests are available. Review the current recommendation and status.'):s.event.text;
  const mapPanel=`<section class="panel map-panel"><div class="panel-heading"><div><h2>${t('가상 물류 창고','Virtual warehouse')}</h2><p>${t('감독 대상 A · B · C','Robots A · B · C')}</p></div><span class="tag">${t('실험 모형','Simulation')}</span></div><canvas class="map-stage" id="warehouse-map" aria-label="${t('가상 창고에서 세 로봇의 개입 요청 위치','Locations of the three intervention requests')}"></canvas><div class="map-meta"><span>WAREHOUSE / THREE REQUESTS</span><span>${initial?t('사건 발생 전','Before update'):t('검토 상태 고정','Status fixed')}</span></div><div class="map-legend"><span><i class="legend-dot"></i>${t('요청 위치','Request location')}</span><span><i class="legend-dot target"></i>${t('변경된 로봇','Updated robot')}</span></div><p class="map-guidance">${t('세 요청을 한 사람이 순차 처리합니다. 개입 시간과 완료 마감은 정보 패널을 기준으로 확인하세요.','One operator handles the requests in sequence. Use the durations and deadlines shown in the information panel.')}</p></section>`;
  let control='';
  const keep = t('유지 가능','Keep the order');
  const change = t('수정 필요','Revise the order');
  if(['prelude','review'].includes(state.phase))control=`<div class="review-bottom"><div><h3>${initial?t('기존 추천 확인','Review the original recommendation'):t('갱신된 상태 검토','Review the updated status')}</h3><p>${initial?t('잠시 후 상태를 다시 확인합니다.','The status will update shortly.'):t('검토가 끝나면 응답 화면으로 전환됩니다.','The response screen will open when the review period ends.')}</p></div><span class="phase-timer" data-countdown></span></div>`;
  else if(state.phase==='decision')control=`<section class="decision"><h3>${t('현재 AI 추천을 유지할 수 있습니까?','Can you keep the recommended order?')}</h3><p class="subtle">${demo?t('모두 제시간이면 유지 가능, 하나라도 늦으면 수정 필요를 누르세요.','Choose Keep the order if all finish on time, or Revise the order if any finish late.'):t('모든 개입이 완료 마감 이내에 끝나는지 판단하세요.','Decide whether every intervention finishes by its deadline.')}</p><div class="actions">${button(keep,'judge','data-choice="keep"','soft')}${button(change,'judge','data-choice="change"','soft')}</div><p class="subtle">${t('응답 제한','Time left')} <span data-countdown></span></p></section>`;
  else {
    selectedOrder=[...s.order];
    control=`<section class="decision"><h3>${t('최종 개입 순서를 확정하세요','Confirm the final intervention order')}</h3><p class="subtle">${t('직전 판단:','Your decision:')} ${state.judgment==='keep'?keep:change} · ${t('순서를 유지하거나 위아래로 이동할 수 있습니다.','Keep the sequence or move robots up and down.')}</p><div class="order-editor" id="order-editor"></div>${button(t('최종 순서 확정','Confirm order'),'confirm')} <span class="phase-timer" data-countdown></span></section>`;
  }
  const status = initial ? t('변화 전','before update') : t('갱신됨','updated');
  const unitNote = demo
    ? t('각 로봇의 예상 완료와 현재 마감(→ 오른쪽)을 비교하세요. 단위는 분입니다.','Compare each robot’s estimated finish with its current deadline (right of →). Times are in minutes.')
    : t('단위: 변화 시점부터 모의 분 · 완료 ≤ 마감이면 충족','Simulated minutes from the update · Finish ≤ deadline means on time');
  $('app').innerHTML=sessionTop()+`<div class="trial-layout">${mapPanel}<section class="panel info-panel"><header class="recommendation" data-aoi="recommendation"><div><div class="label">${t('모의 AI 추천','Simulated AI recommendation')}</div><div class="recommended-order">${s.order.join(' → ')}</div><p class="subtle">${t('추천: 변화 전 생성 · 상태:','Recommendation from before the update · Status:')} ${status}</p></div><span class="status-pill">${initial?t('현재 추천','Current recommendation'):t('재계산 대기','Recalculation pending')}</span></header><div class="info-body"><p class="unit-note">${unitNote}</p><div class="event-box ${s.event?.kind!=='none'&&!initial?'changed':''}" data-aoi="event" id="event-box"><div class="event-label">${initial?t('최초 상태','Initial status'):t('상태 업데이트','Status update')}</div>${esc(eventText)}</div>${condition==='table'?tableMarkup(s):graphMarkup(s)}</div>${control}</section></div>`;
  bindActions();if(state.phase==='reorder')drawOrder();drawMap(initial?0:1);drawGraph();
  if(initial){
    const animate=()=>{if(state?.phase!=='prelude')return;const f=Math.max(0,Math.min(1,1-(state.event_epoch_ms-now())/(state.config.prelude_s*1000)));drawMap(f);previewFrame=requestAnimationFrame(animate);};
    previewFrame=requestAnimationFrame(animate);
  }
}
function drawOrder(){
  $('order-editor').innerHTML=selectedOrder.map((r,i)=>`<div class="order-row"><div><span class="order-index">${i+1}</span><strong>${t('로봇','Robot')} ${r}</strong></div><div class="order-controls"><button type="button" data-move="${i}" data-dir="-1" aria-label="${t(`로봇 ${r} 위로 이동`,`Move robot ${r} up`)}" ${i===0?'disabled':''}>↑</button><button type="button" data-move="${i}" data-dir="1" aria-label="${t(`로봇 ${r} 아래로 이동`,`Move robot ${r} down`)}" ${i===2?'disabled':''}>↓</button></div></div>`).join('');
  document.querySelectorAll('[data-move]').forEach(button=>button.onclick=()=>{const i=+button.dataset.move,j=i+(+button.dataset.dir);[selectedOrder[i],selectedOrder[j]]=[selectedOrder[j],selectedOrder[i]];queueEvent('reorder',{order:[...selectedOrder]});drawOrder();});
}
function drawMap(progress=1){
  const canvas=$('warehouse-map');if(!canvas||!map||!state.stimulus)return;
  const rect=canvas.getBoundingClientRect(),w=rect.width,h=rect.height,dpr=devicePixelRatio||1;
  canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.fillStyle='#f9fbf8';ctx.fillRect(0,0,w,h);
  const xs=map.nodes.map(n=>n.x),ys=map.nodes.map(n=>n.y),minX=Math.min(...xs),minY=Math.min(...ys),maxX=Math.max(...xs),maxY=Math.max(...ys);
  const scale=Math.min((w-65)/(maxX-minX||1),(h-65)/(maxY-minY||1));
  const ox=(w-(maxX-minX)*scale)/2,oy=(h-(maxY-minY)*scale)/2;
  const nodes=Object.fromEntries(map.nodes.map(n=>[n.id,n]));
  const point=n=>({x:ox+(n.x-minX)*scale,y:oy+(n.y-minY)*scale});
  for(const shelf of map.shelves||[]){const p=point(shelf);ctx.fillStyle='#e6ece5';ctx.strokeStyle='#d3ddd2';ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(p.x,p.y,shelf.width*scale,shelf.height*scale,3);ctx.fill();ctx.stroke();}
  ctx.strokeStyle='#d7e0d9';ctx.lineWidth=2;ctx.lineCap='round';
  for(const edge of map.edges){if(edge.from>edge.to)continue;const a=point(nodes[edge.from]),b=point(nodes[edge.to]);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
  for(const port of map.ports){const p=point(nodes[port.nodeId]);ctx.fillStyle='#ead9bf';ctx.fillRect(p.x-3,p.y-3,6,6);}
  for(const [robot,index]of Object.entries(state.stimulus.poses)){
    const port=map.ports[index%map.ports.length],target=nodes[port.nodeId],neighbor=map.edges.find(e=>e.to===target.id);
    const origin=neighbor?nodes[neighbor.from]:target;
    const a=point(origin),b=point(target),p={x:a.x+(b.x-a.x)*progress,y:a.y+(b.y-a.y)*progress};
    const changed=state.stimulus.event?.robot===robot;
    ctx.fillStyle=changed?'#b96528':'#366c5c';ctx.strokeStyle='#fff';ctx.lineWidth=2;
    ctx.beginPath();ctx.roundRect(p.x-11,p.y-9,22,18,4);ctx.fill();ctx.stroke();
    ctx.fillStyle='#fff';ctx.font='600 11px -apple-system,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(robot,p.x,p.y+1);
    ctx.fillStyle='#63766d';ctx.font='9px -apple-system,sans-serif';ctx.textAlign='center';ctx.fillText(port.id,p.x,Math.max(12,p.y-18));
  }
}
function drawGraph(){
  const graph=$('relationship-graph');if(!graph)return;
  const svg=graph.querySelector('svg'),box=graph.getBoundingClientRect();
  const nsv='http://www.w3.org/2000/svg';svg.setAttribute('viewBox',`0 0 ${box.width} ${box.height}`);svg.replaceChildren();
  const defs=document.createElementNS(nsv,'defs'),marker=document.createElementNS(nsv,'marker');
  for(const [k,v]of Object.entries({id:'flow-arrow',viewBox:'0 0 10 10',refX:'9',refY:'5',markerWidth:'5',markerHeight:'5',orient:'auto-start-reverse'}))marker.setAttribute(k,v);
  const tip=document.createElementNS(nsv,'path');tip.setAttribute('d','M 0 0 L 10 5 L 0 10 Z');tip.setAttribute('class','arrow');marker.append(tip);defs.append(marker);svg.append(defs);
  const pt=(anchor,side)=>{const b=graph.querySelector(`[data-anchor="${anchor}"]`).getBoundingClientRect();return{x:b.x-box.x+(side==='left'?0:side==='right'?b.width:b.width/2),y:b.y-box.y+(side==='top'?0:side==='bottom'?b.height:b.height/2)};};
  const line=(d,label,x,y,align='middle')=>{const p=document.createElementNS(nsv,'path');p.setAttribute('d',d);p.setAttribute('marker-end','url(#flow-arrow)');svg.append(p);const t=document.createElementNS(nsv,'text');t.setAttribute('x',x);t.setAttribute('y',y);t.setAttribute('text-anchor',align);t.textContent=label;svg.append(t);};
  const order=state.stimulus.order;
  for(let i=0;i<2;i++){const a=pt(order[i]+'-finish','right'),b=pt(order[i+1]+'-start','left'),m=(a.x+b.x)/2;line(`M ${a.x} ${a.y} C ${m} ${a.y},${m} ${b.y},${b.x} ${b.y}`,t('이후','then'),m,(a.y+b.y)/2-6);}
  for(const robot of order){const a=pt(robot+'-finish','bottom'),b=pt(robot+'-outcome','top');const card=graph.querySelector(`[data-robot="${robot}"]`).getBoundingClientRect();const y=card.bottom-box.y;line(`M ${a.x} ${y} V ${b.y}`,t('마감 비교','deadline check'),a.x+4,(y+b.y)/2-3,'start');}
  const ev=state.stimulus.event;
  if(ev&&ev.kind!=='none'){
    const b=pt(`${ev.robot}-${ev.kind}`,'top');line(`M ${b.x} 2 V ${b.y}`,ev.kind==='deadline'?t('마감 단축','earlier deadline'):t('소요 증가','longer duration'),b.x+5,18,'start');
  }
}
function question(){
  $('app').innerHTML=sessionTop()+`<section class="panel question-panel"><div class="occluded-label"><span>${t('화면 차폐 · 문항','Display hidden · Question')} ${state.question_index+1} / 3</span><span class="phase-timer" data-countdown></span></div><h2>${esc(state.question.prompt)}</h2><div class="answer-list">${state.question.options.map((o,i)=>`<button type="button" data-submit class="answer-option" data-answer="${esc(o.id)}"><span class="letter">${i+1}</span><span>${esc(o.text)}</span></button>`).join('')}</div><p class="subtle" style="margin-top:20px">${t('화면에서 확인한 정보와 처리 규칙을 기준으로 응답하세요.','Use the information you reviewed and the intervention rules to answer.')}</p></section>`;
  document.querySelectorAll('[data-answer]').forEach(el=>el.onclick=()=>action('answer',{answer:el.dataset.answer,question_index:state.question_index}));
}
function trialDone(){
  let feedback='';
  if(state.practice_feedback){const f=state.practice_feedback;feedback=`<span class="practice-check">연습 피드백</span><h1>${f.correct?'판단과 최종 순서가 적절합니다.':'판단 또는 순서를 다시 확인하세요.'}</h1><p>기존 추천은 ${f.suitable?'모든 마감을 충족합니다.':'현재 마감을 충족하지 못합니다.'}<br>가능한 순서: ${f.feasible_orders.map(o=>o.join(' → ')).join(' / ')}</p><p class="subtle">완료 시각이 마감과 같아도 충족입니다. 다음 연습에서 같은 규칙을 적용하세요.</p>`;}
  else feedback=`<div class="eyebrow">${sharedDemo?t('시행 완료','Trial complete'):'Trial saved'}</div><h1>${sharedDemo?t('응답했습니다.','Response recorded'):t('응답이 저장되었습니다.','Response saved')}</h1><p>${t('다음 시행으로 이동하세요.','Continue to the next screen.')}</p>`;
  $('app').innerHTML=`<section class="panel center-stage">${feedback}${button(t('다음 시행 →','Continue →'),'next')}</section>`;bindActions();
}
const tlxItems=[
  ['mental',t('정신적 요구','Mental demand')],
  ['physical',t('신체적 요구','Physical demand')],
  ['temporal',t('시간적 요구','Temporal demand')],
  ['performance',t('수행 성과','Performance'),t('좋음','Good'),t('나쁨','Poor')],
  ['effort',t('노력','Effort')],
  ['frustration',t('좌절감','Frustration')],
];
const tlxPrompts = {
  mental:t('과제를 수행하는 동안 얼마나 많은 정신적·지각적 활동이 필요했습니까? 예를 들어 생각하기, 판단하기, 계산하기, 기억하기, 보기, 탐색하기 등이 얼마나 요구되었습니까? 과제가 쉬웠습니까, 어려웠습니까? 단순했습니까, 복잡했습니까?',
    'How much mental and perceptual activity did the task require, such as thinking, judging, calculating, remembering, looking or searching? Was the task easy or difficult, simple or complex?'),
  physical:t('과제를 수행하는 동안 얼마나 많은 신체적 활동이 필요했습니까? 과제가 신체적으로 쉬웠습니까, 힘들었습니까? 느리고 여유로웠습니까, 빠르고 많은 노력이 필요했습니까?',
    'How much physical activity did the task require? Was it physically easy or demanding, slow and leisurely or fast and strenuous?'),
  temporal:t('과제의 진행 속도로 인해 얼마나 많은 시간적 압박을 느꼈습니까? 과제의 진행 속도가 느리고 여유로웠습니까, 아니면 빠르고 촉박했습니까?',
    'How much time pressure did you feel because of the pace of the task? Was the pace slow and leisurely or fast and rushed?'),
  performance:t('과제에서 요구된 목표를 얼마나 성공적으로 달성했다고 생각합니까? 자신의 수행 성과에 얼마나 만족하였습니까?',
    'How successfully do you think you achieved the task goals? How satisfied were you with your performance?'),
  effort:t('자신이 달성한 수준의 수행 성과를 얻기 위해 정신적·신체적으로 얼마나 열심히 노력해야 했습니까?',
    'How hard did you have to work mentally and physically to achieve your level of performance?'),
  frustration:t('과제를 수행하는 동안 얼마나 불안하고, 낙담하고, 짜증이 나고, 스트레스를 받았습니까? 반대로 얼마나 안정적이고, 만족스럽고, 편안하게 느꼈습니까?',
    'How insecure, discouraged, irritated or stressed did you feel during the task? How secure, satisfied or relaxed did you feel?')
};
const interviewSections = [
  [t('인터페이스 사용 경험','Interface experience'), [
    ['q1',t('AI가 추천한 작업 순서를 확인할 때, 화면에서 어떤 정보를 가장 먼저 살펴보았습니까? 이후에는 어떤 순서로 정보를 확인했습니까?',
      'What information on the screen did you look at first when reviewing the AI-recommended order? What did you look at next?'),
      t('처음 확인한 정보와 마지막 판단에 사용한 정보가 같았나요?','Was the information you looked at first the same information you used for your final judgment?')],
    ['q2',t('화면에서 찾기 어렵거나 의미를 파악하기 위해 여러 번 확인해야 했던 정보가 있었습니까?',
      'Was any information hard to find or something you had to check repeatedly to understand?'),
      t('완료 기한, 예상 완료 시점, 작업 순서, 변경 사항 중 해당하는 것이 있었나요?','Did this include deadlines, expected finish times, the work order or status changes?')]
  ]],
  [t('상황 변화의 이해 및 결과 예측','Understanding changes and predicting outcomes'), [
    ['q3',t('로봇의 완료 기한이나 작업 조건이 변경되었을 때, 그 변화가 기존 추천 순서의 결과에 어떤 영향을 주는지 어떻게 파악했습니까?',
      'When a robot deadline or work condition changed, how did you determine its effect on the outcome of the original recommendation?'),
      t('화면에서 어떤 수치, 설명, 연결 관계를 함께 확인했나요?','Which numbers, explanations or connections did you look at together?')],
    ['q4',t('기존 추천과 다른 작업 순서의 완료 시점을 예상해야 할 때, 어떤 방법으로 결과를 판단했습니까?',
      'When you had to predict finish times for an order different from the original recommendation, how did you work out the outcome?'),
      t('머릿속으로 계산하거나 기억해야 했던 정보 중 어려운 부분이 있었나요?','Was anything difficult to calculate mentally or remember?')]
  ]],
  [t('AI 추천의 유효성 판단과 신뢰','Judging and trusting the AI recommendation'), [
    ['q5',t('기존 AI 추천 순서를 유지할지, 다른 순서로 수정할지 결정할 때 가장 중요하게 사용한 판단 기준은 무엇이었습니까?',
      'What was the most important criterion you used when deciding whether to keep the AI recommendation or revise the order?'),
      t('완료 기한과 예상 완료 시점 등을 어떻게 비교했나요?','How did you compare deadlines and expected finish times?')],
    ['q6',t('기존 AI 추천을 그대로 따라도 된다고 느낀 상황과, 다시 검토해야 한다고 느낀 상황에는 어떤 차이가 있었습니까?',
      'What differed between situations where you felt you could follow the original AI recommendation and those where you felt you should review it again?'),
      t('추천을 믿거나 의심하게 만든 화면의 정보가 있었나요?','Did any on-screen information make you trust or question the recommendation?')]
  ]],
  [t('인지적 부담과 인터페이스 개선','Cognitive effort and interface improvements'), [
    ['q7',t('실험 중 정보 이해나 의사결정에 가장 많은 정신적 노력이 필요했다고 느낀 순간은 언제였습니까?',
      'When did understanding information or making a decision require the most mental effort?'),
      t('변경 사항 발견, 영향 이해, 대안 순서 예측, 최종 선택 중 어느 과정이었나요?','Was it when detecting a change, interpreting its effect, predicting an alternative order or making the final choice?')],
    ['q8',t('상황 변화로 기존 추천이 부적절해진 경우를 더 쉽게 알아차리려면, 화면에서 어떤 정보나 표현 방식을 개선하면 좋겠습니까?',
      'What information or presentation could be improved to make it easier to spot a recommendation that became unsuitable after a change?'),
      t('강조 표시, 정보의 배치, 수치 제시 방식 등에 관한 의견이 있나요?','Do you have suggestions about highlighting, layout or how numbers are presented?')]
  ]]
];
const pilotQuestions = [
  ['qp1',t('전체 36회 시행 중 피로하거나 집중하기 어려워진 구간이 있었습니까?',
    'Was there a point during the 36 trials when you became tired or found it hard to concentrate?'),
    t('언제부터였고 어떤 이유 때문이라고 생각하나요?','When did it start, and what do you think contributed to it?')],
  ['qp2',t('화면을 가린 후 답하는 SA 문항이나 작업 순서 판단 과정에서 이해하기 모호했던 부분이 있었습니까?',
    'Was anything unclear in the situation awareness questions after the screen was hidden or in deciding the work order?'),
    t('특정 질문, 계산 과정, 실험 지침을 예로 들어 설명해 주실 수 있나요?','Could you give an example involving a question, calculation or instruction?')]
];

function legacySurvey(){
  tlxTouched=new Set();
  $('app').innerHTML=`<form class="panel survey" id="survey"><div class="eyebrow">Post experiment / NASA TLX</div><h1>${t('전체 과제의 작업부하','Task workload')}</h1><p>${t('여섯 항목을 모두 조정해 응답하세요. 0부터 100까지, 전체 과제를 기준으로 평가합니다.','Adjust all six sliders. Rate the entire task on each scale from 0 to 100.')}</p>
    ${tlxItems.map(([id,label,low=t('매우 낮음','Very low'),high=t('매우 높음','Very high')])=>`<div class="tlx-item"><div class="tlx-heading"><label for="tlx-${id}">${label}</label><output id="out-${id}">${t('미응답','Unanswered')}</output></div><input id="tlx-${id}" data-tlx="${id}" type="range" min="0" max="100" step="5" value="50" aria-label="${label}"><div class="tlx-anchors"><span>0 · ${low}</span><span>100 · ${high}</span></div></div>`).join('')}
    ${protocol?.collection ? '' : `<div class="field"><label for="notes">${t('불편하거나 이해하기 어려웠던 점 · 선택','Anything unclear or difficult? (Optional)')}</label><textarea id="notes" maxlength="2000" placeholder="${t('이름이나 연락처 등 개인정보를 적지 마세요.','Leave out names and contact details.') }"></textarea></div>`}
    <p class="subtle form-note">${t('이 구현은 비가중 Raw TLX 평균을 사용합니다. 수행 항목은 높을수록 수행이 나빴음을 뜻합니다.','Raw TLX is the unweighted average. Higher performance ratings indicate poorer performance.')}</p><button type="submit" class="btn primary wide" id="finish-survey" disabled>${t('설문 제출 및 종료','Submit and finish')}</button></form>`;
  document.querySelectorAll('[data-tlx]').forEach(input=>input.oninput=()=>{tlxTouched.add(input.dataset.tlx);$('out-'+input.dataset.tlx).textContent=input.value;$('finish-survey').disabled=tlxTouched.size!==6;});
  $('survey').onsubmit=event=>{event.preventDefault();const tlx={};document.querySelectorAll('[data-tlx]').forEach(el=>tlx[el.dataset.tlx]=Number(el.value));action('survey',{tlx,notes:$('notes')?.value || ''});};
}

function survey() {
  if (!state.survey_version) return legacySurvey();
  const pairs = tlxItems.flatMap((item, i) => tlxItems.slice(i + 1).map(other => [item, other]));
  const question = ([id, prompt, followup]) => `<div class="field interview-item">
    <label for="interview-${id}">${id.toUpperCase()}. ${prompt}</label>
    <details class="details"><summary>${t('선택 추가 질문','Optional follow-up')}</summary><p>${followup}</p></details>
    <textarea id="interview-${id}" data-interview="${id}" maxlength="2000" rows="3"></textarea></div>`;
  const title = t('NASA-TLX 주관적 작업부하 평가','NASA-TLX subjective workload');
  const next = `<button type="submit" class="btn primary">${t('다음 →','Next →')}</button>`;
  const back = `<button type="button" class="btn soft" data-survey-back>${t('← 이전','← Back')}</button>`;
  $('app').innerHTML = `<section class="panel survey">
    <div class="eyebrow">IE416 · ${t('실험 종료 후 설문','Post-task survey')}</div>
    <form id="tlx-pairs" data-survey-step="1">
      <div class="subtle">1 / 3</div><h1 tabindex="-1">${title}</h1>
      <h2>${t('Part 1. 항목 간 비교','Part 1. Pairwise comparison')}</h2>
      <p>${t(`방금 수행한 전체 과제(${state.total_main}회 시행)를 떠올리며, 각 쌍에서 작업부하에 더 크게 기여한 항목 하나를 고르세요.`,
        `Think about the full task (${state.total_main} trials). In each pair, choose the item that contributed more to your workload.`)}</p>
      ${pairs.map((pair, i) => `<fieldset class="survey-pair"><legend>${t('비교','Pair')} ${i + 1}</legend>
        ${pair.map(([id,label], j) => `<label><input type="radio" name="pair-${i}" value="${id}" data-pair${j === 0 ? ' required' : ''}> ${label}</label>`).join('')}
      </fieldset>`).join('')}
      <div class="survey-actions">${next}</div>
    </form>
    <form id="tlx-ratings" data-survey-step="2" hidden>
      <div class="subtle">2 / 3</div><h1 tabindex="-1">${title}</h1>
      <h2>${t('Part 2. 작업부하 평가','Part 2. Rating scale')}</h2>
      <p>${t('전체 과제에서 경험한 정도를 기준으로 각 항목에 0~100점을 입력하세요.','Rate each item from 0 to 100 based on your experience across the full task.')}</p>
      ${tlxItems.map(([id,label,low=t('낮음','Low'),high=t('높음','High')], i) => `<div class="tlx-item survey-rating">
        <label for="rating-${id}">Q${i + 1}. ${label}</label><p id="rating-prompt-${id}">${tlxPrompts[id]}</p>
        <div id="rating-scale-${id}" class="subtle">0 ${low} · 100 ${high}</div>
        <input id="rating-${id}" type="number" min="0" max="100" step="1" required data-rating="${id}" aria-describedby="rating-prompt-${id} rating-scale-${id}"> / 100
      </div>`).join('')}
      <div class="survey-actions">${back}${next}</div>
    </form>
    <form id="experience-survey" data-survey-step="3" hidden>
      <div class="subtle">3 / 3</div><h1 tabindex="-1">${t('주관적 경험 조사','Subjective experience')}</h1>
      <p>${t('정답은 없습니다. 실제로 사용한 화면과 과제에서 경험한 내용을 적어 주세요. 답하기 어려운 질문은 비워 두어도 됩니다. 이름이나 연락처 등 식별 정보는 적지 마세요.',
        'There are no right answers. Describe your experience with the interface and task you used. You may skip any question. Leave out names, contact details and other identifying information.')}</p>
      ${interviewSections.map(([heading,questions], i) => `<section class="interview-section"><h2>${i + 1}. ${heading}</h2>${questions.map(question).join('')}</section>`).join('')}
      ${state.config.mode === 'pilot' ? `<section class="interview-section"><h2>${t('파일럿 추가 질문 (선택)','Optional pilot questions')}</h2>${pilotQuestions.map(question).join('')}</section>` : ''}
      <div class="field interview-item"><label for="interview-additional">${t('추가 의견 (선택)','Additional comments (optional)')}</label>
        <textarea id="interview-additional" data-interview="additional" maxlength="2000" rows="3"></textarea></div>
      <div class="survey-actions">${back}<button type="submit" class="btn primary" data-submit>${t('설문 제출 및 종료','Submit and finish')}</button></div>
    </form>
  </section>`;
  const showStep = index => {
    document.querySelectorAll('[data-survey-step]').forEach(form => {
      form.hidden = Number(form.dataset.surveyStep) !== index;
      if (!form.hidden) form.querySelector('h1').focus();
    });
  };
  $('tlx-pairs').onsubmit = event => {event.preventDefault();showStep(2);};
  $('tlx-ratings').onsubmit = event => {event.preventDefault();showStep(3);};
  document.querySelectorAll('[data-survey-back]').forEach(button => {
    button.onclick = () => showStep(Number(button.closest('form').dataset.surveyStep) - 1);
  });
  $('experience-survey').onsubmit = event => {
    event.preventDefault();
    const pairwise = [...document.querySelectorAll('[data-pair]:checked')].map(input => input.value);
    const tlx = Object.fromEntries([...document.querySelectorAll('[data-rating]')].map(input => [input.dataset.rating, Number(input.value)]));
    const interview = Object.fromEntries([...document.querySelectorAll('[data-interview]')]
      .filter(input => input.value.trim()).map(input => [input.dataset.interview, input.value.trim()]));
    action('survey',{pairwise,tlx,interview});
  };
}
async function download(kind){
  try{const blob=await api(`/api/study/sessions/${auth.id}/${kind}`,null,{blob:true});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`ie416-${state.config.participant}-${kind}.${kind==='json'?'json':'csv'}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){reportError(error);}
}
function finished(){
  if (protocol?.collection) {
    $('app').innerHTML = '<section class="panel center-stage"><div class="eyebrow">IE416 · 실험 완료</div><h1>응답이 저장되었습니다.</h1><p>참여해 주셔서 감사합니다. 이 창을 닫아도 됩니다.</p></section>';
    return;
  }
  const summary=state.summary;
  const stats = [
    [t('UI 조건','Interface'),summary.condition==='node'?t('노드링크','Node-link'):t('표 형식','Table')],
    [t('SA 합성 정확도','Composite SA accuracy'),percent(summary.sa_primary)],
    [t('이해','Comprehension'),percent(summary.comprehension)],
    [t('회상','Recall'),percent(summary.recall)],
    [t('대안 순서 예측','Alternative-order projection'),percent(summary.projection)],
    [t('적중률','Hit rate'),percent(summary.hit_rate)],
    [t('오탐률','False alarm rate'),percent(summary.false_alarm_rate)],
    [t('균형 정확도','Balanced accuracy'),percent(summary.balanced_accuracy)],
    [t('최종 순서 정확도','Final order accuracy'),percent(summary.final_accuracy)],
    ['NASA-TLX',summary.weighted_tlx?.toFixed(1)||'—'],
    ['Raw TLX',summary.raw_tlx?.toFixed(1)||'—'],
    ...(sharedDemo ? [] : [[t('화면 이탈 시행','Interrupted trials'),summary.interrupted_trials]]),
    [t('무응답 판단','Unanswered decisions'),summary.missing_judgments],
  ];
  const exports = sharedDemo ? {json:t('데모 결과 JSON','Demo results JSON')} : {summary:t('요약 CSV','Summary CSV'),trials:t('시행 CSV','Trials CSV'),
    answers:t('문항 CSV','Answers CSV'),events:t('이벤트 CSV','Events CSV'),
    survey:t('설문 CSV','Survey CSV'),json:t('전체 JSON','Full JSON')};
  $('app').innerHTML=`<section class="panel center-stage"><div class="eyebrow">Session complete</div>
    <h1>${sharedDemo?t('데모를 마쳤습니다.','Demo complete'):t('실험을 마쳤습니다.','Demo complete')}</h1><p>${sharedDemo?t('응답과 설문 결과를 확인하고 내려받을 수 있습니다.','View or download your responses and workload ratings.'):t(`참여해 주셔서 감사합니다. ${summary.completed_main}개 본 시행의 응답과 설문이 이 컴퓨터에 저장되었습니다.`,`Your ${summary.completed_main} trial responses and workload ratings are saved on this computer.`)}</p>
    <details class="details" id="research-summary"${sharedDemo?' open':''}><summary>${sharedDemo?t('결과 및 다운로드','Results and downloads'):t('연구자용 결과 및 내보내기','Results and downloads')}</summary>
      <p>${sharedDemo?t('공유 데모에서 얻은 결과입니다.','These results are from the public demo.'):t('연습 기록은 아래 정확도 집계에서 제외됩니다. 데모·파일럿·본 실험은 데이터에서 구분됩니다.','These results are marked as demo data.')}</p>
      <table class="summary-table"><tbody>${stats.map(([label,value])=>`<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`).join('')}</tbody></table>
      <div class="export-actions">${Object.entries(exports).map(([kind,label])=>`<button class="btn small" data-export="${kind}">${label}</button>`).join('')}</div>
      <p class="subtle form-note">${t('판단 무응답이 있으면 균형 정확도는 공란입니다.','Balanced accuracy is blank if a decision is missing.')} ${sharedDemo?'':t('시선 값은 수집하지 않으며 events에 AOI와 화면 전환 시각만 있습니다.','The events file includes areas of interest and screen transition times.')}</p>
    </details><button type="button" class="btn" id="new-session">${t('새 세션 준비','Prepare a new demo')}</button></section>`;
  document.querySelectorAll('[data-export]').forEach(el=>el.onclick=()=>download(el.dataset.export));
  $('new-session').onclick=returnToSetup;
}
function render(){
  cancelAnimationFrame(previewFrame);
  if(!state)return setup();
  if(state.phase==='instructions')instructions();
  else if(['prelude','review','decision','reorder'].includes(state.phase))review();
  else if(state.phase==='question')question();
  else if(state.phase==='trial_done')trialDone();
  else if(state.phase==='survey')survey();
  else if(state.phase==='finished')finished();
  else if(state.phase==='break'){$('app').innerHTML=`<section class="panel center-stage"><div class="eyebrow">Break / ${state.completed_main} trials complete</div><h1>잠시 쉬어가세요.</h1><p>시선과 자세를 편하게 하고, 준비가 되면 계속 진행하세요.</p>${button('다음 블록 시작 →','continue')}</section>`;bindActions();}
  if(state.legacy_protocol) {
    const note=document.createElement('p');note.className='subtle form-note';
    note.textContent=`이 세션은 이전 프로토콜(${state.protocol_version})로 생성되었습니다. 수정 문항 v2를 확인하려면 홈에서 새 세션을 만드세요.`;
    $('app').prepend(note);
  }
}
window.addEventListener('resize',()=>{drawMap(state?.phase==='prelude'?0:1);drawGraph();clearTimeout(window.layoutTimeout);window.layoutTimeout=setTimeout(layoutMarker,300);});
document.addEventListener('visibilitychange',()=>{queueEvent(document.hidden?'hidden':'visible');if(!document.hidden&&auth&&state)refresh();});
window.addEventListener('pagehide',()=>{queueEvent('hidden');flushEvents();});
window.addEventListener('keydown',event=>{if(state?.phase!=='question'||busy||!['1','2','3','4'].includes(event.key))return;const option=state.question.options[Number(event.key)-1];if(option)action('answer',{answer:option.id,question_index:state.question_index});});
async function boot(){
  if (sharedDemo) {
    document.documentElement.lang = t('ko','en');
    document.title = t('IE416 로봇 감독 데모','IE416 Robot Supervision Demo');
    $('home-link').href = home + (english ? '?lang=en' : '');
    $('home-link').setAttribute('aria-label', t('데모 홈','Demo home'));
    $('korean-home').href = home + (english ? '' : '?lang=en');
    $('korean-home').lang = t('en','ko');
    $('korean-home').textContent = t('English','한국어');
    $('korean-home').hidden = false;
    $('local-indicator').textContent = t('공유 데모','Public demo');
    $('save-state').textContent = t('브라우저에서 실행','Runs in browser');
    $('footer-note').textContent = t('모의 AI 추천 · 완료 마감 기준','Simulated AI recommendation · Completion deadlines');
  } else if(english) {
    document.documentElement.lang = 'en';
    document.title = 'IE416 Supervision Lab · English Demo';
    $('home-link').href = '/?lang=en';
    $('home-link').setAttribute('aria-label', 'Supervision Lab demo home');
    $('korean-home').hidden = false;
    $('local-indicator').textContent = 'Local study';
    $('save-state').textContent = 'Connecting';
    $('footer-note').textContent = 'Simulated AI recommendation · Completion deadlines · Local storage';
    $('app').innerHTML = '<div class="loading">Loading the demo…</div>';
  }
  try{[map,protocol]=await Promise.all([api('/api/study/map'),api('/api/study/protocol')]);
    if (!sharedDemo) {
      try{const saved=JSON.parse(localStorage.getItem(STORE));if(saved?.id&&saved?.token)auth=saved;}catch(_){}
    }
    if (protocol?.collection) {
      $('local-indicator').textContent = '실험 수집';
      $('save-state').textContent = '수집 서버 연결됨';
      $('footer-note').textContent = '모의 AI 추천 · 완료 마감 기준 · 서버 기록';
      const join = /^#join=([a-f0-9]{16})\.([A-Za-z0-9_-]{32})$/.exec(location.hash);
      if (join) {
        const previous = auth;
        auth = {id:join[1],token:join[2]};
        try {
          const next = await api(`/api/study/sessions/${auth.id}`);
          remember();
          history.replaceState(null,'',location.pathname + location.search);
          install(next);
          if (next.phase !== 'instructions') queueEvent('reload',{phase:next.phase});
          return;
        } catch (error) {
          auth = previous;
          setup();
          reportError(error);
          return;
        }
      }
    }
    if (sharedDemo) {
      window.addEventListener('popstate',restoreDemoPage);
      restoreDemoPage();
    } else setup();
  }catch(error){$('app').innerHTML=`<section class="panel center-stage"><h1>${t('서버에 연결하지 못했습니다.','Could not connect to the server')}</h1><p>${t('study_server.py를 실행한 뒤 이 페이지를 새로고침하세요.','Start study_server.py and reload this page.')}</p></section>`;reportError(error);}
}
boot();
