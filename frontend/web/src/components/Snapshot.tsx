/** Ảnh camera chụp khi có sự cố: ảnh nhỏ (bấm để phóng to) + khung xem lớn. */
import { useEffect, useState } from 'react'
import { ImageOff, X } from 'lucide-react'
import { cameraApi } from '../api'

/**
 * <img> mang access token trong URL (thẻ img không gửi được header). Lỗi lần đầu → làm mới token rồi thử lại 1 lần
 * (token hết hạn); vẫn lỗi → hiện biểu tượng ảnh hỏng. Đổi ảnh → dùng `key={id}` để tạo lại.
 */
export function CameraImage({ id, alt, className }: { id: number; alt: string; className?: string }) {
  const [src, setSrc] = useState(() => cameraApi.imageUrl(id))
  const [retried, setRetried] = useState(false)
  const [failed, setFailed] = useState(false)
  if (failed)
    return (
      <div className={`${className ?? ''} snap-broken`} title="Không tải được ảnh">
        <ImageOff size={20} />
      </div>
    )
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      onError={async () => {
        if (retried) return setFailed(true)
        setRetried(true)
        if (await cameraApi.refreshToken()) setSrc(cameraApi.imageUrl(id))
        else setFailed(true)
      }}
    />
  )
}

export function SnapshotThumb({ id, caption, onOpen }: { id: number; caption: string; onOpen: () => void }) {
  return (
    <button className="snap" onClick={onOpen} title="Bấm để phóng to">
      <CameraImage key={id} id={id} alt={caption} />
    </button>
  )
}

export function Lightbox({ id, caption, onClose }: { id: number; caption: string; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="lightbox" role="dialog" aria-label={caption} onClick={onClose}>
      <figure onClick={(e) => e.stopPropagation()}>
        <CameraImage key={id} id={id} alt={caption} />
        <figcaption>
          <span>{caption}</span>
          <button className="btn sm" onClick={onClose} aria-label="Đóng">
            <X size={14} /> Đóng
          </button>
        </figcaption>
      </figure>
    </div>
  )
}
