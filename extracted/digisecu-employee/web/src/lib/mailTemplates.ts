/**
 * 발송 메일 서식 카탈로그 — **정적**이다.
 *
 * ★ 관리할 "템플릿" 이라는 물건이 존재하지 않는다. 세 저장소를 통틀어 `.j2`/`.jinja`/`.mustache`
 *   0건, 메일용 `.html` 0건, 문안이 든 `.yaml` 0건이다. 제목·본문은 전부 스킬 저장소의
 *   **파이썬 f-string** 안에 있다(2026-08-23 조사).
 *
 * 그래서 이 화면이 할 수 있는 일은 "어떤 도메인이 어떤 문구를 쓰는지" 를 보여주는 것뿐이고,
 * 편집은 불가능하다. 편집하려면 (1) 스킬 저장소에서 문구를 주입 가능한 값으로 외부화하고
 * (2) 쓰기 경로를 신설해야 하는데, 둘 다 "엔진·스킬 무수정" 불변식에 대한 결정이 선행된다.
 *
 * ⚠️ 여기 적힌 것은 **코드와 자동 동기화되지 않는다.** 드리프트가 기본값이라고 보고 읽을 것.
 *    조사 시점: 2026-08-23 (secu-agent-skill HEAD 3a03841).
 */

export interface MailTemplate {
  id: string;
  domain: string;
  /** 메일 종류. */
  kind: string;
  /** 제목의 고정 접두 — ★ 답장을 스레드에 붙이는 유일한 키다(Knox 가 Message-ID 를 안 준다).
   *  편집 가능하게 만들면 회신이 조용히 안 붙는다. */
  subjectPrefix: string;
  subjectTail: string;
  /** 본문 구성 — on 은 들어감, off 는 없음. "없음" 도 정보다. */
  sections: { label: string; on: boolean; proposed?: boolean }[];
  recipient: string;
  /** 실제 발송이 담당자에게 가는지.
   *  ⚠️ 이 값은 **2026-08-23 시점의 손기록**이다. 그 뒤 정책이 바뀌었다 —
   *  수신처는 담당자(To) + DSSOC(Cc) 이고 `dssoc_only` 모드는 폐기됐다.
   *  실제로 담당자에게 나가는지는 엔진 env 가 정하므로 이 카탈로그로 판단하면 안 된다. */
  deliversToOwner: boolean;
  signature: boolean;
  table: string | null;
  /** 보낸 본문이 어디에 남는가. null = 안 남는다. */
  archive: { where: string; count: number } | null;
  /** 실재 여부 — 코드가 아예 없는 것은 unimplemented. */
  state: "live" | "unimplemented";
  note?: string;
}

const on = (label: string) => ({ label, on: true });
const off = (label: string) => ({ label, on: false });
const proposed = (label: string) => ({ label, on: false, proposed: true });

