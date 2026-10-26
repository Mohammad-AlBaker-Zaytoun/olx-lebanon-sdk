#!/usr/bin/env bash
# The REST service from the command line. Start it first: `npx olx-lb serve`.
#   OLX_SDK_API_KEY=<SERVER_API_KEY from .env> bash examples/rest/curl.sh
set -euo pipefail

BASE="${OLX_SDK_URL:-http://127.0.0.1:8787}/v1"
KEY="${OLX_SDK_API_KEY:?Set OLX_SDK_API_KEY to the SERVER_API_KEY in .env}"

# Liveness and session state
curl -fsS "$BASE/health"; echo
curl -fsS -H "X-Api-Key: $KEY" "$BASE/status"; echo

# Create or update the ad for product SKU-1042. The answer is 202 { "jobId": …, "status": "queued" }.
JOB=$(curl -fsS -X PUT "$BASE/products/SKU-1042/listing" \
  -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{
        "title": "Dell Latitude 5440",
        "description": "16 GB RAM, 512 GB SSD, 1 year warranty",
        "price": 899,
        "categoryId": "175",
        "locationId": "47",
        "attributes": { "make": "3", "type": "1", "new_used": "1" },
        "images": [{ "url": "https://shop.example.com/images/dell-5440.jpg" }]
      }')
echo "$JOB"
JOB_ID=$(printf '%s' "$JOB" | sed -E 's/.*"jobId":"([^"]+)".*/\1/')

# Jobs run one at a time and writes are paced, so poll until it is no longer queued or running.
while :; do
  STATE=$(curl -fsS -H "X-Api-Key: $KEY" "$BASE/jobs/$JOB_ID")
  case "$STATE" in
    *'"status":"queued"'*|*'"status":"running"'*) sleep 5 ;;
    *) echo "$STATE"; break ;;
  esac
done

# The stored product ↔ ad link
curl -fsS -H "X-Api-Key: $KEY" "$BASE/products/SKU-1042/listing"; echo

# Remove the ad (also a job):
# curl -fsS -X DELETE -H "X-Api-Key: $KEY" "$BASE/products/SKU-1042/listing"
