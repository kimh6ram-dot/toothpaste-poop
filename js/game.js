/* 게임 화면 — 엔진 구동, Pointer Events 통합 입력, 게이지, 종료 연출 흐름 */
(function () {
  'use strict';

  let engine = null;
  let raf = 0;
  let lastT = 0;
  let running = false;
  let state = 'idle'; // idle | ready | playing | ending | judged
  let activePointer = null;
  let onFinish = null;

  const el = id => document.getElementById(id);
  const canvas = () => el('game-canvas');

  // toothpaste_img.png에서 치약만 제거한 칫솔 에셋.
  // data URL(js/brush-asset.js)로 로드해야 file://에서도 canvas 내보내기(toDataURL)가 막히지 않는다.
  const BRUSH_ASSET = window.BRUSH_ASSET_DATA || 'assets/toothbrush_only.png';
  // 이미지 픽셀 기준 지오메트리 — 칫솔모 상단 라인과 칫솔모 좌우 범위
  const BRUSH_META = { bristleTop: 738, headLeft: 465, headRight: 815 };

  function ensureEngine() {
    if (!engine) {
      engine = new window.PasteEngine(canvas());
      const brushImg = new Image();
      brushImg.src = BRUSH_ASSET;
      engine.setBrushAsset(brushImg, BRUSH_META);
      window.addEventListener('resize', () => engine && engine.resize());
      bindPointer();
    }
    return engine;
  }

  function start(pasteType, finishCb) {
    onFinish = finishCb;
    ensureEngine();
    engine.setPasteType(pasteType);
    engine.resize();
    engine.reset();
    engine.onSettled = handleSettled;
    state = 'tutorial'; // 시작하기 버튼을 눌러야 ready로 전환
    activePointer = null;
    el('tutorial').classList.remove('hidden');
    el('judging').classList.add('hidden');
    updateGauge(1);
    if (!running) {
      running = true;
      lastT = performance.now();
      raf = requestAnimationFrame(loop);
    }
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  function loop(t) {
    if (!running) return;
    const dt = Math.min((t - lastT) / 1000, 0.033);
    lastT = t;
    engine.update(dt, t / 1000);
    engine.render();
    if (state === 'playing') {
      updateGauge(engine.gaugeRatio);
      if (engine.phase !== 'play') state = 'ending'; // 치약 소진 자동 종료
    }
    raf = requestAnimationFrame(loop);
  }

  function updateGauge(ratio) {
    el('gauge-fill').style.width = (ratio * 100).toFixed(1) + '%';
  }

  function pos(e) {
    const r = canvas().getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function bindPointer() {
    const cv = canvas();
    el('btn-play').addEventListener('click', () => {
      if (state !== 'tutorial') return;
      el('tutorial').classList.add('hidden');
      state = 'ready';
    });
    cv.addEventListener('pointerdown', e => {
      if (state !== 'ready') return;
      e.preventDefault();
      activePointer = e.pointerId;
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* 무시 */ }
      state = 'playing';
      const p = pos(e);
      engine.press(p.x, p.y, e.pointerType);
    });
    cv.addEventListener('pointermove', e => {
      if (state !== 'playing' || e.pointerId !== activePointer) return;
      e.preventDefault();
      const p = pos(e);
      engine.move(p.x, p.y);
    });
    const end = e => {
      if (state !== 'playing' || e.pointerId !== activePointer) return;
      state = 'ending';
      engine.finishExtrusion(); // 떼는 순간 즉시 종료
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('contextmenu', e => e.preventDefault());
  }

  function handleSettled() {
    el('judging').classList.remove('hidden');
    setTimeout(() => {
      el('judging').classList.add('hidden');
      state = 'judged';
      if (onFinish) onFinish(engine.getAnalysis(), engine);
    }, 750);
  }

  window.Game = { start, stop };
})();
