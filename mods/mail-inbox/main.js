// Inbox for your himalaya accounts: one merged view or one account, cached lists,
// hover prefetch, server-side search, sender pictures, bounded requests throughout, and
// "Send to agent": the request in a forward chain, with its files, handed to a running agent.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea, Popover } from "gpui-base";
import { exec, hc, run, theme, appHome, home, notify, readTextFile, writeTextFile, agents, spaces } from "herdr";
import { bodyOf, levels, requestIndex } from "./body.js";
import { compose, defaultNote, extractable, publicDomain, senderKey, suggest } from "./context.js";

// Nothing personal lives in this file. The accounts are himalaya's (its config.toml), the
// team is you: your addresses and your company's domain. config.json beside this file
// can pick, order and label accounts and add teammates (see README.md).
let ACCOUNTS = [];   // [{ id, label, email }]
let TEAM = [];       // ["you@company.com", "@company.com"]
let REFRESH = 60;
const teammate = email => {
  const e = (email ?? "").toLowerCase();
  return Boolean(e) && TEAM.some(x => (x.startsWith("@") ? e.endsWith(x) : e === x));
};
const ALL = "all";
const PAGE_SIZE = 30, SEARCH_SIZE = 100;
// himalaya waits on the keyring and the IMAP server; neither may hold the panel hostage.
const TIMEOUT = 20, GUARD_MS = (TIMEOUT + 5) * 1000;
const BODY_CACHE = 150, PREFETCH = 12;
const ICONS = "mods/mail-inbox";
const AVATARS = "data/mail-inbox/avatars";
const FILES = "data/mail-inbox/files";

// himalaya's accounts, from its config.toml: [accounts.<name>] with email, display-name, default.
async function himalayaAccounts(path) {
  const xdg = `${home()}/.config/himalaya/config.toml`;
  for (const file of [path, xdg, `${home()}/.himalayarc`].filter(Boolean)) {
    const text = await readTextFile(file.replace(/^~(?=\/)/, home())).catch(() => null);
    if (!text) continue;
    const found = [];
    let current = null;
    for (const line of text.split("\n")) {
      const section = /^\s*\[\s*accounts\.("?)([^"\]]+)\1\s*\]\s*$/.exec(line);
      if (section) { current = { id: section[2].trim(), email: "", name: "", default: false }; found.push(current); continue; }
      if (/^\s*\[/.test(line)) { current = null; continue; }
      const kv = current && /^\s*([\w-]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (!kv) continue;
      const value = kv[2].replace(/^["']|["']$/g, "");
      if (kv[1] === "email") current.email = value.toLowerCase();
      else if (kv[1] === "display-name") current.name = value;
      else if (kv[1] === "default") current.default = value === "true";
    }
    return found;
  }
  return [];
}

// Accounts, team and refresh from himalaya and the optional config.json.
async function loadSetup() {
  let config = {}, error = null;
  const raw = await readTextFile(`${appHome()}/${ICONS}/config.json`).catch(() => null);
  if (raw) try { config = JSON.parse(raw); } catch (e) { error = `config.json: ${String(e?.message || e).slice(0, 160)}`; }
  const found = await himalayaAccounts(config.himalayaConfig);
  const byId = new Map(found.map(a => [a.id, a]));
  const wanted = Array.isArray(config.accounts) && config.accounts.length
    ? config.accounts.map(a => (typeof a === "string" ? { id: a } : a)).filter(a => a?.id)
    : [...found].sort((a, b) => b.default - a.default).map(a => ({ id: a.id }));
  const accounts = wanted.map(a => {
    const h = byId.get(a.id) ?? {};
    return { id: a.id, label: a.label || h.name || a.id[0].toUpperCase() + a.id.slice(1), email: (a.email || h.email || "").toLowerCase() };
  });
  // You and your company are the team; public mail domains (gmail.com, …) only count by address.
  const team = new Set();
  for (const a of accounts) if (a.email) {
    team.add(a.email);
    const domain = a.email.split("@")[1];
    if (domain && !publicDomain(domain)) team.add(`@${domain}`);
  }
  for (const x of Array.isArray(config.team) ? config.team : []) if (typeof x === "string" && x.trim()) team.add(x.trim().toLowerCase());
  const refresh = Math.max(15, Number(config.refreshSeconds) || 60);
  return { accounts, team: [...team], refresh, error };
}

// Runs a program for at most `secs` (exit 124 when cut off), with GNU timeout, Homebrew's
// gtimeout on macOS, or, with neither, unbounded (the panel's own guards still apply).
const BOUNDED = 'if command -v timeout >/dev/null 2>&1; then exec timeout -k 3 "$0" "$@"; elif command -v gtimeout >/dev/null 2>&1; then exec gtimeout -k 3 "$0" "$@"; else exec "$@"; fi';
const bounded = (secs, program, args) => exec("sh", ["-c", BOUNDED, String(secs), program, ...args]);

// Opens a file or link with the desktop's default app, detached from the panel.
const OPEN = 'if command -v xdg-open >/dev/null 2>&1; then (setsid xdg-open "$1" || xdg-open "$1") >/dev/null 2>&1 & else open "$1"; fi';
const openWith = target => exec("sh", ["-c", OPEN, "open", target]);

async function himalaya(args) {
  const r = await bounded(TIMEOUT, "himalaya", args);
  if (r.code === 124 || r.code === 137) throw new Error("Mail server didn't answer in time. Is the keyring unlocked?");
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "himalaya failed").trim().split("\n").pop().slice(0, 220));
  return JSON.parse(r.stdout);
}

// AnonAddy forwards as alias+user=domain@….anonaddy.com and names the sender "user at domain".
function realEmail(email) {
  const m = /^[^+@]+\+(.+)=([^=@]+)@[^@]*anonaddy\.(?:com|me)$/i.exec(email ?? "");
  return (m ? `${m[1]}@${m[2]}` : email ?? "").toLowerCase();
}

