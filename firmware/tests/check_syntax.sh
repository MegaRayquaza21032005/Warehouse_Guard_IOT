#!/usr/bin/env bash
# Kiểm tra cú pháp firmware bằng compiler ESP32 có sẵn trong ~/.arduino15 (không cần mở Arduino IDE).
# Chỉ kiểm tra biên dịch (-fsyntax-only), KHÔNG tạo file nạp. Nạp board vẫn dùng Arduino IDE.
# Thư viện ngoài: đặt ARDUINO_LIBS=<thư mục chứa PubSubClient, ArduinoJson, DHT_sensor_library,
# Adafruit_Unified_Sensor> (mặc định ~/Arduino/libraries).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SK="$ROOT/warehouse_monitor"
B="$HOME/.arduino15/packages/esp32"
VER="$(ls "$B/hardware/esp32" | sort -V | tail -1)"
H="$B/hardware/esp32/$VER"
L="$B/tools/esp32-libs/$VER"
GXX="$(find "$B/tools/esp-x32" -name xtensa-esp32-elf-g++ -type f | head -1)"
U="${ARDUINO_LIBS:-$HOME/Arduino/libraries}"
[ -f "$SK/secrets.h" ] || { echo "Thiếu $SK/secrets.h (copy từ secrets.example.h)"; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
{ echo '#include <Arduino.h>'; echo "#line 1 \"$SK/warehouse_monitor.ino\""; cat "$SK/warehouse_monitor.ino"; } > "$TMP/sketch.cpp"

INC=()
for d in "$H"/libraries/*/src; do INC+=("-I$d"); done
for d in "$U/PubSubClient/src" "$U/ArduinoJson/src" "$U/DHT_sensor_library" "$U/Adafruit_Unified_Sensor"; do INC+=("-I$d"); done

cd "$L/flags"
set +e
OUT="$("$GXX" -fsyntax-only -Wall -x c++ \
  -DF_CPU=240000000L -DARDUINO=10607 -DARDUINO_ESP32_DEV -DARDUINO_ARCH_ESP32 \
  '-DARDUINO_BOARD="ESP32_DEV"' '-DARDUINO_VARIANT="esp32"' -DESP32=ESP32 -DCORE_DEBUG_LEVEL=0 \
  -DARDUINO_RUNNING_CORE=1 -DARDUINO_EVENT_RUNNING_CORE=1 -DARDUINO_USB_CDC_ON_BOOT=0 \
  @defines @cpp_flags -iprefix "$L/include/" @includes -I"$L/qio_qspi/include" \
  -I"$H/cores/esp32" -I"$H/variants/esp32" -I"$SK" "${INC[@]}" "$TMP/sketch.cpp" 2>&1)"
RC=$?
set -e
# Chỉ in cảnh báo / lỗi thuộc code của dự án (bỏ qua cảnh báo trong core / thư viện)
echo "$OUT" | grep -E "$SK|error" || true
if [ $RC -ne 0 ]; then echo "Syntax check FAILED"; exit $RC; fi
echo "Syntax check OK (ESP32 core $VER)"
