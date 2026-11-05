import { say, TONES, LINES } from './lines.js';
const reviewLine = g => (LINES[state.settings.tone] || LINES.micro).review[g];

/* ---------------- state ---------------- */
const KEY = 'hourly-manager-v1';
const DEFAULTS = {
  managerName: 'Gerald', tone: 'micro', start: '09:00', end: '17:00', interval: 60,
  workdays: [1, 2, 3, 4, 5], sound: true, voice: false,
};
let state = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.days) return { settings: { ...DEFAULTS, ...s.settings }, days: s.days };
  } catch {}
  return { settings: { ...DEFAULTS }, days: {} };
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }
const S = () => state.settings;

/* ---------------- time helpers ---------------- */
const pad = n => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
function fmt(min) {
  min = Math.round(min); let h = Math.floor(min / 60) % 24; const m = min % 60;
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${pad(m)} ${ap}`;
}
const isWorkday = key => S().workdays.includes(new Date(key + 'T12:00').getDay());

function day(key = dateKey()) {
  if (!state.days[key]) state.days[key] = { priorities: [], standupDone: false, entries: {}, nags: {}, breaks: [], snoozeUntil: 0, snoozes: 0, endedAt: null, reviewShown: false };
  return state.days[key];
}
const peekDay = key => state.days[key];

/** Check-in times (minutes since midnight) for a day. */
function slots(key) {
  const d = peekDay(key) || {};
  const s = toMin(S().start), e = toMin(S().end), i = Number(S().interval);
  const stop = d.endedAt != null ? Math.min(e, d.endedAt) : e;
  const out = [];
  for (let t = s + i; t <= stop + 0.01; t += i) out.push(t);
  if (d.endedAt != null && d.endedAt < e && d.endedAt - (out.at(-1) ?? s) >= 10) out.push(Math.round(d.endedAt));
  // keep any slots already answered even if settings changed
  Object.keys(d.entries || {}).map(Number).forEach(t => { if (!out.includes(t)) out.push(t); });
  return out.sort((a, b) => a - b);
}
function slotFrom(key, t) {
  const list = slots(key); const idx = list.indexOf(t);
  return idx > 0 ? list[idx - 1] : Math.min(toMin(S().start), t - Number(S().interval));
}
function status(key, t) {
  const d = peekDay(key) || {};
  const e = d.entries?.[t];
  if (e) return e.status;
  if ((d.breaks || []).some(([a, b]) => t > a && t <= b + 5)) return 'break';
  const today = key === dateKey();
  if (key < dateKey() || (today && t <= nowMin())) return today ? 'pending' : 'missed';
  return 'upcoming';
}
const pending = () => { const k = dateKey(); return isWorkday(k) ? slots(k).filter(t => status(k, t) === 'pending') : []; };
const rangeText = (key, t) => `from ${fmt(slotFrom(key, t))} to ${fmt(t)}`;

function stats(key) {
  const today = key === dateKey();
  const all = slots(key).filter(t => !today || t <= nowMin());
  const st = all.map(t => status(key, t));
  const counted = st.filter(s => s !== 'break').length;
  const done = all.filter((t, i) => st[i] === 'done').map(t => peekDay(key).entries[t]);
  const missed = st.filter(s => s === 'missed' || s === 'pending').length;
  const avg = done.length ? done.reduce((a, e) => a + e.rating, 0) / done.length : 0;
  const onPri = done.filter(e => e.priority >= 0).length;
  const late = done.length ? done.reduce((a, e) => a + (e.late || 0), 0) / done.length : 0;
  const acc = counted ? done.length / counted : 0;
  const snoozes = peekDay(key)?.snoozes || 0;
  let grade = null;
  if (counted) {
    const score = 0.6 * acc + 0.4 * (avg ? (avg - 1) / 4 : 0) - Math.min(0.15, snoozes * 0.03) - Math.min(0.1, late / 300);
    grade = score >= 0.85 ? 'A' : score >= 0.7 ? 'B' : score >= 0.55 ? 'C' : score >= 0.4 ? 'D' : 'F';
  }
  return { counted, done: done.length, missed, avg, onPri, late, acc, grade, snoozes };
}
function dayOver(key = dateKey()) {
  const d = peekDay(key);
  return key < dateKey() || d?.endedAt != null || nowMin() >= toMin(S().end);
}

/* ---------------- manager voice / mood / alerts ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MOODS = {
  happy: { mouth: 'M27 33q5 5 10 0', bl: 'M24 23l6 0', br: 'M40 23l-6 0' },
  neutral: { mouth: 'M28 34h8', bl: 'M24 24l6 1.6', br: 'M40 24l-6 1.6' },
  angry: { mouth: 'M27 36q5 -4 10 0', bl: 'M24 22l6 3.5', br: 'M40 22l-6 3.5' },
};
function mood(m) {
  const v = MOODS[m] || MOODS.neutral;
  $('#mouth').setAttribute('d', v.mouth); $('#brow-l').setAttribute('d', v.bl); $('#brow-r').setAttribute('d', v.br);
}
function speak(text, m = 'neutral', aloud = false) {
  $('#speech').textContent = text; mood(m);
  const el = $('.speech'); el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  if (aloud && S().voice && 'speechSynthesis' in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.toLowerCase()); u.rate = S().tone === 'drill' ? 1.15 : 1.02;
    speechSynthesis.speak(u);
  }
}
let audio;
function unlockAudio() { try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch {} }
function beep(level = 0) {
  if (!S().sound || !audio) return;
  const notes = level >= 2 ? [880, 660, 880, 660] : level === 1 ? [740, 740] : [660, 880];
  notes.forEach((f, i) => {
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + i * 0.18;
    o.type = S().tone === 'drill' ? 'square' : 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.17);
  });
}
async function notify(body, level = 0) {
  beep(level);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = `${S().managerName} wants an update` + (level >= 2 ? '!!' : '');
  const opts = { body, tag: 'checkin', renotify: true, requireInteraction: true, icon: 'icon.svg' };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return reg.showNotification(title, opts);
  } catch {}
  try { const n = new Notification(title, opts); n.onclick = () => { focus(); openCheckin(); }; } catch {}
}

/* ---------------- the loop ---------------- */
let currentKey = dateKey();
function tick() {
  const key = dateKey();
  if (key !== currentKey) { currentKey = key; render(); }
  if (!isWorkday(key)) { setTitle(0); updateClock(); return; }
  const d = day(key), now = nowMin(), start = toMin(S().start);

  if (!d.standupDone && now >= start - 30 && !dayOver(key) && !modal.open) openStandup();

  const p = pending();
  if (p.length && Date.now() >= d.snoozeUntil) {
    const t = p.at(-1), age = now - t;
    const level = age >= 30 ? 3 : age >= 15 ? 2 : age >= 5 ? 1 : 0;
    const prev = d.nags[t] ?? -1;
    const snoozeEnded = d.snoozeUntil > 0;
    if (level > prev || snoozeEnded) {
      d.nags[t] = level; d.snoozeUntil = 0; save();
      const vars = { range: rangeText(key, t) };
      const line = level === 0 && !snoozeEnded ? say(S().tone, 'prompt', vars) : say(S().tone, 'nag', vars);
      speak(line, level >= 2 ? 'angry' : 'neutral', true);
      notify(line, level);
      if (!modal.open) openCheckin();
      render();
    }
  }
  if (dayOver(key) && !d.reviewShown && d.standupDone && !pending().length) {
    d.reviewShown = true; save();
    const g = stats(key).grade;
    if (g) speak(reviewLine(g), 'AB'.includes(g) ? 'happy' : 'DF'.includes(g) ? 'angry' : 'neutral', true);
    render();
  }
  setTitle(p.length);
  updateClock();
}
function setTitle(n) { document.title = n ? `(${n}) Report in — Hourly Manager` : 'Hourly Manager'; }

/* ---------------- modals ---------------- */
const modal = $('#modal');
function showModal(html, onMount) {
  $('#modal-body').innerHTML = html;
  if (!modal.open) modal.showModal();
  onMount?.($('#modal-body'));
}
function closeModal() { if (modal.open) modal.close(); }
modal.addEventListener('cancel', e => e.preventDefault()); // no escaping your manager

function openCheckin() {
  const key = dateKey(), p = pending();
  if (!p.length) return;
  const t = p[0], d = day(key);
  const owed = p.length > 1 ? `<p class="owed">${esc(say(S().tone, 'owed', { n: p.length }))}</p>` : '';
  const pri = d.priorities.length
    ? `<label class="lbl">Did it move a priority forward?</label>
       <div class="chips" id="pri">${d.priorities.map((x, i) => `<button type="button" data-i="${i}">${esc(x.text)}</button>`).join('')}<button type="button" data-i="-1" class="sel">Not really</button></div>`
    : '';
  showModal(`
    <form id="ci" class="sheet">
      <div class="sheet-head"><span class="pill">${fmt(slotFrom(key, t))} – ${fmt(t)}</span>${p.length > 1 ? `<span class="pill red">${p.length} owed</span>` : ''}</div>
      <h2>${esc(say(S().tone, 'prompt', { range: rangeText(key, t) }))}</h2>
      ${owed}
      <textarea id="ci-text" rows="4" required placeholder="e.g. Drafted the intro of the report, answered 6 emails, 20 min on Slack…"></textarea>
      <label class="lbl">How productive was it, honestly?</label>
      <div class="rating" id="rate">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}" class="${n === 3 ? 'sel' : ''}">${n}<small>${['Wasted', 'Weak', 'Okay', 'Good', 'Crushed it'][n - 1]}</small></button>`).join('')}</div>
      ${pri}
      <div class="actions">
        <button type="button" class="ghost" id="ci-off">Write it off</button>
        ${p.length === 1 ? '<button type="button" class="ghost" id="ci-snooze">Snooze 10m</button>' : ''}
        <button class="primary">Report in</button>
      </div>
    </form>`, root => {
    let rating = 3, priority = -1;
    const pick = (box, attr, set) => box?.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      box.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b)); set(Number(b.dataset[attr]));
    });
    pick($('#rate', root), 'n', v => rating = v);
    pick($('#pri', root), 'i', v => priority = v);
    $('#ci-text', root).focus();
    $('#ci', root).addEventListener('submit', e => {
      e.preventDefault();
      const text = $('#ci-text', root).value.trim(); if (!text) return;
      d.entries[t] = { status: 'done', text, rating, priority, at: Date.now(), late: Math.max(0, Math.round(nowMin() - t)) };
      save();
      const k = text.length < 15 ? 'short' : rating >= 4 ? 'great' : rating === 3 ? 'meh' : 'bad';
      speak(say(S().tone, k), k === 'great' ? 'happy' : k === 'bad' ? 'angry' : 'neutral', true);
      after();
    });
    $('#ci-off', root).addEventListener('click', () => {
      d.entries[t] = { status: 'missed', at: Date.now() }; save();
      speak(say(S().tone, 'writeoff'), 'angry', true); after();
    });
    $('#ci-snooze', root)?.addEventListener('click', () => {
      d.snoozeUntil = Date.now() + 10 * 60e3; d.snoozes++; save();
      speak(say(S().tone, 'snooze'), 'angry', true); closeModal(); render();
    });
  });
  function after() { if (pending().length) openCheckin(); else closeModal(); render(); }
}

function openStandup(edit = false) {
  const d = day();
  const cur = d.priorities.map(p => p.text);
  showModal(`
    <form id="su" class="sheet">
      <div class="sheet-head"><span class="pill">Morning stand-up</span></div>
      <h2>${esc(say(S().tone, 'standup'))}</h2>
      ${[0, 1, 2].map(i => `<input class="field" name="p${i}" placeholder="Priority ${i + 1}" value="${esc(cur[i] || '')}" ${i === 0 ? 'required' : ''}>`).join('')}
      <div class="actions">
        ${edit ? '<button type="button" class="ghost" id="su-cancel">Cancel</button>' : '<button type="button" class="ghost" id="su-skip">Skip</button>'}
        <button class="primary">Commit</button>
      </div>
    </form>`, root => {
    $('input', root).focus();
    $('#su', root).addEventListener('submit', e => {
      e.preventDefault();
      const texts = [0, 1, 2].map(i => root.querySelector(`[name=p${i}]`).value.trim()).filter(Boolean);
      d.priorities = texts.map(text => ({ text, done: d.priorities.find(p => p.text === text)?.done || false }));
      d.standupDone = true; save(); closeModal();
      speak(say(S().tone, 'idle', { next: fmt(nextSlot() ?? toMin(S().end)) }), 'neutral'); render(); tick();
    });
    $('#su-skip', root)?.addEventListener('click', () => {
      d.standupDone = true; save(); closeModal(); speak(say(S().tone, 'standupSkip'), 'angry', true); render(); tick();
    });
    $('#su-cancel', root)?.addEventListener('click', closeModal);
  });
}

function openBreak() {
  showModal(`
    <div class="sheet">
      <div class="sheet-head"><span class="pill">Request a break</span></div>
      <h2>How long?</h2>
      <div class="chips big">${[15, 30, 45, 60].map(m => `<button type="button" data-m="${m}">${m} min</button>`).join('')}</div>
      <div class="actions"><button type="button" class="ghost" id="b-cancel">Never mind</button></div>
    </div>`, root => {
    root.querySelector('.chips').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const d = day(), a = nowMin(), until = a + Number(b.dataset.m);
      d.breaks.push([a, until]); save(); closeModal();
      speak(say(S().tone, 'breakStart', { next: fmt(until) }), 'neutral', true); render();
    });
    $('#b-cancel', root).addEventListener('click', closeModal);
  });
}

/* ---------------- iOS ---------------- */
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** iOS can't run timers for a closed web app, so the reliable nag is a Calendar alarm every check-in. */
function downloadICS() {
  const st = S(), i = Number(st.interval), byday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const days = st.workdays.map(d => byday[d]).join(',');
  if (!days) return alert('Pick at least one workday first.');
  const d0 = new Date(); const ymd = `${d0.getFullYear()}${pad(d0.getMonth() + 1)}${pad(d0.getDate())}`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const url = location.origin + location.pathname + '?checkin';
  const ev = [];
  for (let t = toMin(st.start) + i; t <= toMin(st.end); t += i) {
    const hm = `${pad(Math.floor(t / 60))}${pad(t % 60)}00`, end = t + 5, hmEnd = `${pad(Math.floor(end / 60) % 24)}${pad(end % 60)}00`;
    const line = say(st.tone, 'prompt', { range: `from ${fmt(t - i)} to ${fmt(t)}` }).replace(/[,;\\]/g, m => '\\' + m);
    ev.push(['BEGIN:VEVENT', `UID:hourly-manager-${hm}@local`, `DTSTAMP:${stamp}`, `DTSTART:${ymd}T${hm}`, `DTEND:${ymd}T${hmEnd}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${days}`, `SUMMARY:${st.managerName}: check-in`, `DESCRIPTION:${line}`, `URL:${url}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${line}`, 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT'].join('\r\n'));
  }
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hourly Manager//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${st.managerName} check-ins`, ...ev, 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = 'hourly-manager-checkins.ics'; document.body.appendChild(a); a.click(); a.remove();
}

