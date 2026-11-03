# The guardian box

One Docker Compose project, `stables-guardian`, that runs a Stables guardian on a PC or a Linux server (founder
2026-11-03: "a single Docker Compose setup"). Three containers, started and stopped together:

| Container | Runs | Can reach |
|---|---|---|
| `node` | The guardian's own Minima node, Minima's official 1.0.49 (sha256 pinned). RPC with a password made on first start. | The Minima network |
| `guardian` | The guardian program (`../guardian.mjs`), dry run, plus the Council's checker compiled from the app's Route 2 sources | The node, through a door that passes only `status`, `coins`, `txpow`, `mmrcreate`; the Parlons panel |
| `parlons` | The guardian's own Parlons account (Parlons Cloud, built from `github.com/eurobuddha/maxima` at `6c71fbf`), no public ports | Maxima relays, to send the owner chats |

The guardian shares the node's network space (the checker reads only `127.0.0.1`). Parlons has its own: it cannot use
the door, and the node's RPC refuses it without the password, which only the node and the guardian mount.

## Data, and the one rule about it

Everything lives in Docker volumes (`node-data`, `secrets`, `guardian-data`, `parlons-data`, `parlons-ticket`), not in
this folder, so the repo's backups never copy a key.

- **Never restore `node-data` from an old copy**, once the node holds a guardian key: Minima keys sign with one-time
  signatures, and an old copy reuses them. The node's backup is its 24 words, on paper.
- **The Parlons account's 24 words** are in `parlons-data/seed.txt`. Read them once, write them down:
  `docker compose -p stables-guardian exec parlons cat /data/seed.txt`. They are the guardian's chat identity and a
  small wallet; never a seat key.

## Start, set up, check

```
cd box
docker compose -p stables-guardian up -d --build
docker compose -p stables-guardian exec guardian node box/setup-node.mjs          # once: follow the R2T5 scripts
docker compose -p stables-guardian exec guardian node box/parlons-setup.mjs whoami
docker compose -p stables-guardian exec guardian node box/parlons-setup.mjs owner <the owner's Parlons address>
docker compose -p stables-guardian exec guardian node box/parlons-setup.mjs test
docker compose -p stables-guardian exec guardian node test/run-all.mjs             # the 42 tests, inside the box
docker compose -p stables-guardian logs -f guardian
```

Stop: `docker compose -p stables-guardian stop`. The volumes stay.

## Not in the box yet

- Posting: the config says `"allowPost": false`, the box passes no `--post`, and the door refuses every transaction
  command unless `GUARDIAN_DOOR_POSTING=1`. The first posting test is a separate decision.
- A seat key: the guardian watches only (`publicKey: null`).
- Start at log-on (Windows) or at boot (Linux): Docker's `restart: unless-stopped` brings the box back whenever Docker
  runs; Docker Desktop itself starts at log-on only if its setting says so.
