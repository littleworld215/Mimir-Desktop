import type { ResearchPackReply, ResearchQuestionReply, ResearchQuestionSummary, ResearchReadState } from '../../../shared/libraryResearchContracts'
import { document } from './fixtures'
export const uiScope = { workspaceId: 'space-1', spaceEpoch: 'epoch-1' }
export const uiState: ResearchReadState = { revision: 3, evidenceRevision: 1, evidenceState: 'available' }
export function uiFixtures() {
  const doc = document(), question = doc.questions[0]!, pack = doc.packs[0]!
  const questionReply: ResearchQuestionReply = { ...uiState, question }, packReply: ResearchPackReply = { ...uiState, pack }
  const summary: ResearchQuestionSummary = { id: question.id, projectId: 'project-1', title: question.versions[0]!.title, currentVersion: 1, archived: false, cardCount: 1, problemCount: 0 }
  return { questionReply, packReply, summary }
}
