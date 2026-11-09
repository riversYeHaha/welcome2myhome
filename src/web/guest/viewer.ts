import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

interface ViewerOptions {
  modelUrl: string | null;
  dollId: string;
  interactive?: boolean;
}

interface ViewerHandle {
  dispose: () => void;
  /** Swap to another model (E2 second form) without rebuilding the scene. */
  swapModel: (url: string) => void;
}

const PALETTE = [0xe5b567, 0x7ed6a5, 0xf28b82, 0x8ab4f8, 0xd98acb];
const MODEL_HEIGHT = 0.42;
/** Tap reactions: short, non-spoiler lines; never secrets or story text. */
const TAP_LINES = [
  '我在呢。',
  '再靠近一点。',
  '谢谢你找到我。',
  '这个家里还有好多小秘密。',
  '戳一下就好，别把我看穿啦。',
  '今晚，记得多待一会儿。',
];
/** Self-hosted decoder copied from three (`src/web/public/draco/`, no CDN). */
const DRACO_DECODER_PATH = '/draco/';

/**
 * One shared DRACOLoader per page: the decoder worker pool is expensive to
 * spin up and is safe to reuse across inline cards and the collection overlay.
 * Uncompressed GLBs never touch it, so a missing /draco/ asset cannot break
 * the normal path.
 */
let dracoLoader: DRACOLoader | null = null;

function getDracoLoader(): DRACOLoader {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
    dracoLoader.setWorkerLimit(2);
  }
  return dracoLoader;
}

function createGltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setDRACOLoader(getDracoLoader());
  return loader;
}


function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createPlaceholder(dollId: string): THREE.Group {
  const group = new THREE.Group();
  const color = PALETTE[hashString(dollId) % PALETTE.length]!;
  const cloth = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.12 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xf3d9c4, roughness: 0.72 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.12, 8, 16), cloth);
  body.position.y = 0.02;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.075, 24, 16), skin);
  head.position.y = 0.2;
  const armLeft = new THREE.Mesh(new THREE.CapsuleGeometry(0.017, 0.085, 5, 8), cloth);
  armLeft.position.set(-0.09, 0.05, 0);
  armLeft.rotation.z = 0.28;
  const armRight = armLeft.clone();
  armRight.position.x = 0.09;
  armRight.rotation.z = -0.28;

  group.add(body, head, armLeft, armRight);
  return group;
}

function fitModel(model: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = MODEL_HEIGHT / Math.max(size.y, 0.001);
  model.scale.setScalar(scale);

  const scaled = new THREE.Box3().setFromObject(model);
  const center = scaled.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= scaled.min.y;
}

async function freshModelUrl(dollId: string): Promise<string | null> {
  try {
    const response = await fetch('/api/collection', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      items?: Array<{ doll_id: string; model_url: string | null }>;
    };
    return data.items?.find((item) => item.doll_id === dollId)?.model_url ?? null;
  } catch {
    return null;
  }
}

/** Inline viewers by doll id, so the card page can swap to the secret form. */
const inlineViewers = new Map<string, Set<ViewerHandle>>();

