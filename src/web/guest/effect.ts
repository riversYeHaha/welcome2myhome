/**
 * E1 discovery effect (T501–T506).
 *
 * Progressive enhancement: the SSR card page is complete without this script.
 * When it runs, it stages the reveal, renders Canvas 2D particles, synthesises
 * WebAudio cues, and finally reports `discover`. Every failure path degrades to
 * a static card — never a blank screen.
 */

type Theme = 'starlight' | 'confetti' | 'bubbles' | 'sparks';
type Shape = 'star' | 'rect' | 'circle' | 'line';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  life: number;
  ttl: number;
  size: number;
  color: string;
  rotation: number;
  spin: number;
  shape: Shape;
  wobble: number;
}

const COLLECTED_STATES = new Set(['collected', 'egg_answering', 'egg_unlocked']);

interface RiddleView {
  type: 'single_choice' | 'short_answer';
  question: string;
  options: string[];
  hint: string;
  wrong_text: string;
  max_attempts: number;
}

interface SecretPayload {
  story: string;
  whisper: string;
  star: boolean;
  model_url: string | null;
}

interface AnswerResponse {
  correct: boolean;
  wrong_text?: string;
  hint?: string;
  attempts?: number;
  max_attempts?: number;
  secret?: SecretPayload;
  error?: { message?: string };
}

const THEME_COLORS: Record<Theme, string[]> = {
  starlight: ['#ffe9b0', '#e5b567', '#fff6dd', '#ffd98a'],
  confetti: ['#f2c14e', '#e86a5a', '#6bbf8a', '#5b9bd5', '#d98acb'],
  bubbles: ['#9fdfe0', '#f0b8c8', '#ffe9b0'],
  sparks: ['#ffb347', '#ff7a45', '#ffd166'],
};

const card = document.querySelector<HTMLElement>('main.card');
if (card) init(card);

