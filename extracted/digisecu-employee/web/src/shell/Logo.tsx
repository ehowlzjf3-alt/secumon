/** 시큐몬 엠블럼 — 종이·먹 톤의 도장(방패+키홀). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-hidden="true">
      {/* 도장 테두리 */}
      <circle cx="16" cy="16" r="14.6" fill="var(--color-card)" stroke="var(--color-walnut)" strokeWidth="1.3" />
      <circle cx="16" cy="16" r="11.7" stroke="var(--color-walnut)" strokeWidth="0.7" strokeDasharray="0.6 2.3" opacity="0.65" />
      {/* 방패 */}
      <path d="M16 6.6l6.4 2.3v4.4c0 4.6-3.1 7.1-6.4 8.5-3.3-1.4-6.4-3.9-6.4-8.5V8.9z" fill="var(--color-walnut)" />
      {/* 키홀 (임직원 접근) */}
      <circle cx="16" cy="12.8" r="1.75" fill="var(--color-card)" />
      <path d="M14.85 14.1h2.3l-.62 3.5h-1.06z" fill="var(--color-card)" />
    </svg>
  );
}