/* ---------------- views ---------------- */
let tab = 'today';
const nextSlot = () => { const k = dateKey(); return slots(k).find(t => status(k, t) === 'upcoming'); };

function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#mgr-name').textContent = S().managerName;
  $('#view').innerHTML = tab === 'today' ? viewToday() : tab === 'history' ? viewHistory() : viewSettings();
  bindView();
  setTitle(pending().length);
  updateClock();
}

function timeline(key) {
  const d = peekDay(key) || { entries: {}, priorities: [] };
  const rows = slots(key).map(t => {
    const s = status(key, t), e = d.entries[t];
    const range = `${fmt(slotFrom(key, t))} – ${fmt(t)}`;
    let body;
    if (s === 'done') body = `<p>${esc(e.text)}</p><div class="meta"><span class="dots">${'●'.repeat(e.rating)}<i>${'●'.repeat(5 - e.rating)}</i></span>${e.priority >= 0 && d.priorities[e.priority] ? `<span class="tag">↳ ${esc(d.priorities[e.priority].text)}</span>` : ''}${e.late >= 5 ? `<span class="tag warn">${e.late}m late</span>` : ''}</div>`;
    else if (s === 'missed') body = `<p class="miss">Unaccounted for</p>`;
    else if (s === 'pending') body = `<p class="miss">Waiting on your report…</p>`;
    else if (s === 'break') body = `<p class="dim">Break</p>`;
    else body = `<p class="dim">Upcoming</p>`;
    return `<li class="tl ${s}"><span class="t">${range}</span><div>${body}</div></li>`;
  });
  return rows.length ? `<ol class="timeline">${rows.join('')}</ol>` : '<p class="dim">No check-ins scheduled.</p>';
}

