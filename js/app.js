import { say, TONES, LINES } from './lines.js';
const reviewLine = g => (LINES[state.settings.tone] || LINES.micro).review[g];

/* ---------------- state ---------------- */
const KEY = 'hourly-manager-v1';
const DEFAULTS = { managerName: 'Gerald', tone: 'micro', interval: 60, sound: true, voice: false, morningOn: true, morning: '07:00' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_PRIORITIES = 5;
/** One plan per weekday (index 0 = Sunday): hours + blocked-out quiet times. */
const defaultWeek = (old = {}) => DOW.map((_, i) => ({
  on: (old.workdays || [1, 2, 3, 4, 5]).includes(i), start: old.start || '09:00', end: old.end || '17:00', blocks: [],
}));
let state = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.days) {
      const settings = { ...DEFAULTS, ...s.settings };
      if (!Array.isArray(settings.week)) settings.week = defaultWeek(s.settings); // migrate v1 settings
      delete settings.start; delete settings.end; delete settings.workdays;
      return { settings, days: s.days };
    }
  } catch {}
  return { settings: { ...DEFAULTS, week: defaultWeek() }, days: {} };
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
const toHHMM = m => `${pad(Math.floor(m / 60) % 24)}:${pad(Math.round(m) % 60)}`;
const dow = key => new Date(key + 'T12:00').getDay();
const clone = o => JSON.parse(JSON.stringify(o));
/** Past days keep the schedule they were lived with; today follows the live schedule. */
function plan(key) {
  const d = state.days[key];
  return key < dateKey() && d?.plan ? d.plan : S().week[dow(key)];
}
const isWorkday = key => !!plan(key)?.on;
const dayStart = key => toMin(plan(key).start);
const dayEnd = key => toMin(plan(key).end);

/** Blocked times as [from, to (incl. quiet-after), block], sorted. */
function quietRanges(p) {
  return (p?.blocks || []).map(b => {
    const a = toMin(b.start), e = toMin(b.end);
    return [a, Math.min(24 * 60, e + Number(b.after || 0)), b, e];
  }).filter(([a, , , e]) => e > a).sort((x, y) => x[0] - y[0]);
}
function mergedQuiet(p) {
  const out = [];
  for (const [a, b] of quietRanges(p)) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}
const quietAt = (key, m) => quietRanges(plan(key)).find(([a, b]) => m >= a && m < b);

/** Check-ins for a plan: every `interval` through free time, one 10 min before each block, none while quiet. */
function planSlots(p, endedAt = null) {
  if (!p?.on) return [];
  const i = Number(S().interval), s = toMin(p.start);
  let e = toMin(p.end);
  if (endedAt != null) e = Math.min(e, endedAt);
  const segs = []; let cur = s;
  for (const [a, b] of mergedQuiet(p)) {
    if (b <= cur) continue;
    if (a >= e) break;
    if (a > cur) segs.push([cur, a, true]);
    cur = Math.max(cur, b);
  }
  if (cur < e) segs.push([cur, e, false]);
  const out = [];
  for (const [a, b, beforeBlock] of segs) {
    const end = beforeBlock ? b - 10 : b;
    let last = a;
    for (let t = a + i; t <= end + 0.01; t += i) { out.push({ t: Math.round(t), from: Math.round(last) }); last = t; }
    const minGap = endedAt != null && !beforeBlock ? 10 : 15;
    if (end - last >= minGap) out.push({ t: Math.round(end), from: Math.round(last) });
  }
  return out;
}

function day(key = dateKey()) {
  if (!state.days[key]) state.days[key] = { priorities: [], standupDone: false, entries: {}, nags: {}, breaks: [], snoozeUntil: 0, snoozes: 0, endedAt: null, reviewShown: false };
  return state.days[key];
}
const peekDay = key => state.days[key];

