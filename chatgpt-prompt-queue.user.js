// ==UserScript==
// @name         Promptline
// @namespace    adztrz
// @license      MIT
// @version      3.2
// @description  Promptline (formerly ChatGPT Image Queue): queue image prompts in ChatGPT, download each result, wait out limits, batch archive or delete chats, and keep a prompt library.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_download
// @connect      chatgpt.com
// @connect      oaiusercontent.com
// @connect      openai.com
// @run-at       document-idle
// @icon         https://raw.githubusercontent.com/Adztrz/promptline/main/icon.png
// @homepageURL  https://github.com/Adztrz/promptline
// @updateURL    https://raw.githubusercontent.com/Adztrz/promptline/main/chatgpt-prompt-queue.user.js
// @downloadURL  https://raw.githubusercontent.com/Adztrz/promptline/main/chatgpt-prompt-queue.user.js
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    settleMs: 8000,             // the page must look finished this long before the next prompt goes
    gapMs: 5000,                // extra pause between prompts
    startWaitMs: 30000,         // how long to wait for ChatGPT to start replying after a send
    maxWaitMs: 8 * 60 * 1000,   // a reply taking longer than this pauses the queue
    limitDefaultMs: 30 * 60 * 1000, // wait this long when a limit message gives no time
    limitBufferMs: 60 * 1000,   // extra wait after the time a limit message gives
    limitMaxMs: 12 * 60 * 60 * 1000,
    minImagePx: 400,            // smaller images (avatars, icons) are never counted or downloaded
    batchGapMs: 250,            // pause between chats in a batch archive or delete
  };

  // ChatGPT changes its page now and then; if the queue stops sending, these are the first thing to check.
  const SEL = {
    // tried in order; the first visible one wins (ChatGPT keeps a hidden textarea next to the real editor)
    input: ['div#prompt-textarea[contenteditable="true"]', '.ProseMirror[contenteditable="true"]', 'form [contenteditable="true"]', 'textarea#prompt-textarea', 'form textarea'],
    send: ['button[data-testid="send-button"]', 'button#composer-submit-button', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send"]'],
    stop: 'button[data-testid="stop-button"], button[aria-label^="Stop"]',
    // one block per prompt and its reply; its state reads "in_progress" until the reply is done (Nov 2026 layout)
    turn: '[data-talvt-turn-state]',
    oldTurn: '[data-message-author-role="assistant"]',  // the layout before that
    userBubble: '[data-user-message-bubble], [data-message-author-role="user"]',
    chat: 'nav a[href*="/c/"]',  // a chat in the sidebar
    chatRow: '[role="listitem"], li',
  };
  const BUSY_TEXT = /creating image|generating image|image creation in progress/i;
  const LIMIT_TEXT = /(hit|reached) (the|your|our) .*limit|rate limit|too many requests/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const visible = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const ours = (e) => panel.contains(e) || bar.contains(e);
  const first = (list) => { for (const s of list) for (const e of document.querySelectorAll(s)) if (visible(e) && !ours(e)) return e; return null; };
  const findInput = () => first(SEL.input);
  const findSend = () => first(SEL.send);
  const boxText = (box) => (box.isContentEditable ? box.innerText : box.value).trim();
  const turns = () => { const t = document.querySelectorAll(SEL.turn); return t.length ? t : document.querySelectorAll(SEL.oldTurn); };
  const lastTurn = () => { const t = turns(); return t[t.length - 1] || null; };
  const turnCount = () => turns().length;
  // the reply's own text, without the prompt that asked for it
  const replyText = (t) => { let s = t.innerText || ''; for (const u of t.querySelectorAll(SEL.userBubble)) s = s.replace(u.innerText, ''); return s; };
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // ---------- state (kept across reloads, but never auto-resumes) ----------
  const state = {
    queue: GM_getValue('queue', []),
    idx: GM_getValue('idx', 0),
    got: GM_getValue('got', []),  // queue positions whose images were already collected
    running: false,
    limitSeenAt: 0,               // turn count when the last limit message was handled
    note: '',
    bad: false,
  };
  if (GM_getValue('running', false)) state.note = 'Paused because the page reloaded. Press Start to continue.';
  const save = () => { GM_setValue('queue', state.queue); GM_setValue('idx', state.idx); GM_setValue('got', state.got); GM_setValue('running', state.running); };

  const settings = { download: true, png: true, prefix: '', autoResume: true, notify: true, ...GM_getValue('settings', {}) };
  const saveSettings = () => GM_setValue('settings', settings);
  let library = GM_getValue('library', []);  // [{ name, text }]
  const saveLibrary = () => GM_setValue('library', library);

  // One prompt per line; "1. " or "1) " numbering is removed.
  const parse = (text) => text.split('\n').map((l) => l.replace(/^\s*\d+[.)]\s+/, '').trim()).filter(Boolean);

  // ---------- daily counter ----------
  const today = () => new Date().toLocaleDateString('en-CA');
  function daily() {
    const d = GM_getValue('daily', null);
    return d && d.day === today() ? d : { day: today(), sent: 0, images: 0, seen: [], resetAt: 0 };
  }
  function updateDaily(fn) { const d = daily(); fn(d); GM_setValue('daily', d); renderToday(); }

  // ---------- page checks ----------
  function busy() {
    if ($(SEL.stop)) return true;
    const t = lastTurn();
    if (!t) return false;
    const st = t.getAttribute('data-talvt-turn-state');
    if (st && st !== 'complete') return true;
    if (BUSY_TEXT.test(replyText(t))) return true;
    return [...t.querySelectorAll('img')].some((img) => !img.complete);
  }
  // only a limit message that arrived after the last one we handled counts
  const limitHit = () => turnCount() > state.limitSeenAt && !!lastTurn() && LIMIT_TEXT.test(replyText(lastTurn()));
  // generated images only: pictures you attached to the prompt are left out
  const bigImages = (turn) => [...new Set([...turn.querySelectorAll('img')]
    .filter((i) => i.complete && i.naturalWidth >= CFG.minImagePx && !i.closest(SEL.userBubble)).map((i) => i.currentSrc || i.src))];

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(500); }
    return null;
  }

  // Finished = not busy for settleMs in a row. False if it never settles within maxWaitMs.
  async function waitIdle() {
    const start = Date.now();
    let calmSince = null;
    while (state.running) {
      const now = Date.now();
      if (busy()) calmSince = null; else if (calmSince === null) calmSince = now;
      if (calmSince !== null && now - calmSince >= CFG.settleMs) return true;
      if (now - start > CFG.maxWaitMs) return false;
      setStatus(calmSince === null ? 'Waiting for ChatGPT to finish…' : 'Making sure it has finished…');
      await sleep(1000);
    }
    return true;
  }

  // Put the text in the chat box. Tries typing, then pasting, then setting it directly, and checks each time.
  async function fill(box, text) {
    const want = text.slice(0, 40);
    const landed = () => boxText(box).includes(want);
    box.focus();
    if (box.isContentEditable) {
      const sel = window.getSelection(), range = document.createRange();
      range.selectNodeContents(box); sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('insertText', false, text);
      await sleep(300); if (landed()) return true;

      const dt = new DataTransfer(); dt.setData('text/plain', text);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await sleep(300); if (landed()) return true;

      const p = document.createElement('p'); p.textContent = text;
      box.replaceChildren(p);
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      await sleep(300); return landed();
    }
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300); return landed();
  }

  // Returns '' when sent, or what went wrong.
  async function sendPrompt(text) {
    const box = await waitFor(findInput, 15000);
    if (!box) return "Couldn't find the chat box.";
    if (!(await fill(box, text))) return "Found the chat box, but the text didn't go in.";
    const btn = await waitFor(() => { const b = findSend(); return b && !b.disabled ? b : null; }, 10000);
    if (btn) { btn.click(); return ''; }
    // no button found: press Enter in the box instead
    box.focus();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    await sleep(1500);
    return boxText(box).includes(text.slice(0, 40)) ? "Text is in the chat box, but the send button wasn't found." : '';
  }

  // ---------- downloads ----------
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-').slice(0, 40);
  // the extension is set when saving, from what the file really is
  const fileName = (i, k) => `${settings.prefix.replace(/[\\/:*?"<>|]+/g, '-')}${String(i + 1).padStart(3, '0')}-${slug(state.queue[i] || '') || 'image'}${k ? `-${k + 1}` : ''}`;
  const EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' };

  // Redraw an image as PNG. ChatGPT stores its images as WebP; the PNG has the same pixels, in a bigger file.
  async function toPng(blob) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    return new Promise((r, no) => c.toBlob((b) => (b ? r(b) : no(new Error('PNG failed'))), 'image/png'));
  }

  async function download(url, name) {
    // ChatGPT shows its images as blob: links that only the page can read, and its own fetch carries the sign-in
    try {
      let blob = await (await fetch(url, { credentials: 'include' })).blob();
      if (settings.png && blob.type !== 'image/png') blob = await toPng(blob);
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href; a.download = `${name}.${EXT[blob.type] || 'png'}`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10000);
    } catch (_) {
      // the page can't read it (an image on another site): Tampermonkey fetches it instead
      try { GM_download({ url, name: `${name}.png`, saveAs: false, onerror: () => setStatus(`Couldn't download ${name}.`, true) }); }
      catch (__) { setStatus(`Couldn't download ${name}.`, true); }
    }
  }

  // After prompt i has finished, save the images in the last reply once.
  function collect(i) {
    if (i < 0 || state.got.includes(i)) return;
    state.got.push(i); save();
    const t = lastTurn();
    if (!t) return;
    countImages(t);
    if (settings.download) bigImages(t).forEach((src, k) => download(src, fileName(i, k)));
  }

  // ---------- limits ----------
  // "resets in 2 hours and 33 minutes", "try again in 45 minutes", "after 3:40 PM"
  function limitWait(text) {
    let ms = 0;
    for (const [, n, u] of text.matchAll(/(\d+)\s*(hour|hr|minute|min|second|sec)/gi)) ms += n * { h: 3600e3, m: 60e3, s: 1e3 }[u[0].toLowerCase()];
    if (!ms) {
      const m = text.match(/\b(\d{1,2}):(\d{2})\s*([AP]M)?/i);
      if (m) {
        const at = new Date();
        let h = +m[1];
        if (m[3]) h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0);
        at.setHours(h, +m[2], 0, 0);
        if (at <= Date.now()) at.setDate(at.getDate() + 1);
        ms = at - Date.now();
      }
    }
    return Math.min((ms || CFG.limitDefaultMs) + CFG.limitBufferMs, CFG.limitMaxMs);
  }

  async function countdown(until) {
    while (state.running && Date.now() < until) {
      setStatus(`Limit hit. Resuming in ${plural(Math.ceil((until - Date.now()) / 60000), 'min')} (around ${clock(until)}). Keep this tab open.`);
      await sleep(5000);
    }
    return state.running;
  }

  // ---------- the queue ----------
  async function run() {
    state.limitSeenAt = turnCount();  // a limit message already on the page is old news
    while (state.running) {
      const idle = await waitIdle();
      if (!state.running) return;
      if (!idle) return pause('The last reply took too long. Check the page, then press Start.');
      if (limitHit()) {
        state.limitSeenAt = turnCount();
        // the last prompt got the limit message instead of an image, so it goes again
        if (state.idx > 0) { state.idx--; state.got = state.got.filter((g) => g !== state.idx); save(); render(); }
        const until = Date.now() + limitWait(replyText(lastTurn()));
        updateDaily((d) => { d.resetAt = until; });
        if (!settings.autoResume) return pause(`ChatGPT says you hit a limit. Try again around ${clock(until)}.`);
        notify(`Limit hit. The queue resumes around ${clock(until)}.`);
        if (!(await countdown(until))) break;
        notify('Limit wait is over. Resuming the queue.');
        continue;
      }
      collect(state.idx - 1);
      if (state.idx >= state.queue.length) break;
      setStatus('Next prompt in a moment…');
      await sleep(CFG.gapMs);
      if (!state.running) return;

      const before = turnCount();
      const err = await sendPrompt(state.queue[state.idx]);
      if (err) return pause(`${err} Press Check and tell Claude what it says.`);
      state.idx++; save(); render();
      updateDaily((d) => { d.sent++; });
      setStatus(`Sent ${state.idx} of ${state.queue.length}. Waiting for the reply…`);
      await waitFor(() => !state.running || busy() || turnCount() > before, CFG.startWaitMs);
    }
    if (!state.running) return;
    state.running = false; save(); render();
    setStatus(`Done: ${plural(state.queue.length, 'prompt')} sent.`);
    notify(`Done: ${plural(state.queue.length, 'prompt')} sent.`);
  }

  function pause(msg, bad = true) {
    state.running = false; save(); render();
    setStatus(msg, bad);
    if (bad) notify(msg);
  }
  function notify(text) {
    if (!settings.notify) return;
    try { GM_notification({ title: 'Promptline', text, timeout: 10000, onclick: () => window.focus() }); }
    catch (_) { try { new Notification('Promptline', { body: text }); } catch (__) { /* notifications off */ } }
  }

  // Count every image ChatGPT finishes while this tab watches it being made, queued or not.
  // The queue also counts each reply it collects, so a fast image between two checks isn't missed.
  const liveTurns = new WeakSet();
  function countImages(t) {
    const fresh = bigImages(t).filter((s) => !daily().seen.includes(s));
    if (fresh.length) updateDaily((d) => { d.images += fresh.length; d.seen = [...d.seen, ...fresh].slice(-300); });
  }
  setInterval(() => {
    const t = lastTurn();
    if (!t) return;
    if (busy()) liveTurns.add(t);
    else if (liveTurns.has(t)) countImages(t);
  }, 2000);

  // ---------- panel: Faust's look (near-black cards, hairlines, bone primary, uppercase tags with a dot) ----------
  // Built without innerHTML and styled in JS, so ChatGPT's page rules don't block it.
  const C = {
    canvas: '#07090b', card: '#090b0c', raised: '#1a1d1e', divider: '#262727', border: '#363738', rule: '#696a68',
    strong: '#efefed', bone: '#e9e1dc', text: '#b3b0af', muted: '#8a8b8a', faint: '#565858', alert: '#f12614', positive: '#55bc82',
  };
  const SANS = '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
  const CARD_SHADOW = `inset 0 0 0 1px ${C.divider}, 0 1px 0 rgba(255,255,255,.02), 0 12px 32px rgba(0,0,0,.55)`;

  const el = (tag, style, text) => { const e = document.createElement(tag); Object.assign(e.style, style || {}); if (text) e.textContent = text; return e; };
  const hover = (e, on, off) => { e.addEventListener('mouseenter', () => !e.disabled && Object.assign(e.style, on)); e.addEventListener('mouseleave', () => Object.assign(e.style, off)); };
  const dim = (...bs) => { for (const b of bs) { b.style.opacity = b.disabled ? '.4' : '1'; b.style.cursor = b.disabled ? 'default' : 'pointer'; } };

  // buttons: 32px, 8px corners, hairline edge; the one primary action is bone
  function button(label, kind = 'plain') {
    const base = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: '30px', padding: '0 12px', boxSizing: 'border-box',
      width: 'auto', minWidth: '0', margin: '0', flex: 'none', textTransform: 'none', letterSpacing: 'normal', // ignore the page's own button styles
      borderRadius: '8px', cursor: 'pointer', whiteSpace: 'nowrap', font: `500 13px/1 ${SANS}`, transition: `border-color .15s ${EASE}, background .15s ${EASE}, color .15s ${EASE}`,
    };
    const look = {
      plain: { background: 'transparent', border: `1px solid ${C.border}`, color: C.strong },
      primary: { background: C.bone, border: `1px solid ${C.bone}`, color: C.canvas, boxShadow: '0 1px 3px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.5)' },
      ghost: { background: 'transparent', border: '1px solid transparent', color: C.muted, padding: '0 8px' },
      danger: { background: 'transparent', border: `1px solid ${C.alert}`, color: C.alert },
    }[kind];
    const b = el('button', { ...base, ...look }, label);
    b.type = 'button';
    if (kind === 'primary') hover(b, { background: C.strong, borderColor: C.strong }, { background: C.bone, borderColor: C.bone });
    else if (kind === 'ghost') hover(b, { color: C.strong, borderColor: C.border }, { color: b.active ? C.strong : C.muted, borderColor: 'transparent' });
    else if (kind === 'danger') hover(b, { background: 'rgba(241,38,20,.1)' }, { background: 'transparent' });
    else hover(b, { borderColor: C.rule, background: 'rgba(255,255,255,.03)' }, { borderColor: C.border, background: 'transparent' });
    return b;
  }
  // "tag with dot": uppercase label, wide tracking, a small dot, no box
  function tag(text, dot = C.bone, color = C.muted) {
    const t = el('span', { display: 'inline-flex', alignItems: 'center', gap: '7px', font: `600 11px/1 ${SANS}`, letterSpacing: '.1em', textTransform: 'uppercase', color });
    const d = el('i', { width: '6px', height: '6px', borderRadius: '50%', background: dot, flex: 'none', display: 'inline-block' });
    t.append(d, document.createTextNode(text));
    t.dot = d;
    return t;
  }
  const pulse = (e) => e.animate([{ opacity: 1 }, { opacity: .25 }, { opacity: 1 }], { duration: 1600, iterations: Infinity, easing: 'ease-in-out' });
  const fieldStyle = {
    width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: '8px', border: `1px solid ${C.border}`,
    background: C.raised, color: C.strong, font: `400 12px/1.55 ${MONO}`, outline: 'none', transition: `border-color .15s ${EASE}`,
  };
  function field(tagName, placeholder, style) {
    const f = el(tagName, { ...fieldStyle, ...style });
    f.placeholder = placeholder;
    f.addEventListener('focus', () => { f.style.borderColor = C.rule; });
    f.addEventListener('blur', () => { f.style.borderColor = C.border; });
    // typing in our fields must not reach ChatGPT's own shortcuts
    f.addEventListener('keydown', (e) => e.stopPropagation());
    return f;
  }

  // the launcher: a quiet button with the progress in it
  const toggle = button('', 'plain');
  Object.assign(toggle.style, { position: 'fixed', right: '16px', bottom: '96px', zIndex: 99999, gap: '8px', background: C.card, boxShadow: '0 4px 16px rgba(0,0,0,.45)' });
  hover(toggle, { borderColor: C.rule, background: C.raised }, { borderColor: C.border, background: C.card });
  const toggleTag = tag('Queue', C.bone, C.strong);
  const toggleCount = el('span', { font: `500 12px/1 ${MONO}`, color: C.muted });
  toggle.append(toggleTag, toggleCount);
  toggle.title = 'Promptline (Alt+Q)';

  const panel = el('div', {
    position: 'fixed', right: '16px', bottom: '138px', zIndex: 99999, width: '412px', maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box',
    padding: '20px', borderRadius: '8px', background: C.card, color: C.text, boxShadow: CARD_SHADOW, font: `400 13px/1.45 ${SANS}`, display: 'none',
  });

  // header: tag on the left, count pill on the right
  const header = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' });
  const headTag = tag('Promptline');
  const pill = el('span', { minWidth: '20px', padding: '2px 8px', borderRadius: '9999px', background: 'rgba(255,255,255,.05)', font: `500 11px/1.4 ${MONO}`, color: C.muted, textAlign: 'center' });
  header.append(headTag, pill);

  // today's numbers, under the header
  const todayLine = el('div', { font: `500 11px/1.4 ${MONO}`, color: C.faint, marginBottom: '12px' });

  // tabs
  const tabs = el('div', { display: 'flex', gap: '2px', alignItems: 'center', margin: '0 -8px 14px', borderBottom: `1px solid ${C.divider}`, paddingBottom: '8px' });
  const tabBtns = { queue: button('Queue', 'ghost'), library: button('Library', 'ghost'), settings: button('Settings', 'ghost') };
  const bSelect = button('Select chats', 'ghost');
  bSelect.title = 'Pick chats in the sidebar to archive or delete (Alt+X)';
  tabs.append(tabBtns.queue, tabBtns.library, tabBtns.settings, el('span', { flex: '1' }), bSelect);
  let tab = 'queue';

  // edit view: paste prompts, see how many were found
  const editView = el('div');
  const area = field('textarea', 'Paste prompts, one per line.\n1. A single red rose…\n2. Three pastel eggs…', { height: '150px', resize: 'vertical', padding: '10px 12px' });
  const found = el('div', { margin: '8px 0 14px', fontSize: '12px', color: C.muted });
  const editRow = el('div', { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
  const bCancel = button('Cancel', 'ghost');
  const bLoad = button('Load prompts', 'primary');
  editRow.append(bCancel, bLoad);
  editView.append(area, found, editRow);

  // queue view: each prompt is its own card, spaced apart
  const queueView = el('div');
  const list = el('ol', { listStyle: 'none', margin: '0 -4px 0 0', padding: '0 4px 0 0', display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '42vh', overflowY: 'auto' });
  const status = el('div', { margin: '14px 0', minHeight: '18px', fontSize: '12px', lineHeight: '1.4', color: C.muted });
  const row = el('div', { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' });
  const bStart = button('Start', 'primary');
  bStart.title = 'Start (Alt+S)';
  const bPause = button('Pause');
  bPause.title = 'Pause (Alt+S)';
  const bSkip = button('Skip');
  bSkip.title = 'Skip the next prompt';
  const bEdit = button('Edit', 'ghost');
  const bCheck = button('Check', 'ghost');
  bCheck.title = 'Show what the script can find on this page';
  const bClear = button('Clear', 'ghost');
  row.append(bStart, bPause, bSkip, el('span', { flex: '1' }), bEdit, bCheck, bClear);
  queueView.append(list, status, row);

  // library view: saved prompts to insert into the chat box or add to the queue
  const libView = el('div');
  const libTop = el('div', { display: 'flex', gap: '8px', marginBottom: '10px' });
  const libSearch = field('input', 'Search saved prompts (Enter inserts the first)', { flex: '1' });
  const bNewSnip = button('New');
  libTop.append(libSearch, bNewSnip);
  const libForm = el('div', { display: 'none', flexDirection: 'column', gap: '8px', padding: '12px', borderRadius: '8px', boxShadow: `inset 0 0 0 1px ${C.rule}`, marginBottom: '10px' });
  const snipName = field('input', 'Name, e.g. Realistic landscape style');
  const snipText = field('textarea', 'The prompt text. Several lines become several queue prompts.', { height: '90px', resize: 'vertical' });
  const libFormRow = el('div', { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
  const bSnipCancel = button('Cancel', 'ghost');
  const bSnipSave = button('Save', 'primary');
  libFormRow.append(bSnipCancel, bSnipSave);
  libForm.append(snipName, snipText, libFormRow);
  const libList = el('ol', { listStyle: 'none', margin: '0 -4px 0 0', padding: '0 4px 0 0', display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '42vh', overflowY: 'auto' });
  const libNote = el('div', { marginTop: '10px', minHeight: '18px', fontSize: '12px', color: C.muted });
  libView.append(libTop, libForm, libList, libNote);
  let snipEditing = -1;

  // settings view
  const setView = el('div', { display: 'flex', flexDirection: 'column', gap: '12px' });
  // drawn by hand: ChatGPT's page styles hide native checkboxes
  function checkRow(key, label, hint) {
    const r = el('div', { display: 'grid', gridTemplateColumns: '18px 1fr', gap: '2px 10px', cursor: 'pointer', alignItems: 'start' });
    r.setAttribute('role', 'checkbox'); r.tabIndex = 0;
    const box = el('span', {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '16px', height: '16px', marginTop: '2px', boxSizing: 'border-box',
      borderRadius: '4px', font: `700 11px/1 ${SANS}`, color: C.canvas, transition: `background .15s ${EASE}, border-color .15s ${EASE}`,
    });
    const paint = () => {
      const on = settings[key];
      box.textContent = on ? '✓' : '';
      box.style.background = on ? C.bone : 'transparent';
      box.style.border = `1px solid ${on ? C.bone : C.rule}`;
      r.setAttribute('aria-checked', String(on));
    };
    const flip = () => { settings[key] = !settings[key]; saveSettings(); paint(); render(); };
    r.onclick = flip;
    r.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); flip(); } });
    paint();
    r.append(box, el('span', { color: C.strong }, label), el('span'), el('span', { fontSize: '12px', color: C.muted }, hint));
    return r;
  }
  const prefixLabel = el('div', { color: C.strong }, 'File name prefix');
  const prefixInput = field('input', 'e.g. cozy-  →  cozy-001-a-small-wooden-cabin.png');
  prefixInput.value = settings.prefix;
  prefixInput.oninput = () => { settings.prefix = prefixInput.value; saveSettings(); };
  const bTestNote = button('Test notification');
  bTestNote.onclick = () => { const was = settings.notify; settings.notify = true; notify('Notifications work.'); settings.notify = was; };
  const keys = el('div', { font: `400 12px/1.7 ${MONO}`, color: C.muted, whiteSpace: 'pre' },
    'Alt+Q  open or close this panel\nAlt+S  start or pause the queue\nAlt+X  select chats in the sidebar\nAlt+L  prompt library\nEsc    leave chat selection');
  const testRow = el('div', { display: 'flex' });
  testRow.append(bTestNote);
  setView.append(
    checkRow('download', 'Download images automatically', 'Each image is saved as soon as its prompt finishes, named by queue number and prompt.'),
    checkRow('png', 'Save as PNG', 'ChatGPT makes WebP images. On: each is converted to PNG, same pixels in a bigger file. Off: the original WebP is kept.'),
    prefixLabel, prefixInput,
    checkRow('autoResume', 'Wait out limits and resume', 'When ChatGPT says you hit a limit, wait until it resets, then send that prompt again.'),
    checkRow('notify', 'Desktop notifications', 'When the queue finishes, pauses, or waits on a limit.'),
    testRow, keys,
  );

  panel.append(header, todayLine, tabs, editView, queueView, libView, setView);

  // chat selection bar, along the top of the page
  const bar = el('div', {
    position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: 100000, display: 'none', alignItems: 'center', gap: '6px',
    flexWrap: 'wrap', maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', padding: '10px 12px', borderRadius: '8px',
    background: C.card, color: C.text, boxShadow: CARD_SHADOW, font: `400 13px/1.45 ${SANS}`,
  });
  const barTag = tag('Select chats', C.bone, C.strong);
  const barCount = el('span', { font: `500 12px/1 ${MONO}`, color: C.muted, margin: '0 6px' });
  const barFilter = field('input', 'Title contains…', { width: '150px', padding: '6px 10px' });
  const bMatch = button('Select matching', 'ghost');
  const bAll = button('All', 'ghost');
  const bNone = button('None', 'ghost');
  const bArchive = button('Archive');
  const bDelete = button('Delete', 'danger');
  const bDone = button('Done', 'primary');
  const barNote = el('span', { fontSize: '12px', color: C.muted, flexBasis: '100%', display: 'none' });
  bar.append(barTag, barCount, barFilter, bMatch, bAll, bNone, bArchive, bDelete, bDone, barNote);

  document.body.append(toggle, panel, bar);

  let editing = !state.queue.length;
  let pulseAnim = null;

  function setStatus(t, bad = false) { state.note = t; state.bad = bad; status.textContent = t; status.style.color = bad ? C.alert : C.muted; }

  function renderToday() {
    const d = daily();
    const reset = d.resetAt > Date.now() ? `  ·  limit resets ~${clock(d.resetAt)}` : '';
    todayLine.textContent = `Today  ${plural(d.sent, 'prompt')} sent  ·  ${plural(d.images, 'image')}${reset}`;
  }

  function card(text, i) {
    const sent = i < state.idx, next = i === state.idx, working = state.running && i === state.idx - 1;
    const li = el('li', {
      display: 'grid', gridTemplateColumns: '28px 1fr', gap: '4px 10px', padding: '12px 14px', borderRadius: '8px',
      background: next ? C.raised : C.card, boxShadow: `inset 0 0 0 1px ${next ? C.rule : C.divider}`,
      opacity: sent && !working ? '.55' : '1', transition: `opacity .2s ${EASE}, box-shadow .2s ${EASE}`,
    });
    const num = el('span', { gridRow: 'span 2', font: `500 12px/18px ${MONO}`, color: next ? C.strong : C.faint }, String(i + 1).padStart(2, '0'));
    const label = working ? tag('Generating', C.bone, C.strong)
      : sent ? tag(state.got.includes(i) && settings.download ? 'Saved' : 'Sent', C.positive)
      : next ? tag(state.running ? 'Up next' : 'Next', C.bone, C.strong)
      : tag('Queued', C.faint, C.faint);
    if (working) pulseAnim = pulse(label.dot);
    li.append(num, label, clampText(text, sent ? C.muted : C.text, 3));
    return li;
  }
  function clampText(text, color, lines) {
    const p = el('p', {
      margin: '0', color, fontSize: '13px', lineHeight: '1.5', overflowWrap: 'anywhere',
      display: '-webkit-box', WebkitLineClamp: String(lines), WebkitBoxOrient: 'vertical', overflow: 'hidden', cursor: 'pointer',
    }, text);
    p.title = 'Click to show or hide the whole text';
    p.onclick = () => { p.style.webkitLineClamp = p.style.webkitLineClamp === 'unset' ? String(lines) : 'unset'; };
    return p;
  }

  function render() {
    const n = state.queue.length;
    pill.textContent = n ? `${state.idx} / ${n}` : '0';
    toggleCount.textContent = n ? `${state.idx}/${n}` : '';
    toggleTag.dot.style.background = state.running ? C.positive : C.bone;

    for (const [k, b] of Object.entries(tabBtns)) { b.active = k === tab; b.style.color = b.active ? C.strong : C.muted; }
    bSelect.style.color = sel.on ? C.strong : C.muted;
    editView.style.display = tab === 'queue' && editing ? 'block' : 'none';
    queueView.style.display = tab === 'queue' && !editing ? 'block' : 'none';
    libView.style.display = tab === 'library' ? 'block' : 'none';
    setView.style.display = tab === 'settings' ? 'flex' : 'none';

    bCancel.style.display = n ? 'inline-flex' : 'none';
    const cnt = parse(area.value).length;
    found.textContent = cnt ? `${plural(cnt, 'prompt')} found` : 'One prompt per line. Numbers like "1." are removed.';
    bLoad.disabled = !cnt;

    if (pulseAnim) { pulseAnim.cancel(); pulseAnim = null; }
    list.replaceChildren(...state.queue.map(card));
    const cur = list.children[Math.min(state.idx, n - 1)];
    if (cur && panel.style.display !== 'none' && tab === 'queue') cur.scrollIntoView({ block: 'nearest' });

    bStart.textContent = state.running ? 'Running' : state.idx > 0 && state.idx < n ? 'Resume' : 'Start';
    bStart.disabled = state.running || state.idx >= n;
    bPause.disabled = !state.running;
    bSkip.disabled = state.running || state.idx >= n;
    bEdit.disabled = bClear.disabled = state.running;
    dim(bLoad, bStart, bPause, bSkip, bEdit, bClear);
    setStatus(state.note || (n && state.idx >= n ? `Done: ${plural(n, 'prompt')} sent.` : n ? 'Ready. Leave the chat box alone while it runs.' : ''), state.bad);
    renderToday();
    if (tab === 'library') renderLibrary();
  }

  function renderLibrary() {
    const q = libSearch.value.trim().toLowerCase();
    const shown = library.map((s, i) => [s, i]).filter(([s]) => !q || `${s.name} ${s.text}`.toLowerCase().includes(q));
    libList.replaceChildren(...shown.map(([s, i]) => {
      const li = el('li', { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 14px', borderRadius: '8px', boxShadow: `inset 0 0 0 1px ${C.divider}` });
      const acts = el('div', { display: 'flex', gap: '4px', flexWrap: 'wrap', margin: '2px -8px -4px' });
      const bIns = button('Insert', 'ghost'), bQ = button('Add to queue', 'ghost'), bEd = button('Edit', 'ghost'), bDel = button('Delete', 'ghost');
      bIns.title = 'Put it in the chat box';
      bIns.onclick = () => insertIntoChat(s.text);
      bQ.onclick = () => addToQueue(s.text);
      bEd.onclick = () => openSnipForm(i);
      bDel.onclick = () => { if (confirm(`Delete "${s.name}" from the library?`)) { library.splice(i, 1); saveLibrary(); renderLibrary(); } };
      acts.append(bIns, bQ, el('span', { flex: '1' }), bEd, bDel);
      li.append(el('div', { color: C.strong, fontWeight: '500' }, s.name), clampText(s.text, C.text, 2), acts);
      return li;
    }));
    if (!library.length) libNote.textContent = 'No saved prompts yet. Press New to add your favourite style lines and prompts.';
    else if (!shown.length) libNote.textContent = 'Nothing matches that search.';
    else if (!libNote.dataset.keep) libNote.textContent = '';
  }
  function libSay(t) { libNote.textContent = t; libNote.dataset.keep = '1'; setTimeout(() => { delete libNote.dataset.keep; }, 4000); }
  function openSnipForm(i) {
    snipEditing = i;
    snipName.value = i >= 0 ? library[i].name : '';
    snipText.value = i >= 0 ? library[i].text : '';
    libForm.style.display = 'flex';
    snipName.focus();
  }
  async function insertIntoChat(text) {
    const box = findInput();
    if (!box) return libSay("Couldn't find the chat box.");
    const cur = boxText(box);
    if (await fill(box, cur ? `${cur} ${text}` : text)) libSay('Inserted into the chat box.');
    else libSay("Found the chat box, but the text didn't go in.");
    box.focus();
  }
  function addToQueue(text) {
    const l = parse(text);
    if (!state.queue.length || state.idx >= state.queue.length) { state.queue = []; state.idx = 0; state.got = []; state.note = ''; }
    state.queue.push(...l); save();
    editing = false;
    libSay(`Added ${plural(l.length, 'prompt')} to the queue.`);
    render();
  }

  function openPanel(which) {
    if (which) tab = which;
    panel.style.display = 'block';
    render();
    if (tab === 'library') libSearch.focus();
  }
  function togglePanel() { if (panel.style.display === 'none') openPanel(); else panel.style.display = 'none'; }
  function startOrPause() { if (state.running) bPause.onclick(); else bStart.onclick(); }

  toggle.onclick = togglePanel;
  for (const [k, b] of Object.entries(tabBtns)) b.onclick = () => openPanel(k);
  area.addEventListener('input', render);
  bLoad.onclick = () => {
    const l = parse(area.value);
    if (!l.length) return;
    state.queue = l; state.idx = 0; state.got = []; state.note = ''; save();
    editing = false; render();
    setStatus(`Loaded ${plural(l.length, 'prompt')}. Press Start.`);
  };
  bCancel.onclick = () => { editing = false; render(); };
  bEdit.onclick = () => { if (state.running) return; area.value = state.queue.slice(state.idx).join('\n'); editing = true; render(); area.focus(); };
  bStart.onclick = () => {
    if (state.running || state.idx >= state.queue.length) return;
    state.running = true; save(); render();
    setStatus('Starting…');
    run().catch((e) => pause(`Stopped: ${e && e.message ? e.message : e}`));
  };
  bPause.onclick = () => pause('Paused. Press Resume to continue from the next prompt.', false);
  bSkip.onclick = () => { if (!state.running && state.idx < state.queue.length) { state.idx++; save(); state.note = ''; render(); } };
  bClear.onclick = () => { if (state.running) return; state.queue = []; state.idx = 0; state.got = []; state.note = ''; save(); area.value = ''; editing = true; render(); };
  // Reports what the script can see, so a broken selector is easy to spot.
  bCheck.onclick = () => {
    const box = findInput(), send = findSend();
    const all = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter((e) => !ours(e));
    const desc = (e) => e ? `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.isContentEditable ? ' (editable)' : ''}` : 'none';
    setStatus(`Chat box: ${desc(box)}. Send button: ${send ? (send.getAttribute('data-testid') || send.getAttribute('aria-label') || 'found') + (send.disabled ? ' (disabled)' : '') : 'none'}. Editors on page: ${all.map(desc).join(', ') || 'none'}. Sidebar chats: ${chatLinks().length}. Busy: ${busy() ? 'yes' : 'no'}.`);
  };

  libSearch.addEventListener('input', renderLibrary);
  libSearch.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = libSearch.value.trim().toLowerCase();
    const hit = library.find((s) => !q || `${s.name} ${s.text}`.toLowerCase().includes(q));
    if (hit) insertIntoChat(hit.text);
  });
  bNewSnip.onclick = () => openSnipForm(-1);
  bSnipCancel.onclick = () => { libForm.style.display = 'none'; };
  bSnipSave.onclick = () => {
    const name = snipName.value.trim(), text = snipText.value.trim();
    if (!text) return snipText.focus();
    const s = { name: name || text.slice(0, 40), text };
    if (snipEditing >= 0) library[snipEditing] = s; else library.unshift(s);
    saveLibrary(); libForm.style.display = 'none'; renderLibrary();
  };

  // ---------- chat selection: tick chats in the sidebar, then archive or delete them together ----------
  const sel = { on: false, ids: new Set(), last: null, busy: false };
  const chatId = (a) => ((a.getAttribute('href') || '').match(/\/c\/([\w-]+)/) || [])[1];
  const chatLinks = () => [...document.querySelectorAll(SEL.chat)].filter((a) => chatId(a) && visible(a) && !ours(a));

  function paintLink(a) {
    const on = sel.on && sel.ids.has(chatId(a));
    let box = a.querySelector(':scope > [data-iq-box]');
    if (sel.on && !box) {
      box = el('span', {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', width: '16px', height: '16px', marginRight: '8px',
        borderRadius: '4px', border: `1px solid ${C.rule}`, font: `700 11px/1 ${SANS}`, color: C.canvas, boxSizing: 'border-box',
      });
      box.dataset.iqBox = '1';
      a.prepend(box);
    }
    if (!sel.on) { if (box) box.remove(); a.style.boxShadow = ''; a.style.background = ''; return; }
    const mark = on ? '✓' : '';
    if (box.textContent !== mark) box.textContent = mark;  // only when it changes, or the observer loops
    box.style.background = on ? C.bone : 'transparent';
    box.style.borderColor = on ? C.bone : C.rule;
    a.style.boxShadow = on ? `inset 0 0 0 1px ${C.bone}` : '';
    a.style.background = on ? 'rgba(233,225,220,.08)' : '';
  }
  let paintQueued = false;
  function paintAll() {
    if (paintQueued) return;
    paintQueued = true;
    // a microtask, not requestAnimationFrame, which stalls while the tab is in the background
    queueMicrotask(() => { paintQueued = false; document.querySelectorAll(SEL.chat).forEach(paintLink); renderBar(); });
  }
  // the sidebar loads more chats as it scrolls, and React redraws links: tick boxes go on whatever appears
  // (changes inside our own panel and bar are ignored, or repainting the bar would wake it again forever)
  const watcher = new MutationObserver((recs) => { if (recs.some((r) => !ours(r.target))) paintAll(); });

  function setSelect(on) {
    sel.on = on;
    say('');
    if (!on) { sel.ids.clear(); sel.last = null; watcher.disconnect(); }
    else watcher.observe(document.body, { childList: true, subtree: true });
    bar.style.display = on ? 'flex' : 'none';
    document.querySelectorAll(SEL.chat).forEach(paintLink);
    renderBar(); render();
    if (on && !chatLinks().length) say('No chats found in the sidebar. Open the sidebar first.');
  }
  function say(t) { barNote.textContent = t; barNote.style.display = t ? 'block' : 'none'; }
  function renderBar() {
    if (!sel.on) return;
    const count = `${sel.ids.size} selected · ${chatLinks().length} loaded`;
    if (barCount.textContent !== count) barCount.textContent = count;
    bArchive.disabled = bDelete.disabled = !sel.ids.size || sel.busy;
    bAll.disabled = bNone.disabled = bMatch.disabled = bDone.disabled = sel.busy;
    dim(bArchive, bDelete, bAll, bNone, bMatch, bDone);
  }

  // in selection mode a click on a chat ticks it instead of opening it; Shift+click ticks a range
  document.addEventListener('click', (e) => {
    if (!sel.on || sel.busy) return;
    const a = e.target.closest && e.target.closest(SEL.chat);
    if (!a || ours(a)) return;
    e.preventDefault(); e.stopPropagation();
    const id = chatId(a), links = chatLinks().map(chatId);
    if (e.shiftKey && sel.last && links.includes(sel.last)) {
      const [i, j] = [links.indexOf(sel.last), links.indexOf(id)].sort((x, y) => x - y);
      links.slice(i, j + 1).forEach((x) => sel.ids.add(x));
    } else if (sel.ids.has(id)) sel.ids.delete(id);
    else sel.ids.add(id);
    sel.last = id;
    say('');
    paintAll();
  }, true);

  bSelect.onclick = () => setSelect(!sel.on);
  bDone.onclick = () => setSelect(false);
  bAll.onclick = () => { chatLinks().forEach((a) => sel.ids.add(chatId(a))); paintAll(); };
  bNone.onclick = () => { sel.ids.clear(); paintAll(); };
  bMatch.onclick = () => {
    const q = barFilter.value.trim().toLowerCase();
    if (!q) return barFilter.focus();
    const hits = chatLinks().filter((a) => a.innerText.toLowerCase().includes(q));
    hits.forEach((a) => sel.ids.add(chatId(a)));
    say(`${plural(hits.length, 'loaded chat')} match "${barFilter.value.trim()}". Scroll the sidebar to load older chats.`);
    paintAll();
  };
  barFilter.addEventListener('keydown', (e) => { if (e.key === 'Enter') bMatch.onclick(); });

  async function token() {
    const r = await fetch('/api/auth/session', { credentials: 'include' });
    const j = await r.json();
    if (!j.accessToken) throw new Error("couldn't read your ChatGPT sign-in");
    return j.accessToken;
  }
  // Archive and delete go through the same private endpoint ChatGPT's own menu uses.
  async function batch(kind) {
    const ids = [...sel.ids];
    if (!ids.length || sel.busy) return;
    const verb = kind === 'delete' ? 'Delete' : 'Archive';
    if (kind === 'delete' && !confirm(`Delete ${plural(ids.length, 'chat')}? Deleted chats can't be brought back. Archive keeps them under Settings → Archived chats.`)) return;
    sel.busy = true; renderBar();
    let ok = 0, fail = 0;
    try {
      const auth = await token();
      for (const id of ids) {
        say(`${verb === 'Delete' ? 'Deleting' : 'Archiving'} ${ok + fail + 1} of ${ids.length}…`);
        const r = await fetch(`/backend-api/conversation/${id}`, {
          method: 'PATCH', credentials: 'include',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
          body: JSON.stringify(kind === 'delete' ? { is_visible: false } : { is_archived: true }),
        });
        if (r.ok) {
          ok++; sel.ids.delete(id);
          document.querySelectorAll(SEL.chat).forEach((a) => { if (chatId(a) === id) (a.closest(SEL.chatRow) || a).style.display = 'none'; });
        } else fail++;
        await sleep(CFG.batchGapMs);
      }
      say(`${kind === 'delete' ? 'Deleted' : 'Archived'} ${plural(ok, 'chat')}${fail ? `; ${fail} failed (try again, or reload the page)` : ''}. Reload the page to refresh the sidebar.`);
    } catch (e) {
      say(`Stopped after ${plural(ok, 'chat')}: ${e && e.message ? e.message : e}.`);
    }
    sel.busy = false; paintAll();
    if (ids.length >= 10) notify(`${kind === 'delete' ? 'Deleted' : 'Archived'} ${plural(ok, 'chat')}.`);
  }
  bArchive.onclick = () => batch('archive');
  bDelete.onclick = () => batch('delete');

  // ---------- keyboard shortcuts ----------
  // Alt plus a letter, matched by key position so it also works where Alt types accented letters
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sel.on && !sel.busy) { setSelect(false); return; }
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const act = { KeyQ: togglePanel, KeyS: startOrPause, KeyX: () => !sel.busy && setSelect(!sel.on), KeyL: () => openPanel('library') }[e.code];
    if (!act) return;
    e.preventDefault(); e.stopPropagation();
    act();
  }, true);

  GM_setValue('running', false);
  render();
  setInterval(renderToday, 60000);
})();
