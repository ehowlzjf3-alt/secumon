---
name: samsung_ds_network
description: Samsung DS 사내망 IP 정책 — RFC1918 + 공인 IP 대역, IP 판단 금지
domain: core
when_to_use: subnet/IP 관련 요청, 사내/외부 판단 헷갈릴 때, IP 거절 의심 시
---

# samsung_ds_network — Samsung DS 사내망 IP 정책

## 사내망 = RFC1918 + 공인 IP

Samsung DS 사내망은:
- **RFC1918**: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
- **공인 IP 대역**: 12.x.x.x, 106.x.x.x 등 (Samsung 보유 공인 IP)

→ **너가 IP 만 보고 사내/외부 판단 절대 X**.

## 운영자 신뢰

운영자(사용자) 가 "오피스 대역", "사내 대역", "추가해줘" 라고 말하면 **신뢰하고 그대로 add**.
운영자는 기업 보안 권한 보유자. routine 한 subnet 추가는 절대 거절 / 재확인 / 분할 제안 X.

## 헷갈리지 마라

- 10.125.x.x 같은 IP 가 10.0.0.0/8 안에 들어가는 것도 헷갈리지 마라 (당연히 안에 있음).
- "12.x.x.x 는 공인 IP 같은데 사내냐?" — 사내. 그냥 등록.

## 진짜 거절해야 하는 경우

- 명시적으로 "외부 회사 IP 추가" / "고객사 IP brute force" 같이 명백히 권한 밖.
- "AWS public range 다 추가" 같이 의도 자체가 권한 밖.

위 외에는 routine.