function init(root: HTMLElement): void {
  const docEl = document.documentElement;
  const preview = root.dataset.preview === '1';
  const theme = (root.dataset.effect as Theme | undefined) ?? 'starlight';
  const soundEnabled = root.dataset.sound !== '0';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let alreadyCollected = COLLECTED_STATES.has(root.dataset.state ?? '');
  let settled = false;
  let timers: number[] = [];
  let frame = 0;
  let particles: Particle[] = [];
  let lastFrame = 0;
  let hiddenAt = 0;
  let lastReplay = 0;

  const canvas = document.createElement('canvas');
  canvas.className = 'e1-particles';
  const context = canvas.getContext('2d');
  document.body.appendChild(canvas);

  function resizeCanvas(): void {
    if (!context) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  function clearTimers(): void {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  }

  function removeSweep(): void {
    for (const node of root.querySelectorAll('.e1-sweep')) node.remove();
  }

  function addSweep(): void {
    removeSweep();
    const sweep = document.createElement('div');
    sweep.className = 'e1-sweep';
    root.appendChild(sweep);
    window.setTimeout(() => sweep.remove(), 800);
  }

  function particleCount(): number {
    if (reduced) return 0;
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
    const cores = navigator.hardwareConcurrency ?? 4;
    if (memory <= 3 || cores <= 4) return 24;
    if (memory <= 6 || cores <= 6) return 60;
    return 120;
  }

  function spawn(colors: string[]): void {
    const rect = root.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height * 0.42;
    const count = particleCount();

    particles = Array.from({ length: count }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 90 + Math.random() * 360;
      const base: Particle = {
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: 0,
        life: 0,
        ttl: 0.8 + Math.random() * 0.5,
        size: 2 + Math.random() * 4,
        color: colors[Math.floor(Math.random() * colors.length)]!,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 8,
        shape: 'star',
        wobble: Math.random() * Math.PI * 2,
      };

      switch (theme) {
        case 'confetti':
          return { ...base, shape: 'rect', size: 3 + Math.random() * 4, gravity: 320, vy: base.vy * 0.6 };
        case 'bubbles':
          return {
            ...base,
            shape: 'circle',
            size: 4 + Math.random() * 8,
            gravity: -30,
            vx: base.vx * 0.25,
            vy: -40 - Math.random() * 120,
            ttl: 1.1 + Math.random() * 0.6,
          };
        case 'sparks':
          return { ...base, shape: 'line', size: 1.5 + Math.random() * 2, gravity: 150, ttl: 0.4 + Math.random() * 0.3 };
        default:
          return { ...base, shape: 'star' };
      }
    });

    lastFrame = performance.now();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(loop);
  }

  function loop(now: number): void {
    if (!context) return;
    const dt = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);

    particles = particles.filter((particle) => particle.life < particle.ttl);
    for (const particle of particles) {
      particle.life += dt;
      particle.vy += particle.gravity * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.rotation += particle.spin * dt;
      particle.wobble += dt * 4;

      const alpha = Math.max(0, 1 - particle.life / particle.ttl);
      context.save();
      context.globalAlpha = alpha;
      context.fillStyle = particle.color;
      context.strokeStyle = particle.color;

      if (particle.shape === 'star') {
        context.translate(particle.x, particle.y);
        context.rotate(particle.rotation);
        context.beginPath();
        for (let point = 0; point < 8; point += 1) {
          const radius = point % 2 === 0 ? particle.size : particle.size * 0.38;
          const angle = (point * Math.PI) / 4;
          context.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
        }
        context.closePath();
        context.fill();
      } else if (particle.shape === 'rect') {
        context.translate(particle.x, particle.y);
        context.rotate(particle.rotation);
        context.fillRect(-particle.size / 2, -particle.size, particle.size, particle.size * 2);
      } else if (particle.shape === 'circle') {
        context.beginPath();
        context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        context.lineWidth = 1;
        context.stroke();
      } else {
        const length = Math.hypot(particle.vx, particle.vy) * 0.05 + 2;
        context.globalCompositeOperation = 'lighter';
        context.beginPath();
        context.moveTo(particle.x, particle.y);
        context.lineTo(
          particle.x - (particle.vx / (Math.hypot(particle.vx, particle.vy) || 1)) * length,
          particle.y - (particle.vy / (Math.hypot(particle.vx, particle.vy) || 1)) * length,
        );
        context.lineWidth = particle.size;
        context.stroke();
      }
      context.restore();
    }

    if (particles.length > 0) {
      frame = requestAnimationFrame(loop);
    } else {
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  function stopParticles(): void {
    cancelAnimationFrame(frame);
    particles = [];
    context?.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  // --- WebAudio (no files, no CDN) ---
  let audio: AudioContext | null = null;
  let soundChip: HTMLButtonElement | null = null;

  function audioContext(): AudioContext | null {
    if (!soundEnabled) return null;
    try {
      audio ??= new AudioContext();
      if (audio.state === 'suspended') void audio.resume().catch(() => undefined);
      return audio;
    } catch {
      return null;
    }
  }

  function tone(frequency: number, delay: number, duration: number, type: OscillatorType = 'triangle', peak = 0.06): void {
    const ctx = audio;
    if (!ctx || ctx.state !== 'running') return;
    const start = ctx.currentTime + delay;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  function playBurst(): void {
    const ctx = audioContext();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      showSoundChip();
      return;
    }
    tone(523.25, 0, 0.18);
    tone(659.25, 0.11, 0.18);
    tone(783.99, 0.22, 0.22);
  }

  function playSettle(): void {
    const ctx = audioContext();
    if (!ctx || ctx.state !== 'running') return;
    tone(880, 0, 0.13, 'sine', 0.04);
    tone(660, 0.09, 0.2, 'sine', 0.03);
  }

  function showSoundChip(): void {
    if (soundChip) return;
    soundChip = document.createElement('button');
    soundChip.type = 'button';
    soundChip.className = 'e1-sound';
    soundChip.textContent = '🔊 点我开声';
    soundChip.addEventListener('click', () => {
      void audioContext()?.resume().then(() => {
        soundChip?.remove();
        soundChip = null;
        playBurst();
      });
    });
    document.body.appendChild(soundChip);
  }

  // --- Timeline ---
  function startSequence(): void {
    clearTimers();
    root.dataset.e1 = 'flip';
    addSweep();
    timers.push(
      window.setTimeout(() => {
        root.dataset.e1 = 'burst';
        spawn(THEME_COLORS[theme] ?? THEME_COLORS.starlight);
        playBurst();
      }, 300),
    );
    timers.push(window.setTimeout(() => (root.dataset.e1 = 'dissolve'), 1000));
    timers.push(window.setTimeout(() => (root.dataset.e1 = 'reveal'), 2000));
    timers.push(window.setTimeout(() => settle(), 2600));
  }

  function addSkip(): void {
    if (document.querySelector('.e1-skip')) return;
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'e1-skip';
    skip.textContent = '跳过';
    skip.addEventListener('click', () => settle());
    document.body.appendChild(skip);
  }

  function removeSkip(): void {
    document.querySelector('.e1-skip')?.remove();
  }

  function addReplay(): void {
    if (document.querySelector('.e1-replay')) return;
    const replay = document.createElement('button');
    replay.type = 'button';
    replay.className = 'e1-replay';
    replay.textContent = '再放一次';
    replay.addEventListener('click', () => {
      const now = performance.now();
      if (now - lastReplay < 800) return;
      lastReplay = now;
      settled = false;
      stopParticles();
      startSequence();
    });
    root.appendChild(replay);
  }

  async function collect(): Promise<void> {
    if (preview || alreadyCollected) return;
    const dollId = root.dataset.dollId;
    if (!dollId) return;

    try {
      const response = await fetch('/api/play/discover', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ doll_id: dollId }),
      });
      if (!response.ok) return;
      alreadyCollected = true;
      const form = root.querySelector('form');
      if (form) {
        const collected = document.createElement('p');
        collected.className = 'collected';
        collected.textContent = '已收入收藏册';
        form.replaceWith(collected);
      }
    } catch {
      // Keep the no-JS form as the fallback.
    }
  }

  let eggBound = false;

  function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function closePanel(): void {
    document.querySelector('.egg-panel')?.remove();
  }

  function showMessage(text: string): void {
    closePanel();
    const panel = element('section', 'egg-panel');
    panel.setAttribute('role', 'dialog');
    panel.append(element('p', 'egg-eyebrow', '秘密彩蛋'));
    panel.append(element('p', 'egg-question', text));
    const close = element('button', 'egg-close', '收起');
    close.type = 'button';
    close.addEventListener('click', closePanel);
    panel.append(close);
    document.body.append(panel);
  }

  function updateEggButton(): void {
    const button = root.querySelector<HTMLButtonElement>('.egg-open');
    if (!button) return;
    button.dataset.mode = 'secret';
    button.textContent = '看 TA 的秘密';
    button.hidden = false;
  }

  function showSecret(secret: SecretPayload): void {
    closePanel();
    const panel = element('section', 'egg-panel golden');
    panel.setAttribute('role', 'dialog');
    panel.append(element('p', 'egg-eyebrow', '秘密彩蛋'));
    panel.append(element('h2', '', '原来你记得。'));
    if (secret.story) {
      const story = element('p', 'egg-secret-story', secret.story);
      panel.append(story);
    }
    if (secret.whisper) {
      panel.append(element('p', 'egg-whisper', secret.whisper));
    }
    if (secret.star) {
      panel.append(element('p', 'egg-star', '★ 收藏册落下一颗星'));
    }
    if (secret.model_url) {
      panel.append(element('p', 'egg-hint', '第二形态模型将在 T601 接入'));
    }
    const close = element('button', 'egg-close', '收起');
    close.type = 'button';
    close.addEventListener('click', closePanel);
    panel.append(close);
    document.body.append(panel);
    updateEggButton();
  }

  async function openSecret(): Promise<void> {
    const dollId = root.dataset.dollId;
    if (!dollId) return;
    try {
      const response = await fetch(`/api/play/secret/${encodeURIComponent(dollId)}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        showMessage(
          response.status === 403
            ? '先答对 TA 的题，才能听到这段故事。'
            : '故事暂时听不到，稍后再试。',
        );
        return;
      }
      const data = (await response.json()) as { secret: SecretPayload };
      showSecret(data.secret);
    } catch {
      showMessage('网络好像断了，稍后再试。');
    }
  }

  async function submitAnswer(
    payload: Record<string, unknown>,
    setEnabled: (enabled: boolean) => void,
    feedback: HTMLElement,
    hintButton: HTMLButtonElement,
    hintText: HTMLParagraphElement,
    attempts: HTMLElement,
  ): Promise<void> {
    const dollId = root.dataset.dollId;
    if (!dollId) return;
    setEnabled(false);
    feedback.textContent = '正在听…';

    try {
      const response = await fetch('/api/play/answer', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ doll_id: dollId, ...payload }),
      });
      const data = (await response.json().catch(() => null)) as AnswerResponse | null;

      if (!response.ok) {
        feedback.textContent =
          response.status === 429
            ? '慢一点，歇口气再试。'
            : data?.error?.message ?? '出了点问题，再试一次。';
        setEnabled(true);
        return;
      }

      if (data?.correct && data.secret) {
        closePanel();
        showSecret(data.secret);
        return;
      }

      feedback.textContent = data?.wrong_text || '还差一点点，再想想。';
      if (data?.hint) {
        hintButton.hidden = false;
        hintText.textContent = `提示：${data.hint}`;
      }
      if (typeof data?.attempts === 'number') {
        attempts.textContent = `已试 ${data.attempts} 次${data.max_attempts ? ` / ${data.max_attempts}` : ' · 不限次数'}`;
      }
      setEnabled(true);
    } catch {
      feedback.textContent = '网络好像断了，再试一次。';
      setEnabled(true);
    }
  }

  async function skipQuiz(): Promise<void> {
    const dollId = root.dataset.dollId;
    if (!dollId) return;
    try {
      await fetch('/api/play/egg/skip', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ doll_id: dollId }),
      });
    } catch {
      // Skipping is best-effort; the card stays collected either way.
    }
    closePanel();
  }

  async function openQuiz(): Promise<void> {
    const token = root.dataset.token;
    const dollId = root.dataset.dollId;
    if (!token || !dollId) return;

    closePanel();
    let riddle: RiddleView | null = null;
    try {
      const response = await fetch(`/api/play/d/${encodeURIComponent(token)}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        showMessage('暂时听不到故事，稍后再试。');
        return;
      }
      const data = (await response.json()) as { level?: { riddle?: RiddleView | null } };
      riddle = data.level?.riddle ?? null;
    } catch {
      showMessage('网络好像断了，稍后再试。');
      return;
    }

    if (!riddle) {
      showMessage('这张卡没有彩蛋题。');
      return;
    }

    void fetch('/api/play/egg/start', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doll_id: dollId }),
    });

    const panel = element('section', 'egg-panel');
    panel.setAttribute('role', 'dialog');
    panel.append(element('p', 'egg-eyebrow', '再听听 TA 的故事'));
    panel.append(element('p', 'egg-question', riddle.question));

    const feedback = element('p', 'egg-feedback', '');
    const hintText = element('p', 'egg-hint', '');
    hintText.hidden = true;
    const hintButton = element('button', 'egg-hint', '看提示');
    hintButton.type = 'button';
    hintButton.hidden = !riddle.hint;
    hintButton.addEventListener('click', () => {
      hintText.hidden = false;
      hintButton.hidden = true;
    });
    const attempts = element('p', 'egg-feedback', '');
    const actions = element('div', 'egg-actions');
    const skip = element('button', '', '先跳过');
    skip.type = 'button';
    skip.addEventListener('click', () => void skipQuiz());
    const close = element('button', 'egg-close', '收起');
    close.type = 'button';
    close.addEventListener('click', closePanel);
    actions.append(hintButton, skip, close);

    if (riddle.type === 'short_answer') {
      const form = element('form', 'egg-input');
      const input = element('input', '');
      input.placeholder = '写下你的答案';
      input.maxLength = 200;
      const submit = element('button', '', '回答');
      submit.type = 'submit';
      form.append(input, submit);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void submitAnswer(
          { answer_text: input.value },
          (enabled) => {
            input.disabled = !enabled;
            submit.disabled = !enabled;
          },
          feedback,
          hintButton,
          hintText,
          attempts,
        );
      });
      panel.append(form);
    } else {
      const options = element('div', 'egg-options');
      for (const [index, option] of riddle.options.entries()) {
        const button = element('button', 'egg-option', option);
        button.type = 'button';
        button.addEventListener('click', () => {
          void submitAnswer(
            { choice_index: index },
            (enabled) => {
              for (const child of options.querySelectorAll('button')) {
                (child as HTMLButtonElement).disabled = !enabled;
              }
            },
            feedback,
            hintButton,
            hintText,
            attempts,
          );
        });
        options.append(button);
      }
      panel.append(options);
    }

    panel.append(feedback, hintText, attempts, actions);
    document.body.append(panel);
  }

  function revealEgg(): void {
    if (preview) return;
    const button = root.querySelector<HTMLButtonElement>('.egg-open');
    if (!button) return;
    button.hidden = false;
    if (eggBound) return;
    eggBound = true;
    button.addEventListener('click', () => {
      if (button.dataset.mode === 'secret') void openSecret();
      else void openQuiz();
    });
  }

  function settle(): void {
    if (settled) return;
    settled = true;
    clearTimers();
    stopParticles();
    removeSkip();
    root.dataset.e1 = 'settled';
    addReplay();
    playSettle();
    void collect();
    revealEgg();
  }

  function degrade(): void {
    docEl.classList.add('e1-degraded');
    settle();
  }

  // Watchdog: if the main thread is blocked past 300ms, skip the animation.
  const boot = performance.now();
  requestAnimationFrame(() => {
    if (!settled && performance.now() - boot > 300) degrade();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = performance.now();
    } else if (hiddenAt > 0 && performance.now() - hiddenAt > 5000 && !settled) {
      settle();
    }
  });

  docEl.classList.add('e1-ready');

  if (reduced) {
    settle();
  } else {
    addSkip();
    startSequence();
  }
}
