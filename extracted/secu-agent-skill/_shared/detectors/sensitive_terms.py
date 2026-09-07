"""semantic_validation 에서 적출한 도메인(반도체/경영) 민감어휘 사전.

재부착 시 `secu_agent/detectors/sensitive_terms.py` 로 복귀 — 엔진은 부재 시
빈 사전으로 graceful degrade (generic 신호는 코어 유지).
"""

SEMICONDUCTOR_TERMS = (
    "wafer", "lot", "recipe", "parameter", "reticle", "lithography",
    "photo", "etch", "deposition", "cmp", "diffusion", "implant",
    "metrology", "inspection", "defect", "yield", "binning", "fab",
    "cleanroom", "mes", "eap", "fdc", "spc", "apc", "rms", "yms",
    # 계측(metrology) 복합어 — 부분문자열 매칭이라 모호한 짧은 토큰(nm/cd/sem 단독) 금지,
    # 명확한 복합어만. 계측 수치 CSV(BCAT_Fin_Btm_Width 류)를 공정정보로 잡기 위함.
    "critical dimension", "cd-sem", "overlay", "film thickness",
    "sheet resistance", "step height", "profilometry", "ellipsometry",
    "roughness", "reflectance", "particle count", "wafer map", "dataextractor",
    "공정", "웨이퍼", "레시피", "수율", "불량", "설비", "계측",
    "선폭", "두께", "박막", "증착", "식각", "측정값", "계측값",
)
BUSINESS_TERMS = (
    "revenue", "margin", "pricing", "price", "cost", "forecast", "roadmap",
    "capa", "capacity", "shipment", "inventory", "contract", "customer",
    "vendor", "supplier", "supply chain", "m&a", "investment", "executive",
    "매출", "원가", "마진", "가격", "견적", "계약", "고객", "벤더",
    "공급망", "생산계획", "재고", "출하", "납기", "로드맵", "투자",
    "경영", "임원", "전략",
)
