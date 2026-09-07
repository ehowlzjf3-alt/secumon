import type { AgentTurnModelInfo } from './host-models.js';

export const syntheticTurnNotice = '합성 규칙 시험입니다. 자유 문장의 의미 판단이나 실제 모델 품질을 검증하지 않습니다.';

export function agentTurnModelNotice(info: AgentTurnModelInfo): string {
  if (info.selection === 'synthetic') return syntheticTurnNotice;
  return info.execution === 'deterministic_fixture' ? '등록 모델의 로컬 전송 대역 시험입니다. 정해진 시험 문구만 처리하며 실제 모델/API는 호출하지 않습니다.' :
    '호스트에 등록된 모델을 사용합니다.';
}
