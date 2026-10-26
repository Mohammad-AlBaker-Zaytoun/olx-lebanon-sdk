"""A small client for the OLX Lebanon SDK REST service, using only the Python standard library.

Start the service first (`npx olx-lb serve`), then:

    OLX_SDK_API_KEY=<SERVER_API_KEY from .env> python3 examples/rest/client.py
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class OlxSdkError(Exception):
    """An error answer from the service. Branch on `code`, which is stable."""

    def __init__(self, status: int, code: str, message: str, details: dict | None = None, request_id: str | None = None):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.details = details or {}
        self.request_id = request_id


class OlxSdkClient:
    def __init__(self, api_key: str, base_url: str = "http://127.0.0.1:8787", timeout: float = 10):
        self.base = base_url.rstrip("/") + "/v1"
        self.api_key = api_key
        self.timeout = timeout

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("X-Api-Key", self.api_key)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return json.loads(res.read() or b"null")
        except urllib.error.HTTPError as e:
            payload = json.loads(e.read() or b"{}").get("error", {})
            raise OlxSdkError(e.code, payload.get("code", "unknown"), payload.get("message", ""), payload.get("details"), payload.get("requestId")) from None

    @staticmethod
    def _product(product_id: str) -> str:
        return "/products/" + urllib.parse.quote(product_id, safe="") + "/listing"

    def sync_product(self, product_id: str, listing: dict, force: bool = False) -> str:
        """Queues a create or update. Returns the job id."""
        return self._call("PUT", self._product(product_id) + ("?force=true" if force else ""), listing)["jobId"]

    def remove_product(self, product_id: str) -> str:
        """Queues removal of the product's ad. Returns the job id."""
        return self._call("DELETE", self._product(product_id))["jobId"]

    def job(self, job_id: str) -> dict:
        return self._call("GET", "/jobs/" + urllib.parse.quote(job_id, safe=""))

    def wait(self, job_id: str, poll_seconds: float = 5, timeout_seconds: float = 900) -> dict:
        """Polls until the job has finished. Writes are paced about a minute apart."""
        deadline = time.monotonic() + timeout_seconds
        while True:
            job = self.job(job_id)
            if job["status"] not in ("queued", "running"):
                return job
            if time.monotonic() > deadline:
                raise TimeoutError(f"job {job_id} still {job['status']}")
            time.sleep(poll_seconds)

    def listing(self, product_id: str) -> dict | None:
        try:
            return self._call("GET", self._product(product_id))
        except OlxSdkError as e:
            if e.code == "not_found":
                return None
            raise

    def status(self) -> dict:
        return self._call("GET", "/status")


if __name__ == "__main__":
    client = OlxSdkClient(os.environ["OLX_SDK_API_KEY"], os.environ.get("OLX_SDK_URL", "http://127.0.0.1:8787"))
    try:
        job_id = client.sync_product(
            "SKU-1042",
            {
                "title": "Dell Latitude 5440",
                "description": "16 GB RAM, 512 GB SSD, 1 year warranty",
                "price": 899,
                "categoryId": "175",
                "locationId": "47",
                "attributes": {"make": "3", "type": "1", "new_used": "1"},
                "images": [{"url": "https://shop.example.com/images/dell-5440.jpg"}],
            },
        )
    except OlxSdkError as e:
        # invalid_listing: details["issues"] says which field; queue_full: retry later; unauthorized: check the key
        raise SystemExit(f"Rejected: {e} {e.details}")

    job = client.wait(job_id)
    if job["status"] == "succeeded":
        record = job["result"]["record"]
        print(job["result"]["action"], record["adId"], record["status"])
    else:
        error = job.get("error", {})
        # olx_rejected: error["details"]["olxErrors"] names the field OLX refused
        print("Failed:", error.get("code"), error.get("message"), error.get("details"))
