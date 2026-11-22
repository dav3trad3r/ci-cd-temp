# Known noise

- **Cold start**: after a tool scales up from zero, its first request can log `connect ECONNREFUSED` to Postgres once, then succeed. One such line within 30 seconds of a scale-up or a new revision is noise.
- **Sign-in expiry**: `sign_in_required` (401) responses rise around 9 am when staff return to old browser tabs. A 401 is not a 5xx and never pages.
- **Health probe during a deploy**: `GET /healthz` can fail for the first 20 seconds of a new revision while the platform starts it. It is not an outage unless it continues.
