/* 1080x1920 Story용 공유 이미지 — 결과 화면과 동일한 흑백 미니멀 디자인 */
(function () {
  'use strict';

  const FONT = '"Pretendard Variable", Pretendard, -apple-system, "Malgun Gothic", sans-serif';

  const SUB_LABELS = [
    ['shape', '형태', 25],
    ['spiral', '소용돌이', 25],
    ['center', '중심', 15],
    ['balance', '균형', 15],
    ['finish', '꼭지', 10],
    ['clean', '청결', 10],
  ];

  function wrapLines(ctx, text, maxW) {
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  /* result: {typeId, total, breakdown, title, comment, snapshot} */
  function buildImage(result, snapshotCanvas) {
    const W = 1080, H = 1920;
    const cnv = document.createElement('canvas');
    cnv.width = W;
    cnv.height = H;
    const ctx = cnv.getContext('2d');

    // 흰 배경 (결과 화면과 동일)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    // 게임명
    ctx.fillStyle = '#000000';
    ctx.font = `800 68px ${FONT}`;
    ctx.fillText('치약똥 챌린지', W / 2, 168);

    // 결과 이미지 — 1px 검정 프레임 정사각형
    const boxSize = 640;
    const boxX = (W - boxSize) / 2;
    const boxY = 240;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(boxX, boxY, boxSize, boxSize);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 3;
    ctx.strokeRect(boxX + 1.5, boxY + 1.5, boxSize - 3, boxSize - 3);
    const snap = snapshotCanvas || result.snapshot;
    if (snap) {
      const inner = boxSize * 0.92;
      const s = Math.min(inner / snap.width, inner / snap.height);
      const dw = snap.width * s, dh = snap.height * s;
      ctx.drawImage(snap, W / 2 - dw / 2, boxY + (boxSize - dh) / 2, dw, dh);
    }

    // 점수 (크게)
    ctx.fillStyle = '#000000';
    const scoreText = String(result.total);
    const scoreFont = `800 136px ${FONT}`;
    const unitFont = `700 64px ${FONT}`;
    ctx.font = scoreFont;
    const sw = ctx.measureText(scoreText).width;
    ctx.font = unitFont;
    const uw = ctx.measureText('점').width;
    const scoreY = 1085;
    ctx.textAlign = 'left';
    ctx.font = scoreFont;
    ctx.fillText(scoreText, W / 2 - (sw + uw + 8) / 2, scoreY);
    ctx.font = unitFont;
    ctx.fillText('점', W / 2 - (sw + uw + 8) / 2 + sw + 8, scoreY);
    ctx.textAlign = 'center';

    // 별명 (크게)
    ctx.fillStyle = '#000000';
    ctx.font = `700 62px ${FONT}`;
    ctx.fillText(result.title, W / 2, 1190);

    // 평가 한마디 (회색, 크게)
    ctx.fillStyle = '#777777';
    ctx.font = `500 44px ${FONT}`;
    const lines = wrapLines(ctx, result.comment, 880);
    lines.forEach((line, i) => ctx.fillText(line, W / 2, 1264 + i * 58));

    // 세부 점수 — 작게 (2열 표: label 회색 / 값 굵게 / 하단 보더)
    const gridW = 640;
    const colW = (gridW - 48) / 2;
    const gridX = (W - gridW) / 2;
    const rowH = 56;
    const gridY = 1410;
    for (let i = 0; i < SUB_LABELS.length; i++) {
      const [key, label, max] = SUB_LABELS[i];
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = gridX + col * (colW + 48);
      const y = gridY + row * rowH;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#777777';
      ctx.font = `600 25px ${FONT}`;
      ctx.fillText(label, x, y + 34);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#000000';
      ctx.font = `700 25px ${FONT}`;
      ctx.fillText(`${result.breakdown[key]} / ${max}`, x + colW, y + 34);
      ctx.strokeStyle = '#dddddd';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y + rowH - 8);
      ctx.lineTo(x + colW, y + rowH - 8);
      ctx.stroke();
    }
    ctx.textAlign = 'center';

    // 마무리 카피 (크게, 빨간색)
    ctx.fillStyle = '#e5262f';
    ctx.font = `900 104px ${FONT}`;
    ctx.fillText('너도 해봐', W / 2, 1755);

    return cnv;
  }

  function toBlob(canvas) {
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  function download(canvas, name) {
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  }

  /* Web Share API로 이미지 파일 공유, 미지원 시 저장 fallback → 'shared' | 'saved' */
  async function shareImage(result, canvas) {
    const blob = await toBlob(canvas);
    if (!blob) throw new Error('이미지 생성 실패');
    const file = new File([blob], `치약똥_${result.total}점.png`, { type: 'image/png' });
    const text = `치약똥 챌린지 ${result.total}점 · ${result.title}\n너도 해봐`;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: '치약똥 챌린지', text });
      return 'shared';
    }
    download(canvas, `치약똥_${result.total}점.png`);
    return 'saved';
  }

  window.ShareKit = { buildImage, download, shareImage };
})();
