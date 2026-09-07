"""digisecu-gateway — M4 state_domain read 게이트웨이(read-only).

threat_hunter의 유일 외부 sanctioned read 어댑터. 엔진/스킬 무수정, connect() 격리,
read-only 3중 강제, 마스킹 seal 존중(원문 복원 경로 없음). control-plane 미접촉 경계 유지.
"""
__version__ = "0.0.0"
