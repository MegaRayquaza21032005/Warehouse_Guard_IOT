// Metro: cho phép import code dùng chung với web ở ../shared (kiểu dữ liệu, nhãn, cấu hình, parser SSE)
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../shared')]
module.exports = config
