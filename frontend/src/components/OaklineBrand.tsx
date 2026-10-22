export function OaklineBrand({ className = '' }: { className?: string }) {
  return <span className={`inline-flex shrink-0 items-center gap-2.5 font-semibold tracking-tight ${className}`}>
    <img src="/oakline.svg" width="32" height="32" alt="" className="size-8 shrink-0" />
    <span>Oakline</span>
  </span>
}
