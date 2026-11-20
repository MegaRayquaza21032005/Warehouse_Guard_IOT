"""Kết nối PostgreSQL (tài khoản agent, chỉ schema agent) + chạy migration SQL đánh số."""

from pathlib import Path

from psycopg_pool import AsyncConnectionPool

from app.logging_setup import get_logger

log = get_logger("DB")
MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"


async def open_pool(conninfo: str) -> AsyncConnectionPool:
    pool = AsyncConnectionPool(conninfo, min_size=1, max_size=5, open=False,
                               kwargs={"options": "-c search_path=agent,public"})
    await pool.open(wait=True, timeout=10)
    return pool


async def migrate(pool: AsyncConnectionPool) -> list[str]:
    """Chạy các file migrations/NNN_*.sql chưa chạy (theo thứ tự tên). Trả danh sách file vừa chạy."""
    applied_now: list[str] = []
    async with pool.connection() as conn:
        await conn.execute("""CREATE TABLE IF NOT EXISTS agent.schema_migrations (
                                  name VARCHAR(100) PRIMARY KEY,
                                  applied_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
        rows = await (await conn.execute("SELECT name FROM agent.schema_migrations")).fetchall()
        done = {r[0] for r in rows}
        for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if f.name in done:
                continue
            async with conn.transaction():
                await conn.execute(f.read_text(encoding="utf-8"))
                await conn.execute("INSERT INTO agent.schema_migrations (name) VALUES (%s)", (f.name,))
            applied_now.append(f.name)
            log.info("Đã chạy migration %s", f.name)
    return applied_now
