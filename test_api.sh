#!/bin/bash
set -euo pipefail

# Configuration - set these via environment variables
# ==================================================

# API Configuration
PORT="${PORT:-3457}"
API_URL="http://localhost:${PORT}/v1/chat/completions"
MODEL_NAME="${MODEL_NAME:-gemini-nano}"

# System Prompt - Instructions for the AI model
SYSTEM_MESSAGE="${SYSTEM_MESSAGE:-You are a helpful assistant.}"

# User Prompt - The actual question or task
USER_MESSAGE="${USER_MESSAGE:-Hello. Tell me a story}"

# Generation parameters
TEMPERATURE="${TEMPERATURE:-0.7}"  # Controls randomness
TOP_K="${TOP_K:-40}"              # Top-K sampling parameter
STREAM="${STREAM:-false}"          # Whether to stream the response

# Verbose output flag
VERBOSE="${VERBOSE:-false}"

echo "Using local API at $API_URL"
echo "Model: $MODEL_NAME"
echo "System prompt: ${SYSTEM_MESSAGE:0:50}${SYSTEM_MESSAGE:50:+'...'}"
echo "Config: temp=$TEMPERATURE, topK=$TOP_K, stream=$STREAM"

# Build payload using jq for safe JSON generation
PAYLOAD=$(jq -n \
  --arg model "$MODEL_NAME" \
  --arg system "$SYSTEM_MESSAGE" \
  --arg user "$USER_MESSAGE" \
  --argjson temp "$TEMPERATURE" \
  --argjson top_k "$TOP_K" \
  --argjson stream "$STREAM" \
  '{
    model: $model,
    temperature: $temp,
    top_k: $top_k,
    stream: $stream,
    messages: [
      {role: "system", content: $system},
      {role: "user", content: $user}
    ]
  }')

# Make the API request
if [ "$STREAM" = "true" ]; then
  echo "Streaming response..."
  curl -N -s "$API_URL" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD"
else
  if [ "$VERBOSE" = "true" ]; then
    curl -v "$API_URL" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" | jq .
  else
    response=$(curl -s -w "\n%{http_code}" "$API_URL" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" 2>&1) || {
      echo "Error: API request failed" >&2
      exit 1
    }

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" -ge 400 ]; then
      echo "Error: HTTP $http_code" >&2
      echo "$body" | jq .
      exit 1
    fi

    echo "$body" | jq .
  fi
fi
