import type { WorkViewResult } from '../domain/work-view.js';

const statusNames: Record<string, string> = {
  ready: '실행 대기', running: '진행 중', waiting: '확인 대기', paused: '일시 정지',
  blocked: '진행 제한', cancelled: '취소 반영', failed: '실패', completed: '완료',
};
const modeNames: Record<string, string> = { auto: '자동', fast: '빠르게', deep: '깊게' };
const deliveryNames: Record<string, string> = {
  not_prepared: '준비 전', pending: '전달 대기', sending: '전달 확인 중', unknown: '전달 여부 미확인',
  delivered: '전달 확인', superseded: '이전 결과', failed: '전달 실패', unavailable: '현재 전달 정보 확인 불가',
};
function clean(value: string) { return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ''); }

export function formatWorkView(result: WorkViewResult): string {
  if (result.kind === 'unchanged') return '표시 내용에 변경이 없습니다.\n';
  const view = result.view; const progress = view.progress;
  const status = progress.status === 'completed' && !progress.resultReady ? '저장된 업무는 완료 · 현재 결과 재확인 필요' : statusNames[progress.status] ?? progress.status;
  const pending = view.mode.pending ? ` · 모드 변경 대기: ${modeNames[view.mode.pending] ?? view.mode.pending}` : '';
  const lines = [`[${view.workId} · 목표 ${view.goalRevision}] ${view.title}`,
    `${status} · ${modeNames[view.mode.requested] ?? view.mode.requested}${pending} · 결과 ${progress.resultReady ? '준비됨' : '미준비'} · ${deliveryNames[progress.resultDelivery] ?? progress.resultDelivery}`];
  if (!view.reply.observingPrimary) lines.push(`답변 채널: ${view.reply.channel} · 현재 대화에서는 업무를 조회합니다.`);
  if (['blocked', 'waiting', 'failed'].includes(progress.status) && progress.reason && !view.messages.some(message => message.kind === 'question')) lines.push(`확인할 사항: ${progress.reason}`);
  if (view.messages.length) lines.push('', ...view.messages.map(message => {
    if (message.kind === 'ack' || message.deliveryStatus === 'delivered') return message.text;
    const kind = message.kind === 'result' ? '답변' : message.kind === 'question' ? '질문' : '안내';
    return `[준비된 ${kind} · ${deliveryNames[message.deliveryStatus] ?? message.deliveryStatus}]\n${message.text}`;
  }));
  if (view.details) lines.push('', '상세 정보', JSON.stringify(view.details, null, 2));
  if (view.diagnostics) lines.push('', '실행 진단', JSON.stringify(view.diagnostics, null, 2));
  return clean(lines.join('\n')) + '\n';
}
