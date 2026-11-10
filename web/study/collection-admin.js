'use strict';
const $ = id => document.getElementById(id);
const root = '/api/collection/admin';
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let noticeTimer;

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
  const {sessions} = await api('/sessions');
  $('login-panel').hidden = true;
  $('dashboard').hidden = false;
  const complete = sessions.filter(s => s.status === 'finished').length;
  $('session-count').textContent = `전체 ${sessions.length}세션 · 완료 ${complete}세션`;
  const hasLegacyLinks = sessions.some(s => s.legacy_invite);
  $('legacy-links').hidden = !hasLegacyLinks;
  const exports = {summary:'요약',trials:'시행',answers:'문항',events:'이벤트',json:'JSON'};
  const status = {invited:'기존 초대',ready:'참가 접수',active:'진행 중',finished:'완료'};
  $('rows').innerHTML = sessions.map(s => {
    const path = root + '/sessions/' + encodeURIComponent(s.id);
    return `<tr><td><strong>${esc(s.participant)}</strong></td><td>${s.mode==='pilot'?'파일럿':'본 실험'}</td>
      <td>${s.condition==='table'?'표':'노드링크'}</td><td>${status[s.status]} · ${s.completed_main}/36</td>
      ${hasLegacyLinks ? `<td>${s.legacy_invite ? `<button type="button" class="btn small" data-invite="${esc(s.id)}">열기</button>` : '—'}</td>` : ''}
      <td>${Object.entries(exports).map(([kind,label])=>`<a href="${path}/${kind}">${label}</a>`).join(' · ')}</td></tr>`;
  }).join('') || '<tr><td colspan="5">아직 접수된 참가 세션이 없습니다.</td></tr>';
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
$('logout').onclick = async () => {
  try {await api('/logout',{});showLogin();}
  catch (error) {notice(error.message);}
};
refresh().catch(() => showLogin());
