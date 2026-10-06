/**
 * 导航一致性测试（I0-05）。
 *
 * 守护点：`MODULE_IDS`（运行时单一来源）与 Sidebar 导航列表不漂移——
 * 「新增了模块却忘了加导航入口」或「导航里写了拼错的 id」都会在这里失败。
 *
 * 说明：`plugins` / `settings` 在 Sidebar 里单独渲染、不在 `navGroups` 中，
 * 因此本测试只断言「导航 id ⊆ MODULE_IDS」与「资产库入口存在」，不要求 navGroups 覆盖全部模块。
 * `renderModule` 的 case 覆盖由 App 层保证（见 I0-05 复验记录）。
 */
import { describe, expect, it } from 'vitest'
import { MODULE_IDS, navGroups } from '../../src/components/layout/Sidebar'

const NAV_IDS = navGroups.flatMap((group) => group.items.map((item) => item.id))

describe('模块清单与导航一致性', () => {
  it('MODULE_IDS 无重复', () => {
    expect(new Set(MODULE_IDS).size).toBe(MODULE_IDS.length)
  })

  it('导航里出现的每个 id 都是合法模块', () => {
    const unknown = NAV_IDS.filter((id) => !MODULE_IDS.includes(id))
    expect(unknown).toEqual([])
  })

  it('导航 id 无重复', () => {
    expect(new Set(NAV_IDS).size).toBe(NAV_IDS.length)
  })

  it('资产库模块已注册且存在导航入口', () => {
    expect(MODULE_IDS).toContain('assets')
    expect(NAV_IDS).toContain('assets')
  })
})
