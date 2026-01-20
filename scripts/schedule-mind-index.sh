#!/usr/bin/env bash
# Schedule Mind RAG reindexing job via workflow daemon HTTP API

set -euo pipefail

WORKFLOW_DAEMON_URL="${WORKFLOW_DAEMON_URL:-http://localhost:7778}"
MIND_SCOPE="${MIND_SCOPE:-default}"
JOB_PRIORITY="${JOB_PRIORITY:-normal}"

echo "[$(date)] Submitting Mind RAG reindex job..."

RESPONSE=$(curl -s -X POST "${WORKFLOW_DAEMON_URL}/jobs/submit" \
  -H "Content-Type: application/json" \
  -d "{
    \"handler\": \"mind:rag-index\",
    \"priority\": \"${JOB_PRIORITY}\",
    \"input\": {
      \"scope\": \"${MIND_SCOPE}\"
    },
    \"metadata\": {
      \"scheduled\": true,
      \"trigger\": \"cron\",
      \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
    }
  }")

RUN_ID=$(echo "$RESPONSE" | jq -r '.id // .runId // empty')

if [ -n "$RUN_ID" ]; then
  echo "[$(date)] Job submitted successfully: runId=$RUN_ID"
  echo "[$(date)] Track status: curl ${WORKFLOW_DAEMON_URL}/jobs/${RUN_ID}/status"
  exit 0
else
  echo "[$(date)] ERROR: Failed to submit job"
  echo "$RESPONSE" | jq '.' || echo "$RESPONSE"
  exit 1
fi