export const MAIL_TEMPLATES: MailTemplate[] = [
  {
    id: "smb-report",
    domain: "smb",
    kind: "조치 요청",
    subjectPrefix: "[보안취약점 조치요청](대상 IP)",
    subjectTail: "공유폴더 접근권한 관리",
    sections: [
      on("머리글"), on("인사말"), on("누적 경고"), on("요약 4칸"),
      on("공유 폴더 표"), on("조치 방법"), on("서명"),
      off("발견 목록"), off("첨부"),
    ],
    recipient: "IP 담당자 (Splunk 자산목록 매칭)",
    deliversToOwner: false,
    signature: true,
    table: "4열 · 공유 폴더 / 접근 권한 / 수집 파일 수 / 조치 방향",
    archive: { where: "mail_message.body_excerpt", count: 253 },
    state: "live",
    note: "발견 목록을 싣지 않는다 — 공유 폴더 권한 이야기만 한다(빌더가 의도적으로 뺀다).",
  },
  {
    id: "smb-recheck",
    domain: "smb",
    kind: "재확인 요청",
    subjectPrefix: "RE: [보안취약점 조치요청](대상 IP)",
    subjectTail: "",
    sections: [
      on("잔존 권한 표"), on("확인 사항"), on("원문 인용"),
      off("머리글"), off("서명"), off("조치 방법"),
    ],
    recipient: "회신한 담당자",
    deliversToOwner: false,
    signature: false,
    table: "4열 · 공유 폴더 / 남은 접근 권한 / 재확인 범위 / 상태",
    archive: { where: "mail_message.body_excerpt", count: 16 },
    state: "live",
    note: "조치 요청과 서식이 전혀 다르다 — 머리글·서명 없이 본문과 표만.",
  },
  {
    id: "github-report",
    domain: "github",
    kind: "조치 요청",
    subjectPrefix: "[GitHub 보안취약점 조치요청](저장소)",
    subjectTail: "소스코드 시크릿 조치 요청",
    sections: [
      on("머리글"), on("잔존 경고"), on("요약 6칸"), on("발견 표"), on("권장 조치"), on("서명"),
      off("인사말"), off("첨부"),
    ],
    recipient: "커밋 작성자",
    deliversToOwner: false,
    signature: true,
    table: "7열 · 심각도 / 경로 / 현재 상태 / 찾은 방법 / 후보 출처 / 마스킹 값 / 권장 조치",
    archive: null,
    state: "live",
    note: "어떻게 찾았는지(scan_trace)를 메일에 그대로 노출하는 유일한 도메인.",
  },
  {
    id: "github-recheck",
    domain: "github",
    kind: "재확인 안내",
    subjectPrefix: "RE: [GitHub 보안취약점 조치요청](저장소)",
    subjectTail: "",
    sections: [on("머리글"), on("재확인 결과"), on("서명"), off("발견 표")],
    recipient: "커밋 작성자",
    deliversToOwner: false,
    signature: true,
    table: null,
    archive: null,
    state: "live",
  },
  {
    id: "confluence-report",
    domain: "confluence",
    kind: "조치 요청",
    subjectPrefix: "[Confluence 보안취약점 조치요청](스페이스)",
    subjectTail: "콘텐츠 시크릿 조치 요청",
    sections: [on("발견 표"), off("머리글"), off("인사말"), off("서명"), off("첨부")],
    recipient: "스페이스 관리자",
    deliversToOwner: false,
    signature: false,
    table: "8열 · 자산 종류 포함",
    archive: null,
    state: "live",
    note: "네 도메인 중 가장 이질적이다 — 스타일 블록 없이 영어 문구, 인사말·서명·푸터 전부 없음.",
  },
  {
    id: "confluence-recheck",
    domain: "confluence",
    kind: "재확인 안내",
    subjectPrefix: "RE: [Confluence 보안취약점 조치요청](스페이스)",
    subjectTail: "",
    sections: [on("재확인 결과"), off("머리글"), off("서명")],
    recipient: "스페이스 관리자",
    deliversToOwner: false,
    signature: false,
    table: null,
    archive: null,
    state: "live",
    note: "같은 도메인인데 조치 요청과 톤이 다르다 — 이쪽은 한국어에 인라인 스타일.",
  },
  {
    id: "dev_web-report",
    domain: "dev_web",
    kind: "조치 요청",
    subjectPrefix: "[Dev Web 보안취약점 조치요청](웹 도메인)",
    subjectTail: "개발 웹 접근통제 조치",
    sections: [
      on("머리글"), on("요약 4칸"), on("내용"), on("조치 요청 사항"), on("점검 방법"), on("서명"),
      proposed("노출 표면 표"),
      off("인사말"), off("누적 경고"), off("첨부"),
    ],
    recipient: "DSSOC 고정 (담당자 개념 없음)",
    deliversToOwner: false,
    signature: true,
    table: null,
    archive: null,
    state: "live",
    note:
      "표가 하나도 없고 URL 을 딱 하나만 보여준다. 그런데 finding 에는 프로브 결과가 이미 있다 — " +
      "전체 430개 중 343개가 인증 없이 200 으로 열려 있고 각각 응답코드·형식을 들고 있다.",
  },
  {
    id: "dev_web-recheck",
    domain: "dev_web",
    kind: "재확인 안내",
    subjectPrefix: "—",
    subjectTail: "",
    sections: [],
    recipient: "—",
    deliversToOwner: false,
    signature: false,
    table: null,
    archive: null,
    state: "unimplemented",
    note:
      "서식이 없다. 재검증 워커는 존재하고 배선도 돼 있는데 발송 도구가 없어 DB 기록으로 끝난다. " +
      "게다가 답장을 받는 경로 자체가 없다(POP3 제목 분류기에 dev_web 분기 없음).",
  },
];

/** 도메인별로 묶은 목록 — 화면 좌측 트리. */
export function templatesByDomain(): { domain: string; items: MailTemplate[] }[] {
  const order = ["smb", "github", "confluence", "dev_web"];
  return order.map((d) => ({ domain: d, items: MAIL_TEMPLATES.filter((t) => t.domain === d) }));
}
