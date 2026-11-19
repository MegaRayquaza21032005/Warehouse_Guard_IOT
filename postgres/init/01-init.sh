#!/bin/bash
# Chạy MỘT LẦN khi volume PostgreSQL còn trống (lần đầu `docker compose up`).
# Muốn chạy lại: docker compose down -v (MẤT dữ liệu) rồi up lại.
#
# Mỗi service có tài khoản + schema riêng (CLAUDE.md mục 3, nguyên tắc 2):
#   backend -> schema "app"    (dữ liệu nghiệp vụ)
#   agent   -> schema "agent"  (memory, checkpoint, log tool call)
# agent KHÔNG có quyền trên schema "app" và ngược lại.
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" \
  -v backend_user="$POSTGRES_BACKEND_USER" -v backend_pass="$POSTGRES_BACKEND_PASSWORD" \
  -v agent_user="$POSTGRES_AGENT_USER" -v agent_pass="$POSTGRES_AGENT_PASSWORD" <<'SQL'
-- pgvector cho long-term memory (kiểu vector / halfvec)
CREATE EXTENSION IF NOT EXISTS vector;

-- Tài khoản cho từng service
CREATE ROLE :"backend_user" LOGIN PASSWORD :'backend_pass';
CREATE ROLE :"agent_user"   LOGIN PASSWORD :'agent_pass';

-- Schema riêng, mỗi service sở hữu schema của mình
CREATE SCHEMA app   AUTHORIZATION :"backend_user";
CREATE SCHEMA agent AUTHORIZATION :"agent_user";

-- Không ai được tạo bảng trong schema public; vẫn dùng được kiểu dữ liệu của pgvector
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"backend_user", :"agent_user";

-- Schema mặc định khi kết nối
ALTER ROLE :"backend_user" SET search_path = app, public;
ALTER ROLE :"agent_user"   SET search_path = agent, public;

-- Chỉ các tài khoản được chỉ định mới kết nối được database
REVOKE CONNECT ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO :"backend_user", :"agent_user";
SQL

echo "[init] Đã tạo extension vector, tài khoản và schema: app, agent"
