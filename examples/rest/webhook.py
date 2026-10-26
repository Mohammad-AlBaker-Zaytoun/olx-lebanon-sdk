"""Verifies the REST service's job notifications (set WEBHOOK_URL and WEBHOOK_SECRET in its .env).

Use `verify_webhook` from any framework. With Flask, for example:

    @app.post("/olx-webhook")
    def olx_webhook():
        job = verify_webhook(os.environ["OLX_WEBHOOK_SECRET"], request.get_data(),
                             request.headers.get("X-Olx-Sdk-Timestamp", ""),
                             request.headers.get("X-Olx-Sdk-Signature", ""))
        if job is None:
            return "", 401
        ...
        return "", 204

Pass the raw body bytes, not re-serialised JSON: the signature covers the exact bytes sent.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time


def verify_webhook(secret: str, body: bytes, timestamp: str, signature: str, tolerance_seconds: int = 300) -> dict | None:
    """Returns the job when the request is genuine and fresh, or None."""
    if len(secret) < 16:
        raise RuntimeError("The webhook secret is not configured")
    if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > tolerance_seconds:
        return None
    expected = "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return None
    job = json.loads(body)
    return job if isinstance(job, dict) else None
