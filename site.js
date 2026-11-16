/* Rosia: the website. A conversation that plays itself, a face that follows it, and things that arrive as you scroll. */

// Where the Download buttons lead: straight to the installer in the newest release on GitHub, so a click downloads it
// rather than opening the releases page. Until GitHub has answered (or if it cannot be reached), the releases page.
const RELEASES = 'https://github.com/xorosiaxo/xorosiaxo.github.io/releases/latest';
const LATEST = 'https://api.github.com/repos/xorosiaxo/xorosiaxo.github.io/releases/latest';

const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (const a of $$('[data-download]')) a.href = RELEASES;

/**
 * The installer's own download address from the newest release (the .exe attached to it). GitHub is asked on every
 * visit, so a new release is what downloads straight away; the last answer is kept only for when GitHub cannot be
 * reached (it allows each visitor about 60 questions an hour).
 */
async function installerLink() {
  const saved = () => {
    try {
      return JSON.parse(localStorage.getItem('rosia.installer') || 'null')?.url || '';
    } catch {
      return '';
    }
  };
  try {
    const res = await fetch(LATEST, { headers: { accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!res.ok) return saved();
    const release = await res.json();
    const exe = (release.assets || []).find((a) => /setup.*\.exe$|\.exe$/i.test(a.name));
    if (!exe?.browser_download_url) return saved();
    try {
      localStorage.setItem('rosia.installer', JSON.stringify({ url: exe.browser_download_url, at: Date.now() }));
    } catch {
      /* private window: nothing to fall back on next time */
    }
    return exe.browser_download_url;
  } catch {
    return saved();
  }
}

installerLink().then((url) => {
  if (!url) return;
  for (const a of $$('[data-download]')) {
    a.href = url;
    a.setAttribute('download', '');
  }
});

/* After a click on Download: how to run the installer (as administrator), and what to do if Windows hesitates. */
const toast = $('#installToast');
for (const a of $$('[data-download]')) a.addEventListener('click', () => { toast.hidden = false; });
$('#installToastClose')?.addEventListener('click', () => { toast.hidden = true; });

/* "Try her now in your browser": the address is kept in try.json, so a new link is one small edit. While it is empty the
   buttons stay hidden and the page talks about the browser version as coming. */
async function tryLink() {
  let url = '';
  try {
    const res = await fetch('try.json', { cache: 'no-store' });
    if (res.ok) url = String((await res.json()).url || '').trim();
  } catch { /* no link today */ }
  if (!/^https:\/\//i.test(url)) return;
  for (const a of $$('[data-try]')) {
    a.href = url;
    a.hidden = false;
  }
  const note = $('[data-try-note]');
  if (note) note.textContent = 'Free on your own computer. Or meet her in your browser first, nothing to install.';
  const tag = $('[data-try-tag]');
  if (tag) tag.textContent = 'In your browser · try it now';
}
tryLink();

/* ---------- her face ---------- */

const faces = $$('#portrait .face');
function setMood(mood) {
  for (const f of faces) f.classList.toggle('on', f.dataset.mood === mood);
  for (const b of $$('[data-set-mood]')) b.setAttribute('aria-pressed', String(b.dataset.setMood === mood));
}

let handsOff = 0; // while someone is choosing her expression themselves, the conversation leaves her face alone
for (const b of $$('[data-set-mood]')) {
  b.addEventListener('click', () => {
    handsOff = Date.now() + 6000;
    setMood(b.dataset.setMood);
    $('#portrait').scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
  });
}

/* ---------- the conversation beside her ---------- */

const SCRIPT = [
  { who: 'day', text: 'Thursday' },
  { who: 'me', text: "driving test's tomorrow. i'm dead" },
  { who: 'her', text: "you've parallel parked in your head forty times, you're fine", mood: 'thinking' },
  { who: 'her', text: 'text me after', mood: 'winking' },
  { who: 'day', text: 'Saturday' },
  { who: 'her', text: 'so. did you pass or do i need to be nice to you', mood: 'happy', first: true },
  { who: 'me', text: 'passed. two minors' },
  { who: 'her', text: 'KNEW it', mood: 'surprised' },
  { who: 'her', text: "i'm claiming the first lift", mood: 'laughing' }
];

const thread = $('#demoThread');
const status = $('#demoStatus');

function bubble(who, html) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.innerHTML = html;
  thread.appendChild(el);
  while (thread.children.length > 6) thread.firstElementChild.remove();
  return el;
}

async function play() {
  if (calm) {
    // no motion: the conversation is simply there
    for (const line of SCRIPT.slice(4)) bubble(line.who, line.text);
    setMood('laughing');
    return;
  }
  for (;;) {
    thread.replaceChildren();
    for (const line of SCRIPT) {
      if (document.hidden) await wait(600);
      if (line.who === 'her') {
        status.textContent = 'typing';
        const el = bubble('her', '<span class="dots"><i></i><i></i><i></i></span>');
        await wait(Math.min(1700, 520 + line.text.length * 22));
        el.textContent = line.text;
        status.textContent = 'online';
        if (line.mood && Date.now() > handsOff) setMood(line.mood);
        await wait(1150);
      } else if (line.who === 'me') {
        await wait(700);
        bubble('me', line.text);
        await wait(850);
      } else {
        await wait(500);
        bubble('day', line.text);
        await wait(450);
      }
    }
    await wait(4200);
    if (Date.now() > handsOff) setMood('happy');
  }
}

/* ---------- arriving on scroll, counting up, the light under the pointer ---------- */

function reveal() {
  const items = $$('.reveal');
  if (calm || !('IntersectionObserver' in window)) {
    for (const el of items) el.classList.add('in');
    return;
  }
  const seen = new IntersectionObserver((entries) => {
    // things that come into view together arrive one after another
    entries.filter((e) => e.isIntersecting).forEach((e, i) => {
      e.target.style.setProperty('--d', `${Math.min(i, 5) * 70}ms`);
      e.target.classList.add('in');
      seen.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  for (const el of items) seen.observe(el);
  // what is on screen at load never waits for the observer; and if it never fires (a background tab), nothing stays hidden
  const inView = (el) => el.getBoundingClientRect().top < window.innerHeight;
  requestAnimationFrame(() => items.filter(inView).forEach((el, i) => {
    el.style.setProperty('--d', `${Math.min(i, 5) * 70}ms`);
    el.classList.add('in');
  }));
  setTimeout(() => items.filter(inView).forEach((el) => el.classList.add('in')), 1200);
}

function countUp() {
  const el = $('[data-count]');
  if (!el) return;
  const target = Number(el.dataset.count);
  const plus = el.hasAttribute('data-plus') ? '+' : '';
  const show = (n) => { el.textContent = `${Math.round(n).toLocaleString('en-GB')}${plus}`; };
  if (calm || !('IntersectionObserver' in window)) return show(target);
  show(0);
  const io = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    io.disconnect();
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 1400);
      show(target * (1 - (1 - p) ** 4));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, { threshold: 0.4 });
  io.observe(el);
}

for (const card of $$('[data-spot]')) {
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
}

const nav = $('#nav');
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

reveal();
countUp();
play();
