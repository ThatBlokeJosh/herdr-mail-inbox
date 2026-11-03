"""extract.py <file>: writes a plain-text copy beside an attachment an agent can't read as is
(Word and the like through LibreOffice, every sheet of a spreadsheet as CSV, slides and PDFs
through pdftotext) as <file>.txt, and prints that path, or nothing when there's no text to get.
An existing copy is reused: attachments never change.
"""
import glob, os, shutil, subprocess, sys, tempfile

src = sys.argv[1]
out = src + ".txt"
ext = os.path.splitext(src)[1].lower().lstrip(".")
DOCS = {"doc", "docx", "odt", "rtf", "pages", "wps"}
SHEETS = {"xls", "xlsx", "xlsm", "ods", "numbers"}
SLIDES = {"ppt", "pptx", "odp", "key"}


def done(text):
    text = (text or "").replace("\r\n", "\n").replace("\ufeff", "").strip()
    if len(text) < 20:
        sys.exit(0)
    with open(out + ".tmp", "w") as f:
        f.write(text + "\n")
    os.replace(out + ".tmp", out)
    print(out)
    sys.exit(0)


def pdftotext(path):
    r = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", path, "-"], capture_output=True, timeout=20)
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else ""


def soffice(path, target, work):
    # Its own profile, so an open LibreOffice window neither blocks nor gets this job.
    profile = "file://" + os.path.join(tempfile.gettempdir(), "mail-inbox-lo")
    subprocess.run(["soffice", f"-env:UserInstallation={profile}", "--headless", "--convert-to", target, "--outdir", work, path],
                   capture_output=True, timeout=25)
    return sorted(glob.glob(os.path.join(work, "*")))


if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(src):
    print(out); sys.exit(0)
if ext == "pdf":
    done(pdftotext(src))

work = tempfile.mkdtemp(prefix="mail-inbox-")
try:
    if ext in DOCS:
        files = soffice(src, "txt:Text (encoded):UTF8", work)
        done(open(files[0], encoding="utf-8", errors="replace").read() if files else "")
    elif ext in SHEETS:
        # 44,34,76: comma, double quotes, UTF-8; the trailing -1 writes every sheet.
        files = soffice(src, "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1", work)
        stem = os.path.splitext(os.path.basename(src))[0]
        parts = []
        for f in files:
            sheet = os.path.splitext(os.path.basename(f))[0][len(stem):].lstrip("-") or "Sheet"
            parts.append(f"## Sheet: {sheet}\n" + open(f, encoding="utf-8", errors="replace").read())
        done("\n\n".join(parts))
    elif ext in SLIDES:
        files = soffice(src, "pdf", work)
        done(pdftotext(files[0]) if files else "")
except subprocess.TimeoutExpired:
    pass
finally:
    shutil.rmtree(work, ignore_errors=True)
