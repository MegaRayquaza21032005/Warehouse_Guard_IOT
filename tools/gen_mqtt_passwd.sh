#!/usr/bin/env bash
# Tạo file mật khẩu Mosquitto (mqtt-broker/config/passwd) từ các tài khoản MQTT trong .env.
# Chạy lại mỗi khi đổi mật khẩu MQTT trong .env, sau đó: docker compose restart mosquitto
#
# Dùng: ./tools/gen_mqtt_passwd.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
CONF_DIR="$ROOT/mqtt-broker/config"
IMAGE="eclipse-mosquitto:2.0.20"

get_env() {
  local value
  value="$(grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2-)"
  if [[ -z "$value" ]]; then
    echo "Thiếu biến $1 trong .env" >&2
    exit 1
  fi
  printf '%s' "$value"
}

PAIRS=(
  "MQTT_USER MQTT_PASSWORD"
  "MQTT_ESP32_USER MQTT_ESP32_PASSWORD"
  "MQTT_BACKEND_USER MQTT_BACKEND_PASSWORD"
  "MQTT_AGENT_USER MQTT_AGENT_PASSWORD"
  "MQTT_VISION_USER MQTT_VISION_PASSWORD"
)

TMP="$CONF_DIR/passwd.tmp"
rm -f "$TMP"
: > "$TMP"
chmod 600 "$TMP"

for pair in "${PAIRS[@]}"; do
  read -r user_var pass_var <<< "$pair"
  user="$(get_env "$user_var")"
  pass="$(get_env "$pass_var")"
  docker run --rm --user "$(id -u):$(id -g)" \
    -v "$CONF_DIR:/mosquitto/config" "$IMAGE" \
    mosquitto_passwd -b /mosquitto/config/passwd.tmp "$user" "$pass"
  echo "  + $user"
done

mv "$TMP" "$CONF_DIR/passwd"
chmod 600 "$CONF_DIR/passwd"
echo "Đã ghi $CONF_DIR/passwd"
