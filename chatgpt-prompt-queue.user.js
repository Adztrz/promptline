// ==UserScript==
// @name         Promptline
// @namespace    adztrz
// @license      MIT
// @version      3.4.0
// @description  Queue image prompts in ChatGPT, download each result, wait out limits, batch archive or delete chats, keep a prompt library with pictures, and send your last prompt again.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_download
// @grant        GM_addStyle
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
    waitUntil: 0,                 // while waiting out a limit: when the queue resumes
    runImages: 0,                 // images collected since Start, for the summary
    failedSaves: 0,               // downloads that failed since Start
    note: '',
    bad: false,
  };
  if (GM_getValue('running', false)) state.note = 'Paused because the page reloaded. Press Start to continue.';
  const save = () => { GM_setValue('queue', state.queue); GM_setValue('idx', state.idx); GM_setValue('got', state.got); GM_setValue('running', state.running); };

  const settings = { download: true, png: true, prefix: '', autoResume: true, notify: true, ...GM_getValue('settings', {}) };
  const saveSettings = () => GM_setValue('settings', settings);
  let library = GM_getValue('library', []);  // [{ name, text, media?: [ids] }]
  const saveLibrary = () => GM_setValue('library', library);
  // the last prompt sent, by you or by the queue, with its pictures: { text, media: [ids], at }
  let last = GM_getValue('last', null);

  // A queued prompt is its text, or { t: text, m: [media ids] } when pictures go with it.
  const qText = (q) => (typeof q === 'string' ? q : q.t);
  const qMedia = (q) => (typeof q === 'string' ? [] : q.m || []);
  const qItem = (t, m) => (m && m.length ? { t, m } : t);

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

  // ---------- pictures: kept with a saved prompt or the last prompt ----------
  // Tampermonkey's storage holds text, so the pictures themselves live in this site's IndexedDB, as Blobs keyed by id.
  const media = (() => {
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((ok, no) => {
      const r = indexedDB.open('promptline', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('media');
      r.onsuccess = () => ok(r.result); r.onerror = () => { dbp = null; no(r.error); };
    }));
    const run = async (mode, fn) => { const d = await db(); return new Promise((ok, no) => { const t = d.transaction('media', mode), r = fn(t.objectStore('media')); t.oncomplete = () => ok(r && r.result); t.onerror = () => no(t.error); }); };
    return {
      put: async (file) => { const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; await run('readwrite', (st) => st.put({ blob: file, name: file.name || 'picture.png', type: file.type || 'image/png' }, id)); return id; },
      get: (id) => run('readonly', (st) => st.get(id)),
      del: (id) => run('readwrite', (st) => st.delete(id)),
      keys: () => run('readonly', (st) => st.getAllKeys()),
    };
  })();
  const isPicture = (f) => /^image\//.test(f.type || '');
  const filesOf = async (ids) => { const out = []; for (const id of ids) { const m = await media.get(id).catch(() => null); if (m) out.push(new File([m.blob], m.name, { type: m.type })); } return out; };
  // pictures nothing points at any more (a deleted template, an old last prompt) are removed
  async function sweepMedia() {
    const used = new Set([...library.flatMap((x) => x.media || []), ...(last ? last.media : []), ...state.queue.flatMap(qMedia)]);
    try { for (const k of await media.keys()) if (!used.has(k)) await media.del(k); } catch (_) { /* storage blocked: nothing to tidy */ }
  }
  // the pictures waiting in the chat box: ChatGPT shows each as a small preview inside the composer
  const composer = (box) => (box && (box.closest('form') || box.parentElement?.parentElement)) || null;
  const attachedCount = (box) => { const f = composer(box); return f ? [...f.querySelectorAll('img')].filter((i) => !ours(i)).length : 0; };

  // Attach pictures the way you would: through ChatGPT's own file picker, or by pasting them if that doesn't take.
  // Returns '' when they're in, or what went wrong.
  async function attach(box, ids) {
    if (!ids.length) return '';
    const files = await filesOf(ids);
    if (!files.length) return 'The pictures saved with this prompt are gone.';
    const before = attachedCount(box), want = before + files.length;
    const pack = () => { const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f)); return dt; };
    const input = [...document.querySelectorAll('input[type="file"]')].find((i) => !ours(i) && (!i.accept || /image|\*/.test(i.accept)));
    if (input) { input.files = pack().files; input.dispatchEvent(new Event('change', { bubbles: true })); }
    if (input && (await waitFor(() => attachedCount(box) >= want, 6000))) return '';
    box.focus();
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: pack(), bubbles: true, cancelable: true }));
    if (await waitFor(() => attachedCount(box) >= want, 6000)) return '';
    return "Couldn't attach the pictures. Attach them by hand, or open More → Check page.";
  }

  // Returns '' when sent, or what went wrong. Pictures go in first, then the text.
  async function sendPrompt(text, ids = [], dontSend = false) {
    const box = await waitFor(findInput, 15000);
    if (!box) return "Couldn't find the chat box.";
    const bad = await attach(box, ids);
    if (bad) return bad;
    if (!(await fill(box, text))) return "Found the chat box, but the text didn't go in.";
    if (dontSend) return '';
    // the send button stays off while pictures upload
    const btn = await waitFor(() => { const b = findSend(); return b && !b.disabled ? b : null; }, ids.length ? 90000 : 10000);
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
  const fileName = (i, k) => `${settings.prefix.replace(/[\\/:*?"<>|]+/g, '-')}${String(i + 1).padStart(3, '0')}-${slug(qText(state.queue[i] || '')) || 'image'}${k ? `-${k + 1}` : ''}`;
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
      try { GM_download({ url, name: `${name}.png`, saveAs: false, onerror: () => saveFailed(name) }); }
      catch (__) { saveFailed(name); }
    }
  }

  // a failed save is counted for the end-of-run summary, so the message isn't lost under the next status
  function saveFailed(name) { state.failedSaves++; setStatus(`Couldn't save ${name}. The queue carries on; the summary will count it.`, true); }

  // After prompt i has finished, save the images in the last reply once.
  function collect(i) {
    if (i < 0 || state.got.includes(i)) return;
    state.got.push(i); save();
    const t = lastTurn();
    if (!t) return;
    countImages(t);
    const imgs = bigImages(t);
    state.runImages += imgs.length;
    if (settings.download) imgs.forEach((src, k) => download(src, fileName(i, k)));
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

  // the wait itself is drawn by the panel's limit banner and the launcher, ticking every second
  async function countdown(until) {
    state.waitUntil = until; render();
    setStatus('Waiting out ChatGPT\'s limit. Keep this tab open; the queue sends that prompt again by itself.');
    while (state.running && Date.now() < until) { renderWait(); await sleep(1000); }
    state.waitUntil = 0; render();
    return state.running;
  }

  // ---------- the queue ----------
  async function run() {
    state.limitSeenAt = turnCount();  // a limit message already on the page is old news
    state.runImages = 0; state.failedSaves = 0;
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
      const q = state.queue[state.idx];
      const err = await sendPrompt(qText(q), qMedia(q));
      if (err) return pause(`${err} Open More → Check page to see what the script can find.`);
      setLast(qText(q), qMedia(q));
      state.idx++; save(); render();
      updateDaily((d) => { d.sent++; });
      setStatus(`Sent ${state.idx} of ${state.queue.length}. Waiting for the reply…`);
      await waitFor(() => !state.running || busy() || turnCount() > before, CFG.startWaitMs);
    }
    if (!state.running) return;
    state.running = false; save(); render();
    const summary = doneSummary();
    setStatus(summary, state.failedSaves > 0);
    notify(summary);
  }

  function doneSummary() {
    const imgs = state.runImages ? ` · ${plural(state.runImages, 'image')}${settings.download ? ' saved' : ''}` : '';
    const failed = state.failedSaves ? ` · ${state.failedSaves} couldn't be saved` : '';
    return `Done: ${plural(state.queue.length, 'prompt')} sent${imgs}${failed}.`;
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
    // faint is the quietest text that still reads: 4.6:1 on the card
    strong: '#efefed', bone: '#e9e1dc', text: '#b3b0af', muted: '#8a8b8a', faint: '#7a7b7a', alert: '#f12614', positive: '#55bc82',
  };
  const SANS = '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
  const CARD_SHADOW = `inset 0 0 0 1px ${C.divider}, 0 1px 0 rgba(255,255,255,.02), 0 12px 32px rgba(0,0,0,.55)`;
  const H = '32px';  // one control height for buttons and single-line fields

  // What inline styles can't reach: placeholders, focus rings, scrollbars, selection, the narrow-window layout.
  const CSS = `
      .pl-root { color-scheme: dark; }
      .pl-root ::placeholder { color: ${C.muted}; opacity: 1; }
      .pl-root ::selection { background: rgba(233,225,220,.28); color: ${C.strong}; }
      .pl-root * { scrollbar-width: thin; scrollbar-color: ${C.border} transparent; }
      .pl-root :focus { outline: none; }
      .pl-root :focus-visible { outline: 2px solid ${C.bone}; outline-offset: 2px; }
      .pl-root input:focus-visible, .pl-root textarea:focus-visible { outline-offset: 0; border-color: ${C.rule} !important; }
      @media (max-width: 520px) {
        .pl-panel { left: 8px !important; right: 8px !important; width: auto !important; max-width: none !important; }
        .pl-bar { top: 8px !important; }
      }`;
  try { GM_addStyle(CSS); } catch (_) {
    try { const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; }
    catch (__) { /* everything still works, with default placeholders and focus rings */ }
  }

  const el = (tag, style, text) => { const e = document.createElement(tag); Object.assign(e.style, style || {}); if (text) e.textContent = text; return e; };
  const hover = (e, on, off) => { e.addEventListener('mouseenter', () => !e.disabled && Object.assign(e.style, on)); e.addEventListener('mouseleave', () => Object.assign(e.style, typeof off === 'function' ? off() : off)); };
  const dim = (...bs) => { for (const b of bs) { b.style.opacity = b.disabled ? '.4' : '1'; b.style.cursor = b.disabled ? 'default' : 'pointer'; } };

  // small line icons, drawn node by node like the logo
  const NS = 'http://www.w3.org/2000/svg';
  function icon(d, px = 16, stroke = 'currentColor', width = 1.8) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', px); svg.setAttribute('height', px);
    svg.setAttribute('aria-hidden', 'true');
    Object.assign(svg.style, { display: 'block', flex: 'none' });
    for (const part of [].concat(d)) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', part); p.setAttribute('fill', 'none'); p.setAttribute('stroke', stroke);
      p.setAttribute('stroke-width', width); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
      svg.append(p);
    }
    return svg;
  }
  const ICON = {
    check: 'M5 12.5l4.2 4.2L19 7',
    more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
    select: ['M4 6.5l1.8 1.8L9 5', 'M4 13.5l1.8 1.8L9 12', 'M12.5 7h7.5', 'M12.5 14h7.5', 'M4 19.5h16'],
  };

  // buttons: one height, 8px corners, hairline edge; the one primary action is bone
  function button(label, kind = 'plain') {
    const base = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: H, padding: '0 12px', boxSizing: 'border-box',
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
    else if (kind === 'ghost') hover(b, { color: C.strong, borderColor: C.border }, () => ({ color: b.active ? C.strong : C.muted, borderColor: 'transparent' }));
    else if (kind === 'danger') hover(b, { background: 'rgba(241,38,20,.1)' }, { background: 'transparent' });
    else hover(b, { borderColor: C.rule, background: 'rgba(255,255,255,.03)' }, { borderColor: C.border, background: 'transparent' });
    return b;
  }
  function iconButton(d, label, stroke = 1.8) {
    const b = button('', 'ghost');
    Object.assign(b.style, { width: H, padding: '0' });
    b.append(icon(d, 18, 'currentColor', stroke));
    b.setAttribute('aria-label', label); b.title = label;
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
    width: '100%', boxSizing: 'border-box', padding: '0 12px', height: H, borderRadius: '8px', border: `1px solid ${C.border}`,
    background: C.raised, color: C.strong, font: `400 12px/1.55 ${MONO}`, transition: `border-color .15s ${EASE}`,
  };
  function field(tagName, placeholder, label, style) {
    const f = el(tagName, { ...fieldStyle, ...(tagName === 'textarea' ? { height: 'auto', padding: '10px 12px' } : {}), ...style });
    f.placeholder = placeholder;
    f.setAttribute('aria-label', label);
    // typing in our fields must not reach ChatGPT's own shortcuts
    f.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
    return f;
  }
  // a tick box drawn by hand: ChatGPT's page styles hide native checkboxes
  function tickBox() {
    const box = el('span', {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', width: '18px', height: '18px', boxSizing: 'border-box',
      borderRadius: '5px', border: `1px solid ${C.rule}`, color: C.canvas, transition: `background .15s ${EASE}, border-color .15s ${EASE}`,
    });
    const mark = icon(ICON.check, 14, 'currentColor', 2.6);
    box.append(mark);
    box.set = (on) => {
      mark.style.visibility = on ? 'visible' : 'hidden';
      box.style.background = on ? C.bone : 'transparent';
      box.style.borderColor = on ? C.bone : C.rule;
    };
    return box;
  }
  // a keyboard key, for the shortcut list
  const kbd = (k) => el('kbd', {
    display: 'inline-block', minWidth: '20px', padding: '3px 6px', borderRadius: '5px', boxSizing: 'border-box', textAlign: 'center',
    background: C.raised, boxShadow: `inset 0 0 0 1px ${C.border}, 0 1px 0 ${C.border}`, font: `500 11px/1.2 ${MONO}`, color: C.strong,
  }, k);

  // the logo (same drawing as icon.svg): a stack of image cards with a play badge
  function logo(px) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 128 128');
    svg.setAttribute('width', px); svg.setAttribute('height', px);
    svg.setAttribute('aria-hidden', 'true');
    svg.style.display = 'block'; svg.style.flex = 'none';
    const add = (tagName, attrs) => { const e = document.createElementNS(NS, tagName); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.append(e); return e; };
    add('rect', { width: 128, height: 128, rx: 28, fill: C.canvas });
    add('rect', { x: 42, y: 18, width: 64, height: 50, rx: 10, fill: C.raised, stroke: '#565858', 'stroke-width': 3 });
    add('rect', { x: 31, y: 29, width: 66, height: 52, rx: 10, fill: C.raised, stroke: C.muted, 'stroke-width': 3 });
    add('rect', { x: 18, y: 42, width: 72, height: 58, rx: 11, fill: C.bone });
    add('circle', { cx: 68, cy: 58, r: 7, fill: C.canvas });
    add('path', { d: 'M26 92 L46 66 L58 80 L66 72 L82 92 Z', fill: C.canvas });
    svg.badge = add('circle', { cx: 96, cy: 96, r: 20, fill: C.positive, stroke: C.canvas, 'stroke-width': 5 });
    add('path', { d: 'M90 85 L105 96 L90 107 Z', fill: C.canvas });
    return svg;
  }
  // 1:05:09, 4:07, 0:42
  const hms = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  };

  // the launcher: the logo, with the progress (or the limit countdown) beside it
  const toggle = button('', 'plain');
  toggle.className = 'pl-root';
  Object.assign(toggle.style, { position: 'fixed', right: '16px', bottom: '96px', zIndex: 99999, gap: '8px', height: '36px', padding: '0 6px', background: C.card, boxShadow: '0 4px 16px rgba(0,0,0,.45)' });
  hover(toggle, { borderColor: C.rule, background: C.raised }, { borderColor: C.border, background: C.card });
  const toggleLogo = logo(24);
  const toggleCount = el('span', { font: `500 12px/1 ${MONO}`, color: C.muted, marginRight: '4px', fontVariantNumeric: 'tabular-nums' });
  toggle.append(toggleLogo, toggleCount);
  toggle.title = 'Promptline (Alt+Q)';
  toggle.setAttribute('aria-label', 'Promptline (Alt+Q)');
  toggle.setAttribute('aria-controls', 'pl-panel');
  let badgePulse = null;

  // The panel grows up from above the launcher, never taller than the window: header and tabs stay put, the body scrolls.
  const panel = el('div', {
    position: 'fixed', right: '16px', bottom: '138px', zIndex: 99999, width: '412px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 160px)',
    boxSizing: 'border-box', padding: '18px 20px 20px', borderRadius: '8px', background: C.card, color: C.text, boxShadow: CARD_SHADOW,
    font: `400 13px/1.45 ${SANS}`, display: 'none', flexDirection: 'column',
  });
  panel.id = 'pl-panel';
  panel.className = 'pl-root pl-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Promptline');

  // header: name, then progress, then the chat-selection mode switch
  const header = el('div', { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flex: 'none' });
  const headTag = tag('Promptline');
  const pill = el('span', { minWidth: '20px', padding: '2px 8px', borderRadius: '9999px', background: 'rgba(255,255,255,.05)', font: `500 11px/1.4 ${MONO}`, color: C.muted, textAlign: 'center', fontVariantNumeric: 'tabular-nums' });
  const bSelect = iconButton(ICON.select, 'Select chats to archive or delete (Alt+X)');
  header.append(headTag, el('span', { flex: '1' }), pill, bSelect);

  // today's numbers, under the header
  const todayLine = el('div', { font: `500 12px/1.4 ${MONO}`, color: C.faint, marginBottom: '10px', flex: 'none' });

  // tabs, with the active one underlined as well as brighter
  const tabs = el('div', { display: 'flex', gap: '2px', alignItems: 'center', margin: '0 -8px 14px', borderBottom: `1px solid ${C.divider}`, flex: 'none' });
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Promptline sections');
  const TABS = ['queue', 'library', 'settings'];
  const tabBtns = {};
  for (const k of TABS) {
    const b = button(k[0].toUpperCase() + k.slice(1), 'ghost');
    Object.assign(b.style, { borderRadius: '6px 6px 0 0', borderBottom: '2px solid transparent', marginBottom: '-1px', height: '34px' });
    b.setAttribute('role', 'tab'); b.id = `pl-tab-${k}`; b.setAttribute('aria-controls', `pl-view-${k}`);
    tabBtns[k] = b;
    tabs.append(b);
  }
  let tab = 'queue';

  // the scrolling body that holds whichever view is open
  const body = el('div', { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' });

  // limit banner: while the queue waits out a limit, this is the headline
  const waitBox = el('div', { display: 'none', flex: 'none', padding: '12px 14px', marginBottom: '12px', borderRadius: '8px', background: C.raised, boxShadow: `inset 0 0 0 1px ${C.rule}` });
  waitBox.setAttribute('role', 'timer');
  const waitTag = tag('Waiting out a limit', C.bone, C.strong);
  const waitClock = el('div', { font: `500 28px/1.1 ${MONO}`, color: C.strong, margin: '8px 0 4px', fontVariantNumeric: 'tabular-nums', letterSpacing: '-.02em' });
  const waitNote = el('div', { fontSize: '12px', color: C.text });
  waitBox.append(waitTag, waitClock, waitNote);

  // queue: edit view (paste prompts) or queue view (cards)
  const queueTab = el('div', { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' });
  queueTab.id = 'pl-view-queue'; queueTab.setAttribute('role', 'tabpanel'); queueTab.setAttribute('aria-labelledby', 'pl-tab-queue');
  const editView = el('div', { display: 'flex', flexDirection: 'column', minHeight: '0', overflowY: 'auto' });
  const undoStrip = el('div', { display: 'none', alignItems: 'center', gap: '8px', padding: '6px 6px 6px 12px', marginBottom: '10px', borderRadius: '8px', background: C.raised, fontSize: '12px', color: C.text });
  const undoText = el('span', { flex: '1' });
  const bUndo = button('Undo', 'plain');
  undoStrip.append(undoText, bUndo);
  const area = field('textarea', 'Paste prompts, one per line.\n1. A single red rose…\n2. Three pastel eggs…', 'Prompts, one per line', { height: '150px', resize: 'vertical', flex: 'none' });
  const found = el('div', { margin: '8px 0 14px', fontSize: '12px', color: C.muted });
  const editRow = el('div', { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
  const bCancel = button('Cancel', 'ghost');
  const bLoad = button('Load prompts', 'primary');
  editRow.append(bCancel, bLoad);
  editView.append(undoStrip, area, found, editRow);

  const queueView = el('div', { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' });
  const list = el('ol', { listStyle: 'none', margin: '0 -4px 0 0', padding: '0 4px 0 0', display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto', minHeight: '0', flex: '1' });
  list.setAttribute('aria-label', 'Queued prompts');
  const status = el('div', { margin: '12px 0', minHeight: '18px', fontSize: '12px', lineHeight: '1.45', color: C.muted, flex: 'none' });
  status.setAttribute('aria-live', 'polite');
  // one primary toggle (Start / Pause / Resume), Skip, and the rarely used rest behind More
  const row = el('div', { display: 'flex', gap: '6px', alignItems: 'center', flex: 'none', position: 'relative' });
  const bRun = button('Start', 'primary');
  bRun.title = 'Start or pause (Alt+S)';
  const bSkip = button('Skip');
  bSkip.title = 'Skip the next prompt';
  const bMore = iconButton(ICON.more, 'More queue actions', 3.2);
  bMore.setAttribute('aria-haspopup', 'menu'); bMore.setAttribute('aria-expanded', 'false');
  const menu = el('div', {
    display: 'none', position: 'absolute', right: '0', bottom: 'calc(100% + 6px)', zIndex: 1, minWidth: '190px', padding: '4px',
    borderRadius: '8px', background: C.raised, boxShadow: `inset 0 0 0 1px ${C.border}, 0 8px 24px rgba(0,0,0,.5)`, flexDirection: 'column',
  });
  menu.setAttribute('role', 'menu');
  const menuItem = (label, hint) => {
    const b = button(label, 'ghost');
    Object.assign(b.style, { justifyContent: 'flex-start', width: '100%', color: C.strong, height: '34px', padding: '0 10px' });
    b.setAttribute('role', 'menuitem');
    if (hint) b.title = hint;
    menu.append(b);
    return b;
  };
  const mEdit = menuItem('Edit queue', 'Change the prompts that haven\'t been sent');
  const mCheck = menuItem('Check page', 'Show what the script can find on this page, for when ChatGPT changes');
  const mClear = menuItem('Clear queue', 'Remove every prompt (you can undo)');
  mClear.style.color = C.alert;
  row.append(bRun, bSkip, el('span', { flex: '1' }), bMore, menu);
  queueView.append(list, status, row);
  queueTab.append(waitBox, editView, queueView);

  // library: saved prompts to insert into the chat box or add to the queue
  const libView = el('div', { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' });
  libView.id = 'pl-view-library'; libView.setAttribute('role', 'tabpanel'); libView.setAttribute('aria-labelledby', 'pl-tab-library');
  // the last prompt sent, ready to go again
  const lastBox = el('div', { display: 'none', flexDirection: 'column', gap: '8px', padding: '12px 14px', marginBottom: '12px', borderRadius: '8px', background: C.raised, boxShadow: `inset 0 0 0 1px ${C.border}`, flex: 'none' });
  lastBox.setAttribute('aria-label', 'Last prompt sent');
  const libTop = el('div', { display: 'flex', gap: '8px', marginBottom: '10px', flex: 'none' });
  const libSearch = field('input', 'Search saved prompts', 'Search saved prompts; Enter inserts the first match', { flex: '1' });
  const bNewSnip = button('New');
  libTop.append(libSearch, bNewSnip);
  const libForm = el('div', { display: 'none', flexDirection: 'column', gap: '8px', padding: '12px', borderRadius: '8px', boxShadow: `inset 0 0 0 1px ${C.rule}`, marginBottom: '10px', flex: 'none' });
  const snipName = field('input', 'Name, e.g. Realistic landscape style', 'Name');
  const snipText = field('textarea', 'The prompt text. Several lines become several queue prompts.', 'Prompt text', { height: '90px', resize: 'vertical' });
  // pictures that go with the prompt: added from a file, pasted, or dropped on the form
  const snipPics = el('div', { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' });
  const picInput = el('input', { display: 'none' });
  picInput.type = 'file'; picInput.accept = 'image/*'; picInput.multiple = true;
  const bAddPics = button('Add pictures', 'ghost');
  bAddPics.title = 'Pictures to attach with this prompt; you can also paste or drop them here';
  const libFormRow = el('div', { display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center' });
  const bSnipCancel = button('Cancel', 'ghost');
  const bSnipSave = button('Save', 'primary');
  libFormRow.append(bAddPics, picInput, el('span', { flex: '1' }), bSnipCancel, bSnipSave);
  libForm.append(snipName, snipText, snipPics, libFormRow);
  const libList = el('ol', { listStyle: 'none', margin: '0 -4px 0 0', padding: '0 4px 0 0', display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto', minHeight: '0', flex: '1' });
  const libNote = el('div', { marginTop: '10px', minHeight: '18px', fontSize: '12px', color: C.muted, flex: 'none' });
  libNote.setAttribute('aria-live', 'polite');
  libView.append(lastBox, libTop, libForm, libList, libNote);
  let snipEditing = -1;
  let snipMedia = [];  // the form's pictures: { id } already saved, or { file } just added

  // settings
  const setView = el('div', { flex: '1', minHeight: '0', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px', paddingRight: '4px' });
  setView.id = 'pl-view-settings'; setView.setAttribute('role', 'tabpanel'); setView.setAttribute('aria-labelledby', 'pl-tab-settings');
  function checkRow(key, label, hint) {
    const r = el('div', { display: 'grid', gridTemplateColumns: '18px 1fr', gap: '3px 12px', cursor: 'pointer', alignItems: 'start', borderRadius: '6px' });
    r.setAttribute('role', 'checkbox'); r.tabIndex = 0; r.setAttribute('aria-label', label);
    const box = tickBox();
    box.style.marginTop = '1px';
    const paint = () => { box.set(settings[key]); r.setAttribute('aria-checked', String(settings[key])); };
    const flip = () => { settings[key] = !settings[key]; saveSettings(); paint(); render(); };
    r.onclick = flip;
    r.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); flip(); } });
    paint();
    r.append(box, el('span', { color: C.strong }, label), el('span'), el('span', { fontSize: '12px', color: C.muted }, hint));
    return r;
  }
  const prefixGroup = el('div', { display: 'flex', flexDirection: 'column', gap: '6px' });
  const prefixInput = field('input', 'e.g. cozy-', 'File name prefix');
  prefixInput.id = 'pl-prefix';
  const prefixLabel = el('label', { color: C.strong }, 'File name prefix');
  prefixLabel.htmlFor = 'pl-prefix';
  const prefixHint = el('div', { fontSize: '12px', color: C.muted });
  const paintPrefix = () => { prefixHint.textContent = `Files are named like ${settings.prefix.replace(/[\\/:*?"<>|]+/g, '-')}001-a-small-wooden-cabin.${settings.png ? 'png' : 'webp'}`; };
  prefixInput.value = settings.prefix;
  prefixInput.oninput = () => { settings.prefix = prefixInput.value; saveSettings(); paintPrefix(); };
  prefixGroup.append(prefixLabel, prefixInput, prefixHint);
  const bTestNote = button('Send a test notification');
  bTestNote.onclick = () => { const was = settings.notify; settings.notify = true; notify('Notifications work.'); settings.notify = was; };
  const testRow = el('div', { display: 'flex' });
  testRow.append(bTestNote);
  const keysHead = el('div', { color: C.strong, marginTop: '4px' }, 'Keyboard shortcuts');
  const keys = el('div', { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 12px', alignItems: 'center', fontSize: '12px', color: C.text });
  for (const [k, what] of [[['Alt', 'Q'], 'Open or close this panel'], [['Alt', 'S'], 'Start or pause the queue'], [['Alt', 'X'], 'Select chats in the sidebar'], [['Alt', 'L'], 'Prompt library'], [['Alt', 'R'], 'Put your last prompt, with its pictures, back in the chat box'], [['Esc'], 'Close a menu, leave selection, or close the panel']]) {
    const combo = el('span', { display: 'inline-flex', gap: '4px', alignItems: 'center' });
    k.forEach((x, i) => { if (i) combo.append(el('span', { color: C.faint, fontSize: '11px' }, '+')); combo.append(kbd(x)); });
    keys.append(combo, el('span', {}, what));
  }
  setView.append(
    checkRow('download', 'Download images automatically', 'Each image is saved as soon as its prompt finishes, named by queue number and prompt.'),
    checkRow('png', 'Save as PNG', 'ChatGPT makes WebP images. On: each is converted to PNG, same pixels in a bigger file. Off: the original WebP is kept.'),
    prefixGroup,
    checkRow('autoResume', 'Wait out limits and resume', 'When ChatGPT says you hit a limit, wait until it resets, then send that prompt again.'),
    checkRow('notify', 'Desktop notifications', 'When the queue finishes, pauses, or waits on a limit.'),
    testRow, keysHead, keys,
  );

  body.append(queueTab, libView, setView);
  panel.append(header, todayLine, tabs, body);

  // chat selection bar, centred along the top of the page, wrapping by group rather than by button
  const bar = el('div', {
    position: 'fixed', top: '12px', left: '0', right: '0', margin: '0 auto', width: 'max-content', maxWidth: 'calc(100vw - 32px)',
    zIndex: 100000, display: 'none', flexDirection: 'column', gap: '6px', boxSizing: 'border-box',
    padding: '8px 10px 8px 14px', borderRadius: '10px', background: C.card, color: C.text, boxShadow: CARD_SHADOW, font: `400 13px/1.45 ${SANS}`,
  });
  bar.className = 'pl-root pl-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Select chats');
  const group = (...kids) => { const g = el('div', { display: 'flex', alignItems: 'center', gap: '4px' }); g.append(...kids); return g; };
  const barTag = tag('Select chats', C.bone, C.strong);
  const barCount = el('span', { font: `500 12px/1 ${MONO}`, color: C.muted, marginLeft: '8px', fontVariantNumeric: 'tabular-nums' });
  const barFilter = field('input', 'Title contains…', 'Select chats whose title contains', { width: '160px' });
  const bMatch = button('Select matching', 'ghost');
  const bAll = button('All', 'ghost');
  const bNone = button('None', 'ghost');
  const bArchive = button('Archive');
  const bDelete = button('Delete…', 'danger');
  const bStopBatch = button('Stop');
  bStopBatch.style.display = 'none';
  const bDone = button('Done', 'primary');
  // the hint sits under the controls and wraps to their width, so it never stretches the bar
  const barNote = el('div', { fontSize: '12px', color: C.muted, display: 'none', width: '0', minWidth: '100%' });
  barNote.setAttribute('aria-live', 'polite');
  const barRow = el('div', { display: 'flex', alignItems: 'center', columnGap: '14px', rowGap: '8px', flexWrap: 'wrap' });
  barRow.append(group(barTag, barCount), group(barFilter, bMatch), group(bAll, bNone), group(bArchive, bDelete, bStopBatch), group(bDone));
  bar.append(barRow, barNote);

  document.body.append(toggle, panel, bar);

  let editing = !state.queue.length;
  let pulseAnim = null;
  let shownIdx = -1;  // the card last scrolled into view, so a re-render doesn't yank the list

  function setStatus(t, bad = false) { state.note = t; state.bad = bad; status.textContent = t; status.style.color = bad ? C.alert : C.muted; }

  function renderToday() {
    const d = daily();
    const reset = d.resetAt > Date.now() ? `  ·  limit resets ~${clock(d.resetAt)}` : '';
    todayLine.textContent = `Today  ${plural(d.sent, 'prompt')} sent  ·  ${plural(d.images, 'image')}${reset}`;
  }
  function renderWait() {
    const left = state.waitUntil - Date.now();
    waitBox.style.display = state.waitUntil && state.running ? 'block' : 'none';
    if (!state.waitUntil) return;
    waitClock.textContent = hms(left);
    waitNote.textContent = `Prompt ${state.idx + 1} goes again around ${clock(state.waitUntil)}. Keep this tab open; Pause stops the wait.`;
    toggleCount.textContent = hms(left);
  }

  // The card being generated is the loudest; the next one is quiet but numbered brightly.
  function card(q, i) {
    const text = qText(q), pics = qMedia(q).length;
    const sent = i < state.idx, next = i === state.idx, working = state.running && !state.waitUntil && i === state.idx - 1;
    const li = el('li', {
      display: 'grid', gridTemplateColumns: '28px 1fr', gap: '4px 10px', padding: '12px 14px', borderRadius: '8px',
      background: working ? C.raised : C.card, boxShadow: `inset 0 0 0 1px ${working ? C.bone : C.divider}`,
      opacity: sent && !working ? '.6' : '1', transition: `opacity .2s ${EASE}, box-shadow .2s ${EASE}`,
    });
    const num = el('span', { gridRow: 'span 2', font: `500 12px/18px ${MONO}`, color: working || next ? C.strong : C.faint, fontVariantNumeric: 'tabular-nums' }, String(i + 1).padStart(2, '0'));
    const label = working ? tag('Generating', C.bone, C.strong)
      : sent ? tag(state.got.includes(i) && settings.download ? 'Saved' : 'Sent', C.positive)
      : next ? tag('Next', C.bone, C.text)
      : tag('Queued', C.faint, C.faint);
    if (working) pulseAnim = pulse(label.dot);
    li.append(num, label, clampText(text, sent ? C.muted : C.text, 3));
    if (pics) li.append(el('span'), el('span', { font: `500 11px/1.4 ${MONO}`, color: C.faint }, `+ ${plural(pics, 'picture')}`));
    return li;
  }
  // long text folds to a few lines; it opens by click or by keyboard
  function clampText(text, color, lines) {
    const p = el('p', {
      margin: '0', color, fontSize: '13px', lineHeight: '1.5', overflowWrap: 'anywhere', whiteSpace: 'pre-line', borderRadius: '4px',
      display: '-webkit-box', WebkitLineClamp: String(lines), WebkitBoxOrient: 'vertical', overflow: 'hidden', cursor: 'pointer',
    }, text);
    p.tabIndex = 0;
    p.setAttribute('role', 'button');
    p.setAttribute('aria-expanded', 'false');
    p.title = 'Show or hide the whole text';
    const flip = () => {
      const open = p.style.webkitLineClamp !== 'unset';
      p.style.webkitLineClamp = open ? 'unset' : String(lines);
      p.setAttribute('aria-expanded', String(open));
    };
    p.onclick = flip;
    p.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); flip(); } });
    return p;
  }

  function render() {
    const n = state.queue.length;
    const progress = n ? `${state.idx}/${n}` : '';
    pill.textContent = progress;
    pill.style.display = n ? 'inline-block' : 'none';
    toggleCount.textContent = progress;
    toggleCount.style.display = n ? 'inline' : 'none';
    toggle.setAttribute('aria-expanded', String(panel.style.display !== 'none'));
    // the play badge breathes while the queue runs
    if (state.running && !badgePulse) badgePulse = pulse(toggleLogo.badge);
    if (!state.running && badgePulse) { badgePulse.cancel(); badgePulse = null; }

    for (const k of TABS) {
      const b = tabBtns[k], on = k === tab;
      b.active = on;
      b.style.color = on ? C.strong : C.muted;
      b.style.borderBottomColor = on ? C.bone : 'transparent';
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    bSelect.style.color = sel.on ? C.strong : C.muted;
    bSelect.setAttribute('aria-pressed', String(sel.on));
    queueTab.style.display = tab === 'queue' ? 'flex' : 'none';
    editView.style.display = editing ? 'flex' : 'none';
    queueView.style.display = editing ? 'none' : 'flex';
    libView.style.display = tab === 'library' ? 'flex' : 'none';
    setView.style.display = tab === 'settings' ? 'flex' : 'none';

    bCancel.style.display = n ? 'inline-flex' : 'none';
    const cnt = parse(area.value).length;
    found.textContent = cnt ? `${plural(cnt, 'prompt')} found${n && state.idx < n ? ` · loading replaces the ${n - state.idx} not sent yet` : ''}` : 'One prompt per line. Numbers like "1." are removed.';
    bLoad.disabled = !cnt;

    if (pulseAnim) { pulseAnim.cancel(); pulseAnim = null; }
    list.replaceChildren(...state.queue.map(card));
    // bring the current card into view only when the position moves
    const focusIdx = Math.min(Math.max(state.idx - (state.running ? 1 : 0), 0), n - 1);
    if (focusIdx !== shownIdx && panel.style.display !== 'none' && tab === 'queue' && list.children[focusIdx]) {
      list.children[focusIdx].scrollIntoView({ block: 'nearest' });
      shownIdx = focusIdx;
    }

    const done = state.idx >= n;
    bRun.textContent = state.running ? 'Pause' : state.idx > 0 && !done ? 'Resume' : 'Start';
    bRun.disabled = !state.running && (done || !n);
    bSkip.disabled = state.running || done;
    mEdit.disabled = mClear.disabled = state.running || !n;
    dim(bLoad, bRun, bSkip, mEdit, mClear);
    setStatus(state.note || (n && done ? `Done: ${plural(n, 'prompt')} sent.` : n ? 'Ready. Leave the chat box alone while it runs.' : ''), state.bad);
    renderWait();
    renderToday();
    paintPrefix();
    if (tab === 'library') renderLibrary();
  }

  // small previews of saved pictures, made once per picture
  const thumbURL = new Map();
  async function thumbSrc(x) {
    if (x.file) return x.url || (x.url = URL.createObjectURL(x.file));
    if (!thumbURL.has(x.id)) { const m = await media.get(x.id).catch(() => null); thumbURL.set(x.id, m ? URL.createObjectURL(m.blob) : ''); }
    return thumbURL.get(x.id);
  }
  function thumbRow(items, onRemove) {
    const row = el('div', { display: 'flex', flexWrap: 'wrap', gap: '6px' });
    items.forEach((x, k) => {
      const it = typeof x === 'string' ? { id: x } : x;
      const t = el('span', { position: 'relative', width: '44px', height: '44px', borderRadius: '6px', overflow: 'hidden', background: C.canvas, boxShadow: `inset 0 0 0 1px ${C.border}`, flex: 'none' });
      const img = el('img', { width: '100%', height: '100%', objectFit: 'cover', display: 'block' });
      img.alt = '';
      thumbSrc(it).then((u) => { if (u) img.src = u; else t.title = 'This picture is gone'; });
      t.append(img);
      if (onRemove) {
        const x = el('button', { position: 'absolute', top: '2px', right: '2px', width: '18px', height: '18px', padding: '0', border: '0', borderRadius: '50%', background: 'rgba(7,9,11,.8)', color: C.strong, cursor: 'pointer', display: 'grid', placeItems: 'center' });
        x.type = 'button'; x.setAttribute('aria-label', `Remove picture ${k + 1}`); x.title = 'Remove';
        x.append(icon(['M7 7l10 10', 'M17 7L7 17'], 12, 'currentColor', 2.4));
        x.onclick = () => onRemove(k);
        t.append(x);
      }
      row.append(t);
    });
    return row;
  }
  function renderLast() {
    lastBox.style.display = last ? 'flex' : 'none';
    if (!last) return;
    const head = el('div', { display: 'flex', alignItems: 'center', gap: '8px' });
    head.append(tag('Last sent', C.positive, C.text), el('span', { flex: '1' }), el('span', { font: `500 11px/1 ${MONO}`, color: C.faint }, clock(last.at)));
    const bAgain = button('Send again'), bPut = button('Put in chat box', 'ghost'), bKeep = button('Save as template', 'ghost');
    bAgain.title = 'Send it again now, with its pictures';
    bPut.title = 'Put it in the chat box to change before sending (Alt+R)';
    bAgain.disabled = state.running; dim(bAgain);
    bAgain.onclick = () => repeatLast(true);
    bPut.onclick = () => repeatLast(false);
    bKeep.onclick = () => openSnipForm(-1, { name: '', text: last.text, media: last.media });
    const acts = el('div', { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '2px -8px -4px 0' });
    acts.append(bAgain, bPut, el('span', { flex: '1' }), bKeep);
    lastBox.replaceChildren(head, clampText(last.text || 'Pictures only', last.text ? C.text : C.muted, 2), ...(last.media.length ? [thumbRow(last.media)] : []), acts);
  }
  function renderSnipPics() {
    snipPics.replaceChildren(...(snipMedia.length ? [thumbRow(snipMedia, (k) => { snipMedia.splice(k, 1); renderSnipPics(); })] : []));
    snipPics.style.display = snipMedia.length ? 'flex' : 'none';
  }
  function renderLibrary() {
    renderLast();
    const q = libSearch.value.trim().toLowerCase();
    const shown = library.map((s, i) => [s, i]).filter(([s]) => !q || `${s.name} ${s.text}`.toLowerCase().includes(q));
    libList.replaceChildren(...shown.map(([s, i]) => {
      const li = el('li', { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 14px', borderRadius: '8px', boxShadow: `inset 0 0 0 1px ${C.divider}` });
      const lines = parse(s.text).length;
      const head = el('div', { display: 'flex', alignItems: 'baseline', gap: '8px' });
      head.append(el('span', { color: C.strong, fontWeight: '500', flex: '1', overflowWrap: 'anywhere' }, s.name));
      const pics = (s.media || []).length;
      if (lines > 1 || pics) head.append(el('span', { font: `500 11px/1 ${MONO}`, color: C.faint }, [lines > 1 && `${lines} prompts`, pics && plural(pics, 'picture')].filter(Boolean).join(' · ')));
      const acts = el('div', { display: 'flex', gap: '4px', flexWrap: 'wrap', margin: '2px -8px -4px' });
      const bIns = button('Insert', 'ghost'), bQ = button('Add to queue', 'ghost'), bEd = button('Edit', 'ghost'), bDel = button('Delete…', 'ghost');
      bIns.title = pics ? 'Put it in the chat box, with its pictures attached' : 'Put it in the chat box';
      bQ.title = pics ? 'Queue each line, each with these pictures attached' : 'Queue each line';
      bIns.onclick = () => insertIntoChat(s.text, s.media || []);
      bQ.onclick = () => addToQueue(s.text, s.media || []);
      bEd.onclick = () => openSnipForm(i);
      bDel.onclick = () => { if (confirm(`Delete "${s.name}" from the library? This can't be undone.`)) { library.splice(i, 1); saveLibrary(); renderLibrary(); sweepMedia(); } };
      acts.append(bIns, bQ, el('span', { flex: '1' }), bEd, bDel);
      li.append(head, ...(s.text ? [clampText(s.text, C.text, 2)] : []), ...(pics ? [thumbRow(s.media)] : []), acts);
      return li;
    }));
    const formOpen = libForm.style.display !== 'none';
    if (formOpen && !libNote.dataset.keep) libNote.textContent = '';
    else if (!library.length) libNote.textContent = 'No saved prompts yet. Press New to save a style line or a set of prompts you reuse.';
    else if (!shown.length) libNote.textContent = 'Nothing matches that search.';
    else if (!libNote.dataset.keep) libNote.textContent = '';
  }
  function libSay(t) { libNote.textContent = t; libNote.dataset.keep = '1'; setTimeout(() => { delete libNote.dataset.keep; }, 4000); }
  function openSnipForm(i, preset) {
    snipEditing = i;
    const from = preset || (i >= 0 ? library[i] : { name: '', text: '', media: [] });
    snipName.value = from.name || '';
    snipText.value = from.text || '';
    snipMedia = (from.media || []).map((id) => ({ id }));
    renderSnipPics();
    if (preset && tab !== 'library') openPanel('library');
    libForm.style.display = 'flex';
    renderLibrary();
    snipName.focus();
  }
  async function insertIntoChat(text, ids = []) {
    const box = findInput();
    if (!box) return libSay("Couldn't find the chat box.");
    if (ids.length) libSay('Attaching the pictures…');
    const bad = await attach(box, ids);
    if (bad) return libSay(bad);
    if (!text) { box.focus(); return libSay(`Attached ${plural(ids.length, 'picture')}.`); }
    const cur = boxText(box);
    if (await fill(box, cur ? `${cur} ${text}` : text)) libSay(ids.length ? `Inserted, with ${plural(ids.length, 'picture')}.` : 'Inserted into the chat box.');
    else libSay("Found the chat box, but the text didn't go in.");
    box.focus();
  }
  function addToQueue(text, ids = []) {
    const l = text ? parse(text) : [''];
    const fresh = !state.queue.length || state.idx >= state.queue.length;
    if (fresh) { state.queue = []; state.idx = 0; state.got = []; state.note = ''; }
    state.queue.push(...l.map((t) => qItem(t, ids))); save();
    editing = false;
    libSay(fresh ? `Started a new queue with ${plural(l.length, 'prompt')}.` : `Added ${plural(l.length, 'prompt')} to the end of the queue (now ${state.queue.length}).`);
    render();
  }

  // ---------- panel open, close, tabs, menu ----------
  function openPanel(which) {
    if (which) tab = which;
    if (sel.on && !sel.busy) setSelect(false);  // one thing at a time: the panel or chat selection
    panel.style.display = 'flex';
    shownIdx = -1;
    render();
    if (tab === 'library') libSearch.focus();
  }
  function closePanel() { closeMenu(); panel.style.display = 'none'; render(); }
  function togglePanel() { if (panel.style.display === 'none') openPanel(); else closePanel(); }
  function startOrPause() { bRun.onclick(); }
  function openMenu() { menu.style.display = 'flex'; bMore.setAttribute('aria-expanded', 'true'); const f = [...menu.children].find((b) => !b.disabled); if (f) f.focus(); }
  function closeMenu() { if (menu.style.display === 'none') return; menu.style.display = 'none'; bMore.setAttribute('aria-expanded', 'false'); }

  toggle.onclick = togglePanel;
  for (const k of TABS) tabBtns[k].onclick = () => openPanel(k);
  // arrow keys move between tabs, as tab lists do
  tabs.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    const next = TABS[(TABS.indexOf(tab) + d + TABS.length) % TABS.length];
    openPanel(next); tabBtns[next].focus();
  });
  bMore.onclick = (e) => { e.stopPropagation(); if (menu.style.display === 'none') openMenu(); else closeMenu(); };
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.children].filter((b) => !b.disabled);
    const d = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (d) { e.preventDefault(); e.stopPropagation(); items[(items.indexOf(document.activeElement) + d + items.length) % items.length].focus(); }
  });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target) && !bMore.contains(e.target)) closeMenu(); }, true);

  area.addEventListener('input', render);
  bLoad.onclick = () => {
    const l = parse(area.value);
    if (!l.length) return;
    state.queue = l.map((t) => qItem(t, editPics.get(t))); editPics = new Map(); state.idx = 0; state.got = []; state.note = ''; save();
    editing = false; undoStrip.style.display = 'none'; render();
    setStatus(`Loaded ${plural(l.length, 'prompt')}. Press Start.`);
  };
  bCancel.onclick = () => { editing = false; render(); };
  // pictures stay with a line as long as its text is unchanged
  let editPics = new Map();
  mEdit.onclick = () => {
    closeMenu(); if (state.running) return;
    const rest = state.queue.slice(state.idx);
    editPics = new Map(rest.filter((q) => qMedia(q).length).map((q) => [qText(q), qMedia(q)]));
    area.value = rest.map(qText).join('\n'); editing = true; render(); area.focus();
  };
  bRun.onclick = () => {
    if (state.running) return pause('Paused. Press Resume to continue from the next prompt.', false);
    if (state.idx >= state.queue.length) return;
    state.running = true; save(); render();
    setStatus('Starting…');
    run().catch((e) => pause(`Stopped: ${e && e.message ? e.message : e}`));
  };
  bSkip.onclick = () => { if (!state.running && state.idx < state.queue.length) { state.idx++; save(); state.note = ''; render(); } };
  // Clear can be undone for a little while: an unfinished batch is too easy to lose to one click
  let cleared = null, undoTimer = 0;
  mClear.onclick = () => {
    closeMenu();
    if (state.running || !state.queue.length) return;
    cleared = { queue: state.queue, idx: state.idx, got: state.got };
    state.queue = []; state.idx = 0; state.got = []; state.note = ''; save(); area.value = ''; editing = true;
    undoText.textContent = `Cleared ${plural(cleared.queue.length, 'prompt')}.`;
    undoStrip.style.display = 'flex';
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { undoStrip.style.display = 'none'; cleared = null; }, 10000);
    render(); bUndo.focus();
  };
  bUndo.onclick = () => {
    if (!cleared) return;
    Object.assign(state, cleared); save();
    cleared = null; undoStrip.style.display = 'none'; editing = false; state.note = '';
    render(); bRun.focus();
  };
  // Reports what the script can see, so a broken selector is easy to spot.
  mCheck.onclick = () => {
    closeMenu();
    const box = findInput(), send = findSend();
    const all = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter((e) => !ours(e));
    const desc = (e) => e ? `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.isContentEditable ? ' (editable)' : ''}` : 'none';
    setStatus(`Chat box: ${desc(box)}. Send button: ${send ? (send.getAttribute('data-testid') || send.getAttribute('aria-label') || 'found') + (send.disabled ? ' (disabled)' : '') : 'none'}. Editors on page: ${all.map(desc).join(', ') || 'none'}. Replies on page: ${turnCount()}. Sidebar chats: ${chatLinks().length}. Busy: ${busy() ? 'yes' : 'no'}.`);
  };

  libSearch.addEventListener('input', renderLibrary);
  libSearch.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = libSearch.value.trim().toLowerCase();
    const hit = library.find((s) => !q || `${s.name} ${s.text}`.toLowerCase().includes(q));
    if (hit) insertIntoChat(hit.text);
  });
  bNewSnip.onclick = () => openSnipForm(-1);
  bSnipCancel.onclick = () => { libForm.style.display = 'none'; snipMedia = []; renderLibrary(); };
  const addPics = (list) => { const f = [...(list || [])].filter(isPicture); if (!f.length) return false; snipMedia.push(...f.map((file) => ({ file }))); renderSnipPics(); return true; };
  bAddPics.onclick = () => picInput.click();
  picInput.onchange = () => { addPics(picInput.files); picInput.value = ''; };
  libForm.addEventListener('paste', (e) => { if (e.clipboardData && addPics(e.clipboardData.files)) e.preventDefault(); });
  libForm.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((x) => x.kind === 'file')) e.preventDefault(); });
  libForm.addEventListener('drop', (e) => { if (addPics(e.dataTransfer?.files)) e.preventDefault(); });
  bSnipSave.onclick = async () => {
    const name = snipName.value.trim(), text = snipText.value.trim();
    if (!text && !snipMedia.length) return snipText.focus();
    let ids;
    try { ids = []; for (const x of snipMedia) ids.push(x.id || (await media.put(x.file))); }
    catch (_) { return libSay("Couldn't store the pictures in this browser. Saved prompts with pictures need site storage allowed for chatgpt.com."); }
    const s = { name: name || (text ? text.split('\n')[0].slice(0, 40) : `${plural(ids.length, 'picture')}`), text, ...(ids.length ? { media: ids } : {}) };
    if (snipEditing >= 0) library[snipEditing] = s; else library.unshift(s);
    saveLibrary(); libForm.style.display = 'none'; snipMedia = []; sweepMedia();
    libSay(snipEditing >= 0 ? `Saved changes to "${s.name}".` : `Saved "${s.name}".`);
    renderLibrary();
  };

  // ---------- the last prompt: remembered on every send, sent again or put back in the chat box ----------
  function setLast(text, ids) {
    last = { text, media: ids, at: Date.now() };
    GM_setValue('last', last);
    sweepMedia();
    if (panel.style.display !== 'none' && tab === 'library') renderLast();
  }
  async function repeatLast(send) {
    const tell = (t) => { if (panel.style.display === 'none') openPanel('library'); libSay(t); };
    if (!last) return tell('Nothing sent yet. Send a prompt, and it shows up here.');
    if (state.running) return tell('The queue is running. Pause it first.');
    if (panel.style.display !== 'none') libSay(send ? 'Sending it again…' : 'Putting it in the chat box…');
    const err = await sendPrompt(last.text, last.media, !send);
    if (err) return tell(err);
    if (send) { updateDaily((d) => { d.sent++; }); setLast(last.text, last.media); libSay('Sent again.'); }
    else { findInput()?.focus(); if (panel.style.display !== 'none') libSay('In the chat box. Change it if you like, then send.'); }
  }
  // Pictures you attach by hand (picker, paste or drop) are noted until you send; then the text and the pictures
  // still in the chat box become the last prompt. Promptline's own attaching isn't a trusted event, so it isn't noted twice.
  let picked = [];
  const inChatBox = (t) => { const f = composer(findInput()); return !!(f && t && f.contains(t)); };
  const notePictures = (list) => { const f = [...(list || [])].filter(isPicture); if (f.length) picked.push(...f); };
  document.addEventListener('change', (e) => { const i = e.target; if (e.isTrusted && i && i.type === 'file' && !ours(i)) notePictures(i.files); }, true);
  document.addEventListener('paste', (e) => { if (e.isTrusted && inChatBox(e.target)) notePictures(e.clipboardData && e.clipboardData.files); }, true);
  document.addEventListener('drop', (e) => { if (e.isTrusted && inChatBox(e.target)) notePictures(e.dataTransfer && e.dataTransfer.files); }, true);
  function noteSend() {
    const box = findInput();
    if (!box || state.running) return;
    const text = boxText(box), shown = attachedCount(box);
    const pics = shown ? picked.slice(-shown) : [];  // one removed before sending isn't kept
    picked = [];
    if (!text && !pics.length) return;
    Promise.all(pics.map((f) => media.put(f))).then((ids) => setLast(text, ids), () => setLast(text, []));
  }
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || ours(e.target)) return;
    const b = e.target.closest && e.target.closest(SEL.send.join(', '));
    if (b && !b.disabled) noteSend();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.key !== 'Enter' || e.shiftKey || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    const box = findInput();
    if (box && box.contains(e.target)) noteSend();
  }, true);

  // ---------- chat selection: tick chats in the sidebar, then archive or delete them together ----------
  const sel = { on: false, ids: new Set(), last: null, busy: false, stop: false };
  const chatId = (a) => ((a.getAttribute('href') || '').match(/\/c\/([\w-]+)/) || [])[1];
  const chatLinks = () => [...document.querySelectorAll(SEL.chat)].filter((a) => chatId(a) && visible(a) && !ours(a));
  const chatTitle = (id) => { const a = chatLinks().find((x) => chatId(x) === id); return a ? (a.getAttribute('aria-label') || a.innerText).trim() : 'a chat not loaded in the sidebar'; };

  function paintLink(a) {
    const on = sel.on && sel.ids.has(chatId(a));
    let box = a.querySelector(':scope > [data-iq-box]');
    if (sel.on && !box) {
      box = tickBox();
      box.style.marginRight = '8px';
      box.dataset.iqBox = '1';
      box.setAttribute('role', 'checkbox');
      a.prepend(box);
    }
    if (!sel.on) { if (box) box.remove(); a.style.boxShadow = ''; a.style.background = ''; return; }
    // only touch what changed, or the sidebar watcher wakes itself forever
    if (box.getAttribute('aria-checked') !== String(on)) { box.set(on); box.setAttribute('aria-checked', String(on)); }
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
    else { watcher.observe(document.body, { childList: true, subtree: true }); if (panel.style.display !== 'none') closePanel(); }
    bar.style.display = on ? 'flex' : 'none';
    document.querySelectorAll(SEL.chat).forEach(paintLink);
    renderBar(); render();
    if (on) {
      if (!chatLinks().length) say('No chats found in the sidebar. Open the sidebar first.');
      else say('Click chats in the sidebar to tick them. Shift+click ticks a range.');
    }
  }
  function say(t, bad = false) { barNote.textContent = t; barNote.style.display = t ? 'block' : 'none'; barNote.style.color = bad ? C.alert : C.muted; }
  function renderBar() {
    if (!sel.on) return;
    const count = `${sel.ids.size} selected · ${chatLinks().length} loaded`;
    if (barCount.textContent !== count) barCount.textContent = count;
    bArchive.disabled = bDelete.disabled = !sel.ids.size || sel.busy;
    bAll.disabled = bNone.disabled = bMatch.disabled = bDone.disabled = sel.busy;
    bStopBatch.style.display = sel.busy ? 'inline-flex' : 'none';
    bArchive.style.display = bDelete.style.display = sel.busy ? 'none' : 'inline-flex';
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
  bAll.onclick = () => { chatLinks().forEach((a) => sel.ids.add(chatId(a))); say('All loaded chats ticked. Scroll the sidebar to load older ones.'); paintAll(); };
  bNone.onclick = () => { sel.ids.clear(); say(''); paintAll(); };
  bMatch.onclick = () => {
    const q = barFilter.value.trim().toLowerCase();
    if (!q) return barFilter.focus();
    const hits = chatLinks().filter((a) => a.innerText.toLowerCase().includes(q));
    hits.forEach((a) => sel.ids.add(chatId(a)));
    say(`${plural(hits.length, 'loaded chat')} match "${barFilter.value.trim()}". Scroll the sidebar to load older chats.`);
    paintAll();
  };
  barFilter.addEventListener('keydown', (e) => { if (e.key === 'Enter') bMatch.onclick(); });
  bStopBatch.onclick = () => { sel.stop = true; say('Stopping after this chat…'); };

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
    if (kind === 'delete') {
      const names = ids.slice(0, 5).map((id) => `  • ${chatTitle(id)}`).join('\n');
      const more = ids.length > 5 ? `\n  …and ${ids.length - 5} more` : '';
      if (!confirm(`Delete ${plural(ids.length, 'chat')} for good?\n\n${names}${more}\n\nDeleted chats can't be brought back. Archive keeps them under Settings → Archived chats.`)) return;
    }
    sel.busy = true; sel.stop = false; renderBar();
    let ok = 0;
    const failed = [];
    try {
      const auth = await token();
      for (const id of ids) {
        if (sel.stop) break;
        say(`${kind === 'delete' ? 'Deleting' : 'Archiving'} ${ok + failed.length + 1} of ${ids.length}…`);
        const r = await fetch(`/backend-api/conversation/${id}`, {
          method: 'PATCH', credentials: 'include',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
          body: JSON.stringify(kind === 'delete' ? { is_visible: false } : { is_archived: true }),
        });
        if (r.ok) {
          ok++; sel.ids.delete(id);
          document.querySelectorAll(SEL.chat).forEach((a) => { if (chatId(a) === id) (a.closest(SEL.chatRow) || a).style.display = 'none'; });
        } else failed.push(chatTitle(id));
        await sleep(CFG.batchGapMs);
      }
      const did = `${kind === 'delete' ? 'Deleted' : 'Archived'} ${plural(ok, 'chat')}`;
      const left = ids.length - ok - failed.length;
      say(`${did}${left ? `, stopped with ${left} left ticked` : ''}${failed.length ? `. Couldn't ${kind}: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''} (still ticked; try again)` : ''}. Reload the page to refresh the sidebar.`, failed.length > 0);
    } catch (e) {
      say(`Stopped after ${plural(ok, 'chat')}: ${e && e.message ? e.message : e}.`, true);
    }
    sel.busy = false; sel.stop = false; paintAll();
    if (ids.length >= 10) notify(`${kind === 'delete' ? 'Deleted' : 'Archived'} ${plural(ok, 'chat')}.`);
  }
  bArchive.onclick = () => batch('archive');
  bDelete.onclick = () => batch('delete');

  // ---------- keyboard shortcuts ----------
  // Alt plus a letter, matched by key position so it also works where Alt types accented letters
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (menu.style.display !== 'none') { e.stopPropagation(); closeMenu(); bMore.focus(); return; }
      if (sel.on && !sel.busy) { setSelect(false); return; }
      // Esc closes the panel only when you're working in it, so ChatGPT keeps its own Esc
      if (panel.style.display !== 'none' && panel.contains(document.activeElement)) { e.stopPropagation(); closePanel(); toggle.focus(); }
      return;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const act = { KeyQ: togglePanel, KeyS: startOrPause, KeyX: () => !sel.busy && setSelect(!sel.on), KeyL: () => openPanel('library'), KeyR: () => repeatLast(false) }[e.code];
    if (!act) return;
    e.preventDefault(); e.stopPropagation();
    act();
  }, true);

  GM_setValue('running', false);
  render();
  setInterval(renderToday, 60000);
})();
