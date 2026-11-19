#!/usr/bin/env bash
# Biên dịch và chạy test logic firmware trên máy tính (cần g++).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
g++ -std=c++17 -Wall -Wextra -Werror -O1 -o "$OUT/test_logic" "$DIR/test_logic.cpp"
"$OUT/test_logic"
