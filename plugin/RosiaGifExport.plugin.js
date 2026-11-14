/**
 * @name RosiaGifExport
 * @author Rosia
 * @version 1.5.1
 * @description Keeps a folder (Rosia-GIFs in your user folder) filled with your Discord favourites, and adds a Videos tab next to GIFs for favouriting videos (kept as links for Rosia to send). Runs by itself in the background and only fetches what is new.
 * @website https://xorosiaxo.github.io
 * @source https://xorosiaxo.github.io/plugin/RosiaGifExport.plugin.js
 * @updateUrl https://xorosiaxo.github.io/plugin/RosiaGifExport.plugin.js
 */

/*
 * Why this exists: FavoriteMedia remembers each favourite as a link. Links to files uploaded to Discord carry a
 * signature that expires, so most of them stopped working. The Discord client itself can renew such a link (it does
 * it every time you scroll past an old attachment), so this plugin asks the client to do exactly that, then downloads
 * each file straight away, because a renewed link only lasts about a day.
 *
 * Background behaviour: 30 seconds after Discord starts it looks for favourites it has not saved yet and saves them,
 * then looks again every 6 hours while Discord stays open. A file that is already saved is never fetched again, a
 * favourite that could not be recovered is retried only every 2 weeks, and an interrupted run simply carries on the
 * next time. Switch the automatic run off in the plugin's settings if you would rather press the button yourself.
 *
 * It only reads your own favourites and only asks for links to files your account can already see. It is slow on
 * purpose (small batches, a pause between them) so it does not hammer Discord. This is a client modification:
 * Discord's terms do not allow those, so use it at your own discretion.
 *
 * Output (Rosia-GIFs (in your user folder)):
 *   gif-<id>-<name>.gif / .mp4 / .webp   the files
 *   index.json                           what each file is: { file, name, kind, key, source, width, height }
 *   failed.json                          what could not be recovered (deleted message, server left, ...) and when it was tried
 *   videos.json                          your favourite VIDEOS, as links only (nothing is downloaded): { url, name, label, addedAt }
 *
 * Videos: there is no video favourites in Discord, so this adds a "Videos" tab beside GIFs in the emoji/GIF picker. Paste a
 * link there, or right-click any message with a video and choose "Favourite this video for Rosia". Rosia checks that a
 * link still works before she sends it, and the person's own browser plays it. Links to files on Discord's servers expire
 * after about a day, so this plugin renews them in the background (every few hours while Discord is open).
 */

const START_DELAY_MS = 30 * 1000;
const RECHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const CLIP_START_MS = 45 * 1000; // the clips that ship with Rosia: first renewal shortly after Discord has loaded
const CLIP_EVERY_MS = 3 * 60 * 60 * 1000; // then every few hours (a renewed link lasts about a day)
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

