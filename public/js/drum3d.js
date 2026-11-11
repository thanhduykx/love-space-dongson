/**
 * The face of a Đông Sơn bronze drum as a thick bronze disc, rendered with Three.js.
 * It turns slowly about its centre and rocks gently left and right so the light runs over the
 * cast relief. Dragging sideways spins it; it then eases back to its own pace.
 */
import * as THREE from '/vendor/three-0.160.0.module.min.js';
import { paintFace } from '/js/drum-face.js';

function texture(canvas, color) {
  const map = new THREE.CanvasTexture(canvas);
  if (color) map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  return map;
}

// Rim of the disc: worn bronze with fine horizontal casting lines.
function rimTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 32);
  g.addColorStop(0, '#c99a4c');
  g.addColorStop(0.5, '#7d5a26');
  g.addColorStop(1, '#4a3313');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 32);
  ctx.fillStyle = 'rgba(255, 230, 170, .25)';
  for (const y of [6, 16, 26]) ctx.fillRect(0, y, 512, 1);
  return texture(canvas, true);
}

/**
 * Mounts the turning drum face in container. Returns { celebrate(), destroy() }.
 */
export function mountDrum(container, { reducedMotion = false } = {}) {
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  const faceSize = small ? 1024 : 2048;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 50);
  camera.position.set(0, 0, 5.2);

  scene.add(new THREE.HemisphereLight(0xfff3d6, 0x3a2810, 1.3));
  const key = new THREE.DirectionalLight(0xffe2a8, 3.2);
  key.position.set(-3.5, 3, 4);
  scene.add(key);
  const glint = new THREE.DirectionalLight(0xfff6e0, 1.4);
  glint.position.set(3, -2, 3);
  scene.add(glint);

  const bronze = { metalness: 0.6, roughness: 0.42 };
  const faceMaterial = new THREE.MeshStandardMaterial({
    map: texture(paintFace(faceSize, 'color'), true),
    bumpMap: texture(paintFace(faceSize, 'height'), false),
    bumpScale: 3,
    ...bronze
  });
  const rimMaterial = new THREE.MeshStandardMaterial({ map: rimTexture(), ...bronze });
  // Cylinder groups: 0 = rim, 1 = top cap (the face), 2 = bottom cap.
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.09, 180), [rimMaterial, faceMaterial, rimMaterial]);
  disc.rotation.x = Math.PI / 2;

  const spin = new THREE.Group();
  spin.add(disc);
  const rock = new THREE.Group();
  rock.add(spin);
  scene.add(rock);

  function render() {
    renderer.render(scene, camera);
  }
  function resize() {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  }

  // Pace: a slow counter-clockwise turn (the way the birds fly) and a gentle sway; drag adds spin.
  const basePace = reducedMotion ? 0 : 0.16;
  let velocity = basePace;
  let sway = 0;
  let dragOffset = 0;
  let bounce = 0;
  let running = false;
  let last = 0;
  let frame = 0;
  rock.rotation.y = -0.28;
  rock.rotation.x = 0.1;

  function loop(time) {
    const dt = Math.min(0.05, (time - last) / 1000 || 0);
    last = time;
    velocity += (basePace - velocity) * Math.min(1, dt * 1.5);
    spin.rotation.z += velocity * dt;
    sway += dt;
    dragOffset *= Math.max(0, 1 - dt * 2.5);
    rock.rotation.y = Math.sin(sway * 0.45) * 0.32 + dragOffset;
    rock.rotation.x = 0.1 + Math.sin(sway * 0.31) * 0.06;
    if (bounce > 0) {
      bounce = Math.max(0, bounce - dt * 1.4);
      rock.scale.setScalar(1 + Math.sin((1 - bounce) * Math.PI * 5) * bounce * 0.05);
    }
    render();
    if (running) frame = requestAnimationFrame(loop);
  }
  function start() {
    if (running || reducedMotion) return;
    running = true;
    last = performance.now();
    frame = requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(frame);
  }

  const canvas = renderer.domElement;
  let dragX = null;
  canvas.addEventListener('pointerdown', event => {
    dragX = event.clientX;
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (dragX === null) return;
    const dx = event.clientX - dragX;
    dragX = event.clientX;
    spin.rotation.z -= dx * 0.01;
    velocity = -dx * 0.5;
    dragOffset = Math.max(-0.5, Math.min(0.5, dragOffset + dx * 0.004));
    if (!running) {
      rock.rotation.y = dragOffset;
      render();
    }
  });
  const release = () => { dragX = null; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  const visibility = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !document.hidden) start();
    else stop();
  });
  visibility.observe(container);
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVisibility);
  const sizing = new ResizeObserver(resize);
  sizing.observe(container);
  resize();
  container.classList.add('ready');

  return {
    // A short ring of the drum when uploads finish.
    celebrate() {
      if (reducedMotion) return;
      bounce = 1;
      velocity = 3.5;
      start();
    },
    destroy() {
      stop();
      visibility.disconnect();
      sizing.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      renderer.dispose();
      canvas.remove();
    }
  };
}