function person(value) {
  const p = Array.isArray(value) ? value[0] : value;
  const email = realEmail(p?.email);
  let name = (p?.name ?? "").replace(/\s*'[^']* at [^']*'$/, "").trim();
  if (!name || / at [^ ]+\.[a-z]+$/i.test(name)) name = email;
  return { name: name || "Unknown sender", email };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = n => String(n).padStart(2, "0");
const parse = value => { const d = value ? new Date(value) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
const clock = d => `${d.getHours()}:${pad(d.getMinutes())}`;
const stamp = m => parse(m.date)?.getTime() ?? 0;

// Today: 14:32, this week: Tue, this year: 18 Oct, older: 18 Oct 2025.
function when(value) {
  const d = parse(value), now = new Date();
  if (!d) return "";
  if (d.toDateString() === now.toDateString()) return clock(d);
  if (now - d < 6 * 864e5 && d < now) return DAYS[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}

function fullDate(value) {
  const d = parse(value);
  return d ? `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clock(d)}` : "";
}

// Forward headers carry dates as their mailer wrote them: "20 October 2026 at 15:08:20 CEST", "8. 8. 2026 20:46".
function shortDate(value) {
  if (!value) return "";
  const d = parse(value.replace(/\s+at\s+/, " ").replace(/\s+[A-Z]{3,4}$/, ""));
  if (d) return when(d.toISOString());
  const m = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(value);
  return m ? `${m[1]} ${MONTHS[Number(m[2]) - 1] ?? ""}` : "";
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function size(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Icon and tint for an attachment, by extension, then by MIME type.
const KINDS = [
  ["pdf", /^pdf$/, "ansi1"], ["doc", /^(docx?|odt|rtf|txt|md|pages)$/, "ansi4"], ["sheet", /^(xlsx?|xlsm|ods|csv|tsv|numbers)$/, "ansi2"],
  ["slides", /^(pptx?|odp|key)$/, "ansi3"], ["zip", /^(zip|rar|7z|gz|tgz|tar|bz2|xz)$/, "ansi3"], ["image", /^(png|jpe?g|gif|webp|heic|bmp|svg|tiff?)$/, "ansi5"],
  ["video", /^(mp4|mov|mkv|webm|avi)$/, "ansi5"], ["audio", /^(mp3|wav|m4a|ogg|flac|aac)$/, "ansi6"],
  ["code", /^(json|xml|html?|js|ts|py|sh|ya?ml|toml|sql|css)$/, "ansi6"], ["key", /^(p12|pfx|pem|asc|gpg|sig|p7s|crt|cer|key)$/, "ansi3"],
];
function fileKind(a, t) {
  const ext = a.filename.includes(".") ? a.filename.split(".").pop().toLowerCase() : "";
  const mime = (a.mime ?? "").toLowerCase();
  const hit = KINDS.find(([, re]) => re.test(ext))
    ?? (mime.startsWith("image/") ? KINDS[5] : mime.startsWith("video/") ? KINDS[6] : mime.startsWith("audio/") ? KINDS[7] : mime === "application/pdf" ? KINDS[0] : null);
  return hit ? [hit[0], t[hit[2]]] : ["file", t.muted];
}

const seen = m => (m.flags ?? []).some(f => `${typeof f === "string" ? f : `${f?.iana ?? ""} ${f?.raw ?? ""}`}`.toLowerCase().includes("seen"));
const slim = (m, account) => ({ account, id: m.id, subject: m.subject, from: m.from, to: m.to, date: m.date, flags: m.flags, attachment: Boolean(m["has-attachment"]) });
const keyOf = m => `${m.account}:${m.id}`;

// "invoice from:gopay is:unread after:2026-10-01" → himalaya's query language, plus a local
// predicate over what is already loaded so results show before the server answers.
// Dates stay local: some IMAP servers (Seznam's) reject himalaya's date clauses.
function compileSearch(text) {
  const tokens = text.match(/(\w+:)?"[^"]*"|\S+/g) ?? [];
  const clauses = [], tests = [], dates = [];
  const clean = s => s.replace(/["\\]/g, "").trim();
  const has = (hay, needle) => hay.toLowerCase().includes(needle.toLowerCase());
  for (const token of tokens) {
    const [, op, raw] = /^(?:(\w+):)?(.*)$/.exec(token);
    const value = clean(raw);
    if (!value) continue;
    const field = op?.toLowerCase();
    if (field === "from" || field === "to") {
      clauses.push(`${field} "${value}"`);
      tests.push(m => { const p = person(m[field]); return has(`${p.name} ${p.email}`, value); });
    } else if (field === "subject") {
      clauses.push(`subject "${value}"`); tests.push(m => has(m.subject ?? "", value));
    } else if (field === "body") {
      clauses.push(`body "${value}"`); tests.push(() => false);
    } else if (field === "is" && /^(unread|read|seen|flagged|starred)$/i.test(value)) {
      const v = value.toLowerCase();
      if (v === "unread") { clauses.push("not flag seen"); tests.push(m => !seen(m)); }
      else if (v === "read" || v === "seen") { clauses.push("flag seen"); tests.push(seen); }
      else { clauses.push("flag flagged"); tests.push(m => (m.flags ?? []).some(f => /flagged/i.test(f?.iana ?? f))); }
    } else if ((field === "after" || field === "before" || field === "on") && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const day = new Date(`${value}T00:00:00`).getTime();
      dates.push(field === "after" ? m => stamp(m) >= day : field === "before" ? m => stamp(m) < day : m => stamp(m) >= day && stamp(m) < day + 864e5);
    } else {
      const word = clean(token);
      clauses.push(`(from "${word}" or subject "${word}" or body "${word}")`);
      tests.push(m => { const p = person(m.from); return has(`${p.name} ${p.email} ${m.subject ?? ""}`, word); });
    }
  }
  const inDates = m => dates.every(t => t(m));
  return { query: clauses.join(" and "), dated: dates.length > 0, inDates, test: m => inDates(m) && tests.every(t => t(m)) };
}

export default class MailInbox extends View {
  init(_props, cx) {
    // Last run's setup draws at once; the real one is read right after.
    let setup = null;
    try { setup = JSON.parse(localStorage.getItem("mail-inbox-setup") || "null"); } catch {}
    ACCOUNTS = setup?.accounts ?? []; TEAM = setup?.team ?? []; REFRESH = setup?.refresh ?? 60;
    this.setupError = null; this.setupLoaded = false;
    this.view = localStorage.getItem("mail-inbox-view") || ALL;
    // Per account: what we have, whether a request is out, and when it last succeeded.
    this.boxes = {};
    this.ensureBoxes();
    this.bodies = new Map(); this.inflight = new Map(); this.avatars = new Map(); this.expanded = new Set(); this.queue = [];
    this.selected = null; this.bodyError = null; this.menu = false;
    this.handoff = null;
    this.note = TextareaState.new({ placeholder: "What should the agent do? (optional)", rows: 3 });
    this.note.set_auto_grow(2, 8);
    try { this.sent = JSON.parse(localStorage.getItem("mail-inbox-sent") || "{}"); } catch { this.sent = {}; }
    this.search = { text: "", results: null, loading: false, error: null, token: 0 };
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search mail" });
    this.input.on("change", (_e, cx) => this.onSearch(this.input.value(), cx));
    this.input.on("submit", (_e, cx) => this.runSearch(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.start(cx);
    this.fetchAvatars(cx, Object.values(this.boxes).flatMap(b => b.messages.map(m => person(m.from).email)));
    cx.spawn(async cx => {
      let next = null;
      try { next = await loadSetup(); } catch (e) { this.setupError = String(e?.message || e).slice(0, 200); }
      if (next) {
        ACCOUNTS = next.accounts; TEAM = next.team; REFRESH = next.refresh; this.setupError = next.error;
        try { localStorage.setItem("mail-inbox-setup", JSON.stringify({ accounts: ACCOUNTS, team: TEAM, refresh: REFRESH })); } catch {}
        this.ensureBoxes();
        const saved = localStorage.getItem("mail-inbox-view");
        if (saved && ACCOUNTS.some(a => a.id === saved)) this.view = saved;
        this.start(cx);
      }
      this.setupLoaded = true;
      cx.timer.every(REFRESH * 1000, cx => { for (const a of ACCOUNTS) this.refresh(cx, a.id); });
      cx.notify();
    });
    // Keeps "updated 3m ago" honest without redrawing more than it changes.
    cx.timer.every(30_000, cx => cx.notify());
  }

  // A box per account, filled from the last session's cache so the list shows at once.
  ensureBoxes() {
    for (const a of ACCOUNTS) {
      if (this.boxes[a.id]) continue;
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem(`mail-inbox-cache-${a.id}`) || "null"); } catch {}
      const messages = (cached?.messages ?? []).map(m => ({ ...m, account: a.id }));
      this.boxes[a.id] = { messages, updated: cached?.updated ?? 0, page: 1, hasMore: messages.length >= PAGE_SIZE, loading: false, more: false, error: null, token: 0 };
    }
    if (this.view !== ALL && !ACCOUNTS.some(a => a.id === this.view)) this.view = ALL;
  }

  // Loads every account not loaded yet, the shown view first, so switching is instant.
  start(cx) {
    const order = [...ACCOUNTS].sort((a, b) => (b.id === this.view) - (a.id === this.view));
    for (const a of order) if (!this.boxes[a.id].started) { this.boxes[a.id].started = true; this.refresh(cx, a.id); }
    this.fetchAvatars(cx, ACCOUNTS.map(a => a.email));
  }

  accounts() { return this.view === ALL ? ACCOUNTS.map(a => a.id) : [this.view]; }

  // Merged view: show only down to the newest "oldest loaded" date among accounts that have
  // more, so one account's older pages never sit in a gap of the other's.
  visible() {
    const ids = this.accounts();
    if (ids.length === 1) return this.boxes[ids[0]].messages;
    let floor = 0;
    for (const id of ids) {
      const box = this.boxes[id];
      if (box.hasMore && box.messages.length) floor = Math.max(floor, stamp(box.messages[box.messages.length - 1]));
    }
    return ids.flatMap(id => this.boxes[id].messages).filter(m => stamp(m) >= floor).sort((a, b) => stamp(b) - stamp(a));
  }

  loadOlder(cx) {
    const ids = this.accounts().filter(id => this.boxes[id].hasMore);
    if (ids.length <= 1) { if (ids[0]) this.refresh(cx, ids[0], true); return; }
    // The account whose loaded list ends latest is the one holding the merged list back.
    const last = id => { const ms = this.boxes[id].messages; return ms.length ? stamp(ms[ms.length - 1]) : Infinity; };
    this.refresh(cx, ids.reduce((a, b) => (last(b) > last(a) ? b : a)), true);
  }

  refresh(cx, account, more = false) {
    const box = this.boxes[account];
    if (box.loading) return;
    const page = more ? box.page + 1 : 1, token = ++box.token;
    box.loading = true; box.more = more; box.error = null;
    cx.notify();
    // Belt and braces: if exec itself never returns, release the box anyway.
    cx.timer.after(GUARD_MS, cx => {
      if (box.token !== token || !box.loading) return;
      box.token++; box.loading = false; box.more = false;
      box.error = "Mail server didn't answer in time. Is the keyring unlocked?";
      cx.notify();
    });
    cx.spawn(async cx => {
      try {
        const payload = await himalaya(["--account", account, "envelope", "list", "--page", String(page), "--page-size", String(PAGE_SIZE), "--json"]);
        if (box.token !== token) return;
        const rows = (Array.isArray(payload) ? payload : payload.envelopes ?? []).map(m => slim(m, account));
        if (more) {
          const have = new Set(box.messages.map(m => m.id));
          box.messages = [...box.messages, ...rows.filter(m => !have.has(m.id))];
          box.page = page;
        } else {
          // Keep pages already loaded below the fresh first page.
          const fresh = new Set(rows.map(m => m.id));
          box.messages = [...rows, ...(box.page > 1 ? box.messages.slice(PAGE_SIZE).filter(m => !fresh.has(m.id)) : [])];
        }
        if (more || box.page === 1) box.hasMore = rows.length === PAGE_SIZE;
        box.updated = Date.now();
        try { localStorage.setItem(`mail-inbox-cache-${account}`, JSON.stringify({ messages: box.messages.slice(0, PAGE_SIZE), updated: box.updated })); } catch {}
        if (this.selected?.account === account) {
          const current = box.messages.find(m => m.id === this.selected.id);
          if (current) this.selected = current;
        }
        this.fetchAvatars(cx, rows.map(m => person(m.from).email));
        if (!more) this.warm(rows.slice(0, PREFETCH), cx);
      } catch (e) {
        if (box.token === token) box.error = String(e?.message || e).slice(0, 220);
      } finally {
        if (box.token === token) { box.loading = false; box.more = false; cx.notify(); }
      }
    });
  }

  // Pictures land in data/, once per address; misses are remembered there for a week.
  fetchAvatars(cx, emails) {
    const wanted = [...new Set(emails.filter(e => e && e.includes("@") && !this.avatars.has(e)))].slice(0, 60);
    if (!wanted.length) return;
    for (const e of wanted) this.avatars.set(e, null);
    cx.spawn(async cx => {
      try {
        const r = await exec("sh", [`${appHome()}/${ICONS}/avatars.sh`, `${appHome()}/${AVATARS}`, ...wanted]);
        let changed = false;
        for (const line of r.stdout.split("\n")) {
          const [email, hash, kind] = line.split(" ");
          if (email && (kind === "grav" || kind === "logo")) { this.avatars.set(email, { path: `${AVATARS}/${hash}.${kind}.png`, kind }); changed = true; }
        }
        if (changed) cx.notify();
      } catch {}
    });
  }

  onSearch(text, cx) {
    const s = this.search;
    if (text === s.text) return;
    s.text = text; s.error = null;
    const token = ++s.token;
    if (!text.trim()) { s.results = null; s.loading = false; cx.notify(); return; }
    this.selected = null;
    cx.notify();
    cx.timer.after(350, cx => { if (s.token === token) this.runSearch(cx); });
  }

  runSearch(cx) {
    const s = this.search, text = s.text.trim();
    if (!text) return;
    const { query, dated, inDates, test } = compileSearch(text);
    const token = ++s.token, ids = this.accounts();
    // Only dates: nothing to ask the server, so filter what's loaded.
    if (!query) {
      s.results = dated ? ids.flatMap(id => this.boxes[id].messages).filter(test).sort((a, b) => stamp(b) - stamp(a)) : null;
      s.loading = false; s.capped = false; cx.notify();
      return;
    }
    s.loading = true; s.error = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const lists = await Promise.all(ids.map(async id => {
          const payload = await himalaya(["--account", id, "envelope", "search", "--page-size", String(SEARCH_SIZE), "--json", query]);
          return (Array.isArray(payload) ? payload : payload.envelopes ?? []).map(m => slim(m, id));
        }));
        if (s.token !== token) return;
        // The server ignores "order by"; newest first is ours to do.
        s.results = lists.flat().filter(inDates).sort((a, b) => stamp(b) - stamp(a));
        s.capped = lists.some(l => l.length === SEARCH_SIZE);
        this.fetchAvatars(cx, s.results.map(m => person(m.from).email));
      } catch (e) {
        if (s.token === token) s.error = String(e?.message || e).slice(0, 220);
      } finally {
        if (s.token === token) { s.loading = false; cx.notify(); }
      }
    });
  }

  clearSearch(cx) {
    this.input.set_value("");
    this.onSearch("", cx);
  }

  // One request per message, shared by prefetch and opening. A message never changes, so
  // read.py's message.json (with its attachments beside it) is kept for good: the network
  // is asked once per message, ever.
  body(m) {
    const key = keyOf(m);
    if (this.bodies.has(key)) return Promise.resolve(this.bodies.get(key));
    if (!this.inflight.has(key)) {
      const dir = this.attachmentDir(m);
      const p = (async () => {
        let slim = null;
        try { const cached = await readTextFile(`${dir}/message.json`); if (cached) slim = JSON.parse(cached); } catch {}
        if (!slim) {
          const r = await exec("python3", ["-I", `${appHome()}/${ICONS}/read.py`, m.account, String(m.id), dir]);
          if (r.code === 124) throw new Error("Mail server didn't answer in time. Is the keyring unlocked?");
          if (r.code !== 0) throw new Error((r.stderr || r.stdout || "Couldn't read this message").trim().split("\n").pop().slice(0, 220));
          slim = JSON.parse(r.stdout);
        }
        const body = {
          ...bodyOf(slim),
          files: (slim.files ?? []).map(f => ({ ...f, image: /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(f.mime ?? ""), dims: f.w && f.h ? { w: f.w, h: f.h } : null, busy: null })),
        };
        this.bodies.set(key, body);
        if (this.bodies.size > BODY_CACHE) this.bodies.delete(this.bodies.keys().next().value);
        return body;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return this.inflight.get(key);
  }

  prefetch(m, cx) {
    if (this.inflight.size >= 3 || this.bodies.has(keyOf(m))) return;
    cx.spawn(async () => { try { await this.body(m); } catch {} });
  }

  // The newest messages load in the background, one at a time, so opening one is instant.
  warm(messages, cx) {
    for (const m of messages) if (!this.bodies.has(keyOf(m)) && !this.queue.some(q => keyOf(q) === keyOf(m))) this.queue.push(m);
    if (this.pumping || !this.queue.length) return;
    this.pumping = true;
    cx.spawn(async () => {
      try { while (this.queue.length) { const m = this.queue.shift(); if (!this.bodies.has(keyOf(m))) try { await this.body(m); } catch {} } }
      finally { this.pumping = false; }
    });
  }

  open(m, cx) {
    this.selected = m; this.bodyError = null; this.menu = false; this.handoff = null;
    cx.notify();
    if (!this.bodies.has(keyOf(m))) cx.spawn(async cx => {
      try { await this.body(m); }
      catch (e) { if (this.selected === m) this.bodyError = String(e?.message || e).slice(0, 220); }
      cx.notify();
    });
    if (!seen(m)) {
      // The same message may sit in the list and in search results: mark both.
      for (const x of [...this.boxes[m.account].messages, ...(this.search.results ?? [])])
        if (x.id === m.id && x.account === m.account && !seen(x)) x.flags = [...(x.flags ?? []), { raw: "\\Seen", iana: "seen" }];
      if (!seen(m)) m.flags = [...(m.flags ?? []), { raw: "\\Seen", iana: "seen" }];
      cx.spawn(async () => { try { await bounded(TIMEOUT, "himalaya", ["--account", m.account, "flag", "add", "--flag", "seen", String(m.id)]); } catch {} });
    }
  }

  selectView(view, cx) {
    this.menu = false;
    if (this.view !== view) {
      this.view = view; this.selected = null;
      localStorage.setItem("mail-inbox-view", view);
      for (const id of this.accounts()) { const box = this.boxes[id]; if (!box.updated || Date.now() - box.updated > 30_000) this.refresh(cx, id); }
      if (this.search.text.trim()) this.runSearch(cx);
    }
    cx.notify();
  }

  unread(ids) { return ids.reduce((n, id) => n + this.boxes[id].messages.filter(m => !seen(m)).length, 0); }

  // ── pieces ────────────────────────────────────────────────────────────────

  avatar(p, t, size = 28) {
    const pic = this.avatars.get(p.email);
    if (pic?.kind === "grav") return div().size(size).flex_none().rounded_full().overflow_hidden().child(image(pic.path).size(size).rounded_full());
    // Site icons fill a soft rounded tile; the tile only shows through transparent ones.
    if (pic?.kind === "logo") return div().size(size).flex_none().rounded(Math.round(size * 0.28)).overflow_hidden().bg(t.raised)
      .child(image(pic.path).size(size).rounded(Math.round(size * 0.28)));
    const letter = (p.name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
    let h = 0; for (const c of p.email || p.name) h = (h * 31 + c.codePointAt(0)) >>> 0;
    const tint = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6][h % 6];
    return div().size(size).flex_none().rounded_full().flex().items_center().justify_center()
      .bg(tint + "26").text_color(tint).text_size(size * 0.43).font_semibold().child(letter);
  }

  viewIcon(view, t, size) {
    if (view === ALL) return div().size(size).flex_none().rounded(6).bg(t.raised).flex().items_center().justify_center().text_color(t.muted)
      .child(svg(`${ICONS}/inboxes.svg`).size(Math.round(size * 0.58)));
    const a = ACCOUNTS.find(x => x.id === view);
    return this.avatar({ name: a.label, email: a.email }, t, size);
  }

  skeletonRow(i, t) {
    return h_flex().h(56).flex_none().px(10).gap(10).items_center().loop("opacity", { from: 0.35, to: 0.9, period: 1100 + i * 90 })
      .child(div().size(30).flex_none().rounded_full().bg(t.raised))
      .child(v_flex().flex_1().min_w(0).gap(7)
        .child(h_flex().gap(8).child(div().h(9).w(70 + (i * 37) % 60).rounded(4).bg(t.raised)).child(div().flex_1()).child(div().h(8).w(32).rounded(4).bg(t.raised)))
        .child(div().h(8).w(`${55 + (i * 23) % 40}%`).rounded(4).bg(t.raised)));
  }

  row(m, t) {
    const fresh = !seen(m), from = person(m.from), active = this.selected && keyOf(this.selected) === keyOf(m);
    const label = this.view === ALL ? ACCOUNTS.find(a => a.id === m.account)?.label : null;
    return h_flex().id(`mail-${keyOf(m)}`).h(56).flex_none().px(10).gap(10).items_center().rounded(7).cursor_pointer()
      .when(active, e => e.bg(t.selected)).hover(s => s.bg(t.hover))
      .on_hover((hovered, cx) => { if (hovered) this.prefetch(m, cx); })
      .on_click((_e, cx) => this.open(m, cx))
      .child(div().relative().child(this.avatar(from, t, 30))
        .when(fresh, e => e.child(div().absolute().top(-1).right(-1).size(10).rounded_full().bg(t.accent).border_2().border_color(t.background))))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().min_w(0).gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(fresh ? t.foreground : t.muted).when(fresh, e => e.font_semibold()).child(from.name))
          .when(m.attachment, e => e.child(svg(`${ICONS}/paperclip.svg`).size(11).flex_none().text_color(t.dim)))
          .child(div().flex_none().text_size(11).text_color(fresh ? t.accent : t.dim).child(when(m.date))))
        .child(h_flex().min_w(0).gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(fresh ? t.foreground : t.dim).child(m.subject || "(no subject)"))
          .when(Boolean(label), e => e.child(div().flex_none().text_size(10).text_color(t.dim).child(label)))));
  }

  notice(text, t, retry) {
    return v_flex().m(6).p(12).gap(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(div().text_size(12).text_color(t.blocked).child(text))
      .when(Boolean(retry), e => e.child(div().id("mail-retry").h(28).px(12).flex().items_center().self_start().rounded(7)
        .bg(t.solid).text_color(t.solid_foreground).text_size(12).cursor_pointer().on_click(retry).child("Try again")));
  }

  empty(icon, text, t) {
    return v_flex().py(40).gap(10).items_center()
      .child(svg(`${ICONS}/${icon}.svg`).size(26).text_color(t.dim)).child(div().text_size(12).text_color(t.dim).child(text));
  }

  list(t) {
    const ids = this.accounts(), boxes = ids.map(id => this.boxes[id]);
    const messages = this.visible(), empty = messages.length === 0;
    const loading = boxes.some(b => b.loading && !b.more), more = boxes.some(b => b.more), hasMore = boxes.some(b => b.hasMore);
    const errors = boxes.filter(b => b.error);
    return v_flex().id("mail-list").flex_1().min_h(0).overflow_y_scrollbar().p(6)
      .children(errors.map(b => this.notice(ids.length > 1 ? `${ACCOUNTS.find(a => this.boxes[a.id] === b).label}: ${b.error}` : b.error, t,
        (_e, cx) => this.refresh(cx, ids.find(id => this.boxes[id] === b)))))
      .when(empty && loading, e => e.children(Array.from({ length: 9 }, (_, i) => this.skeletonRow(i, t))))
      .when(Boolean(this.setupError), e => e.child(this.notice(this.setupError, t)))
      .when(empty && !loading && !errors.length && (ACCOUNTS.length > 0 || !this.setupLoaded), e => e.child(this.empty("mail", "Inbox is empty", t)))
      .when(this.setupLoaded && !ACCOUNTS.length, e => e.child(this.empty("mail", "No himalaya accounts found. Set one up in ~/.config/himalaya/config.toml", t)))
      .children(messages.map(m => this.row(m, t)))
      .when(hasMore && !empty, e => e.child(h_flex().h(44).flex_none().justify_center().items_center()
        .child(div().id("mail-more").h(28).px(12).gap(8).flex().items_center().rounded(7).border_1().border_color(t.border)
          .text_size(12).text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.loadOlder(cx))
          .when(more, e => e.child(svg(`${ICONS}/refresh.svg`).size(12).spin(900)))
          .child(more ? "Loading…" : "Load older"))));
  }

  results(t) {
    const s = this.search, local = compileSearch(s.text.trim()).test;
    // Until the server answers, what's already loaded and matches shows at once.
    const rows = s.results ?? this.accounts().flatMap(id => this.boxes[id].messages).filter(local).sort((a, b) => stamp(b) - stamp(a));
    return v_flex().id("mail-results").flex_1().min_h(0).overflow_y_scrollbar().p(6)
      .when(Boolean(s.error), e => e.child(this.notice(s.error, t, (_e, cx) => this.runSearch(cx))))
      .when(!rows.length && s.loading, e => e.children(Array.from({ length: 5 }, (_, i) => this.skeletonRow(i, t))))
      .when(!rows.length && !s.loading && !s.error, e => e.child(this.empty("search", "No messages match", t)))
      .children(rows.map(m => this.row(m, t)));
  }

  // ── reader ────────────────────────────────────────────────────────────────

  attachmentDir(m) { return `${appHome()}/${FILES}/${m.account}-${m.id}`; }

  // Only files over read.py's size limit still need fetching on demand.
  async download(m, a, dir) {
    const d = await himalaya(["--account", m.account, "attachment", "download", "--json", "-d", dir, String(m.id), a.id]);
    const path = d.attachments?.[0]?.path;
    if (!path) throw new Error("himalaya saved nothing");
    return path;
  }

  attachmentAction(m, a, action, cx) {
    if (a.busy) return;
    a.busy = action;
    cx.notify();
    cx.spawn(async cx => {
      try {
        if (action === "open") {
          if (!a.path) a.path = await this.download(m, a, this.attachmentDir(m));
          await openWith(a.path);
        } else {
          if (!a.path) a.path = await this.download(m, a, this.attachmentDir(m));
          // A local copy; a name already in Downloads gets " (2)", " (3)", ….
          const r = await exec("sh", ["-c", 'd="$HOME/Downloads"; mkdir -p "$d"; n="${2%.*}"; e="${2##*.}"; [ "$e" = "$2" ] && e="" || e=".$e"; t="$d/$2"; i=2; while [ -e "$t" ]; do t="$d/$n ($i)$e"; i=$((i+1)); done; cp "$1" "$t" && printf %s "${t##*/}"', "save", a.path, a.filename]);
          if (r.code !== 0) throw new Error(r.stderr || "copy failed");
          notify({ title: "Saved to Downloads", body: r.stdout, level: "success" });
        }
      } catch (e) {
        notify({ title: `Couldn't ${action} ${a.filename}`, body: String(e?.message || e).slice(0, 200), level: "error" });
      } finally { a.busy = null; cx.notify(); }
    });
  }

  openUrl(url) { openWith(url).catch(() => {}); }

  imageView(m, a, avail, t) {
    if (!a.path) return div().w(Math.min(avail, 260)).h(140).rounded(8).bg(t.raised).loop("opacity", { from: 0.35, to: 0.9, period: 1200 });
    const w = Math.max(40, Math.min(avail, a.dims?.w ?? avail)), h = a.dims ? Math.round(w * a.dims.h / a.dims.w) : 200;
    return div().id(`img-${a.id}`).w(w).h(h).flex_none().rounded(8).overflow_hidden().border_1().border_color(t.border).cursor_pointer()
      .tooltip(`Open ${a.filename}`).on_click((_e, cx) => this.attachmentAction(m, a, "open", cx))
      .child(image(a.path.slice(appHome().length + 1)).w(w).h(h));
  }

  // Draws parsed blocks; `fg` is the text color at this depth (quotes are quieter).
  blocks(m, list, t, avail, path, fg) {
    const files = this.bodies.get(keyOf(m))?.files ?? [];
    return list.map((b, i) => {
      const id = `${path}-${i}`;
      if (b.type === "p") return div().text_color(fg).child(b.text);
      if (b.type === "list") return v_flex().gap(5).text_color(fg).children(b.items.map((item, n) => h_flex().gap(8).items_start()
        .child(div().w(16).flex_none().text_color(t.dim).child(b.ordered ? `${n + 1}.` : "•"))
        .child(div().flex_1().min_w(0).child(item))));
      if (b.type === "link") return div().id(`link${id}`).max_w("100%").truncate().text_color(t.accent).cursor_pointer()
        .hover(s => s.underline()).tooltip("Open in browser").on_click(() => this.openUrl(b.url)).child(b.url);
      if (b.type === "sig") return div().text_size(11.5).line_height("17px").text_color(t.dim).child(b.text);
      if (b.type === "img") {
        const a = files.find(x => x.image && x.filename === b.name);
        if (a) return this.imageView(m, a, avail, t);
        return h_flex().self_start().px(8).py(3).gap(6).items_center().rounded(6).border_1().border_color(t.border).text_size(11).text_color(t.dim)
          .child(svg(`${ICONS}/paperclip.svg`).size(11)).child(`${b.name} (not included)`);
      }
      if (b.type === "forward") {
        const shown = b.headers.filter(([k]) => k === "From" || k === "Date" || k === "Subject" || k === "To");
        return v_flex().rounded(9).border_1().border_color(t.border).overflow_hidden()
          .child(v_flex().px(12).py(10).gap(4).bg(t.surface).border_b(1).border_color(t.border).line_height("17px")
            .child(h_flex().gap(6).pb(2).items_center().text_size(10.5).font_medium().text_color(t.dim)
              .child(svg(`${ICONS}/forward.svg`).size(11)).child("Forwarded message"))
            .children(shown.map(([k, v]) => {
              const who = /^(.*?)\s*<([^>]+)>$/.exec(v);
              return h_flex().gap(8).items_start().text_size(11.5)
                .child(div().w(50).flex_none().text_color(t.dim).child(k))
                .child(who && who[1]
                  ? h_flex().flex_1().min_w(0).gap(6).child(div().flex_none().text_color(t.foreground).font_medium().child(who[1].replace(/^"|"$/g, ""))).child(div().min_w(0).truncate().text_color(t.dim).child(who[2]))
                  : div().flex_1().min_w(0).text_color(k === "Subject" ? t.foreground : t.muted).when(k === "Subject", e => e.font_medium()).child(v));
            })))
          .child(v_flex().px(12).py(12).gap(12).children(this.blocks(m, b.children, t, avail - 26, id, t.foreground)));
      }
      // A quote that only wraps a forwarded message draws as that message.
      if (!b.attribution && b.children.length === 1 && b.children[0].type === "forward") return this.blocks(m, b.children, t, avail, id, fg)[0];
      // Reply history folds away behind its "On … wrote" line, as in most mail apps.
      const key = `${keyOf(m)}${id}`, open = !b.attribution || this.expanded.has(key);
      const bar = h_flex().items_stretch()
        .child(div().w(2).flex_none().rounded(1).bg(t.border))
        .child(v_flex().flex_1().min_w(0).pl(12).gap(12).children(this.blocks(m, b.children, t, avail - 14, id, t.muted)));
      if (!b.attribution) return bar;
      return v_flex().gap(10)
        .child(h_flex().id(`quote${id}`).self_start().max_w("100%").gap(8).items_center().cursor_pointer().text_size(11.5).text_color(t.dim)
          .hover(s => s.text_color(t.muted))
          .on_click((_e, cx) => { open ? this.expanded.delete(key) : this.expanded.add(key); cx.notify(); })
          .child(div().flex_none().px(6).h(16).flex().items_center().rounded(5).bg(t.raised).text_size(10).child(open ? "Hide" : "•••"))
          .child(div().min_w(0).truncate().child(b.attribution)))
        .when(open, e => e.child(bar));
    });
  }

  placedImages(list, out = new Set()) {
    for (const b of list) { if (b.type === "img") out.add(b.name); if (b.children) this.placedImages(b.children, out); }
    return out;
  }

  // A compact chip per file, under the sender: click opens, the arrow saves.
  attachmentChip(m, a, t) {
    const [icon, tint] = fileKind(a, t);
    return h_flex().id(`att-${a.id}`).h(34).max_w("100%").pl(5).pr(4).gap(8).items_center().rounded(8).border_1().border_color(t.border).bg(t.surface)
      .cursor_pointer().hover(s => s.bg(t.hover)).tooltip(`Open ${a.filename}`)
      .on_click((_e, cx) => this.attachmentAction(m, a, "open", cx))
      .child(a.busy === "open" ? div().size(24).flex_none().flex().items_center().justify_center().child(svg(`${ICONS}/refresh.svg`).size(12).spin(900).text_color(t.dim))
        : a.image && a.path ? div().size(24).flex_none().rounded(5).overflow_hidden().child(image(a.path.slice(appHome().length + 1)).size(24))
        : div().size(24).flex_none().rounded(5).bg(tint + "22").text_color(tint).flex().items_center().justify_center().child(svg(`${ICONS}/ft/${icon}.svg`).size(14)))
      .child(div().min_w(0).max_w(190).truncate().text_size(12).child(a.filename))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(size(a.size)))
      .child(div().id(`save-${a.id}`).size(24).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.dim).hover(s => s.bg(t.raised).text_color(t.foreground)).tooltip("Save to Downloads")
        .on_click((_e, cx) => { cx.stop_propagation(); this.attachmentAction(m, a, "save", cx); })
        .child(a.busy === "save" ? svg(`${ICONS}/refresh.svg`).size(11).spin(900) : svg(`${ICONS}/download.svg`).size(12)));
  }

  reader(t) {
    const m = this.selected, from = person(m.from), to = person(m.to);
    const body = this.bodies.get(keyOf(m)), avail = (this.width ?? 380) - 34, sent = this.sent[keyOf(m)];
    // Files go up top with the sender; inline pictures the text didn't place go after it.
    const placed = body ? this.placedImages(body.blocks) : new Set();
    const files = (body?.files ?? []).filter(a => !a.inline || !a.image);
    const loose = (body?.files ?? []).filter(a => a.inline && a.image && !placed.has(a.filename) && !(a.dims && a.dims.w < 48));
    return v_flex().id("mail-reader").flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().px(16).pt(14).pb(12).gap(12).border_b(1).border_color(t.border)
        .child(div().text_size(15).font_semibold().line_height("21px").child(m.subject || "(no subject)"))
        .child(h_flex().gap(10).items_center()
          .child(this.avatar(from, t, 34))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().text_size(12.5).font_semibold().child(from.name))
            .child(div().truncate().text_size(11.5).text_color(t.dim).child(from.email && from.email !== from.name ? from.email : `to ${to.name}`))
            .child(div().truncate().text_size(11.5).text_color(t.dim).child(fullDate(m.date)))))
        .when(files.length > 0, e => e.child(h_flex().flex_wrap().gap(6).children(files.map(a => this.attachmentChip(m, a, t)))))
        .when(Boolean(sent), e => e.child(h_flex().gap(6).items_center().text_size(11).text_color(t.accent)
          .child(svg(`${ICONS}/agent.svg`).size(12)).child(div().min_w(0).truncate().child(`Sent to ${sent?.label}`))
          .child(div().flex_none().text_color(t.dim).child(sent ? ago(sent.at) : "")))))
      .child(v_flex().px(16).py(14).gap(12).text_size(12.5).line_height("20px")
        .when(Boolean(this.bodyError), e => e.child(this.notice(this.bodyError, t, (_e, cx) => this.open(m, cx))))
        .when(!body && !this.bodyError, e => e.children([92, 100, 84, 96, 60, 0, 88, 72].map((w, i) => w
          ? div().h(9).w(`${w}%`).rounded(4).bg(t.raised).loop("opacity", { from: 0.35, to: 0.9, period: 1100 + i * 70 })
          : div().h(6))))
        .when(Boolean(body), e => e
          .when(body.blocks.length === 0, e => e.child(div().text_color(t.dim).child("This message has no readable text.")))
          .children(body ? this.blocks(m, body.blocks, t, avail, "b", t.foreground) : [])
          .children(loose.map(a => this.imageView(m, a, avail, t)))));
  }

  // ── send to agent ─────────────────────────────────────────────────────────

  openHandoff(m, cx) {
    const body = this.bodies.get(keyOf(m));
    if (!body) return;
    const chain = levels(body.blocks, { from: person(m.from), date: fullDate(m.date), subject: m.subject });
    const pick = requestIndex(chain, teammate);
    // Logos and signature icons aren't part of the request.
    const files = body.files.filter(a => !(a.inline && a.image && a.dims && (a.dims.w < 64 || a.dims.h < 64)));
    const h = this.handoff = {
      m, chain, pick, files, skip: new Set(), texts: new Map(), status: new Map(), extracting: null,
      target: null, picked: false, ranked: [], busy: false, error: null,
    };
    this.note.set_value(defaultNote(chain, pick));
    this.extract(h, cx);
    this.rank(h);
    cx.notify();
  }

  // Running agents, the ones whose space the mail talks about first (a client's site, the
  // project's name, where their last mail went). The best match is picked for you.
  rank(h) {
    let remembered = {};
    try { remembered = JSON.parse(localStorage.getItem("mail-inbox-spaces") || "{}"); } catch {}
    const folders = new Map(spaces().map(s => [s.id, s.folder]));
    const list = agents().map(a => ({ id: a.space_name, address: a.address, names: [a.space_name, (folders.get(a.space) ?? "").split("/").pop() || a.space_name] }));
    const own = TEAM.filter(x => x.startsWith("@")).map(x => x.slice(1).split(".").slice(-2, -1)[0]);
    const matched = suggest(list, h.chain, h.pick, remembered, own).map(x => x.address);
    h.ranked = [...new Set([...matched, ...list.map(x => x.address)])];
    if (!h.picked) h.target = matched[0] ?? (list.length === 1 ? list[0].address : null);
  }

  // Text copies of documents start as soon as the hand-off opens, so Send rarely waits.
  extract(h, cx) {
    const todo = h.files.filter(extractable);
    for (const a of todo) h.status.set(a.id, "busy");
    h.extracting = new Promise(resolve => cx.spawn(async cx => {
      for (const a of todo) {
        try {
          const r = await bounded(28, "python3", ["-I", `${appHome()}/${ICONS}/extract.py`, a.path]);
          const out = r.code === 0 ? r.stdout.trim() : "";
          if (out) h.texts.set(a.id, out);
        } catch {}
        h.status.set(a.id, h.texts.has(a.id) ? "done" : "none");
        cx.notify();
      }
      resolve();
    }));
  }

  send(cx) {
    const h = this.handoff, a = agents().find(x => x.address === h?.target);
    if (!h || h.busy || !a) return;
    h.busy = true; h.error = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        await h.extracting;
        const m = h.m, dir = this.attachmentDir(m), req = h.chain[h.pick];
        const files = h.files.filter(f => !h.skip.has(f.id));
        const { prompt, doc } = compose({ subject: m.subject, chain: h.chain, pick: h.pick, note: this.note.value(), files, texts: h.texts, dir, size });
        const path = `${dir}/mail.md`;
        let prev = null;
        try { prev = await readTextFile(path); } catch {}
        await writeTextFile(path, doc, prev);
        const r = await hc(["send", a.address, prompt]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "Couldn't reach that agent").trim().split("\n").pop().slice(0, 200));
        run("pane.focus", { terminal: a.address });
        if (req.from?.email && !teammate(req.from.email)) {
          let remembered = {};
          try { remembered = JSON.parse(localStorage.getItem("mail-inbox-spaces") || "{}"); } catch {}
          remembered[senderKey(req.from.email)] = a.space_name;
          localStorage.setItem("mail-inbox-spaces", JSON.stringify(remembered));
        }
        const label = `${a.program?.name ?? "agent"} in ${a.space_name}`;
        this.sent[keyOf(m)] = { label, at: Date.now() };
        localStorage.setItem("mail-inbox-sent", JSON.stringify(this.sent));
        if (this.handoff === h) this.handoff = null;
        notify({ title: "Sent to agent", body: label, level: "success" });
      } catch (e) {
        h.error = String(e?.message || e).slice(0, 220);
      } finally { h.busy = false; cx.notify(); }
    });
  }

  label(text, t) { return div().text_size(10.5).font_semibold().text_color(t.dim).child(text); }

  programIcon(p, t, s = 14) {
    if (!p?.icon) return svg(`${ICONS}/agent.svg`).size(s).flex_none().text_color(t.muted);
    return p.tint ? svg(p.icon).size(s).flex_none().text_color(t.foreground) : image(p.icon).size(s).flex_none();
  }

  levelRow(l, i, t) {
    const h = this.handoff, picked = i === h.pick;
    const role = i < h.pick ? "note" : picked ? "request" : "earlier";
    const first = l.text.split("\n").find(x => x.trim()) ?? "(no text)";
    return h_flex().id(`lvl-${i}`).h(40).flex_none().px(6).gap(9).items_center().rounded(7).cursor_pointer()
      .when(picked, e => e.bg(t.selected)).hover(s => s.bg(picked ? t.selected : t.hover))
      .on_click((_e, cx) => {
        if (h.pick !== i) { h.pick = i; this.note.set_value(defaultNote(h.chain, i)); this.rank(h); }
        cx.notify();
      })
      .child(this.avatar(l.from ?? { name: "?", email: "" }, t, 24))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().min_w(0).truncate().text_size(12).font_medium().child(l.from?.name ?? "Unknown sender"))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(i === 0 ? when(h.m.date) : shortDate(l.date))))
        .child(div().truncate().text_size(11).text_color(t.dim).child(first)))
      .child(div().flex_none().px(6).py(1).rounded(4).text_size(10)
        .bg(picked ? t.accent + "26" : t.raised).text_color(picked ? t.accent : t.dim).child(role));
  }

  fileToggle(a, h, t) {
    const on = !h.skip.has(a.id), [icon, tint] = fileKind(a, t), st = h.status.get(a.id);
    return h_flex().id(`hf-${a.id}`).h(32).flex_none().px(6).gap(9).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { if (on) h.skip.add(a.id); else h.skip.delete(a.id); cx.notify(); })
      .child(div().size(15).flex_none().rounded(4).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.surface)
        .flex().items_center().justify_center().when(on, e => e.child(svg(`${ICONS}/check.svg`).size(11).text_color(t.accent_foreground))))
      .child(a.image && a.path ? div().size(22).flex_none().rounded(5).overflow_hidden().child(image(a.path.slice(appHome().length + 1)).size(22))
        : div().size(22).flex_none().rounded(5).bg(tint + "22").text_color(tint).flex().items_center().justify_center().child(svg(`${ICONS}/ft/${icon}.svg`).size(13)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(on ? t.foreground : t.dim).child(a.filename))
      .when(st === "busy", e => e.child(svg(`${ICONS}/refresh.svg`).size(11).flex_none().spin(900).text_color(t.dim)))
      .when(st === "done", e => e.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child("text")))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(st === "busy" ? "reading" : size(a.size)));
  }

  agentRow(a, h, t) {
    const active = h.target === a.address;
    const dot = { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle }[a.status] ?? t.dim;
    return h_flex().id(`ra-${a.address}`).h(42).flex_none().px(8).gap(10).items_center().rounded(8).cursor_pointer()
      .border_1().border_color(active ? t.accent : "#00000000").when(active, e => e.bg(t.selected)).hover(s => s.bg(active ? t.selected : t.hover))
      .on_click((_e, cx) => { h.target = a.address; h.picked = true; cx.notify(); })
      .child(div().size(26).flex_none().rounded(7).bg(t.raised).flex().items_center().justify_center().child(this.programIcon(a.program, t, 14)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12).text_color(active ? t.foreground : t.muted).when(active, e => e.font_medium()).child(a.title || a.program.name))
        .child(h_flex().min_w(0).gap(6).text_size(11)
          .child(div().flex_none().text_color(t.muted).child(a.space_name))
          .child(div().min_w(0).truncate().text_color(t.dim).child(a.tab_name))))
      .child(h_flex().flex_none().gap(5).items_center().text_size(10.5).text_color(t.dim)
        .child(div().size(6).rounded_full().bg(dot)).child(a.status));
  }

  handoffView(t) {
    const h = this.handoff, req = h.chain[h.pick];
    const live = new Map(agents().map(a => [a.address, a]));
    // Agents that started after the hand-off opened go to the end.
    const list = [...h.ranked.filter(x => live.has(x)), ...[...live.keys()].filter(x => !h.ranked.includes(x))].map(x => live.get(x));
    const target = live.get(h.target);
    const ready = Boolean(target) && !h.busy;
    const included = h.files.filter(a => !h.skip.has(a.id)).length;
    const waiting = [...h.status.values()].some(s => s === "busy");
    const action = target ? `Send to ${target.program.name} in ${target.space_name}` : list.length ? "Pick an agent" : "No agent running";

    const content = v_flex().id(`mail-handoff-${keyOf(h.m)}`).flex_1().min_h(0).overflow_y_scrollbar().px(16).py(14).gap(18)
      .child(v_flex().gap(8)
        .child(this.label("Request", t))
        .when(h.chain.length > 1, e => e.child(v_flex().gap(2).children(h.chain.slice(0, 8).map((l, i) => this.levelRow(l, i, t)))))
        .child(div().max_h(170).overflow_hidden().px(11).py(9).rounded(8).border_1().border_color(t.border).bg(t.surface)
          .text_size(12).line_height("18px").text_color(t.muted).child(req.text.trim().slice(0, 4000) || "(no text)")))
      .when(h.files.length > 0, e => e.child(v_flex().gap(4)
        .child(h_flex().justify_between().child(this.label("Attachments", t))
          .child(div().text_size(10.5).text_color(t.dim).child(`${included} of ${h.files.length}`)))
        .children(h.files.map(a => this.fileToggle(a, h, t)))))
      .child(v_flex().gap(4)
        .child(this.label("Agent", t))
        .when(!list.length, e => e.child(v_flex().py(18).gap(8).items_center().rounded(8).border_1().border_color(t.border)
          .child(svg(`${ICONS}/agent.svg`).size(20).text_color(t.dim))
          .child(div().text_size(12).text_color(t.dim).child("No agent is running. Start one, and it shows up here."))))
        .children(list.map(a => this.agentRow(a, h, t))));

    // The note sits with Send, outside the scrolling part: a textarea scrolls its container
    // to its caret, which would yank the request out of view.
    const footer = v_flex().flex_none().px(16).pt(12).pb(12).gap(8).border_t(1).border_color(t.border)
      .child(this.label("Note for the agent", t))
      .child(div().id("handoff-note").px(9).py(6).rounded(8).border_1().border_color(t.border).bg(t.surface).cursor_text()
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.note.focus(); })
        .child(Textarea.new(this.note).text_size(12.5).text_color(t.foreground)))
      .when(Boolean(h.error), e => e.child(div().text_size(11.5).text_color(t.blocked).child(h.error)))
      .child(h_flex().id("handoff-send").h(34).gap(8).justify_center().items_center().rounded(8).text_size(12.5).font_medium()
        .bg(ready || h.busy ? t.solid : t.raised).text_color(ready || h.busy ? t.solid_foreground : t.dim)
        .when(ready, e => e.cursor_pointer().hover(s => s.opacity(0.9)))
        .on_click((_e, cx) => this.send(cx))
        .child(h.busy ? svg(`${ICONS}/refresh.svg`).size(13).spin(900) : svg(`${ICONS}/send.svg`).size(13))
        .child(div().truncate().child(h.busy ? (waiting ? "Reading attachments…" : "Sending…") : action)));

    return v_flex().flex_1().min_h(0).child(content).child(footer);
  }

  menuItem(view, t) {
    const a = ACCOUNTS.find(x => x.id === view), active = this.view === view;
    const n = this.unread(view === ALL ? ACCOUNTS.map(x => x.id) : [view]);
    return h_flex().id(`mail-view-${view}`).h(44).px(8).gap(10).items_center().rounded(7).cursor_pointer()
      .when(active, e => e.bg(t.selected)).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => this.selectView(view, cx))
      .child(this.viewIcon(view, t, 26))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12.5).font_medium().child(a ? a.label : "All inboxes"))
        .child(div().truncate().text_size(11).text_color(t.dim).child(a ? a.email : `${ACCOUNTS.length} accounts`)))
      .when(n > 0, e => e.child(div().flex_none().px(6).rounded(4).text_size(10.5).bg(t.accent + "26").text_color(t.accent).child(String(n))))
      .child(div().w(14).flex_none().when(active, e => e.child(svg(`${ICONS}/check.svg`).size(13).text_color(t.accent))));
  }

  render(cx) {
    const t = theme(), ids = this.accounts(), searching = Boolean(this.search.text.trim());
    const boxes = ids.map(id => this.boxes[id]);
    const fetching = boxes.some(b => b.loading && !b.more) || this.search.loading;
    const current = ACCOUNTS.find(a => a.id === this.view);
    const unread = this.unread(ids);

    const switcher = h_flex().id("mail-switcher").min_w(0).h(30).pl(4).pr(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.menu, e => e.bg(t.hover)).hover(s => s.bg(t.hover))
      .child(this.viewIcon(this.view, t, 22))
      .child(div().min_w(0).truncate().font_semibold().child(current ? current.label : "All inboxes"))
      .when(unread > 0, e => e.child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${unread} unread`)))
      .child(svg(`${ICONS}/chevron.svg`).size(12).flex_none().text_color(t.dim));

    // A popover draws in its own layer, so presses on it never reach the rows beneath.
    const menu = v_flex().mt(4).w(260).p(4).gap(2).rounded(9).bg(t.popover).border_1().border_color(t.border).shadow_lg()
      .child(this.menuItem(ALL, t))
      .child(div().h(1).mx(6).my(2).bg(t.border))
      .children(ACCOUNTS.map(a => this.menuItem(a.id, t)));

    const loaded = this.selected && this.bodies.has(keyOf(this.selected));
    const header = h_flex().h(42).flex_none().pl(this.selected ? 14 : 8).pr(14).gap(6).items_center().border_b(1).border_color(t.border)
      .when(Boolean(this.selected), e => e
        .child(div().id("mail-back").w(20).cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => { if (this.handoff) this.handoff = null; else { this.selected = null; this.bodyError = null; } cx.notify(); }).child("←"))
        .child(div().font_semibold().child(this.handoff ? "Send to agent" : searching ? "Search" : current ? current.label : "Inbox")))
      .when(!this.selected, e => e.child(Popover.new("mail-switch").open(this.menu)
        .on_open_change((open, cx) => { this.menu = open; cx.notify(); })
        .trigger(switcher).content(menu)))
      .child(div().flex_1())
      .when(Boolean(this.selected) && !this.handoff, e => e.child(h_flex().id("mail-to-agent").h(26).px(9).gap(6).items_center().rounded(7)
        .border_1().border_color(t.border).text_size(12).text_color(loaded ? t.foreground : t.dim)
        .when(loaded, e => e.cursor_pointer().hover(s => s.bg(t.hover)))
        .tooltip("Give this mail to an agent")
        .on_click((_e, cx) => this.openHandoff(this.selected, cx))
        .child(svg(`${ICONS}/agent.svg`).size(13)).child("Send to agent")))
      .when(!this.handoff, e => e.child(div().id("mail-refresh").text_color(fetching ? t.foreground : t.dim).hover(s => s.text_color(t.foreground)).cursor_pointer()
        .tooltip(fetching ? "Checking for mail…" : "Refresh")
        .on_click((_e, cx) => { for (const id of ids) this.refresh(cx, id); if (searching) this.runSearch(cx); })
        .child(svg(`${ICONS}/refresh.svg`).size(14).when(fetching, el => el.spin(900)))));

    const search = h_flex().flex_none().p(8).border_b(1).border_color(t.border)
      .child(h_flex().id("mail-search").flex_1().min_w(0).h(30).px(9).gap(7).items_center().rounded(8).border_1()
        .border_color(this.typing ? t.accent : t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.input.focus(); })
        .child(svg(`${ICONS}/search.svg`).size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).child(Input.new(this.input).h(28).text_size(12).text_color(t.foreground)))
        .when(searching, e => e.child(div().id("mail-clear").size(18).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.clearSearch(cx)).child(svg(`${ICONS}/x.svg`).size(11)))));

    const updated = boxes.length ? Math.min(...boxes.map(b => b.updated || 0)) : 0;
    const s = this.search, count = s.results?.length;
    const status = h_flex().h(26).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
      .child(div().flex_1().truncate().child(searching
        ? (s.loading ? "Searching the server…" : count === undefined ? "" : `${count}${s.capped ? "+" : ""} result${count === 1 ? "" : "s"}${s.capped ? ", showing the newest" : ""}`)
        : `${this.visible().length} messages`))
      .when(!searching, e => e.child(div().child(fetching ? "Checking…" : updated ? `Updated ${ago(updated)}` : "")))
      .when(searching && !s.loading, e => e.child(div().child("from: subject: is:unread after:")));


    return v_flex().id("mail-inbox").size_full().min_w(0).min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs((this.width ?? 0) - size.width) > 1) { this.width = size.width; cx.notify(); } })
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.handoff) this.handoff = null;
        else if (this.selected) this.selected = null;
        else if (this.typing || searching) { this.clearSearch(cx); this.handle.focus(); }
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(header)
      .when(!this.selected, e => e.child(search).child(searching ? this.results(t) : this.list(t)).child(status))
      .when(Boolean(this.selected) && !this.handoff, e => e.child(this.reader(t)))
      .when(Boolean(this.handoff), e => e.child(this.handoffView(t)));
  }
}
