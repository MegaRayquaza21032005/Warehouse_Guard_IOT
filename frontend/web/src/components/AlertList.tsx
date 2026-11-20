import { AlertOctagon, AlertTriangle, Bot, Check, Info, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { Alert, AlertLevel } from '../types'
import { LEVEL_LABEL, alertTypeLabel, fmtAgo, fmtDateTime } from '../lib/labels'
import { live } from '../lib/live'

export function LevelIcon({ level, size = 17 }: { level: AlertLevel; size?: number }) {
  const Icon = level === 'critical' ? AlertOctagon : level === 'warning' ? AlertTriangle : Info
  return (
    <span className={`lv ${level}`} style={{ display: 'grid', placeItems: 'center', flex: 'none' }}>
      <Icon size={size} />
    </span>
  )
}

export default function AlertList({ alerts, compact = false }: { alerts: Alert[]; compact?: boolean }) {
  if (!alerts.length) return <div className="empty">Không có cảnh báo.</div>
  return (
    <div>
      {alerts.map((a) => (
        <div key={a.id} className={`alert-item ${a.acknowledgedAt ? '' : 'unacked'} ${compact ? 'compact' : ''}`}>
          <LevelIcon level={a.level} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13.5 }}>{alertTypeLabel(a.type)}</b>
              <span className={`badge ${a.level}`}>{LEVEL_LABEL[a.level]}</span>
              {a.source === 'agent' && (
                <span className="badge accent" title="Nội dung do AI agent phân tích / viết lại">
                  <Bot size={12} /> AI
                </span>
              )}
            </div>
            <div className="msg" style={{ marginTop: 3, fontSize: 13.5 }}>
              {a.message}
            </div>
            <div className="row">
              <span title={fmtDateTime(a.ts)}>{compact ? fmtAgo(a.ts) : fmtDateTime(a.ts)}</span>
              {a.acknowledgedAt && (
                <span>
                  · Đã xem{a.acknowledgedByName && <> bởi <b>{a.acknowledgedByName}</b></>}
                </span>
              )}
              {a.details?.push === false && <span className="faint">· chỉ hiện trong app</span>}
              {compact && !a.acknowledgedAt && (
                <button className="btn sm" style={{ height: 24 }} onClick={() => void live.ack(a.id)}>
                  <Check size={13} /> Đã xem
                </button>
              )}
              {a.feedback && (
                <span className={`badge ${a.feedback === 'false_alarm' ? '' : 'ok'}`}>{a.feedback === 'false_alarm' ? 'Báo giả' : 'Đúng'}</span>
              )}
            </div>
          </div>
          {!compact && (
          <div className="side">
            {!a.acknowledgedAt && (
              <button className="btn sm" onClick={() => void live.ack(a.id)}>
                <Check size={14} /> Đã xem
              </button>
            )}
            {!a.feedback && a.level !== 'info' && (
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="btn sm ghost icon" style={{ width: 28 }} title="Cảnh báo đúng" onClick={() => void live.feedback(a.id, 'true_alarm')}>
                  <ThumbsUp size={14} />
                </button>
                <button className="btn sm ghost icon" style={{ width: 28 }} title="Báo giả" onClick={() => void live.feedback(a.id, 'false_alarm')}>
                  <ThumbsDown size={14} />
                </button>
              </div>
            )}
          </div>
          )}
        </div>
      ))}
    </div>
  )
}
