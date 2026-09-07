"""service.probes — 도메인-무관 active 검증 코어 (recon→active 경계).

credential_login_probe: 발견된 크리덴셜이 실제로 유효한지 1회 검증. 안전봉투(중앙
영속 단발원장·scope·회로차단기·평문격리)는 여기 코어에만 두고, 도메인별 tool 은
원문 재추출 provider 만 바인딩한다. 엔진 무수정 — skill service 레이어.
"""
