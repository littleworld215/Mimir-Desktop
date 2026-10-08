// 测试专用宿主接缝，无DB/凭据/模型；真实客户端通过子进程stdin/stdout走生产SDK协议壳。
import { startAssetsMcpStdio } from '../../out/main/assetsMcp.js'
await startAssetsMcpStdio({
  scope: Object.freeze({ workspaceId: 'fixture', spaceEpoch: 'fixture#1' }),
  async call(method) {
    if (method !== 'get_asset') throw Error('fixture method not implemented')
    return { requestId: 'fixture', data: { assetCode: 'fixture', version: 1, storageType: 'inline_text',
      content: { content: ' 原文 apiKey token\r\n\n', truncated: false }, fileName: null, fileAvailable: false } }
  },
  async close() {}
})
