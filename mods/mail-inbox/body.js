// Turns a mail's text into blocks the reader can draw: paragraphs, lists, quotes (with the
// "On … wrote:" line that opens them), forwarded-message cards, signatures, links and the
// places inline images sit.

const FORWARD = /^\s*(?:-{2,}\s*(?:forwarded message|original message|původní e.?mail|původní zpráva|přeposlaná zpráva)\s*-*|begin forwarded message:?)\s*$/i;
const HEADER = /^\s*(from|to|cc|subject|date|sent|reply-to|od|komu|kopie|datum|předmět|odesláno|odpovědět komu):\s*(.*)$/i;
// eM Client writes the forward's headers without colons ("Od "Jana Nováková" <…>"); only right after a
// forward line is that read as a header.
const LOOSE_HEADER = /^\s*(from|to|cc|subject|date|sent|od|komu|kopie|datum|předmět|odesláno)\s*:?\s+(.*)$/i;
const LABEL = { od: "From", komu: "To", kopie: "Cc", datum: "Date", "předmět": "Subject", "odesláno": "Date", sent: "Date", "odpovědět komu": "Reply-To" };
const ATTRIBUTION = /(?:wrote|napsal\(a\)|napsala?|schrieb|a écrit|escribió)\s*:\s*$/i;
const IMAGE = /^\s*(?:<([^<>]+\.(?:png|jpe?g|gif|webp|heic|bmp))>|\[(?:image|obrázek|cid):\s*([^\]]+)\])\s*$/i;
const URL_LINE = /^\s*<?(https?:\/\/[^\s<>]+?)>?\s*$/;
const ITEM = /^\s*(?:[-*•–]|\d{1,2}[.)])\s+/;
const QUOTED = /^\s*>/;
const SIGNATURE = /^--\s?$/;

export function htmlText(html) {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|section|article|table)>/gi, "\n")
    .replace(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>\s*<\/a>/gi, " $1 ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&zwnj;|&#8204;/gi, "")
    .replace(/&#(\d+);/g, (_m, n) => { const c = Number(n); return c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ""; })
    .replace(/&#x([\da-f]+);/gi, (_m, n) => { const c = parseInt(n, 16); return c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ""; })
    .replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

// "marekadler.cz <http://marekadler.cz/>" says the address twice; keep it once.
function tidy(text) {
  return text.replace(/(\S+@\S+?)\s*<mailto:\1>/gi, "$1").replace(/(\S+)\s*<(https?:\/\/[^>\s]+)>/g, (_m, word, url) =>
    url.toLowerCase().includes(word.replace(/[.,;:)]+$/, "").toLowerCase()) ? word : `${word} ${url}`);
}

// Lines hard-wrapped around 72 columns read as one paragraph; anything else keeps its breaks.
function joinLines(lines) {
  const wrapped = lines.length > 1 && lines.slice(0, -1).every(l => l.length >= 55 && l.length <= 80);
  return tidy(lines.map(l => l.trim()).join(wrapped ? " " : "\n"));
}

function paragraph(lines, out) {
  let run = [], list = null;
  const flush = () => { if (run.length) out.push({ type: "p", text: joinLines(run) }); run = []; };
  for (const line of lines) {
    if (ITEM.test(line)) {
      flush();
      if (!list) { list = { type: "list", ordered: /^\s*\d/.test(line), items: [] }; out.push(list); }
      list.items.push(tidy(line.replace(ITEM, "").trim()));
    } else if (list) {
      // A line right under an item, with no blank between, belongs to it.
      list.items[list.items.length - 1] += `\n${tidy(line.trim())}`;
    } else run.push(line);
  }
  flush();
}

function parse(lines, depth) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (QUOTED.test(line)) {
      const inner = [];
      while (i < lines.length && (QUOTED.test(lines[i]) || (!lines[i].trim() && QUOTED.test(lines[i + 1] ?? "")))) inner.push(lines[i++].replace(/^\s*> ?/, ""));
      const children = depth < 8 ? parse(inner, depth + 1) : [{ type: "p", text: inner.join("\n") }];
      // "On …, X wrote:" sits just before the quote, or as its own first line.
      let attribution = null;
      const prev = out[out.length - 1];
      if (prev?.type === "p" && ATTRIBUTION.test(prev.text)) attribution = out.pop().text;
      else if (children[0]?.type === "p" && ATTRIBUTION.test(children[0].text)) attribution = children.shift().text;
      out.push({ type: "quote", attribution: attribution?.replace(/\s+/g, " ").replace(/:\s*$/, ""), children });
      continue;
    }

    const headerStart = HEADER.test(line) && /^\s*(from|od):/i.test(line) && lines.slice(i + 1, i + 6).some(l => /^\s*(subject|předmět):/i.test(l));
    if (FORWARD.test(line) || headerStart) {
      if (FORWARD.test(line)) i++;
      while (i < lines.length && !lines[i].trim()) i++;
      const headers = [], rule = FORWARD.test(line) ? LOOSE_HEADER : HEADER;
      while (i < lines.length && rule.test(lines[i])) {
        const [, key, value] = rule.exec(lines[i++]);
        const label = LABEL[key.toLowerCase()] ?? key[0].toUpperCase() + key.slice(1).toLowerCase();
        if (value.trim()) headers.push([label, tidy(value.trim())]);
      }
      // Everything after a forward header is the forwarded message.
      out.push({ type: "forward", headers, children: parse(lines.slice(i), depth + 1) });
      break;
    }

    if (SIGNATURE.test(line)) {
      i++;
      const sig = [];
      while (i < lines.length && !QUOTED.test(lines[i]) && !FORWARD.test(lines[i])) sig.push(lines[i++]);
      const text = sig.join("\n").trim();
      if (text) out.push({ type: "sig", text });
      continue;
    }

    const image = IMAGE.exec(line);
    if (image) { out.push({ type: "img", name: (image[1] || image[2]).trim() }); i++; continue; }
    const url = URL_LINE.exec(line);
    if (url) { out.push({ type: "link", url: url[1] }); i++; continue; }

    const run = [];
    while (i < lines.length && lines[i].trim() && !QUOTED.test(lines[i]) && !FORWARD.test(lines[i]) && !SIGNATURE.test(lines[i])
      && !IMAGE.test(lines[i]) && !(run.length && URL_LINE.test(lines[i]))) run.push(lines[i++]);
    paragraph(run, out);
  }
  return out;
}

