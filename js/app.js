import { say, TONES, LINES } from './lines.js';
const reviewLine = g => (LINES[state.settings.tone] || LINES.micro).review[g];

/* ---------------- state ---------------- */
const KEY = 'hourly-manager-v1';
const DEFAULTS = { managerName: 'Gerald', tone: 'micro', interval: 60, sound: true, voice: false, morningOn: true, morning: '07:00' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_PRIORITIES = 5;
/** Working hours per weekday (index 0 = Sunday). Events (lectures etc.) live in settings.events. */
const defaultWeek = (old = {}) => DOW.map((_, i) => ({
  on: (old.workdays || [1, 2, 3, 4, 5]).includes(i), start: old.start || '09:00', end: old.end || '17:00',
}));
const uid = () => Math.random().toString(36).slice(2, 10);
/** Event: { id, label, start, end, after, days: [weekdays] (repeats weekly) | date: 'YYYY-MM-DD' (once), skip: [dates] } */
function migrateEvents(settings) {
  if (!Array.isArray(settings.events)) {
    const map = new Map();
    settings.week.forEach((w, i) => (w.blocks || []).forEach(b => {
      const k = [b.label, b.start, b.end, b.after || 0].join('|');
      if (!map.has(k)) map.set(k, { id: uid(), label: b.label || '', start: b.start, end: b.end, after: Number(b.after || 0), days: [], date: null, skip: [] });
      map.get(k).days.push(i);
    }));
    settings.events = [...map.values()];
  }
  settings.week.forEach(w => delete w.blocks);
  return settings;
}
let state = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.days) {
      const settings = { ...DEFAULTS, ...s.settings };
      if (!Array.isArray(settings.week)) settings.week = defaultWeek(s.settings); // migrate v1 settings
      delete settings.start; delete settings.end; delete settings.workdays;
      return { settings: migrateEvents(settings), days: s.days, push: s.push };
    }
  } catch {}
  return { settings: { ...DEFAULTS, week: defaultWeek(), events: [] }, days: {} };
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }
function save() { persist(); queuePushSync(); }
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
const eventsOn = key => S().events
  .filter(e => e.date ? e.date === key : e.days.includes(dow(key)) && !(e.skip || []).includes(key))
  .sort((a, b) => toMin(a.start) - toMin(b.start));
