/* 치약똥 챌린지 — 치약 압출/점성 물리 + 렌더링 엔진 (v3)
 *
 * v3 핵심: "짜는 손맛" — PRESS → SQUISH → PRESSURE → EXTRUSION
 *  - pointerdown이 즉시 생성으로 이어지지 않는다. 압력(0~1)이 짧게 차오르고,
 *    배출량은 pressure²로 스케일되며, 손을 떼면 잔류 압력으로 조금 더 나온다.
 *  - 튜브 바디는 압력 스프링으로 꾸욱 눌리고(노즐은 고정), 뗄 때 미세한 반동과 함께 복원.
 *  - 노즐 아래엔 구멍(74%)에서 원래 두께로 팽창하는 압출 목이 압력에 따라 자라난다.
 *  - 렌더링은 오프스크린 레이어 + source-atop 합성: 단색 union 본체 위에
 *    수직 그라데이션 셰이딩과 연속적인 좌상단 광택 밴드 → blob 경계가 보이지 않는다.
 */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---- 치약 물성 상수 ----
  const NODE_DT = 0.028;        // 압출 tick — 누르고만 있어도 시간 기반으로 나온다
  const R_BASE = 19;            // 기본 반지름 (두껍게)
  const R_SLOW = 1.12;          // 천천히: 최대 112%
  const R_FAST = 0.78;          // 빠르게: 최소 78% — 실이 되지 않는다
  const SPACING = 6;            // 노드 간 간격
  const MAX_STEPS_PER_TICK = 4;
  const MAX_HOVER = 30;         // active extrusion zone — 노즐 아래 공중 구간은 항상 짧다
  const MIN_HOVER = 14;
  const P_RISE = 0.18;          // 압력 상승 시간 (꾸욱 누르는 지연)
  const P_FALL = 0.16;          // 잔류 압력 감소 시간 (떼도 조금 더 나온다)

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function mixParts(a, b, t) {
    const ca = hexToRgb(a), cb = hexToRgb(b);
    return [
      Math.round(lerp(ca[0], cb[0], t)),
      Math.round(lerp(ca[1], cb[1], t)),
      Math.round(lerp(ca[2], cb[2], t)),
    ];
  }
  function mixHex(a, b, t) {
    const m = mixParts(a, b, t);
    return `rgb(${m[0]},${m[1]},${m[2]})`;
  }
  function mixRgba(a, b, t, alpha) {
    const m = mixParts(a, b, t);
    return `rgba(${m[0]},${m[1]},${m[2]},${alpha})`;
  }
  function rgbaOf(hex, a) {
    const c = hexToRgb(hex);
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  class PasteEngine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.bucketW = 8;
      this.capacity = 6.0; // 치약 총량(초) — 모든 치약 타입 동일
      this.onSettled = null;
      this.brushImg = null;
      this.brushMeta = null;
      this.brushDraw = null;
      this.setPasteType(null);
      this.resize();
      this.reset();
    }

    setBrushAsset(img, meta) {
      this.brushImg = img;
      this.brushMeta = meta;
      this.brushDraw = null;
      if (img.complete && img.naturalWidth) this.resize();
      else img.addEventListener('load', () => this.resize(), { once: true });
    }

    /* 치약 타입은 비주얼(색)만 바꾼다 — 물리/점수/잔량은 동일 */
    setPasteType(type) {
      const c = (type && type.colors) || {
        base: '#8B5A2B', secondary: '#B7793C', highlight: '#D4A166', shadow: '#6E431D',
      };
      this.colors = c;
      this.tints = [
        mixHex(c.base, c.shadow, 0.32),
        mixHex(c.base, c.shadow, 0.16),
        c.base,
        mixHex(c.base, c.secondary, 0.45),
        mixHex(c.base, c.secondary, 0.75),
      ];
      this.rimColor = mixHex(c.base, c.shadow, 0.55);
      this.contactShadow = rgbaOf(c.shadow, 0.22);
      this.nozzleInner = mixHex(c.base, c.shadow, 0.4);
      // 볼륨 셰이딩(수직 그라데이션)용 색
      this.gradTopColor = mixRgba(c.base, c.secondary, 0.7, 0.8);
      this.gradBottomColor = mixRgba(c.base, c.shadow, 0.45, 0.6);
      // 실루엣을 따라 흐르는 하이라이트 밴드 색 (좌상단 조명)
      this.bevelLight = rgbaOf(c.highlight, 0.55);
    }

    resize() {
      const cw = this.canvas.clientWidth || 1;
      const ch = this.canvas.clientHeight || 1;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.round(cw * this.dpr);
      this.canvas.height = Math.round(ch * this.dpr);
      this.w = cw;
      this.h = ch;
      this.brushCx = cw / 2;
      this.brushHalfW = Math.min(cw * 0.31, 150);
      this.brushTopY = ch * 0.7;
      this.bristleH = 24;
      this.floorY = ch * 0.93;
      const nb = Math.ceil(cw / this.bucketW) + 2;
      if (!this.field || this.field.length !== nb) this.field = new Float32Array(nb);
      this.nBuckets = nb;
      // 치약 전용 오프스크린 레이어 (source-atop 합성용) + 하이라이트 밴드 레이어
      if (!this._layer) this._layer = document.createElement('canvas');
      this._layer.width = this.canvas.width;
      this._layer.height = this.canvas.height;
      this._lctx = this._layer.getContext('2d');
      if (!this._band) this._band = document.createElement('canvas');
      this._band.width = this.canvas.width;
      this._band.height = this.canvas.height;
      this._bctx = this._band.getContext('2d');
      this._layoutBrushAsset();
    }

    _layoutBrushAsset() {
      this.brushDraw = null;
      const img = this.brushImg, m = this.brushMeta;
      if (!(img && m && img.complete && img.naturalWidth)) return; // 벡터 fallback
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const targetY = this.h * 0.68;
      const scale = Math.max(this.w / iw, this.h / ih, targetY / m.bristleTop);
      const headCx = (m.headLeft + m.headRight) / 2;
      let offX = this.w / 2 - headCx * scale;
      offX = clamp(offX, this.w - iw * scale, 0);
      let offY = targetY - m.bristleTop * scale;
      offY = clamp(offY, this.h - ih * scale, 0);
      this.brushDraw = { scale, offX, offY, iw, ih };
      this.brushCx = headCx * scale + offX;
      this.brushHalfW = ((m.headRight - m.headLeft) / 2) * scale * 0.94;
      this.brushTopY = m.bristleTop * scale + offY;
      this.floorY = clamp(this.h * 0.93, this.brushTopY + 90, this.h - 6);
    }

    reset() {
      this.nodes = [];
      this.samples = [];
      this.field = new Float32Array(this.nBuckets || 1);
      this.phase = 'play'; // play | settle | done
      this.extruding = false;   // 포인터를 누르고 있는가
      this.releasing = false;   // 손을 뗀 뒤 잔류 압력 구간
      this.pressure = 0;        // 0~1 — 짜는 압력
      this.pointer = null;
      this.pressPY = 0;         // 리프트 기준점 (누른 곳에서 위로 올린 만큼 노즐이 뜬다)
      this.used = 0;
      this.now = 0;
      this.pressAt = -1;
      this.emitAcc = 0;
      this.curR = R_BASE;
      this.lastDepX = null;
      this.prevLandX = null;
      this.lastDir = 1;
      this.nodeIdx = 0;
      this.releaseSpeed = 0;
      this.tipInfo = { type: 'none', topY: 0 };
      this.settleT = 0;
      this.squash = 0;
      this.wobbleAmp = 0;
      this.zoomS = 1;
      this.zoomC = null;
      this.squeezePulse = 0;
      this.tubeSquash = 0;      // 튜브 바디 눌림 (스프링)
      this.squashVel = 0;
      this._settledFired = false;
      this._relaxFlip = false;
      this.tube = { x: this.w / 2, y: Math.max(90, this.brushTopY - 190), vx: 0, vy: 0 };
      this.tubeSpeed = 0;
    }

    get gaugeRatio() {
      return clamp(1 - this.used / this.capacity, 0, 1);
    }

    /* ---------- 입력 ---------- */

    press(x, y) {
      if (this.phase !== 'play' || this.extruding || this.releasing) return;
      this.pointer = { x, y };
      this.pressPY = y;
      this.extruding = true;
      this.pressAt = this.now;
      this.lastDepX = null;
      this.squashVel += 4; // "눌렀다"는 미세한 반동
    }

    move(x, y) {
      if (this.pointer) {
        this.pointer.x = x;
        this.pointer.y = y;
      } else {
        this.pointer = { x, y };
      }
    }

    /* 손을 떼면(또는 소진되면) 즉시 끊지 않고 잔류 압력 구간으로 넘어간다 */
    finishExtrusion() {
      if (this.phase !== 'play' || this.releasing) return;
      this.extruding = false;
      this.releasing = true;
      this.releaseSpeed = this._pointerSpeed();
    }

    /* 잔류 압력이 다 빠진 뒤의 실제 마무리 */
    _completeFinish() {
      this.releasing = false;
      this._buildTip();
      this.phase = 'settle';
      this.settleT = 0;
      this.wobbleAmp = 1.6;
      this.zoomC = this._pileCenter();
    }

    /* ---------- 매 프레임 ---------- */

    update(dt, now) {
      this.now = now;
      if (this.phase === 'play') {
        this._updateTube(dt);
        // 높이 들어 올려도 계속 나온다 — 낙하 스트림으로 아래에 쌓인다
        const canEmit = this.now - this.pressAt > 0.05;
        if (this.extruding) {
          this.pressure = clamp(this.pressure + dt / P_RISE, 0, 1);
          this.used += dt;
          this._recordSample();
          this.squeezePulse += dt;
          if (this.used >= this.capacity) this.finishExtrusion(); // 치약 소진
        } else if (this.releasing) {
          this.pressure = clamp(this.pressure - dt / P_FALL, 0, 1);
          if (this.pressure <= 0) this._completeFinish();
        }
        if (this.phase === 'play' && (this.extruding || this.releasing) && canEmit) {
          this._extrude(dt);
        }
      } else if (this.phase === 'settle') {
        this.settleT += dt;
        this.wobbleAmp = 1.6 * Math.exp(-this.settleT * 4.6);
        this.squash = clamp((this.settleT - 0.18) / 0.4, 0, 1);
        if (this.settleT > 0.35) this.zoomS += (1.16 - this.zoomS) * Math.min(1, dt * 6);
        if (this.settleT > 1.05 && !this._settledFired) {
          this._settledFired = true;
          this.phase = 'done';
          if (this.onSettled) this.onSettled();
        }
      }
      this._updateDrops(dt);
      this._relaxField();
    }

    _updateTube(dt) {
      const idleX = this.w / 2;
      const idleY = Math.max(90, this.brushTopY - 190);
      let tx = idleX, ty = idleY;
      const active = this.extruding || this.releasing;
      if (active && this.pointer) {
        tx = clamp(this.pointer.x, 26, this.w - 26);
        // 아래로 내리면 리프트 기준점을 갱신 (항상 최저점 기준으로 들어 올린다)
        if (this.pointer.y > this.pressPY) this.pressPY = this.pointer.y;
        const refY = Math.min(this._topYAt(tx), this.brushTopY);
        const loY = refY - MIN_HOVER;
        // 기본은 표면 바로 위를 타고 다니고, 누른 곳에서 위로 올린 만큼 떠오른다
        const lift = clamp(this.pressPY - this.pointer.y, 0, 300);
        ty = clamp(loY - lift, 60, loY);
      } else if (this.phase === 'play') {
        ty = idleY + Math.sin(this.now * 1.6) * 6;
      }
      // 직결 추적 — 마우스 위치를 거의 즉시 따라간다 (픽셀 떨림 방지용 미세 스무딩만)
      const prevX = this.tube.x, prevY = this.tube.y;
      const follow = active ? Math.min(1, dt * 35) : Math.min(1, dt * 10);
      this.tube.x += (tx - this.tube.x) * follow;
      this.tube.y += (ty - this.tube.y) * follow;
      if (active) {
        // 쌓인 표면이 올라오면 노즐도 즉시 따라 올라간다
        const refY = Math.min(this._topYAt(this.tube.x), this.brushTopY);
        const loY = refY - MIN_HOVER;
        if (this.tube.y > loY) this.tube.y = loY;
      }
      // 속도 추정 (두께 변화 / 기울기 연출용)
      const est = Math.min(1, dt * 12);
      this.tube.vx = lerp(this.tube.vx, (this.tube.x - prevX) / Math.max(dt, 1e-4), est);
      this.tube.vy = lerp(this.tube.vy, (this.tube.y - prevY) / Math.max(dt, 1e-4), est);
      this.tubeSpeed = Math.hypot(this.tube.vx, this.tube.vy);
      // 바디 눌림 스프링: 압력을 따라가되 눌림/복원에 관성과 미세한 오버슈트
      const sqTarget = this.phase === 'play' && active ? this.pressure : 0;
      const KS = 130, DS = 13;
      this.squashVel += ((sqTarget - this.tubeSquash) * KS - this.squashVel * DS) * dt;
      this.tubeSquash += this.squashVel * dt;
    }

    _recordSample() {
      if (!this.pointer || this.samples.length >= 1500) return;
      this.samples.push({ x: this.pointer.x, y: this.pointer.y, t: this.now });
    }

    _pointerSpeed() {
      const s = this.samples;
      if (s.length < 2) return 0;
      const last = s[s.length - 1];
      let i = s.length - 2;
      while (i > 0 && last.t - s[i].t < 0.09) i--;
      const a = s[i];
      const dt = Math.max(last.t - a.t, 0.016);
      return Math.hypot(last.x - a.x, last.y - a.y) / dt;
    }

    /* ---------- 압출: 압력 기반 시간 tick + 표면 안착 ---------- */

    _extrude(dt) {
      // 속도에 따른 두께 — 좁은 범위(78~112%)에서만 부드럽게 변한다
      const t = clamp((this.tubeSpeed - 60) / 640, 0, 1);
      const targetR = R_BASE * lerp(R_SLOW, R_FAST, t);
      this.curR = lerp(this.curR, targetR, Math.min(1, dt * 8));
      // 배출량 = 압력² — 누르자마자 확 나오지 않고 밀려 나온다
      const pOut = this.pressure * this.pressure;
      if (pOut < 0.02) return;
      this.emitAcc += dt * pOut;
      while (this.emitAcc >= NODE_DT) {
        this.emitAcc -= NODE_DT;
        this._depositTick();
      }
    }

    _depositTick() {
      const tipX = this.tube.x, tipY = this.tube.y;
      // 처음 나올 때도 충분히 굵게 — 실/끈처럼 얇아지지 않는다
      const r = Math.max(this.curR * (0.55 + 0.45 * this.pressure), 4);
      const fromX = this.lastDepX == null ? tipX : this.lastDepX;
      const d = tipX - fromX;
      if (Math.abs(d) > 2) this.lastDir = d > 0 ? 1 : -1;
      const steps = clamp(Math.ceil(Math.abs(d) / SPACING), 1, MAX_STEPS_PER_TICK);
      for (let i = 1; i <= steps; i++) {
        let x = lerp(fromX, tipX, i / steps);
        if (this._overBrush(x)) x += (this.brushCx - x) * 0.02;
        x += (Math.random() - 0.5) * 1.4; // 미세 지터 (수직 기둥 방지, 매끈함 유지)
        x = this._slideX(x, r);
        this._spawnDeposit(x, r, 1 / steps);
      }
      this.lastDepX = tipX;
    }

    _slideX(x, r) {
      for (let k = 0; k < 2; k++) {
        const hereTop = this._topYAt(x);
        const lTop = this._topYAt(x - this.bucketW);
        const rTop = this._topYAt(x + this.bucketW);
        const lowNbr = Math.max(lTop, rTop);
        if (lowNbr - hereTop <= r * 1.1) break;
        x += (rTop > lTop ? 1 : -1) * (3 + Math.random() * 4);
      }
      return x;
    }

    /* 노드는 안착 지점에서 곧바로 등장한다 — 공중에 떠 있는 원이 절대 생기지 않는다.
     * 압출감은 성장 팝(0.6→1) + 노즐 목 + 더미 상승으로만 표현한다. */
    _spawnDeposit(x, r, share) {
      const restY = this._topYAt(x) - r * 0.62;
      const n = {
        x, y: restY,
        tx: x, ty: restY,
        r,
        fieldShare: share || 1,
        landed: true,
        landT: this.now,
        outside: !this._overBrush(x),
        tip: false,
        sx: 1, sy: 1, rot: 0,
        born: this.now,
        idx: this.nodeIdx++,
      };
      if (n.outside) {
        n.sx = 1.35; // 바닥에 철퍼덕
        n.sy = 0.62;
      } else if (this.field[this._bIdx(x)] > r * 0.8) {
        n.sx = 1.07; // 기존 치약 위에 살짝 눌려 얹힘
        n.sy = 0.93;
      }
      this.nodes.push(n);
      this._addField(n);
      return n;
    }

    /* 갓 얹힌 노드의 눌림 안정화 (§19) */
    _updateDrops(dt) {
      for (const n of this.nodes) {
        if (!n.outside && !n.tip && n.landT && this.now - n.landT < 0.5) {
          const k = Math.min(1, dt * 9);
          n.sx += (1.02 - n.sx) * k;
          n.sy += (0.99 - n.sy) * k;
        }
      }
    }

    /* ---------- 하이트필드(쌓임) ---------- */

    _bIdx(x) { return clamp(Math.round(x / this.bucketW), 0, this.nBuckets - 1); }
    _overBrush(x) { return Math.abs(x - this.brushCx) <= this.brushHalfW; }
    _surfaceBaseY(x) { return this._overBrush(x) ? this.brushTopY : this.floorY; }
    _topYAt(x) { return this._surfaceBaseY(x) - this.field[this._bIdx(x)]; }

    _addField(n) {
      const d = this.prevLandX == null ? this.bucketW : Math.abs(n.x - this.prevLandX);
      this.prevLandX = n.x;
      const base = 1.6 * n.r * (clamp(d, 0.5, this.bucketW) / this.bucketW) * (n.fieldShare || 1);
      const k = [0.1, 0.22, 0.36, 0.22, 0.1];
      const b = this._bIdx(n.x);
      for (let o = -2; o <= 2; o++) {
        const i = b + o;
        if (i >= 0 && i < this.nBuckets) this.field[i] += base * k[o + 2];
      }
    }

    /* 기울기가 가파르면 흘러내리듯 완화 — 전체 영역 (칫솔 밖 스필도 탑이 아니라 웅덩이로).
     * 단, 칫솔 가장자리 단차를 넘는 이동은 금지 */
    _relaxField() {
      const th = 18, rate = 0.2;
      this._relaxFlip = !this._relaxFlip;
      if (this._relaxFlip) {
        for (let i = 1; i < this.nBuckets - 1; i++) this._relaxPairSafe(i, i + 1, th, rate);
      } else {
        for (let i = this.nBuckets - 2; i > 0; i--) this._relaxPairSafe(i, i - 1, th, rate);
      }
    }

    _relaxPairSafe(a, b, th, rate) {
      if (this._overBrush(a * this.bucketW) !== this._overBrush(b * this.bucketW)) return;
      this._relaxPair(a, b, th, rate);
    }

    _relaxPair(a, b, th, rate) {
      const d = this.field[a] - this.field[b];
      if (d > th) {
        const f = (d - th) * rate;
        this.field[a] -= f;
        this.field[b] += f;
      }
    }

    /* 손 떼는 순간의 속도에 따라 끝맺음이 달라진다 */
    _buildTip() {
      let last = null;
      for (let i = this.nodes.length - 1; i >= 0; i--) {
        const n = this.nodes[i];
        if (n.landed && !n.outside && !n.tip) { last = n; break; }
      }
      if (!last) { this.tipInfo = { type: 'none', topY: 0 }; return; }
      const s = this.releaseSpeed;
      if (s >= 650) {
        last.sx = 1.25;
        last.sy = 0.75;
        const crumb = this._spawnDeposit(last.tx + this.lastDir * last.r * 1.5, Math.max(3, last.r * 0.3));
        crumb.tip = true;
        crumb.detached = true; // 끊긴 조각 — 스트랜드 연결에서 제외
        this.tipInfo = { type: 'torn', topY: last.ty - last.r };
        return;
      }
      const soft = s < 260;
      const count = soft ? 5 : 3;
      const decay = soft ? 0.72 : 0.62;
      const curve = [2.5, 3.5, 2.5, 0.5, -2];
      let px = last.tx, py = last.ty, pr = last.r;
      for (let i = 0; i < count; i++) {
        const r = Math.max(2.6, pr * decay);
        const y = py - pr * 0.75;
        const x = px + this.lastDir * curve[i % curve.length] * (r / R_BASE + 0.4);
        const t = {
          x, y, tx: x, ty: y,
          r,
          landed: true, landT: 0, outside: false, tip: true,
          sx: 1, sy: 1, rot: 0,
          born: this.now + 0.05 + i * 0.045,
          idx: this.nodeIdx++,
        };
        this.nodes.push(t);
        px = x; py = y; pr = r;
      }
      this.tipInfo = { type: soft ? 'soft' : 'mid', topY: py - pr };
    }

    _pileCenter() {
      let sx = 0, sy = 0, m = 0;
      for (const n of this.nodes) {
        if (!n.landed || n.outside) continue;
        const w = n.r * n.r;
        sx += n.x * w;
        sy += n.y * w;
        m += w;
      }
      if (!m) return { x: this.brushCx, y: this.brushTopY - 40 };
      return { x: sx / m, y: sy / m };
    }

    /* ---------- 렌더링 ---------- */

    render() {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      if (this.zoomS > 1.001 && this.zoomC) {
        ctx.translate(this.zoomC.x, this.zoomC.y);
        ctx.scale(this.zoomS, this.zoomS);
        ctx.translate(-this.zoomC.x, -this.zoomC.y);
      }
      if (this.brushDraw) {
        this._drawBrush(ctx);
      } else {
        this._drawFloor(ctx);
        this._drawBrush(ctx);
      }
      this._drawContactShadow(ctx);
      this._drawPaste(ctx);
      this._drawTube(ctx);
      if (window.PASTE_DEBUG) this._drawDebug(ctx);
    }

    _drawFloor(ctx) {
      ctx.fillStyle = 'rgba(222, 232, 239, 0.55)';
      ctx.fillRect(0, this.floorY, this.w, this.h - this.floorY);
      ctx.fillStyle = 'rgba(200, 214, 224, 0.8)';
      ctx.fillRect(0, this.floorY, this.w, 2);
    }

    _drawBrush(ctx) {
      if (this.brushDraw) {
        const b = this.brushDraw;
        ctx.drawImage(this.brushImg, b.offX, b.offY, b.iw * b.scale, b.ih * b.scale);
        return;
      }
      // 에셋이 없을 때만 쓰는 벡터 fallback
      const cx = this.brushCx, hw = this.brushHalfW;
      const baseY = this.brushTopY + this.bristleH;
      ctx.fillStyle = 'rgba(60, 90, 110, 0.08)';
      ctx.beginPath();
      ctx.ellipse(cx + 30, this.floorY + 8, hw * 1.3, 7, 0, 0, TAU);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#d7e1ea';
      ctx.fillStyle = '#f4f7fa';
      roundRectPath(ctx, cx + hw - 10, baseY + 2, this.w - (cx + hw) + 50, 15, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      roundRectPath(ctx, cx - hw - 6, baseY, hw * 2 + 12, 16, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f7fafc';
      ctx.strokeStyle = '#dde7ef';
      ctx.lineWidth = 1;
      const tuftW = 5, gap = 3.5;
      for (let x = cx - hw + 4; x < cx + hw - 4; x += tuftW + gap) {
        const jitter = (Math.sin(x * 999.1) * 0.5 + 0.5) * 3;
        const th = this.bristleH - 3 + jitter;
        roundRectPath(ctx, x, baseY - th, tuftW, th, 2.5);
        ctx.fill();
        ctx.stroke();
      }
    }

    _drawContactShadow(ctx) {
      let minX = Infinity, maxX = -Infinity, any = false;
      for (const n of this.nodes) {
        if (!n.landed || n.outside) continue;
        any = true;
        minX = Math.min(minX, n.x - n.r);
        maxX = Math.max(maxX, n.x + n.r);
      }
      if (!any) return;
      const cx = (minX + maxX) / 2;
      const rx = clamp((maxX - minX) / 2 + 8, 12, this.brushHalfW + 10);
      ctx.fillStyle = this.contactShadow;
      ctx.beginPath();
      ctx.ellipse(cx, this.brushTopY + 4, rx, 6, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(34, 48, 60, 0.08)';
      ctx.beginPath();
      ctx.ellipse(cx, this.brushTopY + 4, rx * 0.7, 4, 0, 0, TAU);
      ctx.fill();
    }

    _spawnScale(n) {
      const k = clamp((this.now - n.born) / 0.1, 0, 1);
      return 0.75 + 0.25 * (k * (2 - k)); // 줄이 미끄러져 나오듯 은은한 등장
    }

    /* 노즐 바로 아래의 짧고 굵은 압출 목 — active extrusion zone (§4·6)
     * 구멍(76%)에서 몇 px 만에 원래 두께로 팽창하고, 길이는 항상 MAX_HOVER 이내다. */
    _neckCircles() {
      if (this.phase !== 'play' || (!this.extruding && !this.releasing)) return [];
      const p = this.pressure;
      if (p <= 0.04) return [];
      if (p < 0.14) return []; // 배출 시작 전엔 아무것도 없다
      const tipX = this.tube.x, tipY = this.tube.y;
      const surfY = this._topYAt(tipX);
      const len = surfY - tipY;
      if (len <= 2) return [];
      const rBase = Math.max(this.curR * (0.55 + 0.45 * p), 4);
      // 가까우면 굵은 압출 목, 높이 들면 가늘어진 낙하 스트림 — 항상 표면까지 이어진다
      const rTip = rBase * 0.76;
      const rLand = rBase * 0.95;
      // 낙하 구간이 길수록 중간이 가늘어진다 (부으면 늘어나는 치약)
      const rMid = rBase * clamp(lerp(0.76, 0.45, (len - 26) / 160), 0.45, 0.76);
      const sway = Math.min(1.6, Math.max(0, len - 40) * 0.01);
      const out = [];
      const steps = clamp(Math.round(len / 4), 3, 90);
      for (let i = 0; i <= steps; i++) {
        const q = i / steps;
        const y = tipY + 2 + len * q;
        const dTip = len * q;
        const dSurf = len * (1 - q);
        let r = rMid;
        if (dTip < 12) r = lerp(rTip, rMid, dTip / 12);
        if (dSurf < 16) r = Math.max(r, lerp(rLand, rMid, dSurf / 16));
        // 낙하 중간 구간의 미세한 흔들림
        const x = tipX + (sway > 0 && q > 0.12 && q < 0.88 ? Math.sin(this.now * 9 + q * 5) * sway : 0);
        out.push({ x, y, r });
      }
      return out;
    }

    /* 치약 본체 — 오프스크린 레이어에서 union + source-atop 합성으로 매끈하게 */
    _drawPaste(targetCtx) {
      const nodes = this.nodes;
      const neck = this._neckCircles();
      if (!nodes.length && !neck.length) return;
      const L = this._lctx;
      L.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      L.clearRect(0, 0, this.w, this.h);

      let minY = Infinity, maxY = -Infinity;
      for (const n of nodes) {
        if (!n.landed || n.outside) continue;
        minY = Math.min(minY, n.y);
        maxY = Math.max(maxY, n.y);
      }
      if (minY === Infinity) { minY = this.brushTopY - 40; maxY = this.brushTopY; }
      if (neck.length) minY = Math.min(minY, neck[0].y);
      const span = Math.max(maxY - minY, 1);
      const baseY = maxY + 6;
      const cx = this.zoomC ? this.zoomC.x : this.brushCx;
      const sq = this.squash, wob = this.wobbleAmp, t = this.now;
      const N = nodes.length;
      const px = new Array(N), py = new Array(N), sc = new Array(N), wd = new Array(N);
      for (let i = 0; i < N; i++) {
        const n = nodes[i];
        let x = n.x, y = n.y;
        if (n.landed && !n.outside) {
          if (sq > 0) {
            y = baseY - (baseY - y) * (1 - 0.05 * sq);
            x = cx + (x - cx) * (1 + 0.03 * sq);
          }
          if (wob > 0.05) {
            x += Math.sin(t * 20 + n.idx * 0.35) * wob * clamp((baseY - y) / 110, 0.1, 1);
          }
        }
        px[i] = x;
        py[i] = y;
        sc[i] = this._spawnScale(n);
        const depth = n.landed && !n.outside ? clamp((y - minY) / span, 0, 1) : 0.3;
        wd[i] = 1 + depth * 0.07; // 아래층일수록 살짝 눌려 넓다
      }

      // 모든 패스가 같은 union 실루엣만 그린다 — 내부에 알갱이 경계가 생길 수 없다.
      // 이웃 노드는 캡슐 스트로크로 이어져 노즐부터 끝까지 하나의 줄이 된다.
      const blobs = (C, dx, dy, grow) => {
        C.strokeStyle = C.fillStyle;
        C.lineCap = 'round';
        C.lineJoin = 'round';
        for (let i = 0; i < N; i++) {
          const n = nodes[i];
          const rr = n.r * sc[i];
          C.beginPath();
          C.ellipse(px[i] + dx, py[i] + dy, rr * n.sx * wd[i] + grow, rr * n.sy + grow, n.rot, 0, TAU);
          C.fill();
        }
        // 연속 스트랜드: 가까운 이웃끼리 캡슐로 연결 (칫솔 밖 낙차 등 먼 구간은 잇지 않는다)
        for (let i = 1; i < N; i++) {
          const a = nodes[i - 1], b = nodes[i];
          if (a.detached || b.detached) continue;
          const dd = Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]);
          const ra = a.r * sc[i - 1], rb = b.r * sc[i];
          if (dd < 3 || dd > (ra + rb) * 1.5) continue;
          C.lineWidth = Math.max((Math.min(ra, rb) + grow) * 1.9, 2);
          C.beginPath();
          C.moveTo(px[i - 1] + dx, py[i - 1] + dy);
          C.lineTo(px[i] + dx, py[i] + dy);
          C.stroke();
        }
        for (const c of neck) {
          C.beginPath();
          C.ellipse(c.x + dx, c.y + dy, c.r + grow, c.r * 1.04 + grow, 0, 0, TAU);
          C.fill();
        }
        // 노즐 목 끝 ↔ 가장 최근 노드 연결 — 압출되는 줄이 쭈욱 이어진다
        if (neck.length && N) {
          const end = neck[neck.length - 1];
          const j = N - 1;
          const rb = nodes[j].r * sc[j];
          const dd = Math.hypot(px[j] - end.x, py[j] - end.y);
          if (dd < (end.r + rb) * 2.2 && !nodes[j].detached) {
            C.lineWidth = Math.max((Math.min(end.r, rb) + grow) * 1.9, 2);
            C.beginPath();
            C.moveTo(end.x + dx, end.y + dy);
            C.lineTo(px[j] + dx, py[j] + dy);
            C.stroke();
          }
        }
      };

      // ① 하단 접지 림 — union을 아래로 밀어 연속된 윤곽 그림자
      L.fillStyle = this.rimColor;
      blobs(L, 1.0, 2.4, 0.7);
      // ② 본체 — 단색 union (하나의 매끈한 덩어리)
      L.fillStyle = this.colors.base;
      blobs(L, 0, 0, 0.4);
      // ③ 수직 그라데이션 볼륨 셰이딩 — 치약 픽셀 안쪽에만
      L.globalCompositeOperation = 'source-atop';
      const grad = L.createLinearGradient(0, minY - 14, 0, maxY + 14);
      grad.addColorStop(0, this.gradTopColor);
      grad.addColorStop(0.45, 'rgba(0,0,0,0)');
      grad.addColorStop(1, this.gradBottomColor);
      L.fillStyle = grad;
      L.fillRect(0, 0, this.w, this.h);
      // ④ 광택 — 실루엣의 좌상단을 따라 흐르는 크레센트 하이라이트 한 줄
      //    (union에서 아래-오른쪽으로 민 union을 지워낸 차집합 = 부드러운 긴 밴드)
      const B = this._bctx;
      B.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      B.clearRect(0, 0, this.w, this.h);
      B.fillStyle = this.bevelLight;
      blobs(B, 0, 0, 0);
      B.globalCompositeOperation = 'destination-out';
      B.fillStyle = '#000';
      blobs(B, 3.0, 4.0, 0.5);
      B.globalCompositeOperation = 'source-over';
      L.globalAlpha = 0.55;
      L.drawImage(this._band, 0, 0, this.w, this.h);
      L.globalAlpha = 0.3;
      L.drawImage(this._band, 0.8, 0.9, this.w, this.h); // 살짝 어긋나게 한 번 더 → 부드러운 가장자리
      L.globalAlpha = 1;
      L.globalCompositeOperation = 'source-over';

      targetCtx.drawImage(this._layer, 0, 0, this.w, this.h);
    }

    _drawTube(ctx) {
      const lift = this.phase === 'play' ? 0 : this.settleT * 520;
      const s = clamp(this.tubeSquash, -0.25, 1.25);
      const x = this.tube.x;
      const y = this.tube.y - lift + s * 2.5; // 누르면 살짝 가라앉는다
      if (y < -280) return;
      const tilt = clamp(this.tube.vx * 0.00045, -0.2, 0.2);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(tilt);

      // ---- 바디 (압력에 따라 꾸욱 눌린다: 세로 -10%, 가로 +12%) ----
      ctx.save();
      const tremor = this.extruding ? Math.sin(this.squeezePulse * 15) * 0.008 : 0;
      const sqx = 1 + 0.12 * s + tremor;
      const sqy = 1 - 0.1 * s;
      ctx.translate(0, -30); // 바디-목 경계 기준 → 노즐 위치는 흔들리지 않는다
      ctx.scale(sqx, sqy);
      ctx.translate(0, 30);

      // 어깨 곡선 → 몸통 → 위쪽 크림프(눌러 접은 끝단)로 이어지는 실루엣
      const bodyPath = () => {
        ctx.beginPath();
        ctx.moveTo(-11, -30);
        ctx.quadraticCurveTo(-34, -34, -36, -54);
        ctx.lineTo(-36, -164);
        ctx.lineTo(-40, -172);
        ctx.lineTo(40, -172);
        ctx.lineTo(36, -164);
        ctx.lineTo(36, -54);
        ctx.quadraticCurveTo(34, -34, 11, -30);
        ctx.closePath();
      };

      // 크림프 씰 (톱니 자국)
      ctx.fillStyle = '#dfe7ee';
      ctx.strokeStyle = '#c2cfda';
      ctx.lineWidth = 1.5;
      roundRectPath(ctx, -41, -179, 82, 10, 2.5);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(130, 150, 168, 0.5)';
      ctx.lineWidth = 1;
      for (let cx2 = -37; cx2 <= 37; cx2 += 5) {
        ctx.beginPath();
        ctx.moveTo(cx2, -178);
        ctx.lineTo(cx2, -170.5);
        ctx.stroke();
      }

      // 몸통: 원통형 플라스틱 셰이딩
      const bodyGrad = ctx.createLinearGradient(-36, 0, 36, 0);
      bodyGrad.addColorStop(0, '#cdd8e1');
      bodyGrad.addColorStop(0.16, '#f2f6fa');
      bodyGrad.addColorStop(0.45, '#ffffff');
      bodyGrad.addColorStop(0.8, '#eaf0f5');
      bodyGrad.addColorStop(1, '#c6d2dc');
      bodyPath();
      ctx.fillStyle = bodyGrad;
      ctx.fill();
      ctx.strokeStyle = '#c9d6e2';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 라벨/광택은 바디 실루엣 안쪽에만
      ctx.save();
      bodyPath();
      ctx.clip();
      // 라벨 밴드 (치약 색 2톤)
      ctx.fillStyle = this.colors.base;
      ctx.fillRect(-36, -150, 72, 54);
      ctx.fillStyle = this.colors.secondary;
      ctx.fillRect(-36, -112, 72, 16);
      ctx.fillStyle = this.tints[0];
      ctx.fillRect(-36, -114, 72, 2.5);
      // 원통 감김 셰이딩 — 라벨도 함께 좌우가 어두워진다
      const side = ctx.createLinearGradient(-36, 0, 36, 0);
      side.addColorStop(0, 'rgba(70, 95, 115, 0.22)');
      side.addColorStop(0.2, 'rgba(70, 95, 115, 0)');
      side.addColorStop(0.78, 'rgba(70, 95, 115, 0)');
      side.addColorStop(1, 'rgba(70, 95, 115, 0.25)');
      ctx.fillStyle = side;
      ctx.fillRect(-40, -179, 80, 150);
      // 세로 스펙큘러 스트라이프 (광택 플라스틱)
      const spec = ctx.createLinearGradient(-26, 0, -4, 0);
      spec.addColorStop(0, 'rgba(255,255,255,0)');
      spec.addColorStop(0.5, 'rgba(255,255,255,0.55)');
      spec.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = spec;
      ctx.fillRect(-26, -172, 22, 144);
      ctx.restore();
      ctx.restore(); // 바디 변형 끝

      // ---- 목/노즐 (변형 없음 — 고무장난감처럼 찌그러지지 않게) ----
      // 나사산 목
      ctx.fillStyle = '#e6edf3';
      ctx.strokeStyle = '#c2cfda';
      ctx.lineWidth = 1.5;
      roundRectPath(ctx, -11, -31, 22, 18, 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#c5d2dd';
      ctx.lineWidth = 1.4;
      for (const ty of [-26.5, -21.5, -16.5]) {
        ctx.beginPath();
        ctx.moveTo(-10, ty);
        ctx.lineTo(10, ty);
        ctx.stroke();
      }
      // 노즐 팁
      ctx.fillStyle = '#eef3f8';
      ctx.strokeStyle = '#c9d6e2';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-8, -14);
      ctx.lineTo(8, -14);
      ctx.lineTo(5.5, -1);
      ctx.lineTo(-5.5, -1);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // 출구 (안쪽 치약 색이 보인다)
      ctx.fillStyle = this.nozzleInner;
      ctx.beginPath();
      ctx.ellipse(0, -1, 5.2, 2.4, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    _drawDebug(ctx) {
      ctx.strokeStyle = 'rgba(255,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < this.nBuckets; i++) {
        const x = i * this.bucketW;
        const y = this._surfaceBaseY(x) - this.field[i];
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (this.pointer) {
        ctx.strokeStyle = 'rgba(0,0,255,0.5)';
        ctx.strokeRect(this.pointer.x - 4, this.pointer.y - 4, 8, 8);
      }
      ctx.strokeStyle = 'rgba(0,180,0,0.8)';
      ctx.strokeRect(this.tube.x - 3, this.tube.y - 3, 6, 6);
      ctx.fillStyle = '#000';
      ctx.font = '11px monospace';
      const activeLen = Math.max(0, this._topYAt(this.tube.x) - this.tube.y);
      ctx.fillText(
        `nodes:${this.nodes.length} r:${this.curR.toFixed(1)} spd:${this.tubeSpeed.toFixed(0)} p:${this.pressure.toFixed(2)} sq:${this.tubeSquash.toFixed(2)} act:${activeLen.toFixed(0)}px`,
        8, 14
      );
    }

    /* ---------- 결과물 ---------- */

    makeSnapshot(scale) {
      scale = scale || 2;
      let minX = this.brushCx - this.brushHalfW - 20;
      let maxX = this.brushCx + this.brushHalfW + 20;
      let minY = this.brushTopY - 120;
      let maxY = this.brushTopY + this.bristleH + 30;
      for (const n of this.nodes) {
        minX = Math.min(minX, n.x - n.r - 14);
        maxX = Math.max(maxX, n.x + n.r + 14);
        minY = Math.min(minY, n.y - n.r - 20);
        maxY = Math.max(maxY, n.y + n.r + 14);
      }
      minX = Math.max(minX, 0);
      maxX = Math.min(maxX, this.w);
      minY = Math.max(minY, 0);
      maxY = Math.min(maxY, this.h);
      const w = Math.max(maxX - minX, 40);
      const h = Math.max(maxY - minY, 40);
      const cnv = document.createElement('canvas');
      cnv.width = Math.round(w * scale);
      cnv.height = Math.round(h * scale);
      const c2 = cnv.getContext('2d');
      c2.scale(scale, scale);
      c2.translate(-minX, -minY);
      this._drawBrush(c2);
      this._drawContactShadow(c2);
      this._drawPaste(c2);
      return cnv;
    }

    getAnalysis() {
      const inside = [];
      let insideVol = 0, outsideVol = 0;
      for (const n of this.nodes) {
        if (!n.landed) continue;
        const v = n.r * n.r;
        if (n.outside) {
          outsideVol += v;
        } else {
          inside.push({ x: n.x, y: n.y, r: n.r });
          insideVol += v;
        }
      }
      return {
        inside,
        insideVol,
        outsideVol,
        samples: this.samples.slice(),
        releaseSpeed: this.releaseSpeed,
        tip: this.tipInfo,
        brush: { cx: this.brushCx, halfW: this.brushHalfW, topY: this.brushTopY },
      };
    }
  }

  window.PasteEngine = PasteEngine;
})();
