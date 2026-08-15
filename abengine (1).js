/* =====================================================================
 * ABEngine v1 — Ability Chess 전용 고속 엔진 (기물 완전 정합판)
 *
 * 대상 게임: https://github.com/jongseok130413/Abilitychess (index.html v5.3)
 * 설계 원칙:
 *  - 게임의 legal()이 규칙의 원전(오라클). 이 엔진은 그것의 "빠른 재구현"이며
 *    정합성은 perft + 랜덤워크 교차 diff로 검산한다.
 *  - 표준 기물 + 아마존(Ⓐ/ⓐ, 퀸+나이트) + 로마기사병(🛡️/🛡, 전진1 + 제자리 찌르기).
 *  - 킹 캡처 세만틱스: 킹을 실제로 잡을 수 있고(게임과 동일), 잡히면 탐색 점수 ±MATE.
 *  - 찌르기(stab)는 현행 게임 구현대로 "턴을 소모하지 않는" 프리액션 (STAB_FREE_ACTION).
 *    입법자(개발자)가 규칙을 확정하면 플래그 하나로 전환.
 *  - v1 미포함(=v2 훅): 능력(폭발/조종/부활 등)의 탐색 통합, 승급 보너스무브 턴흐름, TT.
 * ===================================================================== */
(function (root) {
  "use strict";

  // ---- 기물 인코딩 ----
  const E = 0,
    WP = 1, WN = 2, WB = 3, WR = 4, WQ = 5, WK = 6, WA = 7, WS = 8,
    BP = 9, BN = 10, BB = 11, BR = 12, BQ = 13, BK = 14, BA = 15, BS = 16;
  const isW = p => p >= 1 && p <= 8;
  const isB = p => p >= 9;
  const typeOf = p => (p > 8 ? p - 8 : p); // 1..8 (색 제거)

  // 게임(index.html)의 유니코드 표기 ↔ 엔진 인코딩
  const FROM_UNI = {
    "♙": WP, "♘": WN, "♗": WB, "♖": WR, "♕": WQ, "♔": WK, "Ⓐ": WA, "🛡️": WS,
    "♟": BP, "♞": BN, "♝": BB, "♜": BR, "♛": BQ, "♚": BK, "ⓐ": BA, "🛡": BS
  };
  const TO_UNI = ["", "♙", "♘", "♗", "♖", "♕", "♔", "Ⓐ", "🛡️", "♟", "♞", "♝", "♜", "♛", "♚", "ⓐ", "🛡"];

  // 규칙 스위치 — 현행 게임 동작 기준. 입법 확정 시 여기만 바꾼다.
  const RULES = {
    STAB_FREE_ACTION: true // 로마기사병 찌르기가 턴을 소모하지 않음 (index.html move() 현행)
  };

  // ---- 상태 ----
  // b: Int8Array(64) [r*8+c], wtm: 백 차례?, ep: 앙파상 목표 sq(-1 없음),
  // rights: 비트 1=백K측 2=백Q측 4=흑K측 8=흑Q측, wk/bk: 킹 위치(-1=사망)
  function makeState() {
    return { b: new Int8Array(64), wtm: true, ep: -1, rights: 15, wk: -1, bk: -1 };
  }

  function initialState(opts) {
    // opts: {amazonWhite, amazonBlack, shieldSquares:[sq,...]} — 검산용 변형 배치
    opts = opts || {};
    const st = makeState();
    const back = [WR, WN, WB, WQ, WK, WB, WN, WR];
    for (let c = 0; c < 8; c++) {
      st.b[0 * 8 + c] = back[c] + 8; // 흑 백랭크
      st.b[1 * 8 + c] = BP;
      st.b[6 * 8 + c] = WP;
      st.b[7 * 8 + c] = back[c];
    }
    if (opts.amazonWhite) { st.b[7 * 8 + 3] = WA; st.b[7 * 8 + 1] = E; st.b[7 * 8 + 6] = E; }
    if (opts.amazonBlack) { st.b[0 * 8 + 3] = BA; st.b[0 * 8 + 1] = E; st.b[0 * 8 + 6] = E; }
    (opts.shieldSquares || []).forEach(sq => {
      if (st.b[sq] === WP) st.b[sq] = WS;
      if (st.b[sq] === BP) st.b[sq] = BS;
    });
    syncKings(st);
    return st;
  }

  function syncKings(st) {
    st.wk = -1; st.bk = -1;
    for (let i = 0; i < 64; i++) {
      if (st.b[i] === WK) st.wk = i;
      else if (st.b[i] === BK) st.bk = i;
    }
  }

  // 게임 페이지의 전역(board, whiteTurn, enPassantTarget, movedKing, movedRook)에서 상태 구성
  function fromGame(gBoard, whiteTurn, enPassantTarget, movedKing, movedRook) {
    const st = makeState();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const cell = gBoard[r][c];
      st.b[r * 8 + c] = cell ? (FROM_UNI[cell.type] || E) : E;
    }
    st.wtm = !!whiteTurn;
    st.ep = enPassantTarget ? enPassantTarget[0] * 8 + enPassantTarget[1] : -1;
    st.rights =
      ((!movedKing.white && !movedRook.whiteH) ? 1 : 0) |
      ((!movedKing.white && !movedRook.whiteA) ? 2 : 0) |
      ((!movedKing.black && !movedRook.blackH) ? 4 : 0) |
      ((!movedKing.black && !movedRook.blackA) ? 8 : 0);
    syncKings(st);
    return st;
  }

  // ---- 공격 판정 (sq가 byWhite 진영에게 공격받는가) ----
  const KN = [[1, 2], [1, -2], [-1, 2], [-1, -2], [2, 1], [2, -1], [-2, 1], [-2, -1]];
  const KG = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const LINE = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function attacked(st, sq, byWhite) {
    const r = sq >> 3, c = sq & 7, b = st.b;
    // 나이트 + 아마존 나이트성분
    for (let i = 0; i < 8; i++) {
      const rr = r + KN[i][0], cc = c + KN[i][1];
      if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
      const p = b[rr * 8 + cc];
      if (p && isW(p) === byWhite) { const t = typeOf(p); if (t === 2 || t === 7) return true; }
    }
    // 킹
    for (let i = 0; i < 8; i++) {
      const rr = r + KG[i][0], cc = c + KG[i][1];
      if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
      const p = b[rr * 8 + cc];
      if (p && isW(p) === byWhite && typeOf(p) === 6) return true;
    }
    // 폰 (byWhite 폰은 위(-1)로 공격) — 게임 attacked()와 동일 기하
    {
      const dr = byWhite ? 1 : -1; // 공격자가 있는 행 = 목표행 + dr
      for (const dc of [-1, 1]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
        const p = b[rr * 8 + cc];
        if (p && isW(p) === byWhite && typeOf(p) === 1) return true;
      }
      // 로마기사병: 정면 1칸 공격
      const rr = r + dr, cc = c;
      if (rr >= 0 && rr <= 7) {
        const p = b[rr * 8 + cc];
        if (p && isW(p) === byWhite && typeOf(p) === 8) return true;
      }
    }
    // 슬라이딩: 대각(B/Q/A), 직선(R/Q/A)
    for (const [dr, dc] of DIAG) {
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7) {
        const p = b[rr * 8 + cc];
        if (p) {
          if (isW(p) === byWhite) { const t = typeOf(p); if (t === 3 || t === 5 || t === 7) return true; }
          break;
        }
        rr += dr; cc += dc;
      }
    }
    for (const [dr, dc] of LINE) {
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7) {
        const p = b[rr * 8 + cc];
        if (p) {
          if (isW(p) === byWhite) { const t = typeOf(p); if (t === 4 || t === 5 || t === 7) return true; }
          break;
        }
        rr += dr; cc += dc;
      }
    }
    return false;
  }

  // ---- 수 표현 ----
  // {from, to, piece, cap, kind, promo}
  // kind: 0 일반 / 1 찌르기(제자리) / 2 앙파상 / 3 캐슬링 / 4 승급(promo=기물) / 5 실드승급(자동N)
  function mv(from, to, piece, cap, kind, promo) {
    return { from, to, piece, cap: cap | 0, kind: kind | 0, promo: promo | 0 };
  }

  // ---- 의사수 생성 (게임 pseudo()와 동일 기하) ----
  function genPseudo(st) {
    const out = [], b = st.b, wtm = st.wtm;
    for (let sq = 0; sq < 64; sq++) {
      const p = b[sq];
      if (!p || isW(p) !== wtm) continue;
      const r = sq >> 3, c = sq & 7, t = typeOf(p);

      if (t === 1) { // 폰
        const d = wtm ? -1 : 1, start = wtm ? 6 : 1, last = wtm ? 0 : 7;
        const fr = r + d;
        if (fr >= 0 && fr <= 7 && !b[fr * 8 + c]) {
          pushPawn(out, sq, fr * 8 + c, p, 0, fr === last, wtm);
          if (r === start && !b[(r + 2 * d) * 8 + c]) out.push(mv(sq, (r + 2 * d) * 8 + c, p, E, 0, 0));
        }
        for (const dc of [-1, 1]) {
          const cc = c + dc;
          if (cc < 0 || cc > 7 || fr < 0 || fr > 7) continue;
          const to = fr * 8 + cc, q = b[to];
          if (q && isW(q) !== wtm) pushPawn(out, sq, to, p, q, fr === last, wtm);
          else if (!q && st.ep === to) {
            const bypass = b[r * 8 + cc]; // 게임과 동일: 통과 폰 실존+적군 확인
            if (bypass && isW(bypass) !== wtm) out.push(mv(sq, to, p, bypass, 2, 0));
          }
        }
      } else if (t === 8) { // 로마기사병: 전진 1칸 (빈칸=이동, 적=찌르기)
        const d = wtm ? -1 : 1, fr = r + d;
        if (fr >= 0 && fr <= 7) {
          const to = fr * 8 + c, q = b[to];
          if (!q) {
            const promoRow = wtm ? fr <= 1 : fr >= 6; // move() 현행: r2<=1 / r2>=6 에서 자동 나이트
            out.push(mv(sq, to, p, E, promoRow ? 5 : 0, 0));
          } else if (isW(q) !== wtm) {
            out.push(mv(sq, to, p, q, 1, 0)); // 찌르기: to=전방 적 칸(오라클 legal()과 동일 좌표), 본인은 제자리
          }
        }
      } else if (t === 2) { // 나이트
        for (let i = 0; i < 8; i++) {
          const rr = r + KN[i][0], cc = c + KN[i][1];
          if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
          const q = b[rr * 8 + cc];
          if (!q || isW(q) !== wtm) out.push(mv(sq, rr * 8 + cc, p, q, 0, 0));
        }
      } else if (t === 6) { // 킹 (+캐슬링: 게임 pseudo와 동일 조건)
        for (let i = 0; i < 8; i++) {
          const rr = r + KG[i][0], cc = c + KG[i][1];
          if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
          const q = b[rr * 8 + cc];
          if (!q || isW(q) !== wtm) out.push(mv(sq, rr * 8 + cc, p, q, 0, 0));
        }
        const home = wtm ? 7 : 0;
        if (r === home && c === 4 && !attacked(st, sq, !wtm)) {
          const kRight = wtm ? 1 : 4, qRight = wtm ? 2 : 8;
          const rook = wtm ? WR : BR;
          if ((st.rights & kRight) && b[home * 8 + 7] === rook &&
            !b[home * 8 + 5] && !b[home * 8 + 6] &&
            !attacked(st, home * 8 + 5, !wtm) && !attacked(st, home * 8 + 6, !wtm))
            out.push(mv(sq, home * 8 + 6, p, E, 3, 0));
          if ((st.rights & qRight) && b[home * 8 + 0] === rook &&
            !b[home * 8 + 1] && !b[home * 8 + 2] && !b[home * 8 + 3] &&
            !attacked(st, home * 8 + 2, !wtm) && !attacked(st, home * 8 + 3, !wtm))
            out.push(mv(sq, home * 8 + 2, p, E, 3, 0));
        }
      } else { // 슬라이더: B(3) R(4) Q(5) A(7)
        if (t === 3 || t === 5 || t === 7) slide(out, st, sq, p, DIAG, wtm);
        if (t === 4 || t === 5 || t === 7) slide(out, st, sq, p, LINE, wtm);
        if (t === 7) { // 아마존 나이트성분
          for (let i = 0; i < 8; i++) {
            const rr = r + KN[i][0], cc = c + KN[i][1];
            if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
            const q = b[rr * 8 + cc];
            if (!q || isW(q) !== wtm) out.push(mv(sq, rr * 8 + cc, p, q, 0, 0));
          }
        }
      }
    }
    return out;
  }

  function slide(out, st, sq, p, dirs, wtm) {
    const r = sq >> 3, c = sq & 7, b = st.b;
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7) {
        const to = rr * 8 + cc, q = b[to];
        if (!q) out.push(mv(sq, to, p, E, 0, 0));
        else { if (isW(q) !== wtm) out.push(mv(sq, to, p, q, 0, 0)); break; }
        rr += dr; cc += dc;
      }
    }
  }

  function pushPawn(out, from, to, p, cap, isPromo, wtm) {
    if (isPromo) {
      const base = wtm ? 0 : 8;
      for (const pt of [WQ, WR, WB, WN]) out.push(mv(from, to, p, cap, 4, pt + base));
    } else out.push(mv(from, to, p, cap, 0, 0));
  }

  // ---- 두기/무르기 ----
  function make(st, m) {
    const u = { ep: st.ep, rights: st.rights, wtm: st.wtm, wk: st.wk, bk: st.bk, capSq: -1, capP: E, fromP: m.piece };
    const b = st.b, r1 = m.from >> 3, c1 = m.from & 7, r2 = m.to >> 3, c2 = m.to & 7;

    st.ep = -1;

    if (m.kind === 1) { // 찌르기: 전방(m.to) 기물 제거, 본인 제자리, (현행 규칙) 턴 유지
      u.capSq = m.to; u.capP = b[m.to];
      if (b[m.to] === WK) st.wk = -1;
      if (b[m.to] === BK) st.bk = -1;
      b[m.to] = E;
      // 찌르기 승급 (move() 현행: 백이 r1===1, 흑이 r1===6에서 찌르면 나이트로)
      if ((st.wtm && r1 === 1) || (!st.wtm && r1 === 6)) b[m.from] = st.wtm ? WN : BN;
      if (!RULES.STAB_FREE_ACTION) st.wtm = !st.wtm;
      return u;
    }

    if (m.kind === 2) { // 앙파상
      const capSq = r1 * 8 + c2;
      u.capSq = capSq; u.capP = b[capSq];
      b[capSq] = E;
    } else if (b[m.to]) {
      u.capSq = m.to; u.capP = b[m.to];
      if (b[m.to] === WK) st.wk = -1;
      if (b[m.to] === BK) st.bk = -1;
    }

    b[m.to] = m.piece; b[m.from] = E;

    if (m.kind === 3) { // 캐슬링 룩 이동
      if (c2 === 6) { b[r1 * 8 + 5] = b[r1 * 8 + 7]; b[r1 * 8 + 7] = E; }
      else { b[r1 * 8 + 3] = b[r1 * 8 + 0]; b[r1 * 8 + 0] = E; }
    }
    if (m.kind === 4) b[m.to] = m.promo;              // 폰 승급(선택)
    if (m.kind === 5) b[m.to] = st.wtm ? WN : BN;     // 실드 자동 승급

    // 폰 더블 → 앙파상 목표
    if (typeOf(m.piece) === 1 && Math.abs(r2 - r1) === 2) st.ep = ((r1 + r2) / 2) * 8 + c1;

    // 킹 위치/캐슬링권
    if (m.piece === WK) { st.wk = m.to; st.rights &= ~3; }
    if (m.piece === BK) { st.bk = m.to; st.rights &= ~12; }
    if (m.from === 56) st.rights &= ~2; if (m.from === 63) st.rights &= ~1;
    if (m.from === 0) st.rights &= ~8; if (m.from === 7) st.rights &= ~4;
    if (m.to === 56) st.rights &= ~2; if (m.to === 63) st.rights &= ~1;
    if (m.to === 0) st.rights &= ~8; if (m.to === 7) st.rights &= ~4;

    st.wtm = !st.wtm;
    return u;
  }

  function unmake(st, m, u) {
    const b = st.b, r1 = m.from >> 3;
    st.ep = u.ep; st.rights = u.rights; st.wtm = u.wtm; st.wk = u.wk; st.bk = u.bk;
    if (m.kind === 1) {
      b[m.from] = u.fromP; // 찌르기 승급 원복 포함
      if (u.capSq >= 0) b[u.capSq] = u.capP;
      return;
    }
    b[m.from] = u.fromP;
    b[m.to] = E;
    if (u.capSq >= 0) b[u.capSq] = u.capP;
    if (m.kind === 3) {
      const c2 = m.to & 7;
      if (c2 === 6) { b[r1 * 8 + 7] = b[r1 * 8 + 5]; b[r1 * 8 + 5] = E; }
      else { b[r1 * 8 + 0] = b[r1 * 8 + 3]; b[r1 * 8 + 3] = E; }
    }
  }

  // 자기 킹 노출 필터 (게임 legal()의 clone+inCheck 검사와 동일 의미)
  function kingSafeAfter(st, m) {
    const mover = st.wtm;
    const u = make(st, m);
    const k = mover ? st.wk : st.bk;
    const ok = k < 0 ? false : !attacked(st, k, !mover); // 킹 소실은 불법으로 취급(게임 kingPos null→체크 관례)
    unmake(st, m, u);
    return ok;
  }

  function legalMoves(st) {
    return genPseudo(st).filter(m => kingSafeAfter(st, m));
  }

  function inCheck(st, white) {
    const k = white ? st.wk : st.bk;
    return k < 0 ? true : attacked(st, k, !white);
  }

  // ---- perft ----
  function perft(st, d) {
    if (d === 0) return 1;
    let n = 0;
    const ms = genPseudo(st);
    for (const m of ms) {
      if (!kingSafeAfter(st, m)) continue;
      const u = make(st, m);
      n += perft(st, d - 1);
      unmake(st, m, u);
    }
    return n;
  }

  // ---- 평가 ----
  const VAL = [0, 100, 300, 310, 500, 900, 0, 1250, 130];
  function evaluate(st) {
    // 백 기준 점수 → 반환 시 착수측 기준으로 부호 조정
    let s = 0;
    for (let sq = 0; sq < 64; sq++) {
      const p = st.b[sq];
      if (!p) continue;
      const t = typeOf(p), w = isW(p);
      let v = VAL[t];
      const r = sq >> 3, c = sq & 7;
      const centr = 3 - Math.max(Math.abs(r - 3.5), Math.abs(c - 3.5)); // 0..~2.5
      if (t === 2 || t === 3 || t === 7) v += centr * 6;
      if (t === 1 || t === 8) v += (w ? (6 - r) : (r - 1)) * 5; // 전진 가산
      s += w ? v : -v;
    }
    return st.wtm ? s : -s;
  }

  // ---- 탐색: 반복심화 알파베타 + MVV-LVA 정렬 + 퀴에선스 ----
  const MATE = 100000;
  let nodes = 0;

  function orderMoves(ms) {
    for (const m of ms) {
      m.sc = 0;
      if (m.cap) m.sc = 10000 + VAL[typeOf(m.cap)] * 10 - VAL[typeOf(m.piece)];
      if (typeOf(m.cap) === 6) m.sc = 1e9; // 킹 캡처 최우선
      if (m.kind === 4) m.sc += 5000;
    }
    ms.sort((a, b) => b.sc - a.sc);
    return ms;
  }

  function search(st, depth, alpha, beta, ply) {
    nodes++;
    const me = st.wtm;
    if ((me ? st.wk : st.bk) < 0) return -MATE + ply;      // 내 킹 사망
    if ((me ? st.bk : st.wk) < 0) return MATE - ply;       // 상대 킹 사망
    if (depth <= 0) return qsearch(st, alpha, beta, ply);

    const ms = orderMoves(genPseudo(st));
    let any = false, best = -Infinity;
    for (const m of ms) {
      if (!kingSafeAfter(st, m)) continue; // 오라클 legal()과 동일: 킹 캡처도 자기킹 안전 필수

      any = true;
      const u = make(st, m);
      const sameSide = st.wtm === me;                       // 찌르기 프리액션이면 턴 유지
      const sc = sameSide
        ? search(st, depth - 1, alpha, beta, ply + 1)
        : -search(st, depth - 1, -beta, -alpha, ply + 1);
      unmake(st, m, u);
      if (sc > best) best = sc;
      if (sc > alpha) alpha = sc;
      if (alpha >= beta) break;
    }
    if (!any) return inCheck(st, me) ? -MATE + ply : 0;     // 메이트 / 스테일메이트
    return best;
  }

  function qsearch(st, alpha, beta, ply) {
    nodes++;
    const me = st.wtm;
    if ((me ? st.wk : st.bk) < 0) return -MATE + ply;
    if ((me ? st.bk : st.wk) < 0) return MATE - ply;
    let stand = evaluate(st);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    const ms = orderMoves(genPseudo(st).filter(m => m.cap));
    for (const m of ms) {
      if (!kingSafeAfter(st, m)) continue;
      const u = make(st, m);
      const sameSide = st.wtm === me;
      const sc = sameSide
        ? qsearch(st, alpha, beta, ply + 1)
        : -qsearch(st, -beta, -alpha, ply + 1);
      unmake(st, m, u);
      if (sc >= beta) return sc;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }

  function bestMove(st, maxDepth, timeMs) {
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    nodes = 0;
    let best = null, bestScore = 0, doneDepth = 0;
    for (let d = 1; d <= (maxDepth || 6); d++) {
      let localBest = null, localScore = -Infinity;
      const ms = orderMoves(legalMoves(st));
      if (!ms.length) break;
      for (const m of ms) {
        const u = make(st, m);
        const same = st.wtm === u.wtm; // 턴 유지 여부(찌르기 프리액션)
        const sc = same
          ? search(st, d - 1, -Infinity, Infinity, 1)
          : -search(st, d - 1, -Infinity, Infinity, 1);
        unmake(st, m, u);
        if (sc > localScore) { localScore = sc; localBest = m; }
      }
      best = localBest; bestScore = localScore; doneDepth = d;
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      if (timeMs && now - t0 > timeMs) break;
      if (Math.abs(bestScore) > MATE - 100) break; // 메이트 확정
    }
    return { move: best, score: bestScore, depth: doneDepth, nodes };
  }

  function moveToStr(m) {
    if (!m) return "(none)";
    const s = sq => "abcdefgh"[sq & 7] + (8 - (sq >> 3));
    if (m.kind === 1) return s(m.from) + "x" + s(m.to) + "(찌르기)";
    return s(m.from) + s(m.to) + (m.kind === 4 ? "=" + TO_UNI[m.promo] : "");
  }

  root.ABEngine = {
    RULES, initialState, fromGame, legalMoves, genPseudo, perft,
    bestMove, evaluate, moveToStr, attacked, inCheck,
    _enc: { FROM_UNI, TO_UNI }
  };
})(typeof self !== "undefined" ? self : this);
