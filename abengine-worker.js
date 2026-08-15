// ABEngine 전용 워커 - 메인 스레드를 막지 않고 백그라운드에서 탐색
importScripts('abengine.js');

const PROMO_CHAR = {};
(function () {
  const TO_UNI = ABEngine._enc.TO_UNI;
  const map = { "♕": 'q', "♛": 'q', "♖": 'r', "♜": 'r', "♗": 'b', "♝": 'b', "♘": 'n', "♞": 'n' };
  TO_UNI.forEach((uni, idx) => { if (map[uni]) PROMO_CHAR[idx] = map[uni]; });
})();

self.onmessage = function (e) {
  try {
    const { board, whiteTurn, enPassantTarget, movedKing, movedRook, depth, timeMs } = e.data;
    const st = ABEngine.fromGame(board, whiteTurn, enPassantTarget, movedKing, movedRook);
    const result = ABEngine.bestMove(st, depth, timeMs);
    const m = result.move;
    if (!m) { self.postMessage({ move: null }); return; }
    self.postMessage({
      move: {
        from: m.from,
        to: m.to,
        promoChar: (m.kind === 4 && m.promo) ? (PROMO_CHAR[m.promo] || 'q') : null
      }
    });
  } catch (err) {
    self.postMessage({ move: null, error: String(err) });
  }
};
