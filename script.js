// ==========================================
// STOCKFISH AI ENGINE INTEGRATION
// ==========================================
let engineWorker = null;
let engineReady = false;
let engineWatchdogTimer = null;
let stockfishDepth = 8; // AI 탐색 깊이 (숫자가 높을수록 수순을 더 깊게 계산함)

// 1. Stockfish CDN 워커 생성 및 메시지 핸들러
function spawnEngineWorker() {
  if (engineWorker) {
    try { engineWorker.terminate(); } catch(e) {}
  }

  // Stockfish 10 CDN 웹 워커 로드
  const stockfishUrl = 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js';
  const blob = new Blob([`importScripts('${stockfishUrl}');`], { type: 'application/javascript' });
  engineWorker = new Worker(URL.createObjectURL(blob));

  engineWorker.onmessage = function(e) {
    clearTimeout(engineWatchdogTimer);
    const msg = typeof e.data === 'string' ? e.data : '';

    // Engine이 최적의 수를 계산해내면 실행
    if (msg.startsWith('bestmove')) {
      const moveStr = msg.split(' ')[1];
      if (moveStr && moveStr !== '(none)') {
        const fromCol = moveStr.charCodeAt(0) - 97;
        const fromRow = 8 - parseInt(moveStr[1]);
        const toCol = moveStr.charCodeAt(2) - 97;
        const toRow = 8 - parseInt(moveStr[3]);
        const promo = moveStr[4] || null;

        if (typeof applyEngineMove === 'function') {
          applyEngineMove({
            from: fromRow * 8 + fromCol,
            to: toRow * 8 + toCol,
            promoChar: promo
          });
        }
      }
    }
  };

  engineWorker.postMessage('uci');
  engineWorker.postMessage('isready');
  engineReady = true;
}

// 2. Stockfish 엔진에 계산 명령 전달
function aiFallbackMove() {
  if (!engineWorker || !engineReady) {
    spawnEngineWorker();
  }

  const fen = (typeof getBoardFEN === 'function') ? getBoardFEN() : 'startpos';

  if (fen === 'startpos') {
    engineWorker.postMessage('position startpos');
  } else {
    engineWorker.postMessage('position fen ' + fen);
  }

  engineWorker.postMessage('go depth ' + stockfishDepth);

  clearTimeout(engineWatchdogTimer);
  // 엔진이 응답하지 않을 때를 대비한 5초 타임아웃
  engineWatchdogTimer = setTimeout(() => {
    spawnEngineWorker();
    if (typeof pickFallbackLegalMove === 'function') {
      const fb = pickFallbackLegalMove();
      if (fb) move(fb[0], fb[1], fb[2], fb[3]);
    }
  }, 5000);
}

// 최초 1회 엔진 초기화 실행
spawnEngineWorker();
