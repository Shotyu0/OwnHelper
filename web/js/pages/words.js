import { addNote } from '../korean.js';
import { esc, $, toast } from '../ui.js';

export async function render(main, ctx, params) {
  const { store } = ctx;
  const cards = (await store.query('cards', { where: [['kind', '==', 'read']] }))
    .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || (a.newRank ?? 0) - (b.newRank ?? 0));
  const ko = params.ko || '';
  main.innerHTML = `<h1>Words</h1>
  <div class="grid">
    <form class="card" id="add">
      <h2>Add a word you met</h2>
      <p class="small muted">Words from things you actually read stick better than list words. They come before the
        starter deck, with your sentence as the context.</p>
      <label>Korean (dictionary form, e.g. 먹다 not 먹었어요)</label><input name="ko" required lang="ko" value="${esc(ko)}">
      <label>Meaning</label><input name="meaning" required>
      <div class="small mt-s" id="lookup"></div>
      <label>Sentence you found it in</label><input name="exKo" lang="ko" value="${esc(params.ex || '')}">
      <label>Sentence translation (optional)</label><input name="exEn">
      <label>Note (optional)</label><input name="hint" placeholder="e.g. casual, from a webtoon">
      <p><button class="primary">Add</button></p>
    </form>
    <form class="card" id="bulk">
      <h2>Bulk import</h2>
      <p class="small muted">One per line: <code>korean ⇥ meaning ⇥ example ⇥ translation</code> (tab-separated, e.g. pasted
        from a spreadsheet). Commas also work if the meaning has none.</p>
      <textarea name="text" rows="8" lang="ko" placeholder="고양이&#9;cat&#9;고양이가 귀여워요.&#9;The cat is cute."></textarea>
      <p><button class="primary">Import</button></p>
    </form>
  </div>
  <div class="card mt"><h2>Your deck <span class="muted small">(${cards.length})</span></h2>
    <table><tr><th>Korean</th><th>Meaning</th><th>Deck</th><th>Status</th></tr>
    ${cards.map(c => `<tr><td lang="ko"><b>${esc(c.ko)}</b></td><td>${esc(c.meaning)}</td><td class="muted">${esc(c.deck)}</td>
      <td>${c.status === 'active' ? `<span class="pill ok">learning</span> <span class="small muted">${(c.stab || 0).toFixed(1)}d memory</span>`
        : c.status === 'suspended' ? '<span class="pill no">suspended</span>' : '<span class="small muted">upcoming</span>'}</td></tr>`).join('')}
    </table></div>`;

  const form = $('#add', main);
  const lookup = () => {
    const w = form.ko.value.trim();
    $('#lookup', main).innerHTML = w ? `Look it up: <a target="_blank" rel="noopener" href="https://korean.dict.naver.com/koendict/#/search?query=${encodeURIComponent(w)}">Naver</a> ·
      <a target="_blank" rel="noopener" href="https://en.wiktionary.org/wiki/${encodeURIComponent(w)}">Wiktionary</a>` : '';
  };
  form.ko.addEventListener('input', lookup);
  lookup();
  if (ko) form.meaning.focus();
  form.onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const ok = await addNote(store, { deck: 'mined', ...f }, ctx.now());
    toast(ok ? `Added ${f.ko} — it'll come up as a new card next.` : 'Already in your deck.', ok ? 'ok' : '');
    if (ok) render(main, ctx, {});
  };
  $('#bulk', main).onsubmit = async e => {
    e.preventDefault();
    let n = 0;
    for (const line of e.target.text.value.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const p = (line.includes('\t') ? line.split('\t') : line.split(',')).map(s => s.trim());
      if (p[0] && p[1] && await addNote(store, { deck: 'mined', ko: p[0], meaning: p[1], exKo: p[2] || '', exEn: p[3] || '' }, ctx.now() + n, 'import')) n++;
    }
    toast(`Imported ${n} new word(s).`, 'ok');
    render(main, ctx, {});
  };
}
