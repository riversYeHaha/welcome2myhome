const button = document.querySelector<HTMLButtonElement>('#print-button');
button?.addEventListener('click', () => window.print());