/** Check-in times (minutes since midnight) for a day. */
function slots(key) {
  const d = peekDay(key) || {};
  const out = planSlots(plan(key), d.endedAt).map(x => x.t);
  // keep any slots already answered even if settings changed
  Object.keys(d.entries || {}).map(Number).forEach(t => { if (!out.includes(t)) out.push(t); });
  return out.sort((a, b) => a - b);
}
function slotFrom(key, t) {
  const hit = planSlots(plan(key), peekDay(key)?.endedAt).find(x => x.t === t);
  if (hit) return hit.from;
  const list = slots(key); const idx = list.indexOf(t);
  return idx > 0 ? list[idx - 1] : t - Number(S().interval);
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
  let grade = null;
  if (counted) {
    const score = 0.6 * acc + 0.4 * (avg ? (avg - 1) / 4 : 0) - Math.min(0.1, late / 300);
    grade = score >= 0.85 ? 'A' : score >= 0.7 ? 'B' : score >= 0.55 ? 'C' : score >= 0.4 ? 'D' : 'F';
  }
  const pri = peekDay(key)?.priorities || [];
  return { counted, done: done.length, missed, avg, onPri, late, acc, grade, priDone: pri.filter(p => p.done).length, priTotal: pri.length };
}
function dayOver(key = dateKey()) {
  const d = peekDay(key);
  return key < dateKey() || d?.endedAt != null || nowMin() >= dayEnd(key);
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
async function notify(body, level = 0, title0 = null) {
  beep(level);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = title0 || `${S().managerName} wants an update` + (level >= 2 ? '!!' : '');
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
  const d = day(key), now = nowMin();
  const mt = toMin(S().morning || '07:00');
  if (S().morningOn && !d.morningPinged && now >= mt && now < mt + 240) {
    d.morningPinged = true; save();
    const line = say(S().tone, 'morning');
    speak(line, 'neutral', true); notify(line, 0, "Time to set today's priorities");
    if (!modal.open) openStandup(d.standupDone);
  }
  if (!isWorkday(key)) { setTitle(0); updateClock(); return; }
  const start = dayStart(key);
  d.plan = clone(plan(key));

  if (!d.standupDone && now >= start - 30 && !dayOver(key) && !modal.open) openStandup();

  const p = pending();
  if (p.length) {
    const t = p.at(-1);
    // a blocked time that ended after this check-in was due restarts the clock (no nagging mid-lecture)
    const base = Math.max(t, ...mergedQuiet(plan(key)).map(([, b]) => b).filter(b => b > t && b <= now));
    const nk = base === t ? t : `${t}@${base}`, age = now - base;
    const level = age >= 30 ? 3 : age >= 15 ? 2 : age >= 5 ? 1 : 0;
    const prev = d.nags[nk] ?? -1;
    if (!quietAt(key, now) && level > prev) {
      d.nags[nk] = level; save();
      const vars = { range: rangeText(key, t) };
      const line = level === 0 ? say(S().tone, 'prompt', vars) : say(S().tone, 'nag', vars);
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
function setTitle(n) { document.title = n ? `(${n}) Report in — Time Keeper` : 'Time Keeper'; }

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
  });
  function after() { if (pending().length) openCheckin(); else closeModal(); render(); }
}

function openStandup(edit = false) {
  const d = day();
  const cur = d.priorities.map(p => p.text);
  showModal(`
    <form id="su" class="sheet">
      <div class="sheet-head"><span class="pill">Morning stand-up</span></div>
      <h2>${esc(say(S().tone, !edit && cur.length && !d.standupDone ? 'planned' : 'standup'))}</h2>
      <div id="su-list">${Array.from({ length: Math.max(3, cur.length) }, (_, i) => priField(i, cur[i])).join('')}</div>
      <button type="button" class="link" id="su-add" ${cur.length >= MAX_PRIORITIES ? 'hidden' : ''}>+ Add another priority</button>
      <div class="actions">
        ${edit ? '<button type="button" class="ghost" id="su-cancel">Cancel</button>' : '<button type="button" class="ghost" id="su-skip">Skip</button>'}
        <button class="primary">Commit</button>
      </div>
    </form>`, root => {
    $('input', root).focus();
    $('#su-add', root).addEventListener('click', e => {
      const list = $('#su-list', root), n = list.children.length;
      if (n >= MAX_PRIORITIES) return;
      list.insertAdjacentHTML('beforeend', priField(n)); list.lastElementChild.focus();
      if (n + 1 >= MAX_PRIORITIES) e.target.hidden = true;
    });
    $('#su', root).addEventListener('submit', e => {
      e.preventDefault();
      const texts = [...root.querySelectorAll('#su-list input')].map(x => x.value.trim()).filter(Boolean).slice(0, MAX_PRIORITIES);
      d.priorities = texts.map(text => ({ text, done: d.priorities.find(p => p.text === text)?.done || false }));
      d.standupDone = true; save(); closeModal();
      speak(say(S().tone, 'idle', { next: fmt(nextSlot() ?? dayEnd(dateKey())) }), 'neutral'); render(); tick();
    });
    $('#su-skip', root)?.addEventListener('click', () => {
      d.standupDone = true; save(); closeModal(); speak(say(S().tone, 'standupSkip'), 'angry', true); render(); tick();
    });
    $('#su-cancel', root)?.addEventListener('click', closeModal);
  });
}

function priField(i, v = '', firstRequired = true) {
  return `<input class="field" name="p${i}" placeholder="Priority ${i + 1}${i >= 3 ? ' (optional)' : ''}" value="${esc(v || '')}" ${i === 0 && firstRequired ? 'required' : ''}>`;
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
  const st = S(), byday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  if (!st.week.some(p => p.on)) return alert('Turn on at least one work day first.');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const url = location.origin + location.pathname + '?checkin';
  const ev = [];
  st.week.forEach((p, wd) => {
    const first = new Date(); first.setDate(first.getDate() + ((wd - first.getDay() + 7) % 7));
    const ymd = `${first.getFullYear()}${pad(first.getMonth() + 1)}${pad(first.getDate())}`;
    for (const { t, from } of planSlots(p)) {
    const hm = `${pad(Math.floor(t / 60))}${pad(t % 60)}00`, end = t + 5, hmEnd = `${pad(Math.floor(end / 60) % 24)}${pad(end % 60)}00`;
    const line = say(st.tone, 'prompt', { range: `from ${fmt(from)} to ${fmt(t)}` }).replace(/[,;\\]/g, m => '\\' + m);
    ev.push(['BEGIN:VEVENT', `UID:hourly-manager-${wd}-${hm}@local`, `DTSTAMP:${stamp}`, `DTSTART:${ymd}T${hm}`, `DTEND:${ymd}T${hmEnd}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${byday[wd]}`, `SUMMARY:${st.managerName}: check-in`, `DESCRIPTION:${line}`, `URL:${url}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${line}`, 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT'].join('\r\n'));
    }
  });
  if (st.morningOn) {
    const d0 = new Date(), ymd = `${d0.getFullYear()}${pad(d0.getMonth() + 1)}${pad(d0.getDate())}`, mt = toMin(st.morning);
    const hm = `${pad(Math.floor(mt / 60))}${pad(mt % 60)}00`, hmEnd = `${pad(Math.floor((mt + 5) / 60))}${pad((mt + 5) % 60)}00`;
    const line = say(st.tone, 'morning').replace(/[,;\\]/g, m => '\\' + m);
    ev.push(['BEGIN:VEVENT', 'UID:time-keeper-morning@local', `DTSTAMP:${stamp}`, `DTSTART:${ymd}T${hm}`, `DTEND:${ymd}T${hmEnd}`,
      'RRULE:FREQ=DAILY', `SUMMARY:${st.managerName}: set today's priorities`, `DESCRIPTION:${line}`, `URL:${location.origin + location.pathname}?priorities`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${line}`, 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT'].join('\r\n'));
  }
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Time Keeper//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${st.managerName} check-ins`, ...ev, 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = 'time-keeper-checkins.ics'; document.body.appendChild(a); a.click(); a.remove();
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
    const from = slotFrom(key, t);
    const s = status(key, t), e = d.entries[t];
    const range = `${fmt(from)} – ${fmt(t)}`;
    let body;
    if (s === 'done') body = `<p>${esc(e.text)}</p><div class="meta"><span class="dots">${'●'.repeat(e.rating)}<i>${'●'.repeat(5 - e.rating)}</i></span>${e.priority >= 0 && d.priorities[e.priority] ? `<span class="tag">↳ ${esc(d.priorities[e.priority].text)}</span>` : ''}${e.late >= 5 ? `<span class="tag warn">${e.late}m late</span>` : ''}</div>`;
    else if (s === 'missed') body = `<p class="miss">Unaccounted for</p>`;
    else if (s === 'pending') body = `<p class="miss">Waiting on your report…</p>`;
    else if (s === 'break') body = `<p class="dim">Break</p>`;
    else body = `<p class="dim">Upcoming</p>`;
    return { at: from, html: `<li class="tl ${s}"><span class="t">${range}</span><div>${body}</div></li>` };
  });
  if (isWorkday(key)) for (const [a, b, blk, e] of quietRanges(plan(key))) {
    rows.push({ at: a, html: `<li class="tl block"><span class="t">${fmt(a)} – ${fmt(b)}</span><div><p>${esc(blk.label || 'Blocked')}</p><div class="meta"><span class="tag">no check-ins</span>${b > e ? `<span class="tag">incl. ${b - e}m after</span>` : ''}</div></div></li>` });
  }
  rows.sort((x, y) => x.at - y.at);
  return rows.length ? `<ol class="timeline">${rows.map(r => r.html).join('')}</ol>` : '<p class="dim">No check-ins scheduled.</p>';
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
        <div><b>${s.priTotal ? s.priDone + '/' + s.priTotal : '–'}</b><span>priorities done</span></div>
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
  const q = isWorkday(key) ? quietAt(key, now) : null;
  const quiet = q ? `<p class="quiet">🔕 ${esc(q[2].label || 'Blocked time')} — quiet until ${fmt(q[1])}</p>` : '';
  let status;
  if (!isWorkday(key)) status = `<p class="big">Day off</p><p class="dim">${esc(say(S().tone, 'off'))}</p>`;
  else if (now < dayStart(key)) status = `<p class="label">Workday starts</p><p class="big">${fmt(dayStart(key))}</p><p class="dim">${esc(say(S().tone, 'before', { start: fmt(dayStart(key)) }))}</p>`;
  else if (p.length) status = `${quiet}<p class="label">Overdue</p><p class="big red">${p.length} report${p.length > 1 ? 's' : ''} owed</p><button class="primary wide" id="report">Report in now</button>`;
  else if (dayOver(key)) status = `<p class="label">Clocked out</p><p class="big">See you tomorrow</p>`;
  else {
    const n = nextSlot();
    status = `${quiet}<p class="label">${n != null ? `Next check-in at ${fmt(n)}` : 'No more check-ins today'}</p><p class="big mono" id="countdown">--:--</p>
      <div class="row"><button class="ghost" id="break">Take a break</button><button class="ghost" id="clockout">Clock out</button></div>`;
  }
  const ahead = plannedAhead();
  const pri = `<section class="card">
      <div class="card-head"><h3>Today's priorities</h3><div class="hdr-btns"><button class="link" id="plan-ahead">📅 Plan ahead</button><button class="link" id="edit-pri">${d.priorities.length ? 'Edit' : 'Set'}</button></div></div>
      ${d.priorities.length ? `<ul class="pri">${d.priorities.map((x, i) => `<li><label><input type="checkbox" data-i="${i}" ${x.done ? 'checked' : ''}><span>${esc(x.text)}</span></label></li>`).join('')}</ul>` : `<p class="dim">None set. ${esc(S().managerName)} has noticed.</p>`}
      ${ahead.length ? `<div class="ahead"><span class="dim small">Planned ahead:</span>${ahead.slice(0, 6).map(k => `<button class="tag" data-k="${k}">${niceDate(k)} · ${state.days[k].priorities.length}</button>`).join('')}</div>` : ''}
    </section>`;
  return `${install}${notif}
    <section class="card status">${status}</section>
    ${dayOver(key) && isWorkday(key) ? reportCard(key) : ''}
    ${pri}
    ${isWorkday(key) ? `<section class="card"><div class="card-head"><h3>Today's log</h3><span class="dim">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span></div>${timeline(key)}</section>` : ''}`;
}

function viewHistory() {
  const keys = Object.keys(state.days).filter(k => k < dateKey() && (isWorkday(k) || Object.keys(state.days[k].entries).length)).sort().reverse();
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
  return `<section class="card form">
    <h3>Your time keeper</h3>
    <label>Name<input class="field" id="s-name" value="${esc(s.managerName)}"></label>
    <label>Personality</label>
    <div class="tones" id="s-tone">${Object.entries(TONES).map(([k, [name, desc]]) => `<button type="button" data-t="${k}" class="${k === s.tone ? 'sel' : ''}"><b>${name}</b><span>${desc}</span></button>`).join('')}</div>
    <div class="tog-row"><label class="tog"><input type="checkbox" id="s-morning-on" ${s.morningOn ? 'checked' : ''}> Daily reminder to set priorities at</label><input class="field inline" type="time" id="s-morning" value="${s.morning}"></div>
    <label class="tog"><input type="checkbox" id="s-sound" ${s.sound ? 'checked' : ''}> Chime when checking in</label>
    <label class="tog"><input type="checkbox" id="s-voice" ${s.voice ? 'checked' : ''}> Say it out loud</label>
  </section>
  ${scheduleSection(s)}
  <section class="card form">
    <h3>Phone alarms</h3>
    <p class="dim small">iPhones pause web apps in the background, so ${esc(s.managerName)} can't nudge you while the app is closed. Add a Calendar alarm for every check-in (and the daily priorities reminder) — tapping it brings you back here.</p>
    <div class="row left"><button class="primary" id="s-ics">Add check-ins to Calendar</button></div>
    <p class="dim small">Changed your schedule? Delete the old “${esc(s.managerName)}: check-in” events and add them again.</p>
  </section>
  <section class="card form">
    <h3>Data</h3>
    <div class="row left"><button class="ghost" id="s-test">Test a check-in alert</button><button class="ghost" id="s-export">Export JSON</button></div>
    <div class="row left"><button class="ghost danger" id="s-reset">Erase everything</button></div>
    <p class="dim small">Everything stays on this device. Keep this tab (or the installed app) open during work hours — browsers can't wake a closed page.</p>
  </section>`;
}

/* ---------------- schedule calendar (drag to block out time) ---------------- */
const HOUR_PX = 44, SNAP = 15, LAST_MIN = 23 * 60 + 59;
const AFTER = [0, 15, 30, 45, 60, 90, 120];
let calDay = new Date().getDay(), calScroll = null;
const ypx = m => m / 60 * HOUR_PX;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function fmtShort(hhmm) {
  const m = toMin(hhmm), h = Math.floor(m / 60), mm = m % 60;
  return `${h % 12 || 12}${mm ? ':' + pad(mm) : ''}${h < 12 ? 'a' : 'p'}`;
}

function scheduleSection(s) {
  const p = S().week[calDay], sl = planSlots(p);
  return `<section class="card form" id="s-week">
    <h3>Weekly schedule</h3>
    <p class="dim small"><b>Tap or drag</b> on the calendar to block out time (lectures, travel…) — no check-ins happen during a block. Drag a block to move it, drag its bottom edge to resize, tap it to rename or delete. Drag the <b>Start</b> / <b>End</b> bars to set your day.</p>
    <div class="wk-strip">${[1, 2, 3, 4, 5, 6, 0].map(i => {
      const w = S().week[i];
      return `<button type="button" data-d="${i}" class="${i === calDay ? 'sel' : ''} ${w.on ? '' : 'off'}"><b>${DOW[i]}</b><span>${w.on ? fmtShort(w.start) + '–' + fmtShort(w.end) : 'off'}</span>${w.on && w.blocks.length ? `<i>${w.blocks.length}</i>` : ''}</button>`;
    }).join('')}</div>
    <div class="cal-bar"><label class="tog"><input type="checkbox" id="cal-on" ${p.on ? 'checked' : ''}> Work day</label><button type="button" class="link" id="cal-copy">Copy ${DOW_LONG[calDay]} to other days…</button></div>
    <div class="cal" id="cal"><div class="cal-grid" id="cal-grid" style="height:${ypx(24 * 60)}px">${calInner(calDay)}</div></div>
    <p class="dim small slots-preview"><b>🔔 ${DOW_LONG[calDay]} check-ins:</b> ${p.on ? (sl.length ? sl.map(x => fmt(x.t)).join(' · ') : 'none') : 'day off'}</p>
    <label>Check in every<select class="field" id="s-int">${[30, 45, 60, 90, 120].map(m => `<option value="${m}" ${m == s.interval ? 'selected' : ''}>${m < 60 ? m + ' minutes' : m / 60 + ' hour' + (m > 60 ? 's' : '')}</option>`).join('')}</select></label>
  </section>`;
}

function calInner(i) {
  const p = S().week[i], out = [];
  for (let h = 0; h < 24; h++) out.push(`<div class="cal-h" style="top:${ypx(h * 60)}px"><span>${h ? fmtShort(toHHMM(h * 60)) : ''}</span></div>`);
  if (!p.on) return out.join('') + `<div class="cal-off all"><span>Day off — tick “Work day” to plan it</span></div>`;
  const s = toMin(p.start), e = toMin(p.end);
  out.push(`<div class="cal-off" style="top:0;height:${ypx(s)}px"></div><div class="cal-off" style="top:${ypx(e)}px;height:${ypx(24 * 60 - e)}px"></div>`);
  planSlots(p).forEach(x => out.push(`<div class="cal-slot" style="top:${ypx(x.t)}px"><span>🔔 ${fmt(x.t)}</span></div>`));
  p.blocks.forEach((b, j) => {
    const a = toMin(b.start), z = toMin(b.end), af = Number(b.after || 0);
    if (af) out.push(`<div class="ev-after" style="top:${ypx(z)}px;height:${ypx(Math.min(af, 24 * 60 - z))}px"><span>quiet ${af} min</span></div>`);
    out.push(`<div class="ev ${z - a < 45 ? 'short' : ''}" data-j="${j}" style="top:${ypx(a)}px;height:${Math.max(ypx(z - a), 14)}px"><b>${esc(b.label || 'Busy')}</b><span>${fmt(a)} – ${fmt(z)}</span><i class="ev-resize" data-j="${j}"></i></div>`);
  });
  out.push(`<div class="hnd" data-h="start" style="top:${ypx(s)}px"><span>Start ${fmt(s)}</span></div><div class="hnd" data-h="end" style="top:${ypx(e)}px"><span>End ${fmt(e)}</span></div>`);
  return out.join('');
}

function bindCal() {
  const grid = $('#cal-grid'), cal = $('#cal'); if (!grid) return;
  const p = S().week[calDay];
  cal.scrollTop = calScroll ?? ypx(Math.max(0, (p.on ? toMin(p.start) : 8 * 60) - 60));
  cal.addEventListener('scroll', () => { calScroll = cal.scrollTop; }, { passive: true });
  const rawAt = y => (y - grid.getBoundingClientRect().top) / HOUR_PX * 60;
  const minAt = y => clamp(Math.round(rawAt(y) / SNAP) * SNAP, 0, 24 * 60);
  const redraw = () => { grid.innerHTML = calInner(calDay); };
  let drag = null;

  grid.addEventListener('pointerdown', e => {
    const rz = e.target.closest('.ev-resize'), ev = e.target.closest('.ev'), h = e.target.closest('.hnd'), m = minAt(e.clientY);
    if (rz) drag = { mode: 'resize', j: +rz.dataset.j };
    else if (ev) { const b = p.blocks[+ev.dataset.j]; drag = { mode: 'move', j: +ev.dataset.j, r0: rawAt(e.clientY), a0: toMin(b.start), z0: toMin(b.end) }; }
    else if (h) drag = { mode: 'hours', which: h.dataset.h };
    else if (!p.on) return;
    else if (e.pointerType === 'mouse') {
      const a = clamp(Math.floor(rawAt(e.clientY) / SNAP) * SNAP, 0, LAST_MIN - 60);
      p.blocks.push({ label: '', start: toHHMM(a), end: toHHMM(a + 60), after: 0 });
      drag = { mode: 'create', j: p.blocks.length - 1, anchor: a };
      redraw();
    } else { drag = { mode: 'tap', x: e.clientX, y: e.clientY, m }; return; } // touch: leave scrolling alone
    Object.assign(drag, { x: e.clientX, y: e.clientY, moved: false });
    grid.setPointerCapture(e.pointerId); e.preventDefault();
  });
  grid.addEventListener('pointermove', e => {
    if (!drag || drag.mode === 'tap') return;
    if (Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
    if (!drag.moved) return;
    const m = minAt(e.clientY), b = p.blocks[drag.j];
    if (drag.mode === 'move') {
      const dur = drag.z0 - drag.a0, a = clamp(drag.a0 + Math.round((rawAt(e.clientY) - drag.r0) / SNAP) * SNAP, 0, LAST_MIN - dur);
      b.start = toHHMM(a); b.end = toHHMM(a + dur);
    } else if (drag.mode === 'resize') b.end = toHHMM(clamp(m, toMin(b.start) + SNAP, LAST_MIN));
    else if (drag.mode === 'create') {
      const a = Math.min(drag.anchor, m), z = Math.max(drag.anchor + SNAP, m);
      b.start = toHHMM(a); b.end = toHHMM(Math.min(z, LAST_MIN));
    } else if (drag.mode === 'hours') {
      if (drag.which === 'start') p.start = toHHMM(clamp(m, 0, toMin(p.end) - 30));
      else p.end = toHHMM(clamp(m, toMin(p.start) + 30, LAST_MIN));
    }
    redraw();
  });
  const finish = e => {
    const d = drag; drag = null; if (!d) return;
    if (d.mode === 'tap') {
      if (e.type === 'pointercancel' || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || !p.on) return;
      const a = clamp(Math.floor(d.m / 60) * 60 + (d.m % 60 >= 30 ? 30 : 0), 0, LAST_MIN - 60);
      p.blocks.push({ label: '', start: toHHMM(a), end: toHHMM(a + 60), after: 0 });
      save(); render(); return openBlock(p.blocks.length - 1, true);
    }
    const obj = d.j != null ? p.blocks[d.j] : null;
    p.blocks.sort((x, y) => toMin(x.start) - toMin(y.start));
    save(); render();
    if (d.mode === 'create') openBlock(p.blocks.indexOf(obj), true);
    else if (d.mode === 'move' && !d.moved) openBlock(p.blocks.indexOf(obj));
  };
  grid.addEventListener('pointerup', finish);
  grid.addEventListener('pointercancel', finish);

  $('.wk-strip').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    calDay = Number(b.dataset.d); calScroll = null; render();
  });
  $('#cal-on').addEventListener('change', e => { p.on = e.target.checked; save(); render(); });
  $('#cal-copy').addEventListener('click', () => openCopy(calDay));
}

/** Edit one block: name, exact times, quiet-after buffer, repeat on other days, delete. */
function openBlock(j, isNew = false) {
  const p = S().week[calDay], b = p.blocks[j]; if (!b) return;
  showModal(`
    <form id="bk" class="sheet">
      <div class="sheet-head"><span class="pill">${DOW_LONG[calDay]}</span><span class="pill">${isNew ? 'New block' : 'Blocked time'}</span></div>
      <input class="field big-input" id="bk-label" value="${esc(b.label)}" placeholder="What is it? e.g. Lecture" autocomplete="off">
      <div class="two">
        <label class="lbl">From<input class="field" type="time" id="bk-start" value="${b.start}"></label>
        <label class="lbl">To<input class="field" type="time" id="bk-end" value="${b.end}"></label>
      </div>
      <label class="lbl">Stay quiet afterwards (travel, getting home…)</label>
      <div class="chips" id="bk-after">${AFTER.map(m => `<button type="button" data-m="${m}" class="${m == (b.after || 0) ? 'sel' : ''}">${m ? (m < 60 ? m + ' min' : m / 60 + ' hr') : 'None'}</button>`).join('')}</div>
      <label class="lbl">Also add on</label>
      <div class="chips" id="bk-days">${[1, 2, 3, 4, 5, 6, 0].filter(i => i !== calDay).map(i => `<button type="button" data-d="${i}">${DOW[i]}</button>`).join('')}</div>
      <div class="actions">
        <button type="button" class="ghost danger" id="bk-del">Delete</button>
        <button class="primary">Save</button>
      </div>
    </form>`, root => {
    let after = Number(b.after || 0); const days = new Set();
    $('#bk-label', root).focus();
    $('#bk-after', root).addEventListener('click', e => {
      const x = e.target.closest('button'); if (!x) return;
      root.querySelectorAll('#bk-after button').forEach(y => y.classList.toggle('sel', y === x)); after = Number(x.dataset.m);
    });
    $('#bk-days', root).addEventListener('click', e => {
      const x = e.target.closest('button'); if (!x) return;
      const d = Number(x.dataset.d); days.has(d) ? days.delete(d) : days.add(d); x.classList.toggle('sel');
    });
    $('#bk-del', root).addEventListener('click', () => { p.blocks.splice(j, 1); save(); closeModal(); render(); });
    $('#bk', root).addEventListener('submit', e => {
      e.preventDefault();
      const st = $('#bk-start', root).value || b.start, en = $('#bk-end', root).value || b.end;
      if (toMin(en) <= toMin(st)) return alert('The end time needs to be after the start time.');
      Object.assign(b, { label: $('#bk-label', root).value.trim(), start: st, end: en, after });
      days.forEach(d => { const w = S().week[d]; w.blocks.push(clone(b)); w.blocks.sort((x, y) => toMin(x.start) - toMin(y.start)); });
      p.blocks.sort((x, y) => toMin(x.start) - toMin(y.start));
      save(); closeModal(); render();
    });
  });
}

function openCopy(from) {
  showModal(`
    <div class="sheet">
      <div class="sheet-head"><span class="pill">Copy ${DOW_LONG[from]}</span></div>
      <h2>Copy ${DOW_LONG[from]}'s hours and blocks to…</h2>
      <div class="chips big" id="cp">${[1, 2, 3, 4, 5, 6, 0].filter(i => i !== from).map(i => `<button type="button" data-d="${i}">${DOW[i]}</button>`).join('')}</div>
      <p class="dim small">This replaces the schedule on the days you pick.</p>
      <div class="actions"><button type="button" class="ghost" id="cp-cancel">Cancel</button><button type="button" class="primary" id="cp-go">Copy</button></div>
    </div>`, root => {
    const picked = new Set();
    $('#cp', root).addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const d = Number(b.dataset.d); picked.has(d) ? picked.delete(d) : picked.add(d); b.classList.toggle('sel');
    });
    $('#cp-cancel', root).addEventListener('click', closeModal);
    $('#cp-go', root).addEventListener('click', () => {
      picked.forEach(d => { S().week[d] = clone(S().week[from]); });
      save(); closeModal(); render();
    });
  });
}

/* ---------------- plan priorities for future days ---------------- */
const addDays = (key, n) => { const d = new Date(key + 'T12:00'); d.setDate(d.getDate() + n); return dateKey(d); };
const niceDate = key => new Date(key + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const plannedAhead = () => Object.keys(state.days).filter(k => k > dateKey() && state.days[k].priorities?.length).sort();

function openPlanAhead(startKey = addDays(dateKey(), 1)) {
  const fill = key => { const cur = (peekDay(key)?.priorities || []).map(p => p.text); return Array.from({ length: Math.max(3, cur.length) }, (_, i) => priField(i, cur[i], false)).join(''); };
  const planned = plannedAhead();
  showModal(`
    <form id="pa" class="sheet">
      <div class="sheet-head"><span class="pill">Plan ahead</span></div>
      <h2>Priorities for a future day</h2>
      <label class="lbl">Date</label>
      <input class="field" type="date" id="pa-date" min="${addDays(dateKey(), 1)}" value="${startKey}" required>
      <label class="lbl">Priorities (up to ${MAX_PRIORITIES})</label>
      <div id="pa-list">${fill(startKey)}</div>
      <button type="button" class="link" id="pa-add">+ Add another priority</button>
      ${planned.length ? `<label class="lbl">Already planned</label><div class="chips" id="pa-planned">${planned.map(k => `<button type="button" data-k="${k}" class="${k === startKey ? 'sel' : ''}">${niceDate(k)} · ${state.days[k].priorities.length}</button>`).join('')}</div>` : ''}
      <p class="dim small">On the day, these show up ready in your morning stand-up — you can still add more.</p>
      <div class="actions"><button type="button" class="ghost" id="pa-cancel">Close</button><button class="primary">Save</button></div>
    </form>`, root => {
    const list = $('#pa-list', root), add = $('#pa-add', root), dateIn = $('#pa-date', root);
    const sync = () => { add.hidden = list.children.length >= MAX_PRIORITIES; };
    sync();
    dateIn.addEventListener('change', () => {
      if (!dateIn.value) return;
      list.innerHTML = fill(dateIn.value); sync();
      root.querySelectorAll('#pa-planned button').forEach(b => b.classList.toggle('sel', b.dataset.k === dateIn.value));
    });
    $('#pa-planned', root)?.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { dateIn.value = b.dataset.k; dateIn.dispatchEvent(new Event('change')); } });
    add.addEventListener('click', () => { list.insertAdjacentHTML('beforeend', priField(list.children.length, '', false)); list.lastElementChild.focus(); sync(); });
    $('#pa-cancel', root).addEventListener('click', closeModal);
    $('#pa', root).addEventListener('submit', e => {
      e.preventDefault();
      const key = dateIn.value; if (!key || key <= dateKey()) return alert('Pick a date after today.');
      const texts = [...list.querySelectorAll('input')].map(x => x.value.trim()).filter(Boolean).slice(0, MAX_PRIORITIES);
      const d = day(key); d.priorities = texts.map(text => ({ text, done: false })); save();
      speak(texts.length ? `Noted for ${niceDate(key)}. ${texts.length} priorit${texts.length > 1 ? 'ies' : 'y'} locked in.` : `Cleared ${niceDate(key)}.`, 'happy');
      closeModal(); render();
    });
  });
}

