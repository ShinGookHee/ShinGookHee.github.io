'use strict';
const $ = id => document.getElementById(id);
let noticeTimer;

function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => $('notice').hidden = true, 7000);
}

function showLogin() {
  $('dashboard').hidden = true;
  $('admin-link').textContent = '관리자 로그인';
  $('rows').replaceChildren();
  $('login-panel').hidden = false;
}

async function api(path, body) {
  const response = await fetch('/api/collection/results/' + path, body ? {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  } : {});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(data.error || `요청 오류 (${response.status})`);
  }
  return data;
}

function metric({mean, n}, percentage = true) {
  if (mean === null) return '—';
  const value = percentage ? (mean * 100).toFixed(1) + '%' : mean.toFixed(1);
  return `${value} (n=${n})`;
}

async function refresh() {
  const {groups, researcher} = await api('summary');
  $('login-panel').hidden = true;
  $('admin-link').textContent = researcher ? '관리자 화면' : '관리자 로그인';
  $('dashboard').hidden = false;
  $('session-count').textContent = `전체 ${groups.reduce((n, g) => n + g.completed, 0)}명 완료`;
  const table = $('rows');
  table.replaceChildren();
  if (!groups.length) {
    const cell = table.insertRow().insertCell();
    cell.colSpan = 7;
    cell.textContent = '아직 접수된 참가 세션이 없습니다.';
    return;
  }
  for (const group of groups) {
    const {mode, version, condition, completed, total, metrics} = group;
    const row = table.insertRow();
    const values = [
      `${mode === 'pilot' ? '파일럿' : '본 실험'} · ${version}`,
      condition === 'table' ? '표' : '노드링크',
      `${completed} / ${total}`, metric(metrics.sa_primary), metric(metrics.balanced_accuracy),
      metric(metrics.final_accuracy), metric(metrics.raw_tlx, false)
    ];
    for (const value of values) row.insertCell().textContent = value;
  }
}

$('login').onsubmit = async event => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    await api('login',{username:$('username').value,password:$('password').value});
    await refresh();
  } catch (error) {notice(error.message);}
  finally {$('password').value = '';submit.disabled = false;}
};
$('refresh').onclick = () => refresh().catch(error => notice(error.message));
$('logout').onclick = async () => {
  try {await api('logout',{});showLogin();}
  catch (error) {notice(error.message);}
};
refresh().catch(() => showLogin());
