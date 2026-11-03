#!/bin/sh
# The account's local panel answers only on its own 127.0.0.1:9587. socat opens it to the box (port 19587) so the
# guardian can send alerts; every call still needs a session from the one-time ticket. The ticket is copied alone into
# the "parlons-ticket" volume, so the guardian never sees the account's seed.
socat TCP-LISTEN:19587,fork,reuseaddr TCP:127.0.0.1:9587 &
(
  while true; do
    if [ -s /data/panel-ticket.txt ] && ! cmp -s /data/panel-ticket.txt /ticket/panel-ticket.txt; then
      cp /data/panel-ticket.txt /ticket/panel-ticket.txt.new && mv /ticket/panel-ticket.txt.new /ticket/panel-ticket.txt
    fi
    sleep 2
  done
) &
# --no-relay --no-direct: an account only, no public ports (a PC behind a router).
exec java -Xmx256m -jar /opt/parlons/parlons-cloud.jar --data /data --no-relay --no-direct --name "$PARLONS_NAME"