function reportCard(key) {
  const s = stats(key);
  if (!s.grade) return '';
  const line = reviewLine(s.grade);
  return `<section class="card review g-${s.grade}">
    <div class="grade">${s.grade}</div>
    <div class="rv">
      <h3>Performance review</h3>
      <p class="quote">“${esc(line)}” <span class="dim">— ${esc(S().managerName)}</span></p>
      <div class="kpis">
        <div><b>${s.done}/${s.counted}</b><span>hours accounted</span></div>
        <div><b>${s.avg ? s.avg.toFixed(1) : '–'}</b><span>avg productivity</span></div>
        <div><b>${s.done ? Math.round(s.onPri / s.done * 100) + '%' : '–'}</b><span>on priorities</span></div>
        <div><b>${s.snoozes}</b><span>snoozes</span></div>
      </div>
    </div>
  </section>`;
}

function viewToday() {
  const key = dateKey(), d = day(key), now = nowMin(), p = pending();
  const notif = 'Notification' in window && Notification.permission !== 'granted'
    ? `<section class="card banner"><div><b>${esc(S().managerName)} can't reach you when this tab is hidden.</b><p class="dim">Turn on notifications so the hourly check-ins actually find you.</p></div>${Notification.permission === 'denied' ? '<span class="small dim">Blocked — allow notifications for this site in your browser settings.</span>' : '<button class="primary" id="enable-notif">Enable</button>'}</section>` : '';
  const install = isIOS && !isStandalone
    ? `<section class="card banner"><div><b>Install on your iPhone</b><p class="dim">In Safari tap <b>Share</b> <span aria-hidden="true">⎋</span> → <b>Add to Home Screen</b>. Then open it from the home screen and enable notifications.</p></div></section>` : '';
  let status;
  if (!isWorkday(key)) status = `<p class="big">Day off</p><p class="dim">${esc(say(S().tone, 'off'))}</p>`;
  else if (now < toMin(S().start)) status = `<p class="label">Workday starts</p><p class="big">${fmt(toMin(S().start))}</p><p class="dim">${esc(say(S().tone, 'before', { start: fmt(toMin(S().start)) }))}</p>`;
  else if (p.length) status = `<p class="label">Overdue</p><p class="big red">${p.length} report${p.length > 1 ? 's' : ''} owed</p><button class="primary wide" id="report">Report in now</button>`;
  else if (dayOver(key)) status = `<p class="label">Clocked out</p><p class="big">See you tomorrow</p>`;
  else {
    const n = nextSlot();
    status = `<p class="label">Next check-in at ${fmt(n)}</p><p class="big mono" id="countdown">--:--</p>
      <div class="row"><button class="ghost" id="break">Take a break</button><button class="ghost" id="clockout">Clock out</button></div>`;
  }
  const pri = isWorkday(key) ? `<section class="card">
      <div class="card-head"><h3>Today's priorities</h3><button class="link" id="edit-pri">${d.priorities.length ? 'Edit' : 'Set'}</button></div>
      ${d.priorities.length ? `<ul class="pri">${d.priorities.map((x, i) => `<li><label><input type="checkbox" data-i="${i}" ${x.done ? 'checked' : ''}><span>${esc(x.text)}</span></label></li>`).join('')}</ul>` : '<p class="dim">None set. Your manager has noticed.</p>'}
    </section>` : '';
  return `${install}${notif}
    <section class="card status">${status}</section>
    ${dayOver(key) && isWorkday(key) ? reportCard(key) : ''}
    ${pri}
    ${isWorkday(key) ? `<section class="card"><div class="card-head"><h3>Today's log</h3><span class="dim">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span></div>${timeline(key)}</section>` : ''}`;
}