/** A day's plan: that weekday's hours + the events happening on that date. */
const livePlan = key => ({ ...S().week[dow(key)], blocks: eventsOn(key) });
/** The repeating pattern for a weekday (used for Calendar alarms). */
const weekdayPlan = wd => ({ ...S().week[wd], blocks: S().events.filter(e => !e.date && e.days.includes(wd)) });
/** Past days keep the schedule they were lived with; today and later follow the live schedule. */
function plan(key) {
  const d = state.days[key];
  return key < dateKey() && d?.plan ? d.plan : livePlan(key);
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
/** No priorities → no check-ins. Priorities set mid-day start check-ins from that moment (no backlog). */
function slots(key) {
  const d = peekDay(key) || {};
  const out = d.priorities?.length
    ? planSlots(plan(key), d.endedAt).map(x => x.t).filter(t => d.priFrom == null || t > d.priFrom)
    : [];
  // keep any slots already answered even if settings changed
  Object.keys(d.entries || {}).map(Number).forEach(t => { if (!out.includes(t)) out.push(t); });
  return out.sort((a, b) => a - b);
}
function slotFrom(key, t) {
  const hit = planSlots(plan(key), peekDay(key)?.endedAt).find(x => x.t === t);
  if (hit) return Math.max(hit.from, Math.floor(peekDay(key)?.priFrom ?? 0));
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
  if (state.push?.on) return; // the push server delivers notifications
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
  if (key !== currentKey) { currentKey = key; render(); queuePushSync(); }
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
  const pri = d.priorities.length
    ? `<label class="lbl">Did it move a priority forward?</label>
       <div class="chips" id="pri">${d.priorities.map((x, i) => `<button type="button" data-i="${i}">${esc(x.text)}</button>`).join('')}<button type="button" data-i="-1" class="sel">Not really</button></div>`
    : '';
  showModal(`
    <form id="ci" class="sheet">
      <p class="eyebrow">${fmt(slotFrom(key, t))} – ${fmt(t)}${p.length > 1 ? ` · <span class="red">${p.length} owed</span>` : ''}</p>
      <h2 class="sheet-title">${esc(say(S().tone, 'prompt', { range: rangeText(key, t) }))}</h2>
      <textarea id="ci-text" rows="4" required placeholder="What did you get done?"></textarea>
      <label class="lbl">How productive was it?</label>
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
      <p class="eyebrow">Morning stand-up · ${gbDate()}</p>
      <h2 class="sheet-title">${esc(say(S().tone, !edit && cur.length && !d.standupDone ? 'planned' : 'standup'))}</h2>
      <div id="su-list">${Array.from({ length: Math.max(3, cur.length) }, (_, i) => priField(i, cur[i])).join('')}</div>
      <button type="button" class="link add" id="su-add" ${cur.length >= MAX_PRIORITIES ? 'hidden' : ''}>+ Add another</button>
      <div class="actions">
        ${edit ? '<button type="button" class="ghost" id="su-cancel">Cancel</button>' : '<button type="button" class="ghost" id="su-skip">Skip</button>'}
        <button class="primary">Commit</button>
      </div>
    </form>`, root => {
    $('input', root).focus();
    $('#su-add', root).addEventListener('click', e => {
      const list = $('#su-list', root), n = list.children.length;
      if (n >= MAX_PRIORITIES) return;
      list.insertAdjacentHTML('beforeend', priField(n)); list.lastElementChild.querySelector('input').focus();
      if (n + 1 >= MAX_PRIORITIES) e.target.hidden = true;
    });
    $('#su', root).addEventListener('submit', e => {
      e.preventDefault();
      const texts = [...root.querySelectorAll('#su-list input')].map(x => x.value.trim()).filter(Boolean).slice(0, MAX_PRIORITIES);
      if (!texts.length) d.priFrom = null;
      else if (!d.priorities.length) d.priFrom = nowMin() > dayStart(dateKey()) ? Math.floor(nowMin()) : null;
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
  return `<div class="num-field"><span>${i + 1}</span><input class="field" name="p${i}" placeholder="${i ? 'Another priority' + (i >= 3 ? ' (optional)' : '') : 'Your top priority'}" value="${esc(v || '')}" ${i === 0 && firstRequired ? 'required' : ''}></div>`;
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
  st.week.forEach((_, wd) => {
    const p = weekdayPlan(wd);
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

/* ---------------- push notifications (Cloudflare Worker) ---------------- */
const PUSH_URL = 'https://time-keeper-push.gitbit773.workers.dev';
const pushInfo = () => (state.push ||= { on: false });
const randId = (n = 24) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const canPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
/** Same line every time for the same moment, so unchanged schedules don't re-sync. */
function lineAt(key, seed, vars = {}) {
  const set = LINES[S().tone] || LINES.micro; let v = set[key] ?? LINES.micro[key];
  if (Array.isArray(v)) v = v[Math.abs(Math.floor(seed / 60000)) % v.length];
  return String(v).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
/** Everything the server should push over the next 7 days. Re-sent whenever it changes. */
function pushItems() {
  const items = [], now = Date.now(), name = S().managerName;
  const atOf = (key, min) => { const d = new Date(key + 'T00:00'); d.setMinutes(Math.round(min)); return d.getTime(); };
  for (let i = 0; i < 7; i++) {
    const key = addDays(dateKey(), i), d = peekDay(key);
    if (S().morningOn) {
      const at = atOf(key, toMin(S().morning));
      if (at > now && !d?.priorities?.length) items.push({ at, title: "Time to set today's priorities", body: lineAt('morning', at), url: './?priorities', tag: 'morning' });
    }
    if (!d?.priorities?.length || !isWorkday(key)) continue;
    for (const { t, from } of planSlots(plan(key), d.endedAt)) {
      if ((d.priFrom != null && t <= d.priFrom) || d.entries?.[t]) continue;
      const at = atOf(key, t), range = `from ${fmt(Math.max(from, d.priFrom ?? 0))} to ${fmt(t)}`;
      if (at > now) items.push({ at, title: `${name} wants an update`, body: lineAt('prompt', at, { range }), url: './?checkin', tag: 'checkin' });
      const nag = at + 15 * 60000;
      if (nag > now && !quietAt(key, t + 15)) items.push({ at: nag, title: `${name} is still waiting`, body: lineAt('nag', nag, { range }), url: './?checkin', tag: 'checkin' });
    }
  }
  return items.sort((a, b) => a.at - b.at).slice(0, 250);
}
let pushTimer;
function queuePushSync() {
  if (!state.push?.on) return;
  clearTimeout(pushTimer); pushTimer = setTimeout(() => syncPush().catch(() => {}), 1500);
}
async function syncPush(force = false) {
  const P = pushInfo(); if (!P.on || !canPush()) return;
  const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
  if (!sub) { P.on = false; persist(); return; }
  const items = pushItems();
  const sig = JSON.stringify([sub.endpoint, items]);
  if (!force && sig === P.sig) return;
  const r = await fetch(PUSH_URL + '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: P.id, secret: P.secret, subscription: sub.toJSON(), items }) });
  if (!r.ok) throw new Error('Sync failed (' + r.status + ')');
  P.sig = sig; P.synced = Date.now(); persist();
}
async function enablePush() {
  if (!canPush()) throw new Error(isIOS && !isStandalone ? 'Add Time Keeper to your Home Screen first, then open it from there.' : "This browser can't receive push notifications.");
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications were not allowed. You can allow them in your phone or browser settings.');
  const reg = await navigator.serviceWorker.ready;
  const { key } = await (await fetch(PUSH_URL + '/vapid')).json();
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) });
  const P = pushInfo(); P.id ||= randId(18); P.secret ||= randId(32); P.on = true; P.sig = '';
  persist(); await syncPush(true);
  return sub;
}
async function disablePush() {
  const P = pushInfo();
  try { await fetch(PUSH_URL + '/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: P.id, secret: P.secret }) }); } catch {}
  try { const reg = await navigator.serviceWorker.ready; await (await reg.pushManager.getSubscription())?.unsubscribe(); } catch {}
  P.on = false; P.sig = ''; persist();
}
async function testPush() {
  const P = pushInfo(); await syncPush(true);
  const r = await fetch(PUSH_URL + '/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: P.id, secret: P.secret, title: `${S().managerName} says hi`, body: lineAt('idle', Date.now(), { next: 'the next check-in' }) }) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error('Test push failed' + (j.status ? ' (' + j.status + ')' : ''));
}
async function withBusy(btn, fn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = 'Working…';
  try { await fn(); } catch (err) { alert(err.message || String(err)); } finally { btn.disabled = false; btn.textContent = old; render(); }
}

/* ---------------- views ---------------- */
let tab = 'today';
const gbDate = (key = dateKey()) => new Date(key + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
/** 9:00, 10:30 — compact 12h time without AM/PM, for dense lists. */
const fmtC = m => { m = Math.round(m); const h = Math.floor(m / 60) % 24; return `${h % 12 || 12}:${pad(m % 60)}`; };
const nextSlot = () => { const k = dateKey(); return slots(k).find(t => status(k, t) === 'upcoming'); };

function render() {
  const navTab = tab === 'schedule' ? 'settings' : tab;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === navTab));
  $('#mgr-name').textContent = S().managerName;
  $('.role').textContent = TONES[S().tone]?.[0] || '';
  $('#view').innerHTML = tab === 'today' ? viewToday() : tab === 'history' ? viewHistory() : tab === 'schedule' ? viewSchedule() : viewSettings();
  bindView();
  setTitle(pending().length);
  updateClock();
}

function timeline(key) {
  const d = peekDay(key) || { entries: {}, priorities: [] };
  const rows = slots(key).map(t => {
    const from = slotFrom(key, t);
    const s = status(key, t), e = d.entries[t];
    const range = `${fmtC(from)}–${fmtC(t)}`;
    let body;
    if (s === 'done') body = `<p>${esc(e.text)}</p><div class="meta"><span class="dots">${'●'.repeat(e.rating)}<i>${'●'.repeat(5 - e.rating)}</i></span>${e.priority >= 0 && d.priorities[e.priority] ? `<span class="tag">${esc(d.priorities[e.priority].text)}</span>` : ''}${e.late >= 5 ? `<span class="tag warn">${e.late}m late</span>` : ''}</div>`;
    else if (s === 'missed') body = `<p class="miss">Unaccounted for</p>`;
    else if (s === 'pending') body = `<p class="miss">Waiting on your report…</p>`;
    else if (s === 'break') body = `<p class="dim">Break</p>`;
    else body = `<p class="dim">Upcoming</p>`;
    return { at: from, html: `<li class="tl ${s}"><span class="t">${range}</span><div>${body}</div></li>` };
  });
  if (isWorkday(key)) for (const [a, b, blk, e] of quietRanges(plan(key))) {
    rows.push({ at: a, html: `<li class="tl block"><span class="t">${fmtC(a)}–${fmtC(b)}</span><div><p>${esc(blk.label || 'Blocked')}</p><div class="meta"><span class="tag">no check-ins</span>${b > e ? `<span class="tag">incl. ${b - e}m after</span>` : ''}</div></div></li>` });
  }
  rows.sort((x, y) => x.at - y.at);
  return rows.length ? `<ol class="timeline">${rows.map(r => r.html).join('')}</ol>` : '<p class="dim empty">No check-ins scheduled.</p>';
}

function reportCard(key) {
  const s = stats(key);
  if (!s.grade) return '';
  return `<section class="review g-${s.grade}">
    <div class="rv-top"><div class="grade">${s.grade}</div><div><p class="eyebrow">Performance review</p><p class="quote">“${esc(reviewLine(s.grade))}”</p></div></div>
    <div class="kpis">
      <div><b>${s.done}/${s.counted}</b><span>hours accounted</span></div>
      <div><b>${s.avg ? s.avg.toFixed(1) : '–'}</b><span>avg productivity</span></div>
      <div><b>${s.done ? Math.round(s.onPri / s.done * 100) + '%' : '–'}</b><span>on priorities</span></div>
      <div><b>${s.priTotal ? s.priDone + '/' + s.priTotal : '–'}</b><span>priorities done</span></div>
    </div>
  </section>`;
}

function viewToday() {
  const key = dateKey(), d = day(key), now = nowMin(), p = pending();
  const notif = !state.push?.on && 'Notification' in window && !(isIOS && !isStandalone)
    ? (Notification.permission === 'denied'
      ? `<section class="banner"><div><b>Notifications are blocked</b><p>Allow them for Time Keeper in your phone or browser settings so ${esc(S().managerName)} can reach you.</p></div></section>`
      : `<section class="banner"><div><b>Turn on notifications</b><p>So ${esc(S().managerName)} can reach you even when the app is closed.</p></div><button class="btn primary sm" id="enable-notif">Enable</button></section>`) : '';
  const install = isIOS && !isStandalone
    ? `<section class="banner"><div><b>Install on your iPhone</b><p>In Safari tap <b>Share</b> → <b>Add to Home Screen</b>, then open it from the Home Screen.</p></div></section>` : '';
  const q = isWorkday(key) ? quietAt(key, now) : null;
  const quiet = q ? `<p class="quiet">🔕 ${esc(q[2].label || 'Blocked time')} · quiet until ${fmt(q[1])}</p>` : '';
  let hero;
  if (!isWorkday(key)) hero = `<p class="eyebrow">${gbDate()}</p><h1 class="display sm">Day off</h1><p class="dim">${esc(say(S().tone, 'off'))}</p>`;
  else if (!d.priorities.length && !dayOver(key)) hero = `<p class="eyebrow">No priorities yet</p><h1 class="display sm">Check-ins paused</h1><p class="dim">Set today's priorities and ${esc(S().managerName)} starts checking in from then.</p><button class="btn primary wide" id="set-pri">Set today's priorities</button>`;
  else if (now < dayStart(key)) hero = `<p class="eyebrow">Workday starts</p><h1 class="display">${fmtC(dayStart(key))}</h1><p class="dim">${esc(say(S().tone, 'before', { start: fmt(dayStart(key)) }))}</p>`;
  else if (p.length) hero = `${quiet}<p class="eyebrow red">Overdue</p><h1 class="display sm red">${p.length} report${p.length > 1 ? 's' : ''} owed</h1><button class="btn primary wide" id="report">Report in now</button>`;
  else if (dayOver(key)) hero = `<p class="eyebrow">Clocked out at ${fmt(d.endedAt ?? dayEnd(key))}</p><h1 class="display sm">See you tomorrow</h1>`;
  else {
    const n = nextSlot();
    hero = `${quiet}<p class="eyebrow">${n != null ? `Next check-in at ${fmt(n)}` : 'No more check-ins today'}</p><h1 class="display" id="countdown">--:--</h1>
      <div class="btn-row"><button class="btn" id="break">Take a break</button><button class="btn" id="clockout">Clock out</button></div>`;
  }
  const ahead = plannedAhead();
  const pri = `<section class="sec">
      <div class="sec-head"><h2>Priorities</h2><div class="hdr-btns"><button class="link" id="plan-ahead">Plan ahead</button><button class="link" id="edit-pri">${d.priorities.length ? 'Edit' : 'Set'}</button></div></div>
      ${d.priorities.length ? `<ul class="pri">${d.priorities.map((x, i) => `<li><label><input type="checkbox" class="cbx" data-i="${i}" ${x.done ? 'checked' : ''}><span>${esc(x.text)}</span></label></li>`).join('')}</ul>` : `<p class="dim empty">None set. ${esc(S().managerName)} has noticed.</p>`}
      ${ahead.length ? `<div class="ahead"><span class="dim small">Planned ahead</span>${ahead.slice(0, 6).map(k => `<button class="tag" data-k="${k}">${gbDate(k)} · ${state.days[k].priorities.length}</button>`).join('')}</div>` : ''}
    </section>`;
  return `${install}${notif}
    <section class="hero">${hero}</section>
    ${dayOver(key) && isWorkday(key) ? reportCard(key) : ''}
    ${pri}
    ${isWorkday(key) ? `<section class="sec"><div class="sec-head"><h2>Today</h2><span class="dim small">${gbDate()}</span></div>${timeline(key)}</section>` : ''}`;
}

function viewHistory() {
  const keys = Object.keys(state.days).filter(k => k < dateKey() && (isWorkday(k) || Object.keys(state.days[k].entries).length)).sort().reverse();
  if (!keys.length) return `<section class="sec"><div class="sec-head"><h2>History</h2></div><p class="dim empty">No past days yet. Survive today first.</p></section>`;
  const week = keys.slice(0, 7).map(k => ({ k, s: stats(k) })).reverse();
  const bars = `<div class="bars">${week.map(({ k, s }) => `<div class="bar"><div class="fill g-${s.grade}" style="height:${Math.max(4, s.acc * 100)}%"></div><span>${new Date(k + 'T12:00').toLocaleDateString('en-GB', { weekday: 'narrow' })}</span></div>`).join('')}</div>`;
  return `<section class="sec"><div class="sec-head"><h2>Hours accounted</h2><span class="dim small">Last ${week.length} days</span></div>${bars}</section>
    <section class="sec hlist">${keys.map(k => {
      const s = stats(k);
      return `<details class="hrow"><summary><span class="gl g-${s.grade}">${s.grade ?? '–'}</span><span class="dk"><b>${gbDate(k)}</b><small>${s.done}/${s.counted} accounted · avg ${s.avg ? s.avg.toFixed(1) : '–'}</small></span><span class="chev">›</span></summary><div class="hrow-body">${timeline(k)}</div></details>`;
    }).join('')}</section>`;
}

function viewSettings() {
  const s = S(), on = S().week.filter(w => w.on).length;
  return `<section class="sec">
    <label class="lbl" for="s-name">Name</label>
    <input class="field" id="s-name" value="${esc(s.managerName)}">
  </section>
  <section class="sec">
    <p class="lbl">Personality</p>
    <div class="radio-list" id="s-tone">${Object.entries(TONES).map(([k, [name, desc]]) => `<button type="button" data-t="${k}" class="radio ${k === s.tone ? 'sel' : ''}"><span><b>${name}</b><small>${desc}</small></span><i aria-hidden="true"></i></button>`).join('')}</div>
  </section>
  <section class="sec rows">
    <div class="row-item"><span>Morning reminder</span><span class="row-end"><input type="time" class="time-plain" id="s-morning" value="${s.morning}"><input type="checkbox" class="switch" id="s-morning-on" ${s.morningOn ? 'checked' : ''} aria-label="Morning reminder"></span></div>
    <label class="row-item"><span>Chime when checking in</span><input type="checkbox" class="switch" id="s-sound" ${s.sound ? 'checked' : ''}></label>
    <label class="row-item"><span>Say it out loud</span><input type="checkbox" class="switch" id="s-voice" ${s.voice ? 'checked' : ''}></label>
    <button type="button" class="row-item nav" id="open-schedule"><span>Weekly schedule</span><span class="row-end dim">${on} work day${on === 1 ? '' : 's'} · ${S().events.length} event${S().events.length === 1 ? '' : 's'} <b class="chev">›</b></span></button>
  </section>
  <section class="sec">
    <p class="lbl">Push notifications</p>
    ${state.push?.on
      ? `<p class="dim small">On — ${esc(s.managerName)} reaches this device even when the app is closed.${state.push.synced ? ' Last synced ' + new Date(state.push.synced).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.' : ''}</p>
         <div class="btn-row left"><button class="btn" id="push-test">Send a test push</button><button class="btn danger" id="push-off">Turn off</button></div>`
      : `<p class="dim small">Get check-ins and the morning reminder even when the app is closed.${isIOS && !isStandalone ? ' On iPhone, add Time Keeper to your Home Screen first and open it from there.' : ''}</p>
         <div class="btn-row left"><button class="btn primary" id="push-on">Turn on push notifications</button></div>`}
  </section>
  <section class="sec">
    <p class="lbl">Calendar alarms (backup)</p>
    <p class="dim small">iPhones pause web apps in the background, so ${esc(s.managerName)} can't nudge you while the app is closed. Add a Calendar alarm for every check-in and the morning reminder — tapping one brings you back here. Re-add them after changing your schedule.</p>
    <div class="btn-row left"><button class="btn primary" id="s-ics">Add check-ins to Calendar</button></div>
  </section>
  <section class="sec">
    <p class="lbl">Data</p>
    <div class="btn-row left"><button class="btn" id="s-test">Test a check-in alert</button><button class="btn" id="s-export">Export JSON</button></div>
    <div class="btn-row left"><button class="btn danger" id="s-reset">Erase everything</button></div>
    <p class="dim small">Everything stays on this device.</p>
  </section>`;
}

/* ---------------- schedule calendar (date-based week, recurring + one-time events) ---------------- */
const HOUR_PX = 44, SNAP = 15, LAST_MIN = 23 * 60 + 59;
const AFTER = [0, 15, 30, 45, 60, 90, 120];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
let calDate = dateKey(), calScroll = null;
const ypx = m => m / 60 * HOUR_PX;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function fmtShort(hhmm) {
  const m = toMin(hhmm), h = Math.floor(m / 60), mm = m % 60;
  return `${h % 12 || 12}${mm ? ':' + pad(mm) : ''}${h < 12 ? 'a' : 'p'}`;
}
/** Monday-first list of the 7 date keys in the week containing `key`. */
const weekOf = key => { const off = (dow(key) + 6) % 7; return Array.from({ length: 7 }, (_, i) => addDays(key, i - off)); };
const shortDate = key => new Date(key + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function repeatText(e) {
  if (e.date) return 'Once · ' + niceDate(e.date);
  const ds = WEEK_ORDER.filter(i => e.days.includes(i));
  if (ds.length === 7) return 'Every day';
  if (ds.length === 5 && !ds.includes(0) && !ds.includes(6)) return 'Every weekday';
  return 'Every ' + ds.map(i => DOW[i]).join(', ');
}
const findEvent = id => S().events.find(e => e.id === id);

function viewSchedule() {
  const s = S(), key = calDate, w = S().week[dow(key)], p = livePlan(key), sl = planSlots(p), wk = weekOf(key);
  return `<div class="subhead"><button type="button" class="back" id="back-settings" aria-label="Back to settings">‹</button><h1 class="title">Weekly schedule</h1></div>
  <section id="s-week">
    <p class="dim small help"><b>Tap or drag</b> to add an event (lecture, travel…) — no check-ins during events. Events repeat weekly or happen once. Drag to move, drag the bottom edge to resize, tap to edit. Drag <b>Start</b> / <b>End</b> to set your hours.</p>
    <div class="cal-nav">
      <button type="button" class="icon-btn" data-nav="-7" aria-label="Previous week">‹</button>
      <b>${shortDate(wk[0])} – ${shortDate(wk[6])}</b>
      <button type="button" class="icon-btn" data-nav="7" aria-label="Next week">›</button>
      ${weekOf(dateKey())[0] !== wk[0] ? '<button type="button" class="link" data-nav="today">This week</button>' : ''}
    </div>
    <div class="wk-strip">${wk.map(k => {
      const ww = S().week[dow(k)], n = ww.on ? eventsOn(k).length : 0;
      return `<button type="button" data-k="${k}" class="${k === key ? 'sel' : ''} ${ww.on ? '' : 'off'} ${k === dateKey() ? 'today' : ''}" aria-label="${niceDate(k)}"><b>${DOW[dow(k)][0]}</b><span>${new Date(k + 'T12:00').getDate()}</span><i class="${n ? 'on' : ''}"></i></button>`;
    }).join('')}</div>
    <div class="cal-bar"><label class="switch-label" title="Applies every ${DOW_LONG[dow(key)]}"><input type="checkbox" class="switch" id="cal-on" ${w.on ? 'checked' : ''}> Work day</label><button type="button" class="link" id="cal-copy">Copy to other days</button></div>
    <div class="cal" id="cal"><div class="cal-grid" id="cal-grid" style="height:${ypx(24 * 60)}px">${calInner(key)}</div></div>
    <p class="dim small slots-preview">🔔 ${niceDate(key)}: ${p.on ? (sl.length ? sl.map(x => fmtC(x.t)).join(' · ') : 'no check-ins') : 'day off'} · only once priorities are set</p>
  </section>
  <section class="sec rows">
    <label class="row-item"><span>Check in every</span><span class="row-end"><select class="select-plain" id="s-int">${[30, 45, 60, 90, 120].map(m => `<option value="${m}" ${m == s.interval ? 'selected' : ''}>${m < 60 ? m + ' minutes' : m / 60 + ' hour' + (m > 60 ? 's' : '')}</option>`).join('')}</select><b class="chev">›</b></span></label>
  </section>`;
}

function calInner(key) {
  const p = livePlan(key), out = [];
  for (let h = 0; h < 24; h++) out.push(`<div class="cal-h" style="top:${ypx(h * 60)}px"><span>${h ? fmtShort(toHHMM(h * 60)) : ''}</span></div>`);
  if (!p.on) return out.join('') + `<div class="cal-off all"><span>Day off — tick “Work day” to plan it</span></div>`;
  const s = toMin(p.start), e = toMin(p.end);
  out.push(`<div class="cal-off" style="top:0;height:${ypx(s)}px"></div><div class="cal-off" style="top:${ypx(e)}px;height:${ypx(24 * 60 - e)}px"></div>`);
  planSlots(p).forEach(x => out.push(`<div class="cal-slot" style="top:${ypx(x.t)}px"><span>🔔 ${fmt(x.t)}</span></div>`));
  p.blocks.forEach(ev => {
    const a = toMin(ev.start), z = toMin(ev.end), af = Number(ev.after || 0);
    if (af) out.push(`<div class="ev-after" style="top:${ypx(z)}px;height:${ypx(Math.min(af, 24 * 60 - z))}px"><span>quiet ${af} min</span></div>`);
    out.push(`<div class="ev ${z - a < 45 ? 'short' : ''} ${ev.date ? 'once' : ''}" data-id="${ev.id}" style="top:${ypx(a)}px;height:${Math.max(ypx(z - a), 14)}px"><b>${ev.date ? '' : '↻ '}${esc(ev.label || 'Busy')}</b><span>${fmt(a)} – ${fmt(z)}</span><i class="ev-resize" data-id="${ev.id}"></i></div>`);
  });
  out.push(`<div class="hnd" data-h="start" style="top:${ypx(s)}px"><span>Start ${fmt(s)}</span></div><div class="hnd" data-h="end" style="top:${ypx(e)}px"><span>End ${fmt(e)}</span></div>`);
  return out.join('');
}

function bindCal() {
  const grid = $('#cal-grid'), cal = $('#cal'); if (!grid) return;
  const key = calDate, w = S().week[dow(key)];
  cal.scrollTop = calScroll ?? ypx(Math.max(0, (w.on ? toMin(w.start) : 8 * 60) - 60));
  cal.addEventListener('scroll', () => { calScroll = cal.scrollTop; }, { passive: true });
  const rawAt = y => (y - grid.getBoundingClientRect().top) / HOUR_PX * 60;
  const minAt = y => clamp(Math.round(rawAt(y) / SNAP) * SNAP, 0, 24 * 60);
  const redraw = () => { grid.innerHTML = calInner(key); };
  const newEvent = a => {
    const ev = { id: uid(), label: '', start: toHHMM(a), end: toHHMM(a + 60), after: 0, days: [dow(key)], date: null, skip: [] };
    S().events.push(ev); return ev;
  };
  let drag = null;

  grid.addEventListener('pointerdown', e => {
    const rz = e.target.closest('.ev-resize'), el = e.target.closest('.ev'), h = e.target.closest('.hnd'), m = minAt(e.clientY);
    if (rz) drag = { mode: 'resize', ev: findEvent(rz.dataset.id) };
    else if (el) { const ev = findEvent(el.dataset.id); drag = { mode: 'move', ev, r0: rawAt(e.clientY), a0: toMin(ev.start), z0: toMin(ev.end) }; }
    else if (h) drag = { mode: 'hours', which: h.dataset.h };
    else if (!w.on) return;
    else if (e.pointerType === 'mouse') {
      const a = clamp(Math.floor(rawAt(e.clientY) / SNAP) * SNAP, 0, LAST_MIN - 60);
      drag = { mode: 'create', ev: newEvent(a), anchor: a };
      redraw();
    } else { drag = { mode: 'tap', x: e.clientX, y: e.clientY, m }; return; } // touch: leave scrolling alone
    if (drag.mode !== 'hours' && !drag.ev) { drag = null; return; }
    Object.assign(drag, { x: e.clientX, y: e.clientY, moved: false });
    try { grid.setPointerCapture(e.pointerId); } catch {} e.preventDefault();
  });
  grid.addEventListener('pointermove', e => {
    if (!drag || drag.mode === 'tap') return;
    if (Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
    if (!drag.moved) return;
    const m = minAt(e.clientY), ev = drag.ev;
    if (drag.mode === 'move') {
      const dur = drag.z0 - drag.a0, a = clamp(drag.a0 + Math.round((rawAt(e.clientY) - drag.r0) / SNAP) * SNAP, 0, LAST_MIN - dur);
      ev.start = toHHMM(a); ev.end = toHHMM(a + dur);
    } else if (drag.mode === 'resize') ev.end = toHHMM(clamp(m, toMin(ev.start) + SNAP, LAST_MIN));
    else if (drag.mode === 'create') {
      const a = Math.min(drag.anchor, m), z = Math.max(drag.anchor + SNAP, m);
      ev.start = toHHMM(a); ev.end = toHHMM(Math.min(z, LAST_MIN));
    } else if (drag.mode === 'hours') {
      if (drag.which === 'start') w.start = toHHMM(clamp(m, 0, toMin(w.end) - 30));
      else w.end = toHHMM(clamp(m, toMin(w.start) + 30, LAST_MIN));
    }
    redraw();
  });
  const finish = e => {
    const d = drag; drag = null; if (!d) return;
    if (d.mode === 'tap') {
      if (e.type === 'pointercancel' || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || !w.on) return;
      const a = clamp(Math.floor(d.m / 60) * 60 + (d.m % 60 >= 30 ? 30 : 0), 0, LAST_MIN - 60);
      const ev = newEvent(a); save(); render(); return openEvent(ev.id, true);
    }
    save(); render();
    if (d.mode === 'create') openEvent(d.ev.id, true);
    else if (d.mode === 'move' && !d.moved) openEvent(d.ev.id);
  };
  grid.addEventListener('pointerup', finish);
  grid.addEventListener('pointercancel', finish);

  $('#s-week').addEventListener('click', e => {
    if (e.target.closest('.cal')) return;
    const nav = e.target.closest('[data-nav]'), k = e.target.closest('.wk-strip [data-k]');
    if (nav) { calDate = nav.dataset.nav === 'today' ? dateKey() : addDays(calDate, Number(nav.dataset.nav)); render(); }
    else if (k) { calDate = k.dataset.k; render(); }
  });
  $('#cal-on').addEventListener('change', e => { w.on = e.target.checked; save(); render(); });
  $('#cal-copy').addEventListener('click', () => openCopy(dow(key)));
}

/** Edit an event: name, times, repeat weekly (which days) or once, quiet-after buffer, delete. */
function openEvent(id, isNew = false) {
  const ev = findEvent(id); if (!ev) return;
  const key = calDate;
  let once = !!ev.date, after = Number(ev.after || 0);
  const days = new Set(ev.days?.length ? ev.days : [dow(key)]);
  showModal(`
    <form id="bk" class="sheet">
      <div class="sheet-head"><span class="pill">${isNew ? 'New event' : 'Event'}</span><span class="pill">${esc(repeatText(ev))}</span></div>
      <input class="field big-input" id="bk-label" value="${esc(ev.label)}" placeholder="What is it? e.g. Lecture" autocomplete="off">
      <div class="two">
        <label class="lbl">From<input class="field" type="time" id="bk-start" value="${ev.start}"></label>
        <label class="lbl">To<input class="field" type="time" id="bk-end" value="${ev.end}"></label>
      </div>
      <label class="lbl">Repeat</label>
      <div class="seg" id="bk-rep"><button type="button" data-r="weekly" class="${once ? '' : 'sel'}">↻ Every week</button><button type="button" data-r="once" class="${once ? 'sel' : ''}">Only ${shortDate(ev.date || key)}</button></div>
      <div class="chips" id="bk-days" ${once ? 'hidden' : ''}>${WEEK_ORDER.map(i => `<button type="button" data-d="${i}" class="${days.has(i) ? 'sel' : ''}">${DOW[i]}</button>`).join('')}</div>
      <label class="lbl">Stay quiet afterwards (travel, getting home…)</label>
      <div class="chips" id="bk-after">${AFTER.map(m => `<button type="button" data-m="${m}" class="${m == after ? 'sel' : ''}">${m ? (m < 60 ? m + ' min' : m / 60 + ' hr') : 'None'}</button>`).join('')}</div>
      <div class="actions" id="bk-actions">
        <button type="button" class="ghost danger" id="bk-del">Delete</button>
        <button class="primary">Save</button>
      </div>
    </form>`, root => {
    if (isNew) $('#bk-label', root).focus();
    const pickOne = (box, fn) => box.addEventListener('click', e => {
      const x = e.target.closest('button'); if (!x) return;
      box.querySelectorAll('button').forEach(y => y.classList.toggle('sel', y === x)); fn(x);
    });
    pickOne($('#bk-rep', root), x => { once = x.dataset.r === 'once'; $('#bk-days', root).hidden = once; });
    pickOne($('#bk-after', root), x => { after = Number(x.dataset.m); });
    $('#bk-days', root).addEventListener('click', e => {
      const x = e.target.closest('button'); if (!x) return;
      const d = Number(x.dataset.d); days.has(d) ? days.delete(d) : days.add(d); x.classList.toggle('sel', days.has(d));
    });
    const remove = () => { S().events = S().events.filter(x => x.id !== ev.id); save(); closeModal(); render(); };
    $('#bk-del', root).addEventListener('click', () => {
      if (isNew || ev.date) return remove();
      $('#bk-actions', root).innerHTML = `<span class="small dim grow">Delete this repeating event…</span>
        <button type="button" class="ghost danger" id="bk-del-one">Only ${shortDate(key)}</button>
        <button type="button" class="ghost danger" id="bk-del-all">Every week</button>`;
      $('#bk-del-one', root).addEventListener('click', () => { (ev.skip ||= []).push(key); save(); closeModal(); render(); });
      $('#bk-del-all', root).addEventListener('click', remove);
    });
    $('#bk', root).addEventListener('submit', e => {
      e.preventDefault();
      const st = $('#bk-start', root).value || ev.start, en = $('#bk-end', root).value || ev.end;
      if (toMin(en) <= toMin(st)) return alert('The end time needs to be after the start time.');
      if (!once && !days.size) return alert('Pick at least one day for it to repeat on.');
      Object.assign(ev, { label: $('#bk-label', root).value.trim(), start: st, end: en, after });
      if (once) { ev.date = ev.date || key; ev.days = []; } else { ev.date = null; ev.days = [...days].sort(); }
      save(); closeModal(); render();
    });
  });
}

function openCopy(from) {
  showModal(`
    <div class="sheet">
      <div class="sheet-head"><span class="pill">Copy ${DOW_LONG[from]}</span></div>
      <h2>Copy ${DOW_LONG[from]}'s hours and weekly events to…</h2>
      <div class="chips big" id="cp">${WEEK_ORDER.filter(i => i !== from).map(i => `<button type="button" data-d="${i}">${DOW[i]}</button>`).join('')}</div>
      <p class="dim small">This replaces the hours and weekly events on the days you pick. One-time events aren't copied.</p>
      <div class="actions"><button type="button" class="ghost" id="cp-cancel">Cancel</button><button type="button" class="primary" id="cp-go">Copy</button></div>
    </div>`, root => {
    const picked = new Set();
    $('#cp', root).addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const d = Number(b.dataset.d); picked.has(d) ? picked.delete(d) : picked.add(d); b.classList.toggle('sel');
    });
    $('#cp-cancel', root).addEventListener('click', closeModal);
    $('#cp-go', root).addEventListener('click', () => {
      const src = S().week[from];
      picked.forEach(d => {
        Object.assign(S().week[d], { on: src.on, start: src.start, end: src.end });
        S().events.forEach(ev => {
          if (ev.date) return;
          const has = ev.days.includes(from);
          ev.days = ev.days.filter(x => x !== d); if (has) ev.days.push(d);
        });
      });
      S().events = S().events.filter(ev => ev.date || ev.days.length);
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
    add.addEventListener('click', () => { list.insertAdjacentHTML('beforeend', priField(list.children.length, '', false)); list.lastElementChild.querySelector('input').focus(); sync(); });
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
  on('#enable-notif', 'click', e => withBusy(e.currentTarget, enablePush));
  on('#push-on', 'click', e => withBusy(e.currentTarget, enablePush));
  on('#push-test', 'click', e => withBusy(e.currentTarget, testPush));
  on('#push-off', 'click', e => withBusy(e.currentTarget, disablePush));
  on('#report', 'click', openCheckin);
  on('#break', 'click', openBreak);
  on('#edit-pri', 'click', () => openStandup(true));
  on('#set-pri', 'click', () => openStandup(true));
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
  on('#open-schedule', 'click', () => { tab = 'schedule'; calScroll = null; render(); scrollTo(0, 0); });
  on('#back-settings', 'click', () => { tab = 'settings'; render(); scrollTo(0, 0); });
  on('#s-export', 'click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
    a.download = `time-keeper-${dateKey()}.json`; a.click();
  });
  on('#s-reset', 'click', () => {
    if (!confirm('Erase all check-ins and settings? This cannot be undone.')) return;
    state = { settings: { ...DEFAULTS, week: defaultWeek(), events: [] }, days: {} }; save(); render();
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
queuePushSync();
{
  const k = dateKey();
  if (!isWorkday(k)) speak(say(S().tone, 'off'));
  else if (nextSlot() != null) speak(say(S().tone, 'idle', { next: fmt(nextSlot()) }));
}
tick();
setInterval(tick, 10_000);
setInterval(updateClock, 1000);
if (location.search.includes('checkin')) pending().length ? openCheckin() : day().priorities.length || openStandup(day().standupDone);
else if (location.search.includes('priorities')) openStandup(day().standupDone);
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'open-priorities') openStandup(day().standupDone); });
