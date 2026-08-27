export function applySavedTheme() {
  const savedTheme = localStorage.getItem('theme')
  document.documentElement.classList.toggle('dark', savedTheme ? savedTheme === 'dark' : true)
}
