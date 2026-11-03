# Inbox

A mail panel for Herdr on top of [himalaya](https://github.com/pimalaya/himalaya): every
account merged or one at a time, server search, sender pictures, attachments, readable
forwards, and **Send to agent**, which hands a mail to a running coding agent.

## Needs

- `himalaya` (v2), with your accounts in `~/.config/himalaya/config.toml`.
- `python3` (reading messages and attachments), `curl` (sender pictures).
- Optional, for text copies of attachments agents can read: `pdftotext` (poppler) and
  LibreOffice (`soffice`) for Word, Excel and PowerPoint files.

It reaches the network for sender pictures (Gravatar, by a hash of the address; else the
sender's site icon through Google's favicon service) and runs `himalaya`, `python3`, `curl`,
`xdg-open` and `hc`. Messages, attachments and pictures are cached under
`~/.config/herdr-app/data/mail-inbox/`.

## Setup

None, usually. The panel shows every account in himalaya's config, the default first.

Send to agent finds the request in a forward chain: notes from your team ("pls fix") and a
few words on top of a forward are skipped, and the first real message from outside is the
request. Your team is your accounts' addresses plus their company domain (not public ones
like gmail.com).

To change any of that, put a `config.json` next to `main.js` (every key is optional):

```json
{
  "accounts": ["work", { "id": "support", "label": "Support desk" }],
  "team": ["boss@gmail.com", "@agency.com"],
  "refreshSeconds": 60,
  "himalayaConfig": "~/.config/himalaya/config.toml"
}
```

- `accounts`: which himalaya accounts to show, in this order, with an optional label
  (default: all of them, labelled by their `display-name` or name).
- `team`: more addresses, or `@domain`s, whose mails are notes rather than requests.
- `refreshSeconds`: how often to check for mail (at least 15).
- `himalayaConfig`: where himalaya's config is, if not in the usual place.

Saving the file applies it at once.
