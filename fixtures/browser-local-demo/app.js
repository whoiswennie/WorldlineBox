document.querySelector('#verify')?.addEventListener('click', () => {
  const status = document.querySelector('#status')
  if (status) status.textContent = '验证成功：本地 JavaScript 正常运行。'
})
