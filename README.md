# RaptiCaL relay

A single-file Node.js relay for the hidden messenger built into RaptiCaL.
No npm packages, no database, no disk writes.

* the phones encrypt everything with a key derived from their shared phrase —
  this process only ever holds ciphertext;
* messages are kept in RAM and dropped **24 hours** after they were sent;
* restarting the process deletes everything.

## Run it

```sh
node server.js                 # http://0.0.0.0:8080
PORT=3000 node server.js
```

Check it: `curl http://localhost:8080/health` → `{"ok":true,...}`

## Put it on the internet

The phones need an **https://** address (an http:// address works only if the
server is reachable directly on the local network).

**Render (free):** create a *Web Service* from this folder, environment
`PORT` is set automatically, start command `node server.js`, health check path
`/health`. You get `https://<name>.onrender.com`.

**Fly.io:** `fly launch --no-deploy` in this folder, then `fly deploy`.

**Any VPS with Docker:**

```sh
docker build -t raptical-relay .
docker run -d --restart unless-stopped -p 8080:8080 --name relay raptical-relay
```

Then put Caddy or nginx in front of it for TLS, e.g. Caddy:

```
relay.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

**Systemd (no Docker):**

```ini
[Unit]
Description=RaptiCaL relay
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/raptical-relay/server.js
Restart=always
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
```

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness + message TTL |
| POST | `/api/send` | store a message and push it to listeners |
| GET | `/api/messages?room=&since=` | catch-up fetch |
| GET | `/api/stream?room=&since=` | Server-Sent Events stream |

`room` is a 24-hex-character id derived on the phone from the shared phrase.
The relay cannot reverse it and never receives the phrase itself.
