// Hands a mail to an agent: the request goes straight into the prompt, the attachments and
// the rest of the thread wait in the message's folder (mail.md beside the files).

// Past this the prompt carries a start and points at mail.md for the rest.
const PROMPT_REQUEST = 6000;
// Mail providers say nothing about which project a sender belongs to.
const GENERIC = new Set(["gmail", "googlemail", "seznam", "email", "centrum", "atlas", "volny", "post", "outlook", "hotmail", "live",
  "icloud", "me", "yahoo", "proton", "protonmail", "tiscali", "quick", "anonaddy", "mailto", "www", "http", "https"]);
const EXTRACTS = /\.(pdf|docx?|odt|rtf|pages|wps|xlsx?|xlsm|ods|numbers|pptx?|odp|key)$/i;

export const extractable = a => Boolean(a.path) && EXTRACTS.test(a.filename ?? "");

// Notes from the team above the request, newest first, become the instruction.
export function defaultNote(chain, pick) {
  const notes = chain.slice(0, pick).filter(l => l.text.trim());
  if (notes.length <= 1) return notes[0]?.text.trim() ?? "";
  return notes.map(l => `${l.from?.name ?? "Someone"}: ${l.text.trim()}`).join("\n");
}

const norm = s => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (s, skip) => norm(s).split(/[^a-z0-9]+/).filter(w => w && !skip(w));
function domains(s, skip) {
  const out = new Set();
  for (const [d] of norm(s).matchAll(/(?:[a-z0-9-]+\.)+[a-z]{2,}/g)) {
    const parts = d.split(".").filter(p => !skip(p));
    if (parts.length >= 2) out.add(parts[parts.length - 2].replace(/-/g, ""));
  }
  return out;
}

// gmail.com, seznam.cz, …: a domain anyone can have an address at.
export const publicDomain = domain => GENERIC.has((domain ?? "").toLowerCase().split(".").slice(-2, -1)[0]);

// Where a sender's mail should go next time: their company's domain, or for a Gmail
// address, the address itself.
export function senderKey(email) {
  const domain = (email ?? "").split("@")[1] ?? "";
  return publicDomain(domain) ? email : domain;
}

// Places ({ id, names }: running agents by their space) ranked by how much the mail talks about them: sites it links, the
// sender's domain, the project's name in the text. The request counts most; a message that
// links one site is about it, one listing ten (references, say) is about none of them.
// `ignore`: words that say nothing here, like the team's own domain in every signature.
export function suggest(places, chain, pick, remembered, ignore = []) {
  const req = chain[pick], sites = new Map(), named = [];
  const stop = new Set(ignore.map(norm)), skip = w => GENERIC.has(w) || stop.has(w);
  chain.forEach((l, i) => {
    const weight = i === pick ? 1 : 0.4;
    const text = i === pick ? `${req.subject ?? chain[0].subject ?? ""} ${l.text} ${l.from?.email ?? ""}` : l.text;
    const d = domains(text, skip);
    for (const x of d) sites.set(x, (sites.get(x) ?? 0) + weight / d.size);
    const ws = words(text, skip);
    named.push({ weight, ws: new Set(ws), pairs: new Set(ws.slice(1).map((w, j) => ws[j] + w)) });
  });
  const pinned = remembered[senderKey(req.from?.email ?? "")];
  const scoreName = raw => {
    const name = norm(raw), n = name.replace(/[^a-z0-9]/g, "");
    const parts = name.split(/[^a-z0-9]+/).filter(p => p.length >= 5 && p !== n);
    let score = 0;
    if (n.length >= 3) {
      for (const [d, w] of sites)
        if (d === n) score += 10 * w;
        else if (Math.min(d.length, n.length) >= 5 && (d.startsWith(n) || n.startsWith(d))) score += 6 * w;
      for (const s of named) {
        if (s.ws.has(n) || s.pairs.has(n)) score += 6 * s.weight;
        for (const p of parts) if (s.ws.has(p)) score += 2 * s.weight;
      }
    }
    return score;
  };
  return places.map(p => ({ p, score: (p.id === pinned ? 100 : 0) + Math.max(...p.names.map(scoreName)) }))
    .filter(x => x.score >= 2).sort((a, b) => b.score - a.score).map(x => x.p);
}

const said = l => `${l.from?.name ?? "Someone"}${l.from?.email && l.from.email !== l.from.name ? ` <${l.from.email}>` : ""}`;
const fileName = a => (a.path ?? a.filename).split("/").pop();

function fileLine(a, size, text, wrap) {
  const bits = [size(a.size)];
  if (/^image\//i.test(a.mime ?? "")) bits.push("image");
  if (text) bits.push(`text copy: ${wrap(text.split("/").pop())}`);
  if (!a.path) bits.push("not downloaded, too large");
  return `- ${wrap(fileName(a))} (${bits.join(", ")})`;
}

// { prompt, doc }: what the agent is started with, and mail.md for everything around it.
export function compose({ subject, chain, pick, note, files, texts, dir, size }) {
  const req = chain[pick];
  const head = [said(req), req.date, `"${req.subject ?? subject ?? "(no subject)"}"`].filter(Boolean).join(", ");
  const text = req.text.trim() || "(no text)";
  const notes = chain.slice(0, pick).filter(l => l.text.trim());
  const earlier = chain.slice(pick + 1).filter(l => l.text.trim());

  const doc = [`# ${subject || "(no subject)"}`, "", "## Request", "", `From: ${said(req)}`];
  if (req.date) doc.push(`Date: ${req.date}`);
  doc.push(`Subject: ${req.subject ?? subject}`, "", text);
  if (notes.length) doc.push("", "## Notes above it, newest first", "", ...notes.flatMap(l => [`**${said(l)}**${l.date ? `, ${l.date}` : ""}:`, l.text.trim(), ""]));
  if (files.length) doc.push("", "## Attachments", "", `In ${dir}/`, "", ...files.map(a => fileLine(a, size, texts.get(a.id), s => `\`${s}\``)));
  if (earlier.length) doc.push("", "## Earlier in the thread, newest first", "", ...earlier.flatMap(l => [`### ${said(l)}${l.date ? `, ${l.date}` : ""}`, "", l.text.trim(), ""]));

  const prompt = [];
  if (note.trim()) prompt.push(note.trim(), "");
  prompt.push(`Request from ${head}:`, "");
  prompt.push(text.length > PROMPT_REQUEST ? `${text.slice(0, 1500).trim()}\n…\n(It goes on: read the whole request in ${dir}/mail.md first.)` : text);
  if (files.length) prompt.push("", `Attachments, in ${dir}/ (open them when the request needs them):`, ...files.map(a => fileLine(a, size, texts.get(a.id), s => `"${s}"`)));
  if (notes.length > 1 || earlier.length) prompt.push("", `The rest of the thread is in ${dir}/mail.md.`);
  return { prompt: prompt.join("\n"), doc: doc.join("\n").replace(/\n{3,}/g, "\n\n") + "\n" };
}
