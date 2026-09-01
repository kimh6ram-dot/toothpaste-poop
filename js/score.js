/* 점수 계산 — 실제 포인터 데이터와 완성된 치약 geometry를 분석한다.
 * 점수 로직은 치약 타입과 무관하게 완전히 동일하다(공정성).
 * 타입은 별명/평가 문구 톤에만 반영된다. */
(function () {
  'use strict';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function velocitySeries(samples) {
    const out = [];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      const dt = Math.max(b.t - a.t, 1 / 120);
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      out.push({ dx, dy, d, dt, speed: d / dt });
    }
    return out;
  }

  /* 형태(25): 아래가 넓고 위로 갈수록 좁아지는 매끈한 실루엣인가 */
  function shapeScore(inside, insideVol) {
    if (inside.length < 8) return 0;
    let minY = Infinity, maxY = -Infinity;
    for (const n of inside) {
      minY = Math.min(minY, n.y - n.r);
      maxY = Math.max(maxY, n.y + n.r);
    }
    const H = maxY - minY;
    const bandH = 14;
    const nBands = Math.max(1, Math.ceil(H / bandH));
    const bands = [];
    for (let b = 0; b < nBands; b++) bands.push({ min: Infinity, max: -Infinity, mass: 0 });
    for (const n of inside) {
      const b = clamp(Math.floor((maxY - n.y) / bandH), 0, nBands - 1); // 0 = 바닥층
      const band = bands[b];
      band.min = Math.min(band.min, n.x - n.r);
      band.max = Math.max(band.max, n.x + n.r);
      band.mass += n.r * n.r;
    }
    const widths = bands.filter(b => b.mass > 0).map(b => b.max - b.min);
    if (widths.length < 2) return 4;
    const baseW = Math.max((widths[0] + (widths[1] || widths[0])) / 2, 8);
    let ok = 0, diffSum = 0;
    for (let i = 1; i < widths.length; i++) {
      if (widths[i] <= widths[i - 1] * 1.2 + 4) ok++; // 위로 갈수록 좁아지는가
      diffSum += Math.abs(widths[i] - widths[i - 1]);
    }
    const mono = ok / (widths.length - 1);
    const smooth = clamp(1 - (diffSum / (widths.length - 1)) / baseW * 1.6, 0, 1);
    const aspect = H / baseW;
    const aspectScore = Math.exp(-Math.pow(aspect - 0.95, 2) / (2 * 0.45 * 0.45));
    const volFactor = Math.pow(clamp(insideVol / 45000, 0, 1), 0.6);
    return 25 * (0.4 * mono + 0.3 * aspectScore + 0.3 * smooth) * (0.35 + 0.65 * volFactor);
  }

  /* 소용돌이(25): 포인터 경로의 누적 회전량 + 좌우 왕복 코일 패턴 */
  function swirlScore(samples, presence) {
    const vs = velocitySeries(samples).filter(v => v.d > 1.5);
    if (vs.length < 6) return 0;
    let totalTurn = 0, prev = null;
    for (const v of vs) {
      const dir = Math.atan2(v.dy, v.dx);
      if (prev != null) {
        let d = dir - prev;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        totalTurn += Math.abs(d);
      }
      prev = dir;
    }
    const loops = totalTurn / (Math.PI * 2);
    let loopFactor = clamp(loops / 1.6, 0, 1);
    if (loops > 4.5) loopFactor *= clamp(1 - (loops - 4.5) / 4, 0.15, 1); // 낙서 방지
    // 좌우 반전 진폭이 점점 줄어드는 코일 패턴
    const xs = samples.map(s => s.x);
    const ext = [];
    for (let i = 2; i < xs.length - 2; i++) {
      const a = (xs[i - 2] + xs[i - 1] + xs[i]) / 3;
      const b = (xs[i - 1] + xs[i] + xs[i + 1]) / 3;
      const c = (xs[i] + xs[i + 1] + xs[i + 2]) / 3;
      if ((b - a) * (c - b) < 0) ext.push(b);
    }
    const amps = [];
    for (let i = 1; i < ext.length; i++) {
      const amp = Math.abs(ext[i] - ext[i - 1]);
      if (amp > 10) amps.push(amp);
    }
    let coil = 0;
    if (amps.length >= 2) {
      const revN = amps.length;
      let countFactor = clamp((revN - 1) / 4, 0, 1);
      if (revN > 16) countFactor *= clamp(1 - (revN - 16) / 20, 0.15, 1); // 마구 흔들기 방지
      // 진폭이 실제로 점점 좁아져야 코일이다
      const half = Math.max(Math.floor(revN / 2), 1);
      const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
      const first = avg(amps.slice(0, half));
      const last = avg(amps.slice(half));
      const shrink = clamp((first - last) / Math.max(first, 1), 0, 1);
      coil = countFactor * (0.35 + 0.65 * shrink);
    }
    const s01 = clamp(0.62 * loopFactor + 0.48 * coil, 0, 1);
    return 25 * s01 * (0.3 + 0.7 * presence);
  }

  /* 중심(15): 무게중심이 칫솔 중앙에 가까운가 */
  function centerScore(inside, brush) {
    if (!inside.length) return 0;
    let sx = 0, m = 0;
    for (const n of inside) {
      const w = n.r * n.r;
      sx += n.x * w;
      m += w;
    }
    const off = Math.abs(sx / m - brush.cx) / brush.halfW;
    return 15 * clamp(1 - off * 1.4, 0, 1);
  }

  /* 균형(15): 무게중심 기준 좌우 질량 대칭 */
  function balanceScore(inside) {
    if (inside.length < 8) return 0;
    let sx = 0, m = 0;
    for (const n of inside) {
      const w = n.r * n.r;
      sx += n.x * w;
      m += w;
    }
    const cx = sx / m;
    const bw = 12;
    const prof = new Map();
    for (const n of inside) {
      const b = Math.round((n.x - cx) / bw);
      prof.set(b, (prof.get(b) || 0) + n.r * n.r);
    }
    let diff = 0;
    const seen = new Set();
    for (const [b, v] of prof) {
      if (seen.has(b)) continue;
      seen.add(b);
      seen.add(-b);
      diff += Math.abs(v - (prof.get(-b) || 0));
    }
    const sym = 1 - diff / (2 * m);
    return 15 * clamp((sym - 0.5) / 0.5, 0, 1);
  }

  /* 꼭지(10): 떼는 순간 속도가 낮고, 끝이 봉우리 위에서 뾰족하게 마무리됐는가 */
  function finishScore(analysis, pileTopY) {
    if (!analysis.inside.length) return 0;
    const s = analysis.releaseSpeed;
    const tip = analysis.tip;
    const base = clamp(1 - (s - 140) / 650, 0, 1);
    let f = 10 * (0.12 + 0.88 * base);
    if (tip.type === 'torn') f = Math.min(f, 3);
    if (tip.type === 'none') f = Math.min(f, 2);
    if (tip.topY > pileTopY + 26) f *= 0.7; // 꼭지가 봉우리 위가 아니다
    return f;
  }

  /* 청결(10): 칫솔 밖으로 흘린 양 */
  function cleanScore(insideVol, outsideVol) {
    const tot = insideVol + outsideVol;
    if (tot <= 0) return 0;
    return 10 * clamp(1 - (outsideVol / tot) * 2.4, 0, 1);
  }

  function compute(analysis, typeId) {
    const { inside, insideVol, outsideVol, samples, brush } = analysis;
    const presence = clamp(insideVol / 8000, 0, 1);
    let pileTopY = Infinity;
    for (const n of inside) pileTopY = Math.min(pileTopY, n.y - n.r);
    // 거의 안 짠 판이 중심/청결 만점을 받지 않게 실제 양으로 스케일링
    const scale = 0.1 + 0.9 * presence;
    const breakdown = {
      shape: Math.round(shapeScore(inside, insideVol)),
      spiral: Math.round(swirlScore(samples, presence)),
      center: Math.round(centerScore(inside, brush) * scale),
      balance: Math.round(balanceScore(inside) * scale),
      finish: Math.round(finishScore(analysis, pileTopY) * scale),
      clean: Math.round(cleanScore(insideVol, outsideVol) * scale),
    };
    const total = breakdown.shape + breakdown.spiral + breakdown.center +
      breakdown.balance + breakdown.finish + breakdown.clean;
    const tierKey =
      total >= 95 ? 't95' :
      total >= 90 ? 't90' :
      total >= 80 ? 't80' :
      total >= 70 ? 't70' :
      total >= 50 ? 't50' : 't0';
    const types = window.PASTE_TYPES;
    const type = types[typeId] || types.poop;
    const pool = type.comments[tierKey];
    return {
      total,
      breakdown,
      tierKey,
      title: type.tierNames[tierKey],
      comment: pool[Math.floor(Math.random() * pool.length)],
    };
  }

  window.Score = { compute };
})();