function createViewer(container: HTMLElement, options: ViewerOptions): ViewerHandle {
  const width = Math.max(container.clientWidth, 120);
  const height = Math.max(container.clientHeight, 160);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.setAttribute('aria-label', '3D 人偶');
  container.append(renderer.domElement);
  container.classList.add('viewer-ready');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, width / height, 0.01, 10);
  camera.position.set(0, 0.14, 1.2);
  camera.lookAt(0, 0.14, 0);

  scene.add(new THREE.HemisphereLight(0xffe6c0, 0x1b1512, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(1, 1.6, 1.4);
  scene.add(key);
  const rim = new THREE.PointLight(0xe5b567, 2.2, 3);
  rim.position.set(-1, 0.7, -0.9);
  scene.add(rim);

  if (window.getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  const group = new THREE.Group();
  scene.add(group);

  let placeholder: THREE.Group | null = createPlaceholder(options.dollId);
  group.add(placeholder);
  let loaded = false;

  function replaceWithModel(model: THREE.Object3D): void {
    if (placeholder) {
      group.remove(placeholder);
      placeholder.traverse((child) => {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
      });
      placeholder = null;
    }
    fitModel(model);
    group.add(model);
    loaded = true;
  }

  /**
   * `swap` loads a different model (E2 second form) and never retries with a
   * fresh base URL, so a failed swap keeps the current doll on screen.
   */
  function load(url: string, retried = false, swap = false): void {
    const loader = createGltfLoader();
    loader.load(
      url,
      (gltf) => replaceWithModel(gltf.scene),
      undefined,
      () => {
        if (retried || swap) return;
        void freshModelUrl(options.dollId).then((fresh) => {
          if (fresh && fresh !== url) load(fresh, true);
        });
      },
    );
  }

  if (options.modelUrl) load(options.modelUrl);

  let disposed = false;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let autoRotate = true;
  let tapStart = 0;
  let downX = 0;
  let downY = 0;
  let taps = 0;
  let pulseStart = 0;
  let bubbleTimer = 0;

  /** Tap (not drag) reaction: a little hop + one preset line in a bubble. */
  function react(): void {
    taps += 1;
    pulseStart = performance.now();
    let bubble = container.querySelector<HTMLDivElement>('.doll-bubble');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'doll-bubble';
      bubble.setAttribute('role', 'status');
      container.append(bubble);
    }
    const line = TAP_LINES[(hashString(options.dollId) + taps) % TAP_LINES.length]!;
    bubble.textContent = line;
    bubble.classList.remove('doll-bubble-show');
    void bubble.offsetWidth;
    bubble.classList.add('doll-bubble-show');
    window.clearTimeout(bubbleTimer);
    bubbleTimer = window.setTimeout(() => {
      bubble?.classList.remove('doll-bubble-show');
    }, 2600);
  }

  const onPointerDown = (event: PointerEvent): void => {
    dragging = true;
    autoRotate = false;
    tapStart = performance.now();
    downX = event.clientX;
    downY = event.clientY;
    lastX = event.clientX;
    lastY = event.clientY;
    renderer.domElement.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    group.rotation.y += (event.clientX - lastX) * 0.01;
    group.rotation.x = clamp(group.rotation.x + (event.clientY - lastY) * 0.006, -0.5, 0.5);
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const onPointerUp = (event: PointerEvent): void => {
    const wasTap =
      dragging &&
      performance.now() - tapStart < 400 &&
      Math.hypot(event.clientX - downX, event.clientY - downY) < 10;
    dragging = false;
    autoRotate = true;
    if (wasTap) react();
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    camera.position.z = clamp(camera.position.z + event.deltaY * 0.0012, 0.72, 2.2);
  };

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  const observer = new ResizeObserver(() => {
    const nextWidth = Math.max(container.clientWidth, 120);
    const nextHeight = Math.max(container.clientHeight, 160);
    renderer.setSize(nextWidth, nextHeight, false);
    camera.aspect = nextWidth / nextHeight;
    camera.updateProjectionMatrix();
  });
  observer.observe(container);

  const clock = new THREE.Clock();
  let frame = 0;
  function animate(): void {
    if (disposed) return;
    const delta = clock.getDelta();
    if (autoRotate && !dragging) group.rotation.y += delta * 0.35;
    group.position.y = Math.sin(performance.now() / 900) * 0.012;
    if (pulseStart > 0) {
      const t = (performance.now() - pulseStart) / 420;
      if (t >= 1) {
        pulseStart = 0;
        group.scale.setScalar(1);
        group.rotation.z = 0;
      } else {
        group.scale.setScalar(1 + Math.sin(t * Math.PI) * 0.09);
        group.rotation.z = Math.sin(t * Math.PI * 2) * 0.05;
      }
    }
    renderer.render(scene, camera);
    frame = requestAnimationFrame(animate);
  }
  animate();

  const handle: ViewerHandle = {
    swapModel: (url: string) => {
      if (url) load(url, true, true);
    },
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
      });
      window.clearTimeout(bubbleTimer);
      container.querySelector('.doll-bubble')?.remove();
      renderer.dispose();
      renderer.domElement.remove();
      container.classList.remove('viewer-ready');
      const set = inlineViewers.get(options.dollId);
      set?.delete(handle);
      if (set && set.size === 0) inlineViewers.delete(options.dollId);
      void loaded;
    },
  };

  const set = inlineViewers.get(options.dollId) ?? new Set<ViewerHandle>();
  set.add(handle);
  inlineViewers.set(options.dollId, set);

  return handle;
}

/**
 * Card page calls this after a correct answer to reveal the second form.
 * Returns whether at least one inline viewer picked it up.
 */
export function swapDollModel(dollId: string, modelUrl: string): boolean {
  const viewers = inlineViewers.get(dollId);
  if (!viewers || viewers.size === 0) return false;
  for (const viewer of viewers) viewer.swapModel(modelUrl);
  return true;
}

declare global {
  interface Window {
    __wtmSwapModel?: (dollId: string, modelUrl: string) => boolean;
  }
}

window.__wtmSwapModel = swapDollModel;

function openOverlay(
  dollId: string,
  name: string,
  modelUrl: string | null,
  secretModelUrl: string | null,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'viewer-overlay';

  const stage = document.createElement('div');
  stage.className = 'viewer-stage';

  const title = document.createElement('p');
  title.className = 'viewer-title';
  title.textContent = name || 'TA 的样子';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'viewer-close';
  close.textContent = '收起';
  close.setAttribute('aria-label', '收起 3D 视图');

  const secret = document.createElement('button');
  secret.type = 'button';
  secret.className = 'viewer-secret';
  secret.textContent = '看第二形态';
  secret.hidden = !secretModelUrl;

  overlay.append(title, stage, secret, close);
  document.body.append(overlay);

  let viewer: ViewerHandle | null = null;
  try {
    viewer = createViewer(stage, { modelUrl, dollId, interactive: true });
  } catch {
    stage.textContent = '这台设备暂时无法显示 3D 人偶。';
  }

  secret.addEventListener('click', () => {
    if (!secretModelUrl) return;
    viewer?.swapModel(secretModelUrl);
    secret.disabled = true;
    secret.textContent = '已换成第二形态';
  });

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeOverlay();
  };
  function closeOverlay(): void {
    viewer?.dispose();
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  close.addEventListener('click', closeOverlay);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeOverlay();
  });
  document.addEventListener('keydown', onKey);
}

function mountInline(): void {
  for (const element of document.querySelectorAll<HTMLElement>(
    '.silhouette[data-doll-id]',
  )) {
    try {
      createViewer(element, {
        dollId: element.dataset.dollId ?? 'doll',
        modelUrl: element.dataset.dollModel || null,
        interactive: true,
      });
    } catch {
      // Keep the SSR silhouette when WebGL is unavailable.
    }
  }
}

function bindCollectionButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('.view-doll')) {
    button.addEventListener('click', () => {
      openOverlay(
        button.dataset.dollId ?? 'doll',
        button.dataset.name ?? '',
        button.dataset.modelUrl || null,
        button.dataset.secretModelUrl || null,
      );
    });
  }
}

mountInline();
bindCollectionButtons();
