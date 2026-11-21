import { nextCard, counts, answer, suspend, previews, checkTyped, DECK_LABEL } from '../korean.js';
import { inc } from '../store-core.js';
import { esc, $ } from '../ui.js';

const LABELS = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
const KEYBOARD = [
  [['q', 'ㅂ'], ['w', 'ㅈ'], ['e', 'ㄷ'], ['r', 'ㄱ'], ['t', 'ㅅ'], ['y', 'ㅛ'], ['u', 'ㅕ'], ['i', 'ㅑ'], ['o', 'ㅐ'], ['p', 'ㅔ']],
  [['a', 'ㅁ'], ['s', 'ㄴ'], ['d', 'ㅇ'], ['f', 'ㄹ'], ['g', 'ㅎ'], ['h', 'ㅗ'], ['j', 'ㅓ'], ['k', 'ㅏ'], ['l', 'ㅣ']],
  [['z', 'ㅋ'], ['x', 'ㅌ'], ['c', 'ㅊ'], ['v', 'ㅍ'], ['b', 'ㅠ'], ['n', 'ㅜ'], ['m', 'ㅡ']],
];

const stem = w => { const s = w.split('/')[0].replace(/^-/, '').trim(); return s.length > 1 && s.endsWith('다') ? s.slice(0, -1) : s; };
const hl = (sentence, word) => { const s = stem(word), e = esc(sentence); return s && e.includes(esc(s)) ? e.replace(esc(s), `<mark>${esc(s)}</mark>`) : e; };
const blank = (sentence, word) => { const s = stem(word); return s && sentence.includes(s) ? esc(sentence).replace(esc(s), '<b>＿＿＿</b>') : null; };

let koVoice = null;
function pickVoice() { koVoice = speechSynthesis.getVoices().find(v => v.lang?.startsWith('ko')) || null; }
if ('speechSynthesis' in globalThis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text) {
  if (!koVoice || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.split('/')[0]);
  u.voice = koVoice; u.lang = koVoice.lang; u.rate = 0.9;
  speechSynthesis.speak(u);
}