// `slim` is what read.py prints: { text, html, files }.
export function bodyOf(slim) {
  const text = slim.text ?? (slim.html ? htmlText(slim.html) : null);
  if (text === null) return { blocks: [] };
  // U+FFFC is where Apple Mail had an inline object; the <name> line already marks it.
  const lines = text.replace(/\r\n?/g, "\n").replace(/[\uFFFC\u200B\u00AD\u034F]/g, "").slice(0, 80_000).split("\n").slice(0, 3000);
  return { blocks: parse(lines, 0) };
}

// ---- For agents: the email as markdown, and which message in a forward chain is the request.

export function markdown(list) {
  const out = [];
  for (const b of list) {
    if (b.type === "p") out.push(b.text);
    else if (b.type === "list") out.push(b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : "-"} ${it.replace(/\n/g, "\n  ")}`).join("\n"));
    else if (b.type === "link") out.push(b.url);
    else if (b.type === "img") out.push(`[image: ${b.name}]`);
    else if (b.type === "quote") {
      const inner = markdown(b.children);
      if (inner) out.push((b.attribution ? `${b.attribution}:\n` : "") + inner.split("\n").map(l => (l ? `> ${l}` : ">")).join("\n"));
    } else if (b.type === "forward")
      out.push(["---------- Forwarded message ----------", ...b.headers.map(([k, v]) => `${k}: ${v}`), "", markdown(b.children)].join("\n"));
    // Signatures stay out: an agent needs the request, not the phone numbers.
  }
  return out.filter(Boolean).join("\n\n");
}

const EMAIL = /<?([^\s<>"'(),;:]+@[^\s<>"'(),;:]+\.[a-z]{2,})>?/i;

function personOf(value) {
  if (!value) return null;
  const m = EMAIL.exec(value);
  const email = m ? m[1].toLowerCase() : "";
  const name = value.replace(EMAIL, "").replace(/["']/g, "").trim();
  return { name: name || email || "Unknown sender", email };
}

// "On 25. 10. 2026, at 16:55, Jan Novák <jan@…> wrote" → the person and the date.
function replier(attribution) {
  const m = EMAIL.exec(attribution);
  let before = (m ? attribution.slice(0, m.index) : attribution.replace(ATTRIBUTION, "")).trim();
  const date = /^(?:on|dne|am|le|el)\s+(.+?\d{1,2}:\d{2}(?::\d{2})?)/i.exec(before)?.[1] ?? null;
  before = before.replace(/^.*\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]m)?\s*,?\s*/i, "").replace(/^(?:on|dne|am|le|el)\s+/i, "").replace(/[,"']/g, " ").trim();
  return { from: { name: before.split(/\s{2,}/).pop() || (m ? m[1] : "Someone"), email: m ? m[1].toLowerCase() : "" }, date };
}

// The message quoted or forwarded inside these blocks, if any. Apple Mail quotes its
// forwards ("> Begin forwarded message:"), so a quote holding only a forward is that forward.
function nested(blocks) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "forward") return { at: i, kind: "forward", node: b, children: b.children };
    if (b.type === "quote" && !b.attribution && b.children[0]?.type === "forward")
      return { at: i, kind: "forward", node: b.children[0], children: [...b.children[0].children, ...b.children.slice(1)] };
    if (b.type === "quote" && b.attribution) return { at: i, kind: "reply", node: b, children: b.children };
  }
  return null;
}

// After "S pozdravem" / "Best regards" and the name, a block of phones, addresses and links
// is the signature: the agent gets the name, not the business card.
const SIGN_OFF = /^(?:s pozdravem|se srdečným pozdravem|s přáním|s úctou|děkuji|díky|best|best regards|kind regards|regards|thanks|thank you|cheers|mit freundlichen grüßen)\b.{0,40}$/i;
const CONTACT = /(\+?\d[\d ]{7,}\d)|@|www\.|https?:|\b(?:s\.r\.o|a\.s|spol|tel|mobil|ičo?|dič)\b|\d{3} ?\d{2}\b/i;
function trimSignature(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!SIGN_OFF.test(lines[i].trim())) continue;
    let keep = i + 1, names = 0;
    while (keep < lines.length && names < 2) { if (lines[keep].trim()) { if (CONTACT.test(lines[keep])) break; names++; } keep++; }
    const tail = lines.slice(keep);
    if (tail.some(l => l.trim()) && tail.some(l => CONTACT.test(l))) return lines.slice(0, keep).join("\n").trim();
    break;
  }
  return text;
}

// Every message in the chain, outermost first: who wrote it, when, and its own text
// (without what it quotes or forwards, and without signatures).
export function levels(blocks, top) {
  const out = [];
  let level = { kind: "top", from: top.from, date: top.date, subject: top.subject }, list = blocks;
  for (let guard = 0; guard < 12; guard++) {
    const inner = nested(list);
    const own = inner ? [...list.slice(0, inner.at), ...list.slice(inner.at + 1)] : list;
    out.push({ ...level, text: trimSignature(markdown(own.filter(b => b.type !== "sig"))) });
    if (!inner) break;
    if (inner.kind === "forward") {
      const h = Object.fromEntries(inner.node.headers.map(([k, v]) => [k.toLowerCase(), v]));
      level = { kind: "forward", from: personOf(h.from), date: h.date ?? null, subject: h.subject ?? null };
    } else level = { kind: "reply", ...replier(inner.node.attribution), subject: null };
    list = inner.children;
  }
  return out;
}

// Notes ride on top of the request: the team's ("pls fix"), or anyone's few words on a
// forward ("see below"). The first message that is neither is the request. With only notes,
// short ones that forward something are passed down.
export function requestIndex(chain, internal) {
  const note = (l, i) => !l.text.trim() || internal(l.from?.email) || (l.text.length < 280 && chain[i + 1]?.kind === "forward");
  const request = chain.findIndex((l, i) => !note(l, i));
  if (request >= 0) return request;
  let i = 0;
  while (i < chain.length - 1 && chain[i].text.length < 280 && chain[i + 1].kind === "forward") i++;
  return i;
}
