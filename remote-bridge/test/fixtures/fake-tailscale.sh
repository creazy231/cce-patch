#!/usr/bin/env bash
# A stand-in for the `tailscale` CLI, for remote-bridge/test/tailscale.test.ts and for the end-to-end
# run in an isolated editor (CCE_REMOTE_TAILSCALE=<this file>). It answers the four commands the
# bridge runs, keeps its serve config in files, and never touches a real tailnet:
#
#   tailscale status --json
#   tailscale serve status --json
#   tailscale serve --bg --https=<port> http://127.0.0.1:<port>
#   tailscale serve --https=<port> off
#
# FAKE_TS_STATE_DIR  where it keeps its state (default: $TMPDIR/fake-tailscale)
#                      calls         one line per run: its arguments (the status cache test counts them)
#                      serve-<port>  exists while `serve --https=<port>` is on; holds the proxy target
#                      pid           the process id of the last `serve` run (a test checks it was killed)
# FAKE_TS_MODE       ok (default)    a running tailnet owned by owner@example.com, HTTPS certificates on;
#                                    every command works
#                    consent         HTTPS certificates off: `serve --bg` prints the consent text on
#                                    stdout, then waits, as the real CLI does until you enable the feature
#                    consent-stderr  the same, on stderr
#                    fail            every command exits 1 with an error on stderr

set -u

tmp="${TMPDIR:-/tmp}"
state="${FAKE_TS_STATE_DIR:-${tmp%/}/fake-tailscale}"
mode="${FAKE_TS_MODE:-ok}"
dns="example-mac.tailnet-0000.ts.net"

case "$mode" in
  ok|consent|consent-stderr|fail) ;;
  *) echo "fake-tailscale: unknown FAKE_TS_MODE '$mode'" >&2; exit 2 ;;
esac

mkdir -p "$state"
printf '%s\n' "$*" >> "$state/calls"

if [ "$mode" = fail ]; then
  echo "failed to connect to local Tailscale service; is Tailscale running?" >&2
  exit 1
fi

status_json() {
  local certs="[\"$dns\"]"
  [ "$mode" = ok ] || certs=null
  cat <<JSON
{
  "Version": "1.99.0-tfake",
  "TUN": true,
  "BackendState": "Running",
  "HaveNodeKey": true,
  "AuthURL": "",
  "TailscaleIPs": ["100.64.0.1"],
  "Self": {
    "ID": "nExampleCNTRL",
    "HostName": "example-mac",
    "DNSName": "$dns.",
    "OS": "macOS",
    "UserID": 123,
    "TailscaleIPs": ["100.64.0.1"],
    "Online": true
  },
  "Health": [],
  "MagicDNSSuffix": "tailnet-0000.ts.net",
  "CurrentTailnet": { "Name": "tailnet-0000.ts.net", "MagicDNSSuffix": "tailnet-0000.ts.net", "MagicDNSEnabled": true },
  "CertDomains": $certs,
  "Peer": {},
  "User": {
    "123": { "ID": 123, "LoginName": "owner@example.com", "DisplayName": "Example Owner", "ProfilePicURL": "" }
  }
}
JSON
}

# The recorded ports as the real CLI shows them: a TCP entry and a Web handler per port ({} when none).
serve_status_json() {
  local tcp="" web="" sep="" file port target
  for file in "$state"/serve-*; do
    [ -e "$file" ] || continue
    port="${file##*/serve-}"
    target="$(cat "$file")"
    tcp="$tcp$sep\"$port\":{\"HTTPS\":true}"
    web="$web$sep\"$dns:$port\":{\"Handlers\":{\"/\":{\"Proxy\":\"$target\"}}}"
    sep=","
  done
  if [ -z "$sep" ]; then
    echo '{}'
  else
    printf '{"TCP":{%s},"Web":{%s}}\n' "$tcp" "$web"
  fi
}

serve_command() {
  shift # "serve"
  local port="" off=0 target="" arg
  for arg in "$@"; do
    case "$arg" in
      --bg) ;;
      --https=*) port="${arg#--https=}" ;;
      off) off=1 ;;
      http://*) target="$arg" ;;
      *) echo "fake-tailscale: unsupported serve argument '$arg'" >&2; exit 2 ;;
    esac
  done
  case "$port" in
    ''|*[!0-9]*) echo "fake-tailscale: serve needs --https=<port>" >&2; exit 2 ;;
  esac
  echo $$ > "$state/pid"

  if [ "$off" = 1 ]; then
    if [ ! -e "$state/serve-$port" ]; then
      echo "error: failed to remove web serve: handler does not exist" >&2
      exit 1
    fi
    rm -f "$state/serve-$port"
    exit 0
  fi

  [ -n "$target" ] || { echo "fake-tailscale: serve needs a target" >&2; exit 2; }
  case "$mode" in
    consent|consent-stderr)
      local text=$'\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n'
      if [ "$mode" = consent ]; then printf '%s\n' "$text"; else printf '%s\n' "$text" >&2; fi
      exec sleep 30 # the same process id stays, so a kill reaches it
      ;;
  esac
  printf '%s' "$target" > "$state/serve-$port"
  cat <<TEXT

Available within your tailnet:

https://$dns:$port/
|-- proxy $target

Serve started and running in the background.
To disable the proxy, run: tailscale serve --https=$port off
TEXT
}

unsupported() {
  echo "fake-tailscale: unsupported arguments: $*" >&2
  exit 2
}

case "${1:-}" in
  status)
    [ "${2:-}" = --json ] || unsupported "$@"
    status_json
    ;;
  serve)
    if [ "${2:-}" = status ]; then serve_status_json; else serve_command "$@"; fi
    ;;
  *) unsupported "$@" ;;
esac
