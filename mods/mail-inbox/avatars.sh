#!/bin/sh
# avatars.sh <cache dir> <email>... → one "<email> <hash> grav|logo|miss" line each.
# Gravatar first; for company domains, the site's icon. Misses are retried after a week.
dir=$1; shift; mkdir -p "$dir"
# sha256sum on Linux, shasum on macOS.
if command -v sha256sum >/dev/null 2>&1; then sha=sha256sum; else sha="shasum -a 256"; fi
personal=" gmail.com googlemail.com seznam.cz email.cz post.cz centrum.cz atlas.cz volny.cz outlook.com hotmail.com live.com icloud.com me.com yahoo.com proton.me protonmail.com pm.me gmx.com gmx.net "
for e in "$@"; do (
  h=$(printf %s "$e" | tr 'A-Z' 'a-z' | $sha | cut -c1-64)
  for k in grav logo; do [ -s "$dir/$h.$k.png" ] && { echo "$e $h $k"; exit; }; done
  [ -e "$dir/$h.miss" ] && [ -z "$(find "$dir/$h.miss" -mtime +7)" ] && { echo "$e $h miss"; exit; }
  if curl -sfL -m 6 -o "$dir/$h.tmp" "https://gravatar.com/avatar/$h?d=404&s=96"; then mv "$dir/$h.tmp" "$dir/$h.grav.png"; echo "$e $h grav"; exit; fi
  d=${e#*@}
  case "$personal" in *" $d "*) ;; *)
    # notify.cloudflare.com → cloudflare.com when the subdomain has no icon of its own.
    for site in "$d" "$(echo "$d" | awk -F. 'NF>2{print $(NF-1)"."$NF}')"; do
      [ -n "$site" ] && curl -sfL -m 6 -o "$dir/$h.tmp" "https://www.google.com/s2/favicons?domain=$site&sz=64" && { mv "$dir/$h.tmp" "$dir/$h.logo.png"; echo "$e $h logo"; exit; }
    done;;
  esac
  rm -f "$dir/$h.tmp"; : > "$dir/$h.miss"; echo "$e $h miss"
) & done
wait