function bindView() {
  bindCal();
  const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);
  on('#enable-notif', 'click', async () => { await Notification.requestPermission(); render(); });
  on('#report', 'click', openCheckin);
  on('#break', 'click', openBreak);
  on('#edit-pri', 'click', () => openStandup(true));
  on('#plan-ahead', 'click', () => openPlanAhead());
  document.querySelectorAll('.ahead [data-k]').forEach(b => b.addEventListener('click', () => openPlanAhead(b.dataset.k)));
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
  on('#s-tone', 'click', e => { const b = e.target.closest('button'); if (!b) return; set('tone', b.dataset.t); render(); speak(say(S().tone, 'idle', { next: fmt(nextSlot() ?? dayEnd(dateKey())) }), 'neutral', true); });
  on('#s-sound', 'change', e => set('sound', e.target.checked));
  on('#s-morning-on', 'change', e => set('morningOn', e.target.checked));
  on('#s-morning', 'change', e => e.target.value && set('morning', e.target.value));
  on('#s-voice', 'change', e => set('voice', e.target.checked));
  on('#s-int', 'change', e => { set('interval', Number(e.target.value)); render(); });
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
    a.download = `time-keeper-${dateKey()}.json`; a.click();
  });
  on('#s-reset', 'click', () => {
    if (!confirm('Erase all check-ins and settings? This cannot be undone.')) return;
    state = { settings: { ...DEFAULTS, week: defaultWeek() }, days: {} }; save(); render();
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
else if (location.search.includes('priorities')) openStandup(day().standupDone);
