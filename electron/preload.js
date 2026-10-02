// Tags the page so the stylesheet can make room for native window controls.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop', `platform-${process.platform}`);
});
