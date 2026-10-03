// Avisos do Game Companion no canto da tela (aparecem mesmo com o painel escondido).
const stack = document.getElementById('stack');
window.api.onToast((text) => {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = '<div><div class="brand">Game Companion</div><div class="text"></div></div>';
  el.querySelector('.text').textContent = text;
  stack.appendChild(el);
  while (stack.children.length > 3) stack.firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 6000);
});
