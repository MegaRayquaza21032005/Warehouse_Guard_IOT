/** Ảnh camera chụp khi có sự cố. URL mang access token (Image không gửi được header); lỗi -> làm mới token, thử lại 1 lần. */
import { useState } from 'react'
import { Image, type ImageStyle, type StyleProp } from 'react-native'
import { cameraApi } from '../lib/api'

export function SnapshotImage({ id, style }: { id: number; style: StyleProp<ImageStyle> }) {
  const [uri, setUri] = useState(() => cameraApi.imageUrl(id))
  const [retried, setRetried] = useState(false)
  return (
    <Image
      source={{ uri }}
      resizeMode="cover"
      style={[{ backgroundColor: '#000' }, style]}
      onError={async () => {
        if (retried) return
        setRetried(true)
        if (await cameraApi.refreshToken()) setUri(cameraApi.imageUrl(id))
      }}
    />
  )
}
