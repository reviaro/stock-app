export function savedThemeIsDark() {
  try { return localStorage.getItem('theme') !== 'light' }
  catch { return true }
}

export function setTheme(isDark: boolean) {
  document.documentElement.classList.toggle('dark', isDark)
  try { localStorage.setItem('theme', isDark ? 'dark' : 'light') }
  catch { /* Theme changes still work when browser storage is unavailable. */ }
}

export function applySavedTheme() {
  document.documentElement.classList.toggle('dark', savedThemeIsDark())
}