function viewHistory() {
  const keys = Object.keys(state.days).filter(k => k < dateKey() && isWorkday(k) || (k < dateKey() && Object.keys(state.days[k].entries).length)).sort().reverse();
  if (!keys.length) return `<section class="card"><h3>History</h3><p class="dim">No past days yet. Survive today first.</p></section>`;
  const week = keys.slice(0, 7).map(k => ({ k, s: stats(k) })).reverse();
  const bars = `<div class="bars">${week.map(({ k, s }) => `<div class="bar"><div class="fill g-${s.grade}" style="height:${Math.max(4, s.acc * 100)}%"></div><span>${new Date(k + 'T12:00').toLocaleDateString(undefined, { weekday: 'narrow' })}</span></div>`).join('')}</div>`;
  return `<section class="card"><div class="card-head"><h3>Hours accounted</h3><span class="dim">last ${week.length} days</span></div>${bars}</section>
    ${keys.map(k => {
      const s = stats(k);
      return `<details class="card day"><summary><span class="gl g-${s.grade}">${s.grade ?? '–'}</span><span class="dk"><b>${new Date(k + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</b><small>${s.done}/${s.counted} accounted · avg ${s.avg ? s.avg.toFixed(1) : '–'}</small></span></summary>${timeline(k)}</details>`;
    }).join('')}`;
}

function viewSettings() {
  const s = S();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `<section class="card form">
    <h3>Your manager</h3>
    <label>Name<input class="field" id="s-name" value="${esc(s.managerName)}"></label>
    <label>Management style<select class="field" id="s-tone">${Object.entries(TONES).map(([k, v]) => `<option value="${k}" ${k === s.tone ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="tog"><input type="checkbox" id="s-sound" ${s.sound ? 'checked' : ''}> Chime when checking in</label>
    <label class="tog"><input type="checkbox" id="s-voice" ${s.voice ? 'checked' : ''}> Say it out loud</label>
  </section>
  <section class="card form">
    <h3>Work hours</h3>
    <div class="two"><label>Start<input class="field" type="time" id="s-start" value="${s.start}"></label><label>End<input class="field" type="time" id="s-end" value="${s.end}"></label></div>
    <label>Check in every<select class="field" id="s-int">${[30, 45, 60, 90, 120].map(m => `<option value="${m}" ${m == s.interval ? 'selected' : ''}>${m < 60 ? m + ' minutes' : m / 60 + ' hour' + (m > 60 ? 's' : '')}</option>`).join('')}</select></label>
    <label>Workdays</label>
    <div class="chips" id="s-days">${days.map((n, i) => `<button type="button" data-d="${i}" class="${s.workdays.includes(i) ? 'sel' : ''}">${n}</button>`).join('')}</div>
  </section>
  <section class="card form">
    <h3>Phone alarms</h3>
    <p class="dim small">iPhones pause web apps in the background, so ${esc(s.managerName)} can't nudge you while the app is closed. Add a Calendar alarm for every check-in — tapping it brings you back here.</p>
    <div class="row left"><button class="primary" id="s-ics">Add check-ins to Calendar</button></div>
    <p class="dim small">Changed your hours? Delete the old “${esc(s.managerName)}: check-in” events and add them again.</p>
  </section>
  <section class="card form">
    <h3>Data</h3>
    <div class="row left"><button class="ghost" id="s-test">Test a check-in alert</button><button class="ghost" id="s-export">Export JSON</button></div>
    <div class="row left"><button class="ghost danger" id="s-reset">Erase everything</button></div>
    <p class="dim small">Everything stays on this device. Keep this tab (or the installed app) open during work hours — browsers can't wake a closed page.</p>
  </section>`;
}

function bindView() {
  const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);
  on('#enable-notif', 'click', async () => { await Notification.requestPermission(); render(); });
  on('#report', 'click', openCheckin);
  on('#break', 'click', openBreak);
  on('#edit-pri', 'click', () => openStandup(true));
  on('#clockout', 'click', () => {
    if (!confirm('Clock out for the day?')) return;
    const d = day(); d.endedAt = nowMin(); d.standupDone = true; save();
    speak(say(S().tone, 'clockOut'), 'neutral', true); render(); tick();
  });
  document.querySelectorAll('.pri input').forEach(cb => cb.addEventListener('change', () => {
    day().priorities[cb.dataset.i].done = cb.checked; save();
    if (cb.checked) speak(say(S().tone, 'great'), 'happy');
  }));
  // settings
  const set = (k, v) => { S()[k] = v; save(); };
  on('#s-name', 'change', e => { set('managerName', e.target.value.trim() || 'Gerald'); render(); });
  on('#s-tone', 'change', e => { set('tone', e.target.value); speak(say(S().tone, 'idle', { next: fmt(nextSlot() ?? toMin(S().end)) }), 'neutral', true); });
  on('#s-sound', 'change', e => set('sound', e.target.checked));
  on('#s-voice', 'change', e => set('voice', e.target.checked));
  on('#s-start', 'change', e => e.target.value && set('start', e.target.value));
  on('#s-end', 'change', e => e.target.value && set('end', e.target.value));
  on('#s-int', 'change', e => set('interval', Number(e.target.value)));
  on('#s-days', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const i = Number(b.dataset.d), w = new Set(S().workdays);
    w.has(i) ? w.delete(i) : w.add(i); set('workdays', [...w].sort()); render();
  });
  on('#s-test', 'click', async () => {
    unlockAudio();
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    const line = say(S().tone, 'prompt', { range: 'in the last hour' });
    speak(line, 'neutral', true); notify(line, 0);
  });
  on('#s-ics', 'click', downloadICS);
  on('#s-export', 'click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
    a.download = `hourly-manager-${dateKey()}.json`; a.click();
  });
  on('#s-reset', 'click', () => {
    if (!confirm('Erase all check-ins and settings? This cannot be undone.')) return;
    state = { settings: { ...DEFAULTS }, days: {} }; save(); render();
  });
}

function updateClock() {
  const el = $('#countdown'); if (!el) return;
  const n = nextSlot(); if (n == null) { el.textContent = '--:--'; return; }
  const secs = Math.max(0, Math.round((n - nowMin()) * 60));
  el.textContent = `${pad(Math.floor(secs / 60))}:${pad(secs % 60)}`;
  if (secs === 0) tick();
}

/* ---------------- boot ---------------- */
document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return; tab = b.dataset.tab; render();
});
document.addEventListener('pointerdown', unlockAudio, { once: false, passive: true });
if ('serviceWorker' in navigator && !location.search.includes('nosw')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'open-checkin') openCheckin(); });
}
render();
{
  const k = dateKey();
  if (!isWorkday(k)) speak(say(S().tone, 'off'));
  else if (pending().length > 1) speak(say(S().tone, 'owed', { n: pending().length }), 'angry');
  else if (nextSlot() != null) speak(say(S().tone, 'idle', { next: fmt(nextSlot()) }));
}
tick();
setInterval(tick, 10_000);
setInterval(updateClock, 1000);
if (location.search.includes('checkin')) openCheckin();
