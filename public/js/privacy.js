// Terms page: the same turning drum face in the corner of the scroll, loaded once the text is shown.
const container = document.getElementById('scroll-drum');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const mount = () => import('/js/drum3d.js')
  .then(({ mountDrum }) => mountDrum(container, { reducedMotion }))
  .catch(() => { /* without WebGL the static bronze icon stays */ });
if (container) {
  if ('requestIdleCallback' in window) requestIdleCallback(mount, { timeout: 2500 });
  else setTimeout(mount, 600);
}
