"""ai-agent — FastAPI: tầng luật (giai đoạn 3) + multi-agent Supervisor, chatbot, giọng nói (giai đoạn 4).

Chạy: cd ai-agent && conda run --no-capture-output -n iot-agent python -m app
"""

import asyncio
from contextlib import asynccontextmanager
from zoneinfo import ZoneInfo

from fastapi import FastAPI

from app.agents.graph import build_graph
from app.agents.llm import LLMCaller, make_chat_model
from app.agents.service import AgentService
from app.agents.tools import Services
from app.agents.voice import VoiceService
from app.api.chat import router as chat_router
from app.api.health import router as health_router
from app.backend_client import BackendClient
from app.config import get_settings
from app.db import migrate, open_checkpointer, open_pool
from app.logging_setup import get_logger, setup_logging
from app.mqtt.client import MqttBridge
from app.observability.langfuse import Tracer
from app.observability.tool_logger import ToolCallLogger
from app.observability.usage import UsageRecorder
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
    log.info("Khởi động ai-agent (tầng luật + multi-agent)")
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
    dispatcher = AlertDispatcher(mqtt, tracer, s.llm_alert_timeout_s, enricher=None)
    backend = BackendClient(s)
    runtime = RuleRuntime(s, engine, mqtt, dispatcher, tracer, backend, pool)
    usage = UsageRecorder(pool)

    # ---- Multi-agent (giai đoạn 4). Lỗi ở đây KHÔNG được làm dừng tầng luật.
    agent, cp_pool = None, None
    if not s.llm_enabled:
        log.warning("Chưa có OPENAI_API_KEY — tắt chatbot / multi-agent, chỉ chạy tầng luật")
    else:
        try:
            if pool is not None:
                cp_pool, checkpointer = await open_checkpointer(s.postgres_conninfo)
            else:
                from langgraph.checkpoint.memory import InMemorySaver
                checkpointer = InMemorySaver()
                log.warning("Không có DB — short-term memory chỉ lưu trong RAM, tool ghi sẽ không chạy")
            services = Services(settings=s, backend=backend, mqtt=mqtt, engine=engine, runtime=runtime,
                                dispatcher=dispatcher, logger=ToolCallLogger(pool), pool=pool)
            sup_llm = make_chat_model(s, s.openai_model)
            wrk_llm = sup_llm if s.worker_model == s.openai_model else make_chat_model(s, s.worker_model)
            graph = build_graph(services, LLMCaller(usage), sup_llm, s.openai_model, wrk_llm, s.worker_model,
                                checkpointer)
            agent = AgentService(s, graph, tracer, pool, engine, checkpointer)
            if s.incident_llm_enabled:
                dispatcher.enricher = agent.enrich
            log.info("Multi-agent sẵn sàng: Supervisor=%s, worker=%s, luồng sự cố %s", s.openai_model,
                     s.worker_model, "BẬT" if s.incident_llm_enabled else "TẮT")
        except Exception:  # noqa: BLE001
            log.exception("Không khởi tạo được multi-agent — chỉ chạy tầng luật")
            agent = None

    app.state.settings, app.state.agent, app.state.voice = s, agent, VoiceService(s, usage)
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
        if cp_pool is not None:
            await cp_pool.close()
        if pool is not None:
            await pool.close()
        log.info("Đã dừng")


app = FastAPI(title="Warehouse AI Agent", version="0.4.0", lifespan=lifespan)
app.include_router(health_router)
app.include_router(chat_router)
