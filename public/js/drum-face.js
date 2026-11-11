/**
 * Paints the tympanum of a Đông Sơn bronze drum (after the Ngọc Lũ drum) on a canvas:
 * 14-ray star with peacock feathers, dancers with feathered headdresses and stilt houses,
 * deer, flying Lạc birds and the geometric bands between them, all moving counter-clockwise.
 * mode 'color' gives cast bronze (dark recesses, gilt relief, verdigris); mode 'height' a bump map.
 */
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ painting helpers */

function seededRandom(seed) {
  let value = seed;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

// Draws one motif either as cast bronze relief (colour map) or as raised white (height map).
function relief(ctx, mode, build, { stroke = 0, fill = true } = {}) {
  const paint = (style, dx, dy) => {
    ctx.save();
    ctx.translate(dx, dy);
    ctx.beginPath();
    build(ctx);
    if (fill) { ctx.fillStyle = style; ctx.fill(); }
    if (stroke) { ctx.lineWidth = stroke; ctx.strokeStyle = style; ctx.stroke(); }
    ctx.restore();
  };
  const unit = ctx.canvas.width / 1024;
  if (mode === 'height') {
    paint('#f2f2f2', 0, 0);
    return;
  }
  paint('rgba(18, 10, 2, .85)', 1.8 * unit, 2 * unit);
  paint('rgba(255, 242, 196, .8)', -1.1 * unit, -1.2 * unit);
  paint('#e2b961', 0, 0);
}

function ring(ctx, mode, r, width) {
  relief(ctx, mode, c => c.arc(0, 0, r, 0, TAU), { stroke: width, fill: false });
}

// Places count copies of a motif around the face, each in its own frame: x along the band
// (counter-clockwise, as the figures on the drum all move), y pointing outward.
function around(ctx, count, radius, draw, offset = 0) {
  for (let i = 0; i < count; i++) {
    const angle = offset + (i * TAU) / count;
    ctx.save();
    ctx.rotate(angle);
    ctx.translate(0, -radius);
    draw(i);
    ctx.restore();
  }
}

function bronzeBase(ctx, size, mode, random) {
  if (mode === 'height') {
    ctx.fillStyle = '#7a7a7a';
    ctx.fillRect(0, 0, size, size);
    return;
  }
  const base = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.72);
  base.addColorStop(0, '#6e4f22');
  base.addColorStop(0.6, '#5a3f19');
  base.addColorStop(1, '#3f2b10');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  // Fine casting grain.
  for (let i = 0; i < size * 6; i++) {
    ctx.fillStyle = random() < 0.5 ? 'rgba(20, 12, 4, .18)' : 'rgba(255, 220, 150, .1)';
    ctx.fillRect(random() * size, random() * size, 1.4, 1.4);
  }
}

