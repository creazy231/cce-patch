#!/bin/sh
# Runs at container start, before the nginx image fills CCE_REMOTE_TAILNET into the Content Security
# Policy: anything but a DNS name (ts.net, tailnet-0000.ts.net) stops the container instead of serving a
# broken or wider policy.
set -eu

case "${CCE_REMOTE_TAILNET:-}" in
  "" | *[!A-Za-z0-9.-]* | .* | *. | *..* | -* | *-)
    echo "$0: CCE_REMOTE_TAILNET must be a DNS name such as ts.net or tailnet-0000.ts.net" >&2
    exit 1
    ;;
esac
