"""ai-agent — FastAPI. Giai đoạn 3: tầng luật (không LLM) + hạ tầng log / Langfuse.

Chạy: cd ai-agent && conda run --no-capture-output -n iot-agent python -m app
"""

import asyncio
from contextlib import asynccontextmanager
from zoneinfo import ZoneInfo

from fastapi import FastAPI

from app.api.health import router as health_router
from app.backend_client import BackendClient
from app.config import get_settings
from app.db import migrate, open_pool
from app.logging_setup import get_logger, setup_logging
from app.mqtt.client import MqttBridge
from app.observability.langfuse import Tracer
from app.rules.alert_policy import AlertDispatcher
from app.rules.engine import RuleConfig, RuleEngine
from app.rules.schedule import WorkSchedule
from app.runtime import RuleRuntime

settings = get_settings()
setup_logging(settings.log_level, settings.log_format)
log = get_logger("APP")


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = settings
    log.info("Khởi động ai-agent (giai đoạn 3 — tầng luật, chưa có LLM)")
    log.info("Giờ làm việc %s-%s, ngày %s (%s)", s.work_hours_start.strftime("%H:%M"),
             s.work_hours_end.strftime("%H:%M"), s.work_days, s.timezone)

    pool = None
    try:
        pool = await open_pool(s.postgres_conninfo)
        await migrate(pool)
        log.info("PostgreSQL OK (schema agent)")
    except Exception as e:  # noqa: BLE001 — thiếu DB vẫn chạy tầng luật, chỉ mất lưu sự cố / nhật ký
        log.error("Không kết nối được PostgreSQL: %s — tầng luật vẫn chạy, sự cố không được lưu", e)
        pool = None

    tracer = Tracer(s)
    if tracer.enabled:
        await asyncio.to_thread(tracer.check)

    schedule = WorkSchedule(s.work_hours_start, s.work_hours_end, frozenset(s.work_day_set), ZoneInfo(s.timezone))
    engine = RuleEngine(RuleConfig.from_settings(s), schedule)
    mqtt = MqttBridge(s, asyncio.get_running_loop())
    dispatcher = AlertDispatcher(mqtt, tracer, s.llm_alert_timeout_s, enricher=None)  # giai đoạn 4: gắn LLM
    backend = BackendClient(s)
    runtime = RuleRuntime(s, engine, mqtt, dispatcher, tracer, backend, pool)

    app.state.pool, app.state.mqtt, app.state.tracer, app.state.runtime = pool, mqtt, tracer, runtime
    mqtt.start()
    runtime.start()
    log.info("Sẵn sàng — API nội bộ http://127.0.0.1:%s (X-Internal-Key)", s.agent_port)
    try:
        yield
    finally:
        log.info("Đang dừng...")
        await runtime.stop()
        mqtt.stop()
        await backend.close()
        tracer.shutdown()
        if pool is not None:
            await pool.close()
        log.info("Đã dừng")


app = FastAPI(title="Warehouse AI Agent", version="0.3.0", lifespan=lifespan)
app.include_router(health_router)
