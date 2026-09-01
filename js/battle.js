/* 친구 대결 — Supabase 저장(설정 시) / 링크에 기록을 담는 fallback */
(function () {
  'use strict';

  const cfg = window.TOOTHPASTE_CONFIG || {};
  const configured = () => !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);

  function b64uEncode(obj) {
    const b = btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
    return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const clampByte = v => Math.max(0, Math.min(255, Math.round(v)));

  /* 완성작 geometry를 노드당 3바이트로 압축 — 링크에 똥 그림을 담는다.
   * 좌표는 칫솔 프레임 기준 상대값이라 상대 기기 해상도와 무관하게 복원된다. */
  function encodeFigure(fig) {
    if (!fig || !fig.nodes || !fig.nodes.length) return null;
    const { cx, halfW, topY } = fig.frame;
    let nodes = fig.nodes;
    const stride = Math.ceil(nodes.length / 550);
    if (stride > 1) nodes = nodes.filter((_, i) => i % stride === 0);
    let bin = '';
    for (const nd of nodes) {
      const relX = (nd[0] - cx) / halfW;
      const relY = (topY - nd[1]) / halfW;
      const relR = nd[2] / halfW;
      bin += String.fromCharCode(
        clampByte((relX + 2.5) * 51),
        clampByte((relY + 2) * 42),
        clampByte(relR * 800)
      );
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeFigure(str) {
    try {
      let b = str.replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      const bin = atob(b);
      const out = [];
      for (let i = 0; i + 2 < bin.length; i += 3) {
        out.push({
          x: bin.charCodeAt(i) / 51 - 2.5,
          y: bin.charCodeAt(i + 1) / 42 - 2,
          r: bin.charCodeAt(i + 2) / 800,
        });
      }
      return out.length ? out : null;
    } catch (_) {
      return null;
    }
  }
  function b64uDecode(str) {
    let b = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return JSON.parse(decodeURIComponent(escape(atob(b))));
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function headers() {
    return {
      apikey: cfg.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    };
  }

  /* rec: {nickname, typeId, total, breakdown, imageDataUrl} → 도전장 토큰 */
  async function saveChallenge(rec) {
    if (configured()) {
      const id = uuid();
      const row = {
        challenge_id: id,
        nickname: rec.nickname,
        score: rec.total,
        shape_score: rec.breakdown.shape,
        spiral_score: rec.breakdown.spiral,
        center_score: rec.breakdown.center,
        balance_score: rec.breakdown.balance,
        finish_score: rec.breakdown.finish,
        clean_score: rec.breakdown.clean,
        toothpaste_type: rec.typeId,
        result_image_url: rec.imageDataUrl || null,
        created_at: new Date().toISOString(),
      };
      const res = await fetch(`${cfg.SUPABASE_URL}/rest/v1/challenges`, {
        method: 'POST',
        headers: Object.assign(headers(), { Prefer: 'return=minimal' }),
        body: JSON.stringify(row),
      });
      if (!res.ok) throw new Error(`저장 실패 (${res.status})`);
      return id;
    }
    // Supabase 미설정: 기록 + 압축한 똥 geometry를 링크에 직접 담는다
    const payload = {
      n: rec.nickname,
      s: rec.total,
      p: rec.typeId,
      b: [
        rec.breakdown.shape, rec.breakdown.spiral, rec.breakdown.center,
        rec.breakdown.balance, rec.breakdown.finish, rec.breakdown.clean,
      ],
    };
    const g = encodeFigure(rec.figure);
    if (g) payload.g = g;
    return 'v1.' + b64uEncode(payload);
  }

  /* 토큰 → {nickname, score, typeId, breakdown[], imageUrl} */
  async function loadChallenge(token) {
    if (token.indexOf('v1.') === 0) {
      const d = b64uDecode(token.slice(3));
      return {
        nickname: d.n,
        score: d.s,
        typeId: d.p,
        breakdown: d.b,
        imageUrl: null,
        figure: d.g ? decodeFigure(d.g) : null,
      };
    }
    if (!configured()) throw new Error('Supabase가 설정되지 않았습니다');
    const res = await fetch(
      `${cfg.SUPABASE_URL}/rest/v1/challenges?challenge_id=eq.${encodeURIComponent(token)}&select=*`,
      { headers: headers() }
    );
    if (!res.ok) throw new Error(`조회 실패 (${res.status})`);
    const rows = await res.json();
    if (!rows.length) throw new Error('도전장을 찾을 수 없습니다');
    const r = rows[0];
    return {
      nickname: r.nickname,
      score: r.score,
      typeId: r.toothpaste_type,
      imageUrl: r.result_image_url,
      breakdown: [
        r.shape_score, r.spiral_score, r.center_score,
        r.balance_score, r.finish_score, r.clean_score,
      ],
    };
  }

  function buildUrl(token) {
    return `${location.origin}${location.pathname}#battle/${token}`;
  }

  function parseHash() {
    const m = location.hash.match(/^#battle\/(.+)$/);
    return m ? m[1] : null;
  }

  window.Battle = { configured, saveChallenge, loadChallenge, buildUrl, parseHash };
})();
