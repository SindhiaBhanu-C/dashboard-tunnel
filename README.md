# Railway SSH Dashboard Proxy

A tiny Railway app that exposes a dashboard running on a Google Cloud VM without moving the dashboard, database, files, or app logic.

```text
Public Railway URL
  -> this Node proxy on Railway
  -> SSH local-forward tunnel
  -> GCP VM http://127.0.0.1:8766
```

## 1. Required Railway environment variables

Set these in Railway → your service → Variables:

```bash
SSH_HOST=<your-gcp-vm-external-ip-or-hostname>
SSH_USER=<vm-ssh-username>
SSH_PRIVATE_KEY=<private key that can SSH into the VM>

# Usually keep these defaults unless your dashboard uses another port.
REMOTE_DASHBOARD_HOST=127.0.0.1
REMOTE_DASHBOARD_PORT=8766
LOCAL_TUNNEL_HOST=127.0.0.1
LOCAL_TUNNEL_PORT=9000
SSH_PORT=22

```

Optional but recommended:

```bash
SSH_KNOWN_HOSTS=<output of ssh-keyscan -H YOUR_VM_IP>
```

If `SSH_KNOWN_HOSTS` is omitted, the app uses `StrictHostKeyChecking=accept-new`, which pins the first host key seen during that Railway container lifetime.

## 2. Create an SSH key for Railway

On your own machine:

```bash
ssh-keygen -t ed25519 -f railway_lightship_proxy -C railway-lightship-proxy
```

Add the public key to the VM user's authorized keys:

```bash
cat railway_lightship_proxy.pub
```

Paste that public key into:

```text
~/.ssh/authorized_keys
```

on the GCP VM for `SSH_USER`.

Then put the **private** key contents into Railway as `SSH_PRIVATE_KEY`.

## 3. GCP firewall

Railway needs to connect to your VM over SSH port 22.

Simplest: allow TCP 22 from the internet to the VM. Better: restrict SSH to Railway egress IPs if your Railway plan/setup gives you static egress.

Your dashboard itself does **not** need to be public. It can stay bound to `127.0.0.1:8766` on the VM.

## 4. Deploy to Railway

Push this folder to GitHub and deploy it as a Railway service, or use Railway CLI from this folder.

Railway will run:

```bash
npm start
```

## 5. Health check

Open:

```text
https://YOUR-RAILWAY-URL/healthz
```

- `200 {"ok":true}` means the SSH tunnel is up.
- `503` means Railway is running but cannot reach the dashboard through SSH yet.

## Security notes

- The Railway URL is intentionally public. Authentication/authorization should be handled by the dashboard application itself.
- Use a dedicated SSH key for this proxy only.
- Use a VM user with minimal permissions if possible.
- Do not expose the dashboard directly from GCP if you only want access through Railway.
