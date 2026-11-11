'use strict';
const $ = id => document.getElementById(id);
const root = '/api/collection/admin';
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let noticeTimer;
let demoImportId = null;

function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => $('notice').hidden = true, 7000);
}

function showLogin() {
  $('dashboard').hidden = true;
  $('login-panel').hidden = false;
  $('invite-result').hidden = true;
  $('invite-link').value = '';
  $('rows').textContent = '';
  $('demo-rows').textContent = '';
}

async function api(path, body) {
  const response = await fetch(root + path, body ? {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  } : {});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(data.error || `요청 오류 (${response.status})`);
  }
  return data;
}

async function refresh() {
  const [{sessions}, {results}] = await Promise.all([api('/sessions'),api('/demo-results')]);
  $('login-panel').hidden = true;
  $('dashboard').hidden = false;
  const complete = sessions.filter(s => s.status === 'finished').length;
  $('session-count').textContent = `전체 ${sessions.length}세션 · 완료 ${complete}세션`;
  const hasLegacyLinks = sessions.some(s => s.legacy_invite);
  $('legacy-links').hidden = !hasLegacyLinks;
  const exports = {summary:'요약',trials:'시행',answers:'문항',events:'이벤트',survey:'설문',json:'JSON'};
  const status = {invited:'기존 초대',ready:'참가 접수',active:'진행 중',finished:'완료'};
  $('rows').innerHTML = sessions.map(s => {
    const path = root + '/sessions/' + encodeURIComponent(s.id);
    return `<tr><td><strong>${esc(s.participant)}</strong></td><td>${s.mode==='pilot'?'파일럿':'본 실험'}</td>
      <td>${s.condition==='table'?'표':'노드링크'}</td><td>${status[s.status]} · ${s.completed_main}/36</td>
      ${hasLegacyLinks ? `<td>${s.legacy_invite ? `<button type="button" class="btn small" data-invite="${esc(s.id)}">열기</button>` : '—'}</td>` : ''}
      <td>${Object.entries(exports).map(([kind,label])=>`<a href="${path}/${kind}">${label}</a>`).join(' · ')}</td></tr>`;
  }).join('') || '<tr><td colspan="5">아직 접수된 참가 세션이 없습니다.</td></tr>';
  $('demo-count').textContent = `가져온 데모 ${results.length}건`;
  const percent = value => value === null ? '—' : (value * 100).toFixed(1) + '%';
  $('demo-rows').innerHTML = results.map(row => `<tr>
    <td>${esc(new Date(row.imported_utc).toLocaleString('ko-KR'))}</td>
    <td>${row.condition === 'node' ? '노드링크' : '표'} · ${row.language === 'ko' ? '한국어' : '영어'}</td>
    <td>${row.completed_main}/6</td><td>${percent(row.sa_primary)}</td><td>${percent(row.balanced_accuracy)}</td>
    <td>${percent(row.final_accuracy)}</td><td>${row.weighted_tlx?.toFixed(1) ?? '—'}</td><td>${row.raw_tlx.toFixed(1)}</td>
    <td><a href="${root}/demo-results/${encodeURIComponent(row.id)}/json">JSON</a></td></tr>`
  ).join('') || '<tr><td colspan="9">가져온 데모 결과가 없습니다.</td></tr>';
}

function showInvite(invite, label) {
  $('invite-label').textContent = label;
  $('invite-result').hidden = false;
  $('invite-link').value = invite;
  $('invite-link').focus();
  $('invite-link').select();
}

$('login').onsubmit = async event => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    await api('/login',{username:$('username').value,password:$('password').value});
    await refresh();
  } catch (error) {notice(error.message);}
  finally {$('password').value = '';submit.disabled = false;}
};
$('study-links').onclick = async event => {
  const mode = event.target.closest('[data-study-mode]')?.dataset.studyMode;
  if (!mode) return;
  try {
    const {links} = await api('/links');
    showInvite(links[mode], mode === 'pilot' ? '공용 파일럿 참가 링크' : '공용 본 실험 참가 링크');
  } catch (error) {notice(error.message);}
};
$('rows').onclick = async event => {
  const button = event.target.closest('[data-invite]');
  if (!button) return;
  try {showInvite((await api('/sessions/' + encodeURIComponent(button.dataset.invite) + '/invite')).invite,'기존 개별 참가 링크');}
  catch (error) {notice(error.message);}
};
$('copy').onclick = async () => {
  try {await navigator.clipboard.writeText($('invite-link').value);notice('참가 링크를 복사했습니다.');}
  catch (_) {$('invite-link').select();notice('선택된 참가 링크를 복사하세요.');}
};
$('refresh').onclick = () => refresh().catch(error => notice(error.message));
$('demo-file').onchange = () => {demoImportId = null;};
$('demo-import').onsubmit = async event => {
  event.preventDefault();
  const input = $('demo-file');
  const file = input.files[0];
  if (!file) return;
  const submit = event.submitter;
  input.disabled = submit.disabled = true;
  try {
    let result;
    try {result = JSON.parse(await file.text());}
    catch (_) {throw new Error('JSON 파일을 읽을 수 없습니다. 공개 데모에서 내려받은 결과 파일을 선택하세요.');}
    demoImportId ??= crypto.randomUUID().replaceAll('-', '');
    await api('/demo-results',{import_id:demoImportId,result});
    $('demo-import').reset();
    demoImportId = null;
    await refresh();
    notice('데모 결과를 가져왔습니다.');
  } catch (error) {notice(error.message);}
  finally {input.disabled = submit.disabled = false;}
};
$('logout').onclick = async () => {
  try {await api('/logout',{});showLogin();}
  catch (error) {notice(error.message);}
};
refresh().catch(() => showLogin());