module.exports = class RosiaGifExport {
  constructor(meta) {
    this.meta = meta;
    this.running = false;
    this.timers = [];
    this.listeners = new Set(); // status lines go to the settings panel when it is open
    this.lastStatus = 'Waiting to start.';
    this.settings = { auto: true, rosiaPort: 8787 };
  }

  /* ---------- starting and stopping ---------- */

  start() {
    this.settings = { ...this.settings, ...(this.load('settings') || {}) };
    this.stopped = false;
    try { this.startVideoUi(); } catch (err) { this.save('videoUiError', String(err?.message || err)); } // the GIF export never depends on this
    if (!this.settings.auto) {
      this.say('Automatic run is off. Press Export in this plugin\'s settings to run it.');
      return;
    }
    this.say('Will check for new favourites shortly after Discord has finished loading.');
    this.toast('Rosia GIFs is on. It will check your favourites in about 30 seconds.');
    this.timers.push(setTimeout(() => this.cycle().catch((err) => this.say(`Stopped: ${err?.message || err}`)), START_DELAY_MS));
    this.timers.push(setTimeout(() => this.relayClips(), CLIP_START_MS));
  }

  /* ---------- the clips that ship with Rosia: keep their Discord links working for the Rosia app on this computer ---------- */

  /*
   * Rosia ships a catalogue of clips as links, not files. A link to a file on Discord only works while its signature is
   * fresh (about a day), so this asks the Rosia app on this computer which links need renewing, has Discord renew them
   * the same way it renews favourites above, and hands the fresh links back. Nothing else is sent anywhere.
   */
  rosiaBase() {
    return `http://127.0.0.1:${Number(this.settings.rosiaPort) || 8787}`;
  }

  async rosiaAsk(pathname, body) {
    const url = `${this.rosiaBase()}${pathname}`;
    const options = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method: 'GET' };
    // BetterDiscord's own fetch runs outside Discord's page, so the page's rules about which addresses it may reach do not
    // stop it from talking to the Rosia app on this computer; the page's fetch is the fallback for older BetterDiscord
    const viaBd = typeof BdApi !== 'undefined' && BdApi.Net && typeof BdApi.Net.fetch === 'function';
    this.clipPath = viaBd ? 'BetterDiscord' : 'page';
    const res = await this.withTimeout(viaBd ? BdApi.Net.fetch(url, options) : fetch(url, options), 15000, 'the Rosia app');
    if (!res.ok) throw new Error(`the Rosia app answered ${res.status}`);
    return typeof res.json === 'function' ? res.json() : JSON.parse(await res.text());
  }

  async relayClips() {
    if (this.stopped) return;
    let kept = 0;
    try {
      const { links } = await this.rosiaAsk('/api/clips/stale?limit=2000');
      if (Array.isArray(links) && links.length) {
        await this.findRenewer(links);
        let fresh = [];
        for (let i = 0; i < links.length; i += 50) {
          if (this.stopped) return;
          const batch = links.slice(i, i + 50);
          const got = await this.renew(batch);
          for (const original of batch) {
            const refreshed = got.get(original) || got.get(this.pathOf(original));
            if (refreshed) fresh.push({ original, refreshed });
          }
          // handed over a few batches at a time, so a long run is useful even if it is interrupted
          if (fresh.length >= 200 || i + 50 >= links.length) {
            if (fresh.length) kept += (await this.rosiaAsk('/api/clips/fresh', { links: fresh })).kept || 0;
            fresh = [];
          }
          await new Promise((r) => setTimeout(r, 1500)); // gently: one request every second and a half
        }
      }
      this.clipNote = kept ? `Kept ${kept} of Rosia's clip links working.` : "Rosia's clip links are up to date.";
    } catch (err) {
      // the Rosia app is not running: nothing to do until next time
      this.clipNote = `Rosia's clip links not renewed: ${err?.message || err}`;
    }
    this.save('clips', { note: this.clipNote, via: this.clipPath || '', at: new Date().toISOString() });
    if (!this.stopped) this.timers.push(setTimeout(() => this.relayClips(), CLIP_EVERY_MS));
  }

  stop() {
    this.stopped = true;
    this.running = false;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    try { this.stopVideoUi(); } catch { /* already gone */ }
  }

  /** One background check, then the next one is booked. */
  async cycle() {
    if (this.stopped || !this.settings.auto) return;
    await this.run({ background: true });
    try { await this.refreshVideos(); } catch (err) { this.videoNote = `Video links not renewed: ${err?.message || err}`; }
    if (!this.stopped && this.settings.auto) this.timers.push(setTimeout(() => this.cycle().catch((err) => this.say(`Stopped: ${err?.message || err}`)), RECHECK_EVERY_MS));
  }

  say(text) {
    this.lastStatus = text;
    this.save('lastRun', { text, at: new Date().toISOString() }); // also readable in RosiaGifExport.config.json, to see what it last did
    for (const fn of this.listeners) { try { fn(text); } catch { /* the panel was closed */ } }
  }

  toast(text, type = 'info') {
    try {
      if (BdApi.UI && BdApi.UI.showToast) BdApi.UI.showToast(text, { type });
      else if (BdApi.showToast) BdApi.showToast(text, { type });
    } catch { /* no toast: the status line still has it */ }
  }

  load(key) {
    try { return BdApi.Data.load(this.meta.name, key); } catch { return null; }
  }

  save(key, value) {
    try { BdApi.Data.save(this.meta.name, key, value); } catch { /* settings just do not stick */ }
  }

  /* ---------- finding the pieces inside the Discord client ---------- */

  /** Every module in the client that looks like its web request module. More than one can match, so each is tried. */
  candidates() {
    const W = BdApi.Webpack || {};
    const looksLikeRest = (m) => m && typeof m.post === 'function' && typeof m.get === 'function' && (typeof m.getAPIBaseURL === 'function' || typeof m.del === 'function' || typeof m.patch === 'function');
    const list = [];
    const add = (m) => { if (looksLikeRest(m) && !list.includes(m)) list.push(m); };
    try { if (W.getByKeys) { add(W.getByKeys('getAPIBaseURL', 'post')); add(W.getByKeys('get', 'post', 'del', 'patch')); } } catch { /* not in this version */ }
    try { if (W.getModule) [].concat(W.getModule(looksLikeRest, { first: false, searchExports: true }) || []).forEach(add); } catch { /* not in this version */ }
    try { if (BdApi.findModuleByProps) add(BdApi.findModuleByProps('getAPIBaseURL', 'post')); } catch { /* old API */ }
    return list;
  }

  api() {
    return this.candidates()[0] || null;
  }

  folderOfPlugins() {
    const path = require('path');
    return (BdApi.Plugins && BdApi.Plugins.folder) || path.join(process.env.APPDATA || '', 'BetterDiscord', 'plugins');
  }

  /** The GIFs in Discord's own Favourites tab, read from the client's settings (no login details are touched). */
  nativeFavourites() {
    try {
      const W = BdApi.Webpack;
      const store = (W.getStore && W.getStore('UserSettingsProtoStore')) || (W.getByKeys && W.getByKeys('frecencyWithoutFetchingLatest'));
      const gifs = store?.frecencyWithoutFetchingLatest?.favoriteGifs?.gifs || {};
      return Object.entries(gifs)
        .sort((a, b) => (a[1]?.order || 0) - (b[1]?.order || 0))
        .map(([url, g]) => {
          const slug = decodeURIComponent(String(url).split('?')[0].split('/').filter(Boolean).pop() || '').replace(/-gif-\d+$/, '');
          return { kind: 'gif', name: slug, url, src: g?.src || url, width: g?.width, height: g?.height };
        });
    } catch {
      return [];
    }
  }

  readFavourites() {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(this.folderOfPlugins(), 'FavoriteMedia.config.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = [];
    for (const kind of ['gif', 'video', 'image']) {
      for (const m of data?.[kind]?.medias || []) out.push({ kind, name: m.name || '', url: m.url || '', src: m.src || m.url || '', width: m.width, height: m.height });
    }
    return out;
  }

  /* ---------- renewing links ---------- */

  isDiscordFile(u) {
    try {
      const h = new URL(u).hostname;
      return h === 'cdn.discordapp.com' || h === 'media.discordapp.net';
    } catch {
      return false;
    }
  }

  /** A request that never answers must not freeze the whole run. */
  withTimeout(promise, ms, what) {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} seconds`)), ms); });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
  }

  parseBody(res) {
    let body = res?.body;
    // some response objects keep the JSON as text only
    if ((!body || typeof body !== 'object' || !('refreshed_urls' in body)) && typeof res?.text === 'string' && res.text.trim().startsWith('{')) {
      try { body = JSON.parse(res.text); } catch { /* not JSON */ }
    }
    return body && typeof body === 'object' ? body : null;
  }

  /*
   * Finds the way to talk to Discord's API that really answers with { refreshed_urls }. The request module and the
   * address form are not the same in every Discord build (one wrong combination returns the web page instead), so each
   * is tried on three links until one answers properly. The outcome of every try is kept in the config file.
   */
  async findRenewer(urls) {
    if (this.choice) return;
    const origin = (typeof location !== 'undefined' && location.origin) || 'https://discord.com';
    const forms = ['/attachments/refresh-urls', '/api/v9/attachments/refresh-urls', `${origin}/api/v9/attachments/refresh-urls`];
    const clean = (t) => String(t ?? '').replace(/\?[^"'\s]*/g, '?…').slice(0, 120);
    const probe = urls.slice(0, 3);
    const tried = [];
    const modules = this.candidates().slice(0, 8);
    for (let m = 0; m < modules.length; m += 1) {
      for (let f = 0; f < forms.length; f += 1) {
        this.say(`Testing how to ask Discord to renew links (try ${m * forms.length + f + 1} of ${modules.length * forms.length})…`);
        this.save('debug', { probing: `module ${m}, form ${f}`, modules: modules.length, tried }); // so a try that hangs is visible
        try {
          const res = await this.withTimeout(modules[m].post({ url: forms[f], body: { attachment_urls: probe }, oldFormErrors: true }), 12000, 'Discord');
          const body = this.parseBody(res);
          const ok = Boolean(body && Array.isArray(body.refreshed_urls));
          tried.push({ module: m, form: f, status: res?.status, ok, answered: ok ? body.refreshed_urls.length : undefined, head: ok ? '' : clean(res?.text) });
          if (ok) {
            this.choice = { rest: modules[m], url: forms[f] };
            this.save('debug', { chose: { module: m, form: f }, modules: modules.length, tried });
            return;
          }
        } catch (err) {
          tried.push({ module: m, form: f, error: clean(err?.message || err?.body?.message || JSON.stringify(err || '')) });
        }
      }
    }
    this.save('debug', { modules: modules.length, tried });
    throw new Error(modules.length ? "No way of asking Discord to renew links answered properly (see 'debug' in this plugin's config file)." : "Could not find Discord's request module (Discord changed). The plugin needs an update.");
  }

  /** Asks the client to renew a batch of Discord links. Resolves to a Map(original or path -> fresh link). */
  async renew(urls) {
    const res = await this.withTimeout(this.choice.rest.post({ url: this.choice.url, body: { attachment_urls: urls }, oldFormErrors: true }), 30000, 'Discord');
    const list = this.parseBody(res)?.refreshed_urls || [];
    const map = new Map();
    for (const x of list) {
      map.set(x.original, x.refreshed);
      map.set(this.pathOf(x.original), x.refreshed); // Discord may hand the link back without its signature, so also match by file path
    }
    // if it answered every link in order, the position is a safe match too
    if (list.length === urls.length) urls.forEach((u, i) => { if (!map.has(u)) map.set(u, list[i].refreshed); });
    return map;
  }

  pathOf(u) {
    try { return new URL(u).pathname; } catch { return String(u || ''); }
  }

  /* ---------- downloading ---------- */

  async download(url, dest, redirects = 0) {
    // BetterDiscord's own network call works around the browser's cross-origin rules and Discord's wrapped Node modules
    if (BdApi.Net && BdApi.Net.fetch) {
      const res = await BdApi.Net.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
      const length = Number((res.headers && res.headers.get && res.headers.get('content-length')) || 0);
      if (length > 60 * 1024 * 1024) throw new Error('too big');
      require('fs').writeFileSync(dest, new Uint8Array(await res.arrayBuffer()));
      return type;
    }
    return this.downloadWithNode(url, dest, redirects);
  }

  downloadWithNode(url, dest, redirects = 0) {
    const https = require('https');
    let http = null;
    try { http = require('http'); } catch { /* Discord's plugin loader does not offer it: plain-http links are fetched over https instead */ }
    const fs = require('fs');
    if (!http && url.startsWith('http:')) url = `https:${url.slice(5)}`;
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
          if (res.resume) res.resume();
          resolve(this.downloadWithNode(new URL(res.headers.location, url).href, dest, redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          if (res.resume) res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const type = String(res.headers['content-type'] || '');
        const length = Number(res.headers['content-length'] || 0);
        if (length > 60 * 1024 * 1024) {
          if (res.resume) res.resume();
          reject(new Error('too big'));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(type)));
        file.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('timed out')));
    });
  }

  extensionFor(url, type) {
    if (/gif/i.test(type)) return '.gif';
    if (/webp/i.test(type)) return '.webp';
    if (/mp4|video/i.test(type)) return '.mp4';
    if (/png/i.test(type)) return '.png';
    if (/jpe?g/i.test(type)) return '.jpg';
    const m = /\.(gif|webp|mp4|webm|png|jpe?g)(?:$|\?)/i.exec(url.split('?')[0] + (url.includes('?') ? '?' : ''));
    return m ? `.${m[1].toLowerCase()}` : '.bin';
  }

  /** A short stable name: the same favourite always gets the same file name, so nothing is saved twice. */
  safeName(name, key) {
    let id;
    try {
      id = require('crypto').createHash('md5').update(String(key)).digest('hex').slice(0, 8);
    } catch {
      // no crypto module here: a plain hash does the same job of giving each favourite its own stable name
      let h = 2166136261;
      for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
      id = h.toString(16).padStart(8, '0');
    }
    const base = String(name || '').replace(/[^\w\- ]+/g, ' ').trim().replace(/\s+/g, '-').slice(0, 40) || 'media';
    return `${id}-${base}`;
  }

  /* ---------- the export ---------- */

  /**
   * How long to wait before trying a failed favourite again, doubling with each failed attempt (at most 14 days).
   * A hiccup (timeout, server error, rate limit) is tried again within the hour; a missing or refused file once a day,
   * because it can come back; one that can never work (not a web link) practically never.
   */
  retryDelay(reason, attempts = 1) {
    const r = String(reason || '');
    if (/not a web link|Unsupported protocol/i.test(r)) return 365 * DAY;
    const base = /timed out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|HTTP (5\d\d|429|408)|too many/i.test(r) ? HOUR : DAY;
    return Math.min(14 * DAY, base * 2 ** Math.max(0, attempts - 1));
  }

  readJson(file, fallback) {
    try {
      return JSON.parse(require('fs').readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  /**
   * Saves the favourites that are not in the folder yet.
   * { background: true } for the automatic run (quiet, two downloads at a time); { retryFailed: true } also retries
   * the ones that failed before instead of waiting two weeks.
   */
  async run({ background = false, retryFailed = false } = {}) {
    if (this.running) return;
    this.running = true;
    this.say('Checking your favourites…');
    const fs = require('fs');
    const path = require('path');
    // in the user folder, not Documents: Documents is often synced to OneDrive, which would upload every GIF
    // (Discord's plugin loader does not offer the `os` module, so the user folder comes from the environment)
    const home = process.env.USERPROFILE || process.env.HOME || `${process.env.HOMEDRIVE || ''}${process.env.HOMEPATH || ''}`;
    if (!home) throw new Error('Could not work out your user folder.');
    const folder = path.join(home, 'Rosia-GIFs');
    const indexFile = path.join(folder, 'index.json');
    const failedFile = path.join(folder, 'failed.json');

    try {
      try { require('https'); } catch { throw new Error('Discord does not offer the "https" module to plugins, so files cannot be downloaded.'); }
      fs.mkdirSync(folder, { recursive: true });

      let plugin = [];
      try { plugin = this.readFavourites(); } catch { /* FavoriteMedia is not installed: Discord's own favourites still work */ }
      const native = this.nativeFavourites();
      // the same GIF can be in both lists: keep one copy, preferring the plugin's (it has the name you gave it)
      const seen = new Set(plugin.map((i) => i.src));
      const items = [...plugin, ...native.filter((i) => !seen.has(i.src))];
      if (!items.length) {
        this.say("No favourites found yet: FavoriteMedia has none saved and Discord's own Favourites tab is empty (it may still be loading).");
        return;
      }

      const index = this.readJson(indexFile, []);
      let failed = this.readJson(failedFile, []);
      const have = new Set(index.flatMap((e) => [e.key, e.source].filter(Boolean)));
      const now = Date.now();
      // a failed favourite is tried again later, soon for a hiccup and less often for one that is probably gone
      const recentlyFailed = new Set(
        failed.filter((f) => !retryFailed && now - (f.at || 0) < this.retryDelay(f.reason, f.attempts)).map((f) => f.key)
      );
      const todo = items.filter((i) => !have.has(i.src) && !have.has(i.url) && !recentlyFailed.has(i.src));

      if (!todo.length) {
        this.say(`Up to date: ${index.length} saved, ${failed.length} not recoverable. Checked ${new Date().toLocaleTimeString()}.`);
        return;
      }
      this.say(`${todo.length} new favourite${todo.length === 1 ? '' : 's'} to save (${index.length} already saved). Renewing links…`);

      // 1. renew the Discord links, 20 at a time, with a pause
      const fresh = new Map();
      const discord = [...new Set(todo.filter((i) => this.isDiscordFile(i.src)).map((i) => i.src))];
      this.renewBroken = false;
      let emptyBatches = 0;
      if (discord.length) {
        try {
          await this.findRenewer(discord);
        } catch (err) {
          this.renewBroken = true;
          this.renewError = String(err?.message || err);
        }
      }
      for (let i = 0; i < discord.length && !this.stopped && !this.renewBroken; i += 20) {
        const batch = discord.slice(i, i + 20);
        try {
          const got = await this.renew(batch);
          for (const [orig, renewed] of got) fresh.set(orig, renewed);
          emptyBatches = got.size ? 0 : emptyBatches + 1;
        } catch (err) {
          emptyBatches += 1;
          // a bad batch is skipped; its items are recorded as not recovered. The reason is kept so it can be seen.
          this.renewError = String(err?.message || err?.body?.message || JSON.stringify(err || '').slice(0, 160));
          this.save('debug', { ...(this.debug || {}), renewError: this.renewError });
        }
        // three batches in a row with nothing renewed and nothing renewed so far: something is wrong, not just deleted files
        if (emptyBatches >= 3 && !fresh.size) {
          this.renewBroken = true;
          break;
        }
        this.say(`Renewed ${Math.min(i + 20, discord.length)} of ${discord.length} Discord links…`);
        await new Promise((r) => setTimeout(r, 1500));
      }

      // 2. download each one straight away; progress is written as it goes, so an interrupted run loses nothing
      let saved = 0;
      let done = 0;
      let skipped = 0;
      const queue = [...todo];
      const flush = () => {
        fs.writeFileSync(indexFile, JSON.stringify(index, null, 1));
        fs.writeFileSync(failedFile, JSON.stringify(failed, null, 1));
      };
      const worker = async () => {
        while (!this.stopped && queue.length) {
          const item = queue.shift();
          const link = this.isDiscordFile(item.src) ? (fresh.get(item.src) || fresh.get(this.pathOf(item.src))) : item.src;
          const before = failed.find((f) => f.key === item.src);
          const attempts = (before?.attempts || 0) + 1;
          failed = failed.filter((f) => f.key !== item.src); // a retry replaces its old record
          if (!link && this.renewBroken && this.isDiscordFile(item.src)) {
            skipped += 1; // not recorded as failed: renewal itself did not work, so it is tried again next time
          } else if (!link) {
            failed.push({ key: item.src, name: item.name, kind: item.kind, source: item.src, reason: this.renewError ? `could not be renewed: ${this.renewError}` : 'could not be renewed (deleted, or no longer visible to you)', at: Date.now(), attempts });
          } else {
            const stem = path.join(folder, `${item.kind}-${this.safeName(item.name, item.src)}`);
            try {
              if (!/^https?:/i.test(link)) throw new Error('not a web link');
              const type = await this.download(link, `${stem}.part`);
              const file = `${stem}${this.extensionFor(item.src, type)}`;
              fs.renameSync(`${stem}.part`, file);
              index.push({ file: path.basename(file), name: item.name, kind: item.kind, key: item.src, source: item.url || item.src, width: item.width, height: item.height });
              saved += 1;
            } catch (err) {
              try { fs.rmSync(`${stem}.part`, { force: true }); } catch { /* nothing to remove */ }
              failed.push({ key: item.src, name: item.name, kind: item.kind, source: item.src, reason: String(err.message || err), at: Date.now(), attempts });
            }
          }
          done += 1;
          if (done % 10 === 0) {
            flush();
            this.say(`Saved ${saved} new, ${done} of ${todo.length} tried…`);
          }
        }
      };
      await Promise.all(Array.from({ length: background ? 2 : 3 }, worker));
      flush();

      const lost = todo.length - saved - skipped;
      if (this.renewBroken) {
        this.say(`Could not renew Discord links: ${this.renewError || 'Discord returned nothing for the first 60'} ${saved} others saved, ${skipped} Discord links left for next time. ${new Date().toLocaleTimeString()}`);
      } else {
        this.say(`Done: ${saved} new saved (${index.length} in total), ${lost} could not be recovered. ${new Date().toLocaleTimeString()}`);
      }
      if (saved) this.toast(`Rosia GIFs: saved ${saved} new favourite${saved === 1 ? '' : 's'}.`, 'success');
    } catch (err) {
      this.say(`Stopped: ${err.message || err}`);
      if (!background) this.toast(`Rosia GIFs: ${err.message || err}`, 'error');
    } finally {
      this.running = false;
    }
  }

  /* ---------- videos: saved as links only ---------- */

  folderPath() {
    const home = process.env.USERPROFILE || process.env.HOME || `${process.env.HOMEDRIVE || ''}${process.env.HOMEPATH || ''}`;
    if (!home) throw new Error('Could not work out your user folder.');
    return require('path').join(home, 'Rosia-GIFs');
  }

  videosFile() {
    return require('path').join(this.folderPath(), 'videos.json');
  }

  readVideos() {
    const list = this.readJson(this.videosFile(), []);
    return Array.isArray(list) ? list.filter((v) => v && /^https?:\/\//i.test(String(v.url || ''))) : [];
  }

  writeVideos(list) {
    const fs = require('fs');
    const file = this.videosFile();
    fs.mkdirSync(require('path').dirname(file), { recursive: true });
    const text = JSON.stringify(list, null, 1);
    try {
      fs.writeFileSync(`${file}.tmp`, text);
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      fs.writeFileSync(file, text); // the rename can fail while Rosia has the file open: write it in place instead
    }
  }

  /** Two links to the same file are the same video (Discord's differ only in their signature). */
  videoKey(url) {
    try {
      const u = new URL(url);
      return this.isDiscordFile(url) ? u.pathname : u.href;
    } catch {
      return String(url);
    }
  }

  /** The time a signed Discord link stops working (the hex `ex=` in it), in ms, or 0 when it does not say. */
  expiryOf(url) {
    try {
      const ex = new URL(url).searchParams.get('ex');
      return ex && /^[0-9a-f]{6,10}$/i.test(ex) ? parseInt(ex, 16) * 1000 : 0;
    } catch {
      return 0;
    }
  }

  looksLikeVideo(url, type = '') {
    if (/^video\//i.test(String(type))) return true;
    try {
      return /\.(mp4|webm|mov|m4v|ogv)$/i.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  nameFromUrl(url) {
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
      return last.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 80) || 'video';
    } catch {
      return 'video';
    }
  }

  cleanName(name) {
    return String(name || '').replace(/\.(mp4|webm|mov|m4v|ogv)$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  /** Adds a video link, or refreshes the link of one that is already there. Returns { added, video }. */
  addVideo({ url, name = '', label = '' }) {
    url = String(url || '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('That is not a web link (it should start with https://).');
    const list = this.readVideos();
    const key = this.videoKey(url);
    const hit = list.find((v) => this.videoKey(v.url) === key);
    if (hit) {
      hit.url = url;
      if (label) hit.label = label;
      this.writeVideos(list);
      return { added: false, video: hit };
    }
    const video = { url, name: this.cleanName(name) || this.nameFromUrl(url), label: String(label || '').slice(0, 80), addedAt: Date.now() };
    list.push(video);
    this.writeVideos(list);
    return { added: true, video };
  }

  /** Adds every link in a pasted block of text (one per line, or separated by spaces). Returns { added, refreshed, skipped }. */
  addVideos(text) {
    const links = [...new Set(String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
    const out = { added: 0, refreshed: 0, skipped: 0 };
    for (const url of links) {
      try {
        if (this.addVideo({ url }).added) out.added += 1;
        else out.refreshed += 1;
      } catch {
        out.skipped += 1;
      }
    }
    return out;
  }

  removeVideo(url) {
    const key = this.videoKey(url);
    this.writeVideos(this.readVideos().filter((v) => this.videoKey(v.url) !== key));
  }

  setVideoLabel(url, label) {
    const key = this.videoKey(url);
    const list = this.readVideos();
    const hit = list.find((v) => this.videoKey(v.url) === key);
    if (hit) {
      hit.label = String(label || '').slice(0, 80);
      this.writeVideos(list);
    }
  }

  /** The videos in a Discord message: uploaded files, embedded video files, and plain links to a video file. */
  videosIn(message) {
    const out = [];
    const add = (url, name) => {
      if (!url || !/^https?:\/\//i.test(url)) return;
      if (out.some((o) => this.videoKey(o.url) === this.videoKey(url))) return;
      out.push({ url, name: this.cleanName(name) || this.nameFromUrl(url) });
    };
    for (const a of message?.attachments || []) {
      if (/^video\//i.test(a.content_type || a.contentType || '') || this.looksLikeVideo(a.url)) add(a.url, a.filename);
    }
    for (const e of message?.embeds || []) {
      const v = e?.video?.url || e?.video?.proxyURL || e?.video?.proxy_url;
      if (e?.type !== 'gifv' && v && this.looksLikeVideo(v)) add(v, e.rawTitle || e.title);
    }
    for (const m of String(message?.content || '').matchAll(/https?:\/\/[^\s<>"]+/gi)) {
      const link = m[0].replace(/[),.;!?]+$/, '');
      if (this.looksLikeVideo(link)) add(link, '');
    }
    return out;
  }

  /** The element of a rendered context menu that carries `navId` (the menu proper), searching down. */
  findMenuElement(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 10) return null;
    if (Array.isArray(node)) {
      for (const c of node) {
        const found = this.findMenuElement(c, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (node.props && node.props.navId) return node;
    return this.findMenuElement(node.props?.children, depth + 1);
  }

  /**
   * The list of groups in a context menu. Other plugins (ImageUtilities, through BDFDB) do the same: find the element that
   * carries `navId`, and use its children, made into an array if it is a single element. Failing that, the first array of
   * three or more elements further down.
   */
  menuGroups(tree) {
    const menu = tree?.props?.navId ? tree : this.findMenuElement(tree?.props?.children);
    if (menu) {
      if (!Array.isArray(menu.props.children)) menu.props.children = [menu.props.children].filter(Boolean);
      return menu.props.children;
    }
    return Array.isArray(tree?.props?.children) ? tree.props.children : this.findMenuList(tree?.props?.children);
  }

  /** The array of menu groups inside a context menu tree: the first array of three or more elements, searching down. */
  findMenuList(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (Array.isArray(node)) {
      if (node.filter((c) => c && c.props).length >= 3) return node;
      for (const c of node) {
        const found = this.findMenuList(c, depth + 1);
        if (found) return found;
      }
      return null;
    }
    return this.findMenuList(node.props?.children, depth + 1);
  }

  /**
   * The videos a right-click is about. The message's own attachments and embeds first; then what the menu itself was given
   * for the thing clicked on (the link behind "Copy link" / "View Video"), and the <video> element under the pointer.
   */
  videosFromMenu(props) {
    const out = this.videosIn(props?.message);
    const add = (url, name = '') => {
      if (!url || !/^https?:\/\//i.test(String(url))) return;
      if (out.some((o) => this.videoKey(o.url) === this.videoKey(url))) return;
      out.push({ url: String(url), name: this.cleanName(name) || this.nameFromUrl(url) });
    };
    const asVideo = /video/i.test(String(props?.itemType || ''));
    for (const u of [props?.itemHref, props?.itemSrc, props?.itemSafeSrc]) {
      if (u && (asVideo || this.looksLikeVideo(u))) add(u);
    }
    try {
      const t = props?.target;
      const el = t && (t.tagName === 'VIDEO' ? t : t.closest?.('video') || t.querySelector?.('video'));
      if (el) add(el.currentSrc || el.src || el.querySelector?.('source')?.src);
    } catch { /* not a DOM element */ }
    // the menu was opened on a link or media item that is not obviously a video: still offer it, the person knows what it is
    if (!out.length && props?.itemHref && /^https?:\/\//i.test(String(props.itemHref)) && /video|media|attachment/i.test(String(props.itemType || props.itemHref))) add(props.itemHref);
    return out;
  }

  /**
   * Renews the Discord links in videos.json that have expired or will within 12 hours (a renewed link lasts about a day).
   * { force: true } renews every Discord link. Returns { due, renewed }.
   */
  async refreshVideos({ force = false } = {}) {
    const soon = Date.now() + 12 * HOUR;
    const due = this.readVideos().filter((v) => this.isDiscordFile(v.url) && (force || (this.expiryOf(v.url) && this.expiryOf(v.url) < soon)));
    if (!due.length) return { due: 0, renewed: 0 };
    await this.findRenewer(due.map((v) => v.url));
    const fresh = new Map(); // video key -> renewed link
    for (let i = 0; i < due.length && !this.stopped; i += 20) {
      const batch = due.slice(i, i + 20);
      const got = await this.renew(batch.map((v) => v.url));
      for (const v of batch) {
        const link = got.get(v.url) || got.get(this.pathOf(v.url));
        if (link && link !== v.url) fresh.set(this.videoKey(v.url), link);
      }
      if (i + 20 < due.length) await new Promise((r) => setTimeout(r, 1500));
    }
    if (fresh.size) {
      // read the file again: the person may have added or removed a video while this was running
      const list = this.readVideos();
      for (const v of list) {
        const link = fresh.get(this.videoKey(v.url));
        if (link) Object.assign(v, { url: link, renewedAt: Date.now() });
      }
      this.writeVideos(list);
    }
    this.videoNote = `Video links: ${fresh.size} of ${due.length} renewed ${new Date().toLocaleTimeString()}.`;
    return { due: due.length, renewed: fresh.size };
  }

  favourite(video) {
    try {
      const { added } = this.addVideo(video);
      this.toast(added ? `Saved to Rosia's videos: ${video.name}` : 'That video was already saved (link refreshed).', 'success');
      this.renderVideoPanel();
    } catch (err) {
      this.toast(String(err?.message || err), 'error');
    }
  }

  /* ---------- videos: the tab beside GIFs, and the right-click item ---------- */

  startVideoUi() {
    this.stopVideoUi();
    const CM = BdApi.ContextMenu;
    this.save('menuDebug', { patching: Boolean(CM && CM.patch), buildItem: Boolean(CM && CM.buildItem), item: Boolean(CM && CM.Item) });
    if (CM && CM.patch) {
      this.menuPatch = (tree, props) => {
        try {
          const videos = this.videosFromMenu(props);
          // what the menu was given, without any link signatures, so a miss can be diagnosed from the config file
          const strip = (u) => (u ? String(u).split('?')[0].slice(-80) : u);
          this.save('menuDebug', {
            at: new Date().toISOString(),
            keys: Object.keys(props || {}).slice(0, 30),
            itemType: props?.itemType,
            itemHref: strip(props?.itemHref),
            itemSrc: strip(props?.itemSrc),
            target: props?.target?.tagName,
            attachments: (props?.message?.attachments || []).map((a) => [a.content_type, strip(a.url)]),
            embeds: (props?.message?.embeds || []).map((e) => [e.type, strip(e?.video?.url), strip(e?.url)]),
            found: videos.length,
            childrenIsArray: Array.isArray(tree?.props?.children)
          });
          if (!videos.length) return;
          // the list of menu groups is not always directly in `children` (this menu wraps it): look for it
          const list = this.menuGroups(tree);
          const shape = (n, d = 0) => (d > 6 || !n ? '' : Array.isArray(n) ? `[${n.length}:${shape(n[0], d + 1)}]` : `${typeof n.type === 'string' ? n.type : n.type?.displayName || n.type?.name || typeof n.type}>${shape(n.props?.children, d + 1)}`);
          this.save('menuDebug', { ...this.load('menuDebug'), shape: shape(tree), listFound: Boolean(list), listLen: list?.length });
          if (!list) return;
          const make = (label, video) => (CM.buildItem
            ? CM.buildItem({ type: 'text', label, action: () => this.favourite(video) })
            : BdApi.React.createElement(CM.Item, { label, id: 'rosia-fav-video', action: () => this.favourite(video) }));
          const group = CM.Group ? (kids) => BdApi.React.createElement(CM.Group, null, ...kids) : (kids) => kids;
          const items = videos.map((v, n) => make(videos.length > 1 ? `Favourite video ${n + 1} for Rosia` : 'Favourite this video for Rosia', v));
          const added = group(items);
          // near the top, with the link items, so it is easy to find; the end of the list is a long way down
          list.splice(Math.min(1, list.length), 0, ...[].concat(added));
        } catch (err) {
          this.save('menuDebug', { error: String(err?.message || err) });
        }
      };
      CM.patch('message', this.menuPatch);
    }
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      this.pickerObserver = new MutationObserver(() => this.syncPicker());
      this.pickerObserver.observe(document.body, { childList: true, subtree: true });
      this.syncPicker();
    }
  }

  stopVideoUi() {
    if (this.pickerObserver) this.pickerObserver.disconnect();
    this.pickerObserver = null;
    if (this.menuPatch && BdApi.ContextMenu && BdApi.ContextMenu.unpatch) BdApi.ContextMenu.unpatch('message', this.menuPatch);
    this.menuPatch = null;
    this.closeVideoPanel();
    if (typeof document !== 'undefined') document.getElementById('rosia-video-tab')?.remove();
    this.tab = null;
  }

  el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n[k] = v;
      else n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
  }

  gifTab() {
    return document.getElementById('gif-picker-tab') || [...document.querySelectorAll('[role="tab"]')].find((t) => /^gifs?$/i.test((t.textContent || '').trim()));
  }

  /** Keeps a "Videos" tab next to GIFs whenever the picker is open. Never changes anything Discord draws. */
  syncPicker() {
    const gif = this.gifTab();
    const bar = gif?.parentElement;
    if (!gif || !bar) {
      if (this.panel) this.closeVideoPanel(); // the picker was closed
      return;
    }
    for (const t of bar.children) {
      if (t === this.tab || !t.className) continue;
      if (t.getAttribute('aria-selected') === 'true') { if (!this.panel) this.selectedClass = t.className; } else if (!this.panel) this.idleClass = t.className;
    }
    if (this.tab && bar.contains(this.tab)) return;
    const tab = gif.cloneNode(false);
    tab.id = 'rosia-video-tab';
    tab.removeAttribute('aria-controls');
    tab.setAttribute('aria-selected', 'false');
    tab.className = this.idleClass || gif.className;
    tab.textContent = 'Videos';
    tab.onclick = (e) => { e.stopPropagation(); this.openVideoPanel(bar); };
    gif.after(tab);
    this.tab = tab;
    if (!bar.dataset.rosiaWatch) {
      bar.dataset.rosiaWatch = '1';
      // choosing any of Discord's own tabs closes this one
      bar.addEventListener('click', (e) => { if (this.panel && e.target.closest && !e.target.closest('#rosia-video-tab')) this.closeVideoPanel(); }, true);
    }
  }

  openVideoPanel(bar) {
    if (this.panel) return;
    const shown = [...bar.children].find((t) => t !== this.tab && t.getAttribute('aria-selected') === 'true');
    this.dimmed = shown ? { tab: shown, className: shown.className } : null;
    if (shown) shown.setAttribute('aria-selected', 'false');
    if (shown && this.idleClass) shown.className = this.idleClass;
    if (this.selectedClass) this.tab.className = this.selectedClass;
    this.tab.setAttribute('aria-selected', 'true');

    // the panel lies over the picker's body, from just under the tab bar down; Discord's own content is left alone underneath
    let host = bar;
    const barBox = bar.getBoundingClientRect();
    while (host.parentElement && host.getBoundingClientRect().height < barBox.height + 200) host = host.parentElement;
    if (getComputedStyle(host).position === 'static') { host.style.position = 'relative'; this.hostPosition = host; }
    const top = barBox.bottom - host.getBoundingClientRect().top;
    this.panel = this.el('div', {
      id: 'rosia-video-panel',
      style: `position:absolute;left:0;right:0;bottom:0;top:${Math.max(0, top)}px;z-index:50;overflow:auto;padding:10px;box-sizing:border-box;background:var(--background-base-lower,var(--background-secondary,#2b2d31));color:var(--header-primary,#fff);font-size:13px`
    });
    host.appendChild(this.panel);
    this.renderVideoPanel();
  }

  closeVideoPanel() {
    if (this.panel) this.panel.remove();
    this.panel = null;
    if (this.hostPosition) { this.hostPosition.style.position = ''; this.hostPosition = null; }
    if (this.dimmed) {
      this.dimmed.tab.className = this.dimmed.className;
      this.dimmed.tab.setAttribute('aria-selected', 'true');
      this.dimmed = null;
    }
    if (this.tab) {
      this.tab.setAttribute('aria-selected', 'false');
      if (this.idleClass) this.tab.className = this.idleClass;
    }
  }

  renderVideoPanel() {
    const panel = this.panel;
    if (!panel) return;
    panel.replaceChildren();
    const quiet = (e) => e.stopPropagation(); // typing here must not trigger Discord's shortcuts
    const field = 'flex:1;min-width:0;padding:6px 8px;border:0;border-radius:4px;background:var(--input-background,#1e1f22);color:inherit;font-size:13px';
    const btn = 'padding:6px 12px;border:0;border-radius:4px;cursor:pointer;font-size:13px;color:#fff;background:var(--brand-experiment,#5865f2)';

    const link = this.el('textarea', { rows: '2', placeholder: 'Paste video links here, as many as you like (one per line)', style: `${field};resize:vertical`, onkeydown: quiet, onkeyup: quiet });
    const note = this.el('div', { style: 'margin:6px 0 10px;opacity:.75' }, this.videoNote || 'Videos are kept as links, no naming needed. Rosia checks a link works before she sends it.');
    const add = this.el('button', {
      type: 'button',
      style: btn,
      onclick: () => {
        const { added, refreshed, skipped } = this.addVideos(link.value);
        if (!added && !refreshed) {
          note.textContent = skipped ? 'Those are not web links (they should start with https://).' : 'Paste a link first.';
          return;
        }
        this.videoNote = `${added} saved${refreshed ? `, ${refreshed} already there (links refreshed)` : ''}${skipped ? `, ${skipped} not links` : ''}.`;
        this.renderVideoPanel();
      }
    }, 'Add');
    const renew = this.el('button', {
      type: 'button',
      style: `${btn};background:var(--background-tertiary,#1e1f22)`,
      title: 'Ask Discord for fresh links to the videos stored on its servers',
      onclick: async () => {
        note.textContent = 'Renewing links…';
        try {
          const { due, renewed } = await this.refreshVideos({ force: true });
          this.videoNote = due ? `${renewed} of ${due} links renewed.` : 'No Discord-hosted videos to renew.';
        } catch (err) {
          this.videoNote = `Could not renew: ${String(err?.message || err).slice(0, 120)}`;
        }
        this.renderVideoPanel();
      }
    }, 'Renew');
    panel.append(this.el('div', { style: 'display:flex;gap:6px;align-items:flex-start' }, link, add, renew), note);

    const list = this.readVideos();
    if (!list.length) {
      panel.append(this.el('div', { style: 'opacity:.7;padding:18px 0;text-align:center' }, 'No videos yet. Paste a link above, or right-click a message with a video and choose “Favourite this video for Rosia”.'));
      return;
    }
    const grid = this.el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px' });
    for (const v of list) grid.append(this.videoCard(v));
    panel.append(grid);
  }

  videoCard(v) {
    const thumb = this.el('video', { preload: 'metadata', muted: '', playsinline: '', style: 'display:block;width:100%;height:96px;object-fit:cover;background:#000' });
    thumb.muted = true;
    thumb.src = v.url;
    const flag = this.el('div', { style: 'position:absolute;inset:auto 4px 4px 4px;font-size:11px;padding:2px 4px;border-radius:3px;background:rgba(0,0,0,.7);color:#fff;display:none' });
    thumb.onerror = () => {
      const gone = this.expiryOf(v.url) && this.expiryOf(v.url) < Date.now();
      flag.textContent = gone ? 'link expired: press Renew' : 'no preview here';
      flag.style.display = 'block';
    };
    thumb.onmouseenter = () => thumb.play().catch(() => {});
    thumb.onmouseleave = () => { thumb.pause(); try { thumb.currentTime = 0; } catch { /* not loaded */ } };
    const name = this.el('input', {
      type: 'text',
      value: v.label || '',
      placeholder: 'name (optional)',
      title: 'Optional. If you name a video, she can find it when asked for something specific; otherwise she just picks one',
      style: 'width:100%;box-sizing:border-box;margin-top:4px;padding:3px 5px;border:0;border-radius:3px;background:transparent;color:inherit;font-size:12px',
      onkeydown: (e) => e.stopPropagation(),
      onkeyup: (e) => e.stopPropagation(),
      onchange: (e) => this.setVideoLabel(v.url, e.target.value)
    });
    const small = 'border:0;border-radius:3px;cursor:pointer;font-size:11px;padding:3px 7px;color:inherit;background:var(--background-tertiary,#1e1f22)';
    const copy = this.el('button', {
      type: 'button',
      style: small,
      onclick: () => {
        try {
          if (navigator.clipboard) navigator.clipboard.writeText(v.url);
          this.toast('Link copied.', 'success');
        } catch { this.toast('Could not copy.', 'error'); }
      }
    }, 'Copy link');
    const remove = this.el('button', { type: 'button', style: small, onclick: () => { this.removeVideo(v.url); this.renderVideoPanel(); } }, 'Remove');
    return this.el('div', { style: 'border-radius:6px;overflow:hidden;background:var(--background-secondary,#2b2d31)' },
      this.el('div', { style: 'position:relative' }, thumb, flag),
      this.el('div', { style: 'padding:4px 6px 6px' }, name, this.el('div', { style: 'display:flex;gap:4px;margin-top:4px' }, copy, remove)));
  }

  /* ---------- the settings panel ---------- */

  getSettingsPanel() {
    const panel = document.createElement('div');
    panel.style.cssText = 'padding:16px;color:var(--header-primary);font-size:14px;line-height:1.5';

    const text = document.createElement('p');
    text.textContent = "Keeps the Rosia-GIFs folder in your user folder (C:\\Users\\you\\Rosia-GIFs) filled with your favourites (FavoriteMedia and Discord's own Favourites tab), renewing expired Discord links first. It runs by itself in the background after Discord starts and only fetches what is new.";

    const videos = document.createElement('p');
    videos.textContent = 'Videos: open the GIF picker and use the new Videos tab to save a video link, or right-click a message with a video and choose "Favourite this video for Rosia". Only the links are kept (Rosia-GIFs\\videos.json); the plugin renews Discord-hosted ones so they keep working.';

    const status = document.createElement('p');
    status.style.cssText = 'margin:12px 0;color:var(--text-muted)';
    status.textContent = this.lastStatus;
    const listener = (msg) => { status.textContent = msg; };
    this.listeners.add(listener);

    const auto = document.createElement('label');
    auto.style.cssText = 'display:flex;gap:8px;align-items:center;margin:12px 0;cursor:pointer';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = Boolean(this.settings.auto);
    box.onchange = () => {
      this.settings.auto = box.checked;
      this.save('settings', this.settings);
      if (box.checked && !this.timers.length) this.timers.push(setTimeout(() => this.cycle(), 2000));
      if (!box.checked) { this.timers.forEach((t) => clearTimeout(t)); this.timers = []; }
    };
    auto.append(box, document.createTextNode('Run automatically in the background'));

    const button = (label, onclick, secondary) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `padding:8px 18px;border:0;border-radius:4px;cursor:pointer;font-size:14px;margin-right:8px;${secondary ? 'background:var(--background-tertiary,#2b2d31);color:var(--header-primary)' : 'background:var(--brand-experiment,#5865f2);color:#fff'}`;
      b.onclick = onclick;
      return b;
    };
    this.stopped = false;
    panel.append(
      text,
      videos,
      status,
      auto,
      button('Check now', () => { this.stopped = false; this.run(); }),
      button('Retry failed too', () => { this.stopped = false; this.run({ retryFailed: true }); }, true),
      button('Stop', () => { this.stopped = true; }, true)
    );
    return panel;
  }
};
