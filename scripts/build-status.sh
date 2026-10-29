#!/usr/bin/env bash
# List the staging build's processes (pid, elapsed, command) without matching this script itself.
ps -eo pid,ppid,etime,cmd | awk '$4 ~ /bash$/ && $5 ~ /build-stage-wsl\.sh$/ || $4 ~ /swift-(build|test)|swift-frontend/ || $5 ~ /scripts\/test\.sh$/ {print}' | cut -c1-160
