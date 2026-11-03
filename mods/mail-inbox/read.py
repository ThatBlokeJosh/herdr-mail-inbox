"""read.py <account> <id> <dir>: reads one message with himalaya, writes its attachments and a
slim message.json into <dir>, and prints that JSON.

himalaya's --json carries every attachment as a list of byte values, which for a few megabytes
of files outgrows what Herdr's exec returns; here the bytes go to disk and only text comes back.
"""
import json, os, subprocess, sys

account, mid, out = sys.argv[1], sys.argv[2], sys.argv[3]
MAX_FILE = 40 * 1024 * 1024

try:
    raw = subprocess.run(["himalaya", "--account", account, "message", "read", "--json", mid],
                         capture_output=True, timeout=25)
except subprocess.TimeoutExpired:
    sys.stderr.write("Mail server didn't answer in time. Is the keyring unlocked?\n"); sys.exit(124)
if raw.returncode != 0:
    sys.stderr.write((raw.stderr or raw.stdout).decode("utf-8", "replace")); sys.exit(raw.returncode)
msg = json.loads(raw.stdout)


def header(part, name):
    for h in part.get("headers", []):
        if h.get("name") == name:
            return h.get("value")


def ctype(part, name):
    value = header(part, name)
    return value.get("ContentType") if isinstance(value, dict) else None


def attr(ct, key):
    for a in (ct or {}).get("attributes") or []:
        if a.get("name", "").lower() == key:
            return a.get("value")


def dims(data):
    """Pixel size from the header bytes of a PNG, GIF or JPEG."""
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
        if data[:6] in (b"GIF87a", b"GIF89a"):
            return int.from_bytes(data[6:8], "little"), int.from_bytes(data[8:10], "little")
        if data[:2] == b"\xff\xd8":
            i = 2
            while i + 9 < len(data):
                if data[i] != 0xFF:
                    i += 1; continue
                marker, length = data[i + 1], int.from_bytes(data[i + 2:i + 4], "big")
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
                i += 2 + length
    except Exception:
        pass
    return None


def text_of(indices, kind):
    for i in indices or []:
        body = (msg["parts"][i].get("body") or {}).get(kind)
        if isinstance(body, str) and body.strip():
            return body


os.makedirs(out, exist_ok=True)
files, used = [], set()
for i in msg.get("attachments") or []:
    part = msg["parts"][i]
    body = part.get("body") or {}
    data = body.get("Binary")
    if data is None and isinstance(body.get("Text"), str):
        data = body["Text"].encode()
    if data is None:
        continue
    data = bytes(data) if isinstance(data, list) else data
    ct, cd = ctype(part, "content_type"), ctype(part, "content_disposition")
    mime = f"{ct.get('c_type')}/{ct.get('c_subtype')}" if ct else "application/octet-stream"
    name = os.path.basename(attr(cd, "filename") or attr(ct, "name") or f"part-{i + 1}")
    stem, ext = os.path.splitext(name)
    n, unique = 1, name
    while unique in used:
        n += 1; unique = f"{stem} ({n}){ext}"
    used.add(unique)
    path = None
    if len(data) <= MAX_FILE:
        path = os.path.join(out, unique)
        if not os.path.exists(path) or os.path.getsize(path) != len(data):
            with open(path, "wb") as f:
                f.write(data)
    size = dims(data) if mime.startswith("image/") else None
    files.append({"id": str(i + 1), "filename": name, "mime": mime, "size": len(data),
                  "inline": bool(cd and cd.get("c_type") == "inline"), "path": path,
                  "w": size[0] if size else None, "h": size[1] if size else None})

slim = {"text": text_of(msg.get("text_body"), "Text"), "html": None, "files": files}
if slim["text"] is None:
    slim["html"] = text_of(msg.get("html_body"), "Html")
encoded = json.dumps(slim, ensure_ascii=False)
with open(os.path.join(out, "message.json.tmp"), "w") as f:
    f.write(encoded)
os.replace(os.path.join(out, "message.json.tmp"), os.path.join(out, "message.json"))
print(encoded)
