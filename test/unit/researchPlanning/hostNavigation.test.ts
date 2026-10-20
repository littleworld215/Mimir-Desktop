// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { consumePlanningHostIntent, rememberPlanningHostIntent } from '../../../src/lib/planningHostNavigation'

it('资料跳转为一次性明确意图，保留空间代际，不打开任意URL或路径', () => {
  const scope = { workspaceId: 'space', spaceEpoch: 'epoch' }
  rememberPlanningHostIntent({ scope, kind: 'paper', id: 'doi:10.1000/paper' })
  expect(consumePlanningHostIntent('experiments')).toBeNull()
  expect(consumePlanningHostIntent('library')).toEqual({ scope, kind: 'paper', id: 'doi:10.1000/paper' })
  expect(consumePlanningHostIntent('library')).toBeNull()
  sessionStorage.setItem('mimir:planning-host-intent', JSON.stringify({ scope, kind: 'url', id: 'file:///secret' }))
  expect(consumePlanningHostIntent('library')).toBeNull()
})