// Verdigris: soft blooms of green-blue corrosion, heavier toward the rim.
function patina(ctx, size, random, strength) {
  for (let i = 0; i < 70; i++) {
    const x = random() * size;
    const y = random() * size;
    const r = size * (0.02 + random() * 0.09);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tone = random() < 0.5 ? '63, 122, 104' : '88, 140, 118';
    g.addColorStop(0, `rgba(${tone}, ${strength * (0.35 + random() * 0.4)})`);
    g.addColorStop(1, `rgba(${tone}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

/* ------------------------------------------------------------------ figures */

function lacBird(ctx, s) {
  // Lạc bird in flight as cast on the drums: long straight beak (+x), round head with a swept crest,
  // slim body, both wings raised with notched feathers, long trailing tail plumes and legs.
  const p = (x, y) => [x * s, y * s];
  const poly = points => {
    ctx.moveTo(...p(...points[0]));
    for (const point of points.slice(1)) ctx.lineTo(...p(...point));
    ctx.closePath();
  };
  ctx.moveTo(...p(0.44, -0.06));
  ctx.arc(0.36 * s, -0.06 * s, 0.08 * s, 0, TAU);
  poly([[0.42, -0.09], [1.02, -0.02], [0.42, -0.02]]);
  poly([[0.32, -0.12], [0.1, -0.34], [0.16, -0.34], [0.36, -0.14]]);
  poly([[0.28, -0.12], [0.02, -0.26], [0.08, -0.28], [0.32, -0.13]]);
  ctx.moveTo(...p(0.3, -0.04));
  ctx.ellipse(-0.02 * s, -0.02 * s, 0.32 * s, 0.09 * s, -0.05, 0, TAU);
  poly([[0.12, -0.08], [-0.02, -0.62], [-0.1, -0.5], [-0.12, -0.6], [-0.2, -0.46], [-0.24, -0.54], [-0.26, -0.08]]);
  poly([[0.02, -0.06], [-0.16, -0.44], [-0.22, -0.36], [-0.28, -0.42], [-0.32, -0.08]]);
  poly([[-0.28, -0.06], [-0.92, -0.16], [-0.34, 0.0]]);
  poly([[-0.3, -0.01], [-0.98, 0.04], [-0.34, 0.04]]);
  poly([[-0.28, 0.03], [-0.88, 0.2], [-0.32, 0.07]]);
  poly([[-0.04, 0.05], [-0.36, 0.3], [-0.32, 0.31], [0.0, 0.07]]);
  poly([[0.04, 0.05], [-0.26, 0.32], [-0.22, 0.33], [0.08, 0.07]]);
}

// Paired S-scroll used as filler between figures, as on the bands of the Ngọc Lũ drum.
function scroll(ctx, s) {
  ctx.moveTo(-0.5 * s, 0);
  ctx.bezierCurveTo(-0.5 * s, -0.4 * s, 0, -0.4 * s, 0, 0);
  ctx.bezierCurveTo(0, 0.4 * s, 0.5 * s, 0.4 * s, 0.5 * s, 0);
}

function deer(ctx, s) {
  // Walking deer with antlers, facing +x.
  ctx.ellipse(0, -0.42 * s, 0.42 * s, 0.17 * s, 0, 0, TAU);
  ctx.moveTo(0.34 * s, -0.5 * s);
  ctx.lineTo(0.5 * s, -0.86 * s);
  ctx.lineTo(0.66 * s, -0.86 * s);
  ctx.lineTo(0.48 * s, -0.46 * s);
  ctx.moveTo(0.52 * s, -0.86 * s);
  ctx.lineTo(0.46 * s, -1.12 * s);
  ctx.lineTo(0.54 * s, -1.1 * s);
  ctx.lineTo(0.58 * s, -0.92 * s);
  ctx.lineTo(0.72 * s, -1.08 * s);
  ctx.lineTo(0.78 * s, -1.02 * s);
  ctx.lineTo(0.62 * s, -0.86 * s);
  for (const [x, lean] of [[-0.32, -0.08], [-0.18, 0.06], [0.2, -0.06], [0.32, 0.08]]) {
    ctx.moveTo((x - 0.035) * s, -0.36 * s);
    ctx.lineTo((x + lean - 0.03) * s, 0);
    ctx.lineTo((x + lean + 0.03) * s, 0);
    ctx.lineTo((x + 0.035) * s, -0.36 * s);
  }
  ctx.moveTo(-0.4 * s, -0.48 * s);
  ctx.lineTo(-0.56 * s, -0.56 * s);
  ctx.lineTo(-0.42 * s, -0.4 * s);
}

function feathered(ctx, s) {
  // Dancer with a tall feathered headdress, moving +x, feet toward the centre.
  ctx.moveTo(-0.12 * s, 0);
  ctx.lineTo(-0.02 * s, -0.42 * s);
  ctx.lineTo(0.08 * s, 0);
  ctx.closePath();
  ctx.moveTo(0.06 * s, -0.36 * s);
  ctx.ellipse(0, -0.5 * s, 0.1 * s, 0.16 * s, 0, 0, TAU);
  ctx.moveTo(0.1 * s, -0.66 * s);
  ctx.arc(0.02 * s, -0.7 * s, 0.07 * s, 0, TAU);
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 - 0.9 + i * 0.24;
    const len = (0.46 + (i % 2) * 0.08) * s;
    ctx.moveTo(0.02 * s, -0.74 * s);
    ctx.lineTo(0.02 * s + Math.cos(a - 0.05) * len - 0.18 * s, -0.74 * s + Math.sin(a - 0.05) * len);
    ctx.lineTo(0.02 * s + Math.cos(a + 0.05) * len - 0.18 * s, -0.74 * s + Math.sin(a + 0.05) * len);
    ctx.closePath();
  }
  ctx.moveTo(0.08 * s, -0.5 * s);
  ctx.lineTo(0.42 * s, -0.62 * s);
  ctx.lineTo(0.42 * s, -0.56 * s);
  ctx.lineTo(0.08 * s, -0.44 * s);
}

function stiltHouse(ctx, s) {
  // House on stilts with the saddle roof of the drums, gables ending in bird heads.
  for (const x of [-0.3, -0.1, 0.1, 0.3]) {
    ctx.moveTo((x - 0.02) * s, 0);
    ctx.lineTo((x - 0.02) * s, -0.3 * s);
    ctx.lineTo((x + 0.02) * s, -0.3 * s);
    ctx.lineTo((x + 0.02) * s, 0);
  }
  ctx.rect(-0.42 * s, -0.36 * s, 0.84 * s, 0.07 * s);
  ctx.moveTo(-0.62 * s, -0.86 * s);
  ctx.quadraticCurveTo(0, -0.42 * s, 0.62 * s, -0.86 * s);
  ctx.lineTo(0.44 * s, -0.4 * s);
  ctx.lineTo(-0.44 * s, -0.4 * s);
  ctx.closePath();
}

/* ------------------------------------------------------------------ the tympanum */

export function paintFace(size, mode) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const random = seededRandom(1987);
  bronzeBase(ctx, size, mode, random);
  if (mode === 'color') patina(ctx, size, random, 0.22);
  ctx.translate(size / 2, size / 2);
  const R = size * 0.49;
  const u = size / 1024;

  // Central 14-ray star on a raised boss.
  relief(ctx, mode, c => c.arc(0, 0, 0.05 * R, 0, TAU));
  relief(ctx, mode, c => {
    for (let i = 0; i < 28; i++) {
      const r = (i % 2 ? 0.045 : 0.145) * R;
      const a = (i * Math.PI) / 14 - Math.PI / 2;
      c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
    }
    c.closePath();
  });
  // Peacock-feather chevrons between the rays.
  around(ctx, 14, 0, () => {
    relief(ctx, mode, c => {
      for (let k = 0; k < 3; k++) {
        const r0 = (0.07 + k * 0.022) * R;
        c.moveTo(-0.022 * R, -r0);
        c.lineTo(0, -r0 - 0.02 * R);
        c.lineTo(0.022 * R, -r0);
      }
    }, { stroke: 2.2 * u, fill: false });
  }, Math.PI / 14);

  ring(ctx, mode, 0.16 * R, 2.4 * u);
  ring(ctx, mode, 0.168 * R, 1.6 * u);
  // Circles with a centre dot, joined by tangents.
  around(ctx, 30, 0.19 * R, () => {
    relief(ctx, mode, c => c.arc(0, 0, 0.016 * R, 0, TAU), { stroke: 2 * u, fill: false });
    relief(ctx, mode, c => c.arc(0, 0, 0.005 * R, 0, TAU));
  });
  ring(ctx, mode, 0.214 * R, 1.6 * u);
  ring(ctx, mode, 0.222 * R, 2.4 * u);
  // Ladder band.
  around(ctx, 150, 0.236 * R, () => relief(ctx, mode, c => c.rect(-0.6 * u, -0.012 * R, 1.2 * u, 0.024 * R)));
  ring(ctx, mode, 0.252 * R, 2 * u);

  // Scene band: feathered dancers and stilt houses.
  // Frames from around() point outward along -y; the mirror turns every figure counter-clockwise.
  around(ctx, 20, 0.262 * R, i => {
    ctx.scale(-1, 1);
    relief(ctx, mode, c => (i % 5 === 4 ? stiltHouse : feathered)(c, 0.13 * R));
  });
  ring(ctx, mode, 0.44 * R, 2.4 * u);
  around(ctx, 52, 0.465 * R, () => {
    relief(ctx, mode, c => c.arc(0, 0, 0.013 * R, 0, TAU), { stroke: 1.8 * u, fill: false });
    relief(ctx, mode, c => c.arc(0, 0, 0.004 * R, 0, TAU));
  });
  ring(ctx, mode, 0.49 * R, 2.4 * u);

  // Deer band.
  around(ctx, 16, 0.5 * R, () => {
    ctx.scale(-1, 1);
    relief(ctx, mode, c => deer(c, 0.064 * R));
  }, 0.12);
  around(ctx, 16, 0.54 * R, () => relief(ctx, mode, c => scroll(c, 0.04 * R), { stroke: 1.6 * u, fill: false }), 0.12 + Math.PI / 16);
  ring(ctx, mode, 0.585 * R, 2 * u);
  around(ctx, 180, 0.595 * R, () => relief(ctx, mode, c => c.rect(-0.5 * u, -0.008 * R, 1 * u, 0.016 * R)));
  ring(ctx, mode, 0.605 * R, 1.6 * u);

  // Flying Lạc birds, the widest band, all heading counter-clockwise.
  around(ctx, 16, 0.685 * R, () => {
    ctx.scale(-1, 1);
    relief(ctx, mode, c => lacBird(c, 0.1 * R));
  }, 0.2);
  ring(ctx, mode, 0.765 * R, 2.4 * u);
  ring(ctx, mode, 0.773 * R, 1.6 * u);

  // Hatched zigzag.
  around(ctx, 96, 0.79 * R, () => relief(ctx, mode, c => {
    c.moveTo(-0.022 * R, 0.012 * R);
    c.lineTo(0, -0.012 * R);
    c.lineTo(0.022 * R, 0.012 * R);
  }, { stroke: 1.6 * u, fill: false }));
  ring(ctx, mode, 0.81 * R, 1.6 * u);
  around(ctx, 72, 0.83 * R, () => {
    relief(ctx, mode, c => c.arc(0, 0, 0.012 * R, 0, TAU), { stroke: 1.6 * u, fill: false });
    relief(ctx, mode, c => c.arc(0, 0, 0.004 * R, 0, TAU));
  });
  ring(ctx, mode, 0.852 * R, 2 * u);
  around(ctx, 220, 0.875 * R, () => relief(ctx, mode, c => c.rect(-0.5 * u, -0.016 * R, 1 * u, 0.032 * R)));
  ring(ctx, mode, 0.9 * R, 2.6 * u);
  ring(ctx, mode, 0.985 * R, 3 * u);

  if (mode === 'color') {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    patina(ctx, size, seededRandom(42), 0.14);
    // Worn rim: darker toward the edge.
    const edge = ctx.createRadialGradient(size / 2, size / 2, size * 0.36, size / 2, size / 2, size * 0.5);
    edge.addColorStop(0, 'rgba(0,0,0,0)');
    edge.addColorStop(1, 'rgba(30, 18, 6, .45)');
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, size, size);
  }
  return canvas;
}
