#!/bin/sh
# The RPC password is made once, on first start, and kept in the secrets volume (node and guardian only).
set -e
if [ ! -s /secrets/node-rpc-password ]; then
  umask 077
  head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 > /secrets/node-rpc-password
fi
# Minima 1.0.49 puts its RPC on the main port + 4 (it ignores -rpc): port 9011 gives RPC 9015, so 127.0.0.1:9005 stays
# free for the guardian's door. -isclient: a PC behind a router takes no incoming connections.
# -rpccrlf: standard header line ends, which the door (Node.js) needs.
# The official release ships no peers: MINIMA_PEERS (compose) seeds the first ones, then the node finds its own.
exec java -Xmx1g -jar /opt/minima/minima.jar -data /data -basefolder /data -daemon -isclient -nodefaultminidapps \
  -port 9011 -rpcenable -rpccrlf -rpcpassword "$(cat /secrets/node-rpc-password)" -p2pnodes "$MINIMA_PEERS"