export async function render(main, ctx) {
  const { store, settings } = ctx;
  let card = null, phase = 'front', result = null, typed = '', shownAt = 0, intervals = {};

  main.innerHTML = `<div class="study">
    <div class="spread small muted mb"><span id="counts"></span>
      <button id="kbd-toggle">⌨ Korean keyboard</button></div>
    <div class="card flash-card" id="card"><p class="muted">Loading…</p></div>
    <div id="kbd" class="kbd card mt" hidden>
      <div class="small muted center">Korean keyboard (2-set). On Windows: Win+Space, then Right Alt toggles 한/A. Shift = ㅃㅉㄸㄲㅆ ㅒㅖ</div>
      ${KEYBOARD.map(row => `<div>${row.map(([k, j]) => `<span><b>${j}</b>${k}</span>`).join('')}</div>`).join('')}
      <div class="small muted center">Combined vowels are typed in sequence: ㅘ = ㅗ+ㅏ · ㅝ = ㅜ+ㅓ · ㅢ = ㅡ+ㅣ</div>
    </div>
    <p class="small muted center">Space = show answer · 1 Again · 2 Hard · 3 Good · 4 Easy<br>
      Rate honestly — "Again" isn't failure, it's what keeps the schedule accurate.</p></div>`;
  $('#kbd-toggle', main).onclick = () => { $('#kbd', main).hidden ^= 1; };
  const el = $('#card', main);

  async function load() {
    const now = ctx.now(), start = ctx.dayStart(ctx.today());
    const [c, k] = await Promise.all([nextCard(store, settings.korean, now, start), counts(store, settings.korean, now, start)]);
    $('#counts', main).innerHTML = `Due <b>${k.due}</b> · New <b>${k.newLeft}</b> · Reviewed today <b>${k.reviewedToday}</b>`;
    card = c; phase = 'front'; result = null; typed = ''; shownAt = Date.now();
    if (!card) {
      el.innerHTML = `<div class="ko">끝! 🎉</div><p class="meaning">Done for today</p>
        <p class="muted">The Korean gate is clear. Reviews today: ${k.reviewedToday}.</p>
        <p><a class="btn primary" href="${esc(ctx.cfg.pcReader || '#/words')}" target="_blank">Read something</a> <a class="btn" href="#/today">Back to today</a></p>`;
      return;
    }
    intervals = previews(card, settings.korean.desiredRetention, now);
    draw();
  }

  function front() {
    const c = card;
    if (c.kind === 'type') {
      const b = c.exKo && blank(c.exKo, c.ko);
      return `<div class="muted small">Type it in Korean</div><div class="meaning mt">${esc(c.meaning)}</div>
        ${c.deck === 'hangul' && c.hint ? `<div class="muted">${esc(c.hint)}</div>` : ''}
        ${b ? `<div class="example">${b}</div><div class="muted small">${esc(c.exEn)}</div>` : ''}
        <input id="typed" lang="ko" autocomplete="off" autocapitalize="off" class="typed" placeholder="한국어로…" ${phase === 'back' ? 'disabled' : ''} value="${esc(typed)}">`;
    }
    if (c.deck === 'mined' && c.exKo) return `<div class="ko sentence">${hl(c.exKo, c.ko)}</div><div class="muted">What does <b>${esc(c.ko)}</b> mean?</div>`;
    if (c.deck === 'grammar') return `<div class="ko" style="font-size:36px">${esc(c.ko)}</div><div class="example">${hl(c.exKo, c.ko)}</div>`;
    return `<div class="ko">${esc(c.ko)}</div>`;
  }

  function back() {
    const c = card;
    let h = '<div class="answer">';
    if (c.kind === 'type') {
      if (result.correct) h += `<div class="diff" style="color:var(--good)">✓ ${esc(c.ko)}</div>`;
      else {
        const exp = [...c.ko.split('/')[0].trim()], got = [...typed];
        h += `<div class="diff">${exp.map((ch, i) => `<span style="color:var(--${got[i] === ch ? 'good' : 'bad'})">${esc(ch)}</span>`).join('')}</div>
          <div class="muted small">you typed: ${esc(typed) || '—'}${result.distance === 1 ? ' · one letter off' : ''}</div>`;
      }
    } else h += `<div class="meaning">${esc(c.meaning)}</div>`;
    if (c.hint && !(c.kind === 'type' && c.deck === 'hangul')) h += `<div class="muted">${esc(c.hint)}</div>`;
    if (c.exKo && !(c.kind === 'read' && (c.deck === 'grammar' || c.deck === 'mined')))
      h += `<div class="example">${hl(c.exKo, c.ko)} <button data-say="ex" title="Listen">🔊</button></div>`;
    if (c.exEn) h += `<div class="muted">${esc(c.exEn)}</div>`;
    h += '</div><div class="ratings">';
    for (const r of [1, 2, 3, 4]) h += `<button class="r${r} ${result?.suggested === r ? 'suggest' : ''}" data-rate="${r}">${LABELS[r]}<small>${intervals[r]}</small></button>`;
    return h + '</div>';
  }

  function draw() {
    const c = card;
    el.innerHTML = `<div class="spread small muted"><span>${DECK_LABEL[c.deck] || esc(c.deck)}${c.status === 'new' ? ' · <span class="pill wn">new</span>' : ''}${c.kind === 'type' ? ' · typing' : ''}</span>
      <span><button data-say="word" title="Listen">🔊</button> <button id="suspend" title="Stop showing this card">Suspend</button></span></div>
      ${front()}
      ${phase === 'front' ? (c.kind === 'type'
        ? `<div class="row center mt"><button class="primary" id="check">Check (Enter)</button><button id="giveup">I don't know</button></div>`
        : `<p class="mt"><button class="primary" id="reveal">Show answer (Space)</button></p>`) : back()}`;
    const inp = $('#typed', el);
    if (inp && phase === 'front') {
      inp.focus();
      inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } });
    }
  }

  function reveal() { phase = 'back'; draw(); if (card.deck !== 'grammar') speak(card.ko); }
  function submit() {
    typed = $('#typed', el).value.trim();
    if (!typed) return;
    result = checkTyped(card.ko, typed); phase = 'back'; draw(); speak(card.ko);
  }
  async function rate(r) {
    if (!card) return;
    const c = card; card = null;
    const now = ctx.now(), today = ctx.today();
    await answer(store, c, r, settings.korean, now, { ms: Date.now() - shownAt, typed: typed || null });
    store.update('daily', today, { day: today, reviews: inc(1), ...(c.status === 'new' && c.kind === 'read' ? { newCards: inc(1) } : {}) });
    load();
  }

  el.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'reveal') reveal();
    else if (t.id === 'check') submit();
    else if (t.id === 'giveup') { typed = ''; result = { correct: false, distance: 99, suggested: 1 }; phase = 'back'; draw(); speak(card.ko); }
    else if (t.id === 'suspend' && card && confirm('Stop showing this card?')) suspend(store, card).then(load);
    else if (t.dataset.rate) rate(+t.dataset.rate);
    else if (t.dataset.say) speak(t.dataset.say === 'ex' ? card.exKo : card.ko);
  });
  const onKey = e => {
    if (!card || (e.target.tagName === 'INPUT' && phase === 'front')) return;
    if (phase === 'front' && card.kind === 'read' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); reveal(); }
    else if (phase === 'back' && '1234'.includes(e.key) && e.key.length === 1) rate(+e.key);
    else if (phase === 'back' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); rate(result ? result.suggested : 3); }
  };
  document.addEventListener('keydown', onKey);
  await load();
  return () => document.removeEventListener('keydown', onKey);
}
