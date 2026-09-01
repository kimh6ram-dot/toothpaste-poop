/* 화면 전환/테마/결과/공유/대결 글루 코드 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const TYPES = window.PASTE_TYPES;

  const app = {
    typeId: 'poop',
    mode: 'solo', // solo | battle
    battleOwner: null, // {nickname, score, typeId, breakdown[], imageUrl}
    lastResult: null, // {typeId, total, breakdown, title, comment, snapshot, dataUrl}
  };

  const SUB_LABELS = [
    ['shape', '형태', 25],
    ['spiral', '소용돌이', 25],
    ['center', '중심', 15],
    ['balance', '균형', 15],
    ['finish', '꼭지', 10],
    ['clean', '청결', 10],
  ];

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
    if (id !== 'screen-game') window.Game.stop();
  }

  function startGame() {
    showScreen('screen-game');
    // 캔버스 레이아웃이 반영된 다음 프레임에 시작
    requestAnimationFrame(() => window.Game.start(TYPES[app.typeId], onGameFinished));
  }

  function onGameFinished(analysis, engine) {
    const result = window.Score.compute(analysis, app.typeId);
    let snapshot = engine.makeSnapshot(2);
    // 공유/저장용: 사진 배경 없이 흰 바탕 + 심플 칫솔 + 치약만 (흑백 UI 톤)
    const bd = engine.brushDraw;
    engine.brushDraw = null;
    const shareSnap = engine.makeSnapshot(2);
    engine.brushDraw = bd;
    let dataUrl;
    try {
      dataUrl = snapshot.toDataURL('image/png');
    } catch (e) {
      // 사진 에셋 때문에 canvas가 오염된 환경 — 흰 배경 버전으로 대체
      snapshot = shareSnap;
      dataUrl = shareSnap.toDataURL('image/png');
    }
    app.lastResult = {
      typeId: app.typeId,
      total: result.total,
      breakdown: result.breakdown,
      title: result.title,
      comment: result.comment,
      snapshot,
      shareSnap,
      dataUrl,
      // 도전장 링크에 담을 완성작 geometry (칫솔 프레임 기준)
      figure: {
        frame: { cx: engine.brushCx, halfW: engine.brushHalfW, topY: engine.brushTopY },
        nodes: engine.nodes
          .filter(n => n.landed)
          .map(n => [Math.round(n.x), Math.round(n.y), Math.round(n.r * 10) / 10]),
      },
    };
    if (app.mode === 'battle' && app.battleOwner) showBattleResult();
    else showResult();
  }

  /* ---------- 결과 화면 ---------- */

  function showResult() {
    const r = app.lastResult;
    if (!r) return;
    $('result-image').src = r.dataUrl;
    $('result-title').textContent = r.title;
    $('result-comment').textContent = r.comment;
    const wrap = $('subscores');
    wrap.innerHTML = '';
    for (const [key, label, max] of SUB_LABELS) {
      const row = document.createElement('div');
      row.className = 'subscore';
      row.innerHTML =
        `<span class="label">${label}</span>` +
        `<span class="value">${r.breakdown[key]} / ${max}</span>`;
      wrap.appendChild(row);
    }
    showScreen('screen-result');
    countUp($('result-score'), r.total);
  }

  function countUp(elm, total) {
    const t0 = performance.now();
    const dur = 900;
    function tick(t) {
      const p = Math.min((t - t0) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      elm.innerHTML = `${Math.round(total * eased)}<span class="unit">점</span>`;
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ---------- 대결 ---------- */

  /* 실사 칫솔 에셋 (게임과 동일한 이미지/지오메트리) */
  const BRUSH_META = { bristleTop: 738, headLeft: 465, headRight: 815 };
  let brushImgShared = null;
  function getBrushImg() {
    if (!brushImgShared && window.BRUSH_ASSET_DATA) {
      brushImgShared = new Image();
      brushImgShared.src = window.BRUSH_ASSET_DATA;
    }
    return brushImgShared;
  }

  /* 링크로 받은 geometry를 숨김 캔버스 엔진으로 다시 그려 이미지로 만든다 */
  async function renderFigure(relNodes, typeId) {
    const brushImg = getBrushImg();
    if (brushImg && !brushImg.complete) {
      await new Promise(res => {
        brushImg.onload = res;
        brushImg.onerror = res;
      });
    }
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;left:-9999px;top:0;width:430px;height:650px;visibility:hidden;';
    document.body.appendChild(cv);
    try {
      const eng = new window.PasteEngine(cv);
      eng.setPasteType(TYPES[typeId] || TYPES.poop);
      if (brushImg && brushImg.complete && brushImg.naturalWidth) {
        eng.setBrushAsset(brushImg, BRUSH_META); // 실사 칫솔 위에 그린다
      }
      eng.reset();
      const cx = eng.brushCx, halfW = eng.brushHalfW, topY = eng.brushTopY;
      relNodes.forEach((nd, i) => {
        eng.nodes.push({
          x: cx + nd.x * halfW,
          y: topY - nd.y * halfW,
          tx: 0, ty: 0,
          r: Math.max(nd.r * halfW, 2),
          landed: true, landT: 0,
          outside: false, tip: false,
          sx: 1, sy: 1, rot: 0,
          born: -1,
          idx: i,
        });
      });
      return eng.makeSnapshot(2).toDataURL('image/png');
    } finally {
      cv.remove();
    }
  }

  async function showBattleResult() {
    const me = app.lastResult;
    const owner = app.battleOwner;
    let ownerImg = owner.imageUrl;
    if (!ownerImg && owner.figure && owner.figure.length) {
      try { ownerImg = await renderFigure(owner.figure, owner.typeId); } catch (_) { /* placeholder 유지 */ }
    }
    setVsCard('a', owner.nickname, owner.score, ownerImg, owner.typeId);
    setVsCard('b', myName() || '나', me.total, me.dataUrl, me.typeId);
    const w = $('vs-winner');
    if (me.total > owner.score) w.textContent = `${myName() || '나'} 승리 🏆`;
    else if (me.total < owner.score) w.textContent = `${owner.nickname} 승리 🏆`;
    else w.textContent = '무승부 🤝';
    showScreen('screen-battle-result');
  }

  function setVsCard(side, name, score, imageUrl, typeId) {
    $(`vs-${side}-name`).textContent = name;
    $(`vs-${side}-score`).textContent = `${score}점`;
    const fig = $(`vs-${side}-figure`);
    fig.innerHTML = '';
    if (imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = name;
      fig.appendChild(img);
    } else {
      fig.textContent = (TYPES[typeId] && TYPES[typeId].emoji) || '💩';
    }
  }

  function myName() {
    try { return localStorage.getItem('tp_nickname') || ''; } catch (_) { return ''; }
  }

  async function sendChallenge() {
    const r = app.lastResult;
    if (!r) return;
    const nickname = await askNickname();
    if (!nickname) return;
    try { localStorage.setItem('tp_nickname', nickname); } catch (_) { /* 시크릿 모드 등 */ }
    // 이미지 저장은 Supabase 설정 시에만 (링크 방식엔 담기지 않음)
    const smallImg = window.Battle.configured() ? downscale(r.snapshot, 480) : null;
    let url;
    try {
      const token = await window.Battle.saveChallenge({
        nickname,
        typeId: r.typeId,
        total: r.total,
        breakdown: r.breakdown,
        imageDataUrl: smallImg,
        figure: r.figure,
      });
      url = window.Battle.buildUrl(token);
    } catch (e) {
      toast('도전장 만들기에 실패했어요' + (e && e.message ? ` (${e.message})` : ''));
      return;
    }
    // OS 공유창은 http/https 링크에서만 (file:// 링크는 거부됨)
    if (navigator.share && /^https?:/i.test(url)) {
      try {
        await navigator.share({
          title: '치약똥 챌린지',
          text: `${nickname}의 ${r.total}점, 이길 수 있음?`,
          url,
        });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    if (await copyText(url)) {
      toast('도전장 링크를 복사했어요. 친구에게 보내보세요!');
    } else {
      window.prompt('복사가 막혀 있어요. 링크를 직접 복사해 주세요', url);
    }
  }

  function downscale(cnv, w) {
    const s = w / cnv.width;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = Math.round(cnv.height * s);
    c.getContext('2d').drawImage(cnv, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (_) {
        return false;
      }
    }
  }

  /* ---------- 모달 / 토스트 ---------- */

  function askNickname() {
    return new Promise(resolve => {
      const modal = $('modal');
      const input = $('modal-input');
      const ok = $('modal-ok');
      const cancel = $('modal-cancel');
      input.value = myName();
      modal.classList.remove('hidden');
      input.focus();
      const close = v => {
        modal.classList.add('hidden');
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
        resolve(v);
      };
      const onOk = () => close(input.value.trim() || '익명');
      const onCancel = () => close(null);
      const onKey = e => { if (e.key === 'Enter') onOk(); };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
    });
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ---------- 부팅 ---------- */

  function boot() {
    // 치약 선택 → 게임 시작
    document.querySelectorAll('.paste-card').forEach(card => {
      card.addEventListener('click', () => {
        app.typeId = card.dataset.paste;
        startGame();
      });
    });

    $('btn-start').addEventListener('click', () => showScreen('screen-select'));
    $('btn-battle-start').addEventListener('click', () => showScreen('screen-select'));
    $('btn-retry').addEventListener('click', () => showScreen('screen-select'));
    $('btn-rematch').addEventListener('click', () => showScreen('screen-select'));
    $('btn-vs-detail').addEventListener('click', showResult);
    $('btn-challenge').addEventListener('click', sendChallenge);

    $('btn-save-img').addEventListener('click', () => {
      const r = app.lastResult;
      if (!r) return;
      window.ShareKit.download(window.ShareKit.buildImage(r, r.snapshot), `치약똥_${r.total}점.png`);
      toast('이미지를 저장했어요');
    });


    // 도전장 링크(#battle/...)로 들어온 경우
    const token = window.Battle.parseHash();
    if (token) {
      window.Battle.loadChallenge(token)
        .then(async owner => {
          app.mode = 'battle';
          app.battleOwner = owner;
          $('battle-owner-name').textContent = `${owner.nickname}의 기록`;
          $('battle-owner-score').textContent = `${owner.score}점`;
          // 도전자의 완성작 미리보기 (링크에 그림 데이터가 있을 때)
          const fig = $('battle-owner-figure');
          fig.innerHTML = '';
          let img = owner.imageUrl;
          if (!img && owner.figure && owner.figure.length) {
            try { img = await renderFigure(owner.figure, owner.typeId); } catch (_) { /* 미리보기 생략 */ }
          }
          if (img) {
            const el = document.createElement('img');
            el.src = img;
            el.alt = `${owner.nickname}의 완성작`;
            fig.appendChild(el);
            fig.style.display = '';
          } else {
            fig.style.display = 'none';
          }
          showScreen('screen-battle-intro');
        })
        .catch(() => {
          toast('도전장을 불러오지 못했어요');
          showScreen('screen-intro');
        });
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
