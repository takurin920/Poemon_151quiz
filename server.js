const express = require('express'), http = require('http'), { Server } = require('socket.io');
const app = express(); app.use(express.static(__dirname + '/public'));
const srv = http.createServer(app), io = new Server(srv);

const MAX_ID = 151, REVEAL_MS = 2500, rooms = {};
const clamp = (v, a, b, d) => { v = parseInt(v, 10); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
const cleanSettings = s => ({
  time: clamp(s.time, 30, 600, 120),      // 持ち時間(秒)
  penalty: clamp(s.penalty, 0, 60, 10),   // 誤答ペナルティ(秒)
  bonusOn: !!s.bonusOn,                   // 正解時の加算 ON/OFF
  bonus: clamp(s.bonus, 1, 60, 5),        // 加算秒数
  handi: (h => ({                         // ハンデ
    on: !!h.on,
    target: Number(h.target) === 0 ? 0 : 1,  // 0=1P, 1=2P（ハンデを受ける側）
    extraOn: !!h.extraOn, extra: clamp(h.extra, 1, 300, 30), // 持ち時間の追加
    digitOn: !!h.digitOn                     // 図鑑番号の下1桁を提示
  }))(s.handi || {})
});
const rnd3 = () => { const s = new Set(); while (s.size < 3) s.add(1 + Math.floor(Math.random() * MAX_ID)); return [...s]; };
const roomState = r => ({ id: r.id, phase: r.phase, names: r.names, settings: r.settings, ready: r.ready, count: r.players.length });
const sendRoom = r => io.to(r.id).emit('room_state', roomState(r));
const snapshot = r => ({ settings: r.settings, time: r.time, turn: r.turn, q: r.q, names: r.names, started: r.phase === 'playing' });

function newQuestion(r, p) {
  r.q[p] = rnd3();
  const h = r.settings.handi;
  const hint = h.on && h.digitOn && h.target === p ? r.q[p].map(i => i % 10) : null; // 下1桁ヒント
  io.to(r.id).emit('question_updated', { player: p, ids: r.q[p], hint });
}

function finish(r, loser) {
  clearInterval(r.timer); r.phase = 'done'; r.lock = false;
  io.to(r.id).emit('game_over', { loser, winner: 1 - loser, time: r.time.map(t => Math.max(t, 0)), stats: r.stats });
}

function start(r) {
  r.phase = 'playing'; r.turn = 0; r.lock = false; r.q = [[], []];
  r.time = [r.settings.time, r.settings.time];
  const h = r.settings.handi;
  if (h.on && h.extraOn) r.time[h.target] += h.extra; // ハンデ：持ち時間の追加
  r.stats = [{ ok: 0, ng: 0 }, { ok: 0, ng: 0 }];
  sendRoom(r);
  io.to(r.id).emit('state', snapshot(r));
  newQuestion(r, 0);
  r.timer = setInterval(() => {
    if (r.lock) return; // 誤答の結果表示中は時計を止める
    r.time[r.turn]--;
    io.to(r.id).emit('tick', { time: r.time, turn: r.turn });
    if (r.time[r.turn] <= 0) finish(r, r.turn);
  }, 1000);
}

io.on('connection', s => {
  const ctx = () => { const { room, idx } = s.data || {}; return { r: rooms[room], idx, room }; };

  s.on('join', ({ room, name }) => {
    // 全角→半角、大文字→小文字、英数字以外は除去（別部屋になるのを防ぐ）
    room = String(room || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    if (!room) return s.emit('err', 'ルームIDは半角英数字で入力してください');
    const r = rooms[room] || (rooms[room] = {
      id: room, players: [], names: [], phase: 'waiting', ready: [false, false],
      settings: cleanSettings({}), time: [0, 0], turn: 0, q: [[], []], lock: false, stats: []
    });
    if (r.players.length >= 2) return s.emit('err', 'このルームは満員です');
    const idx = r.players.length;
    r.players.push(s.id);
    r.names[idx] = String(name || '').replace(/[<>&"'`]/g, '').trim().slice(0, 10) || `${idx + 1}P`;
    r.ready = [false, false]; r.phase = idx === 1 ? 'lobby' : 'waiting';
    s.join(room); s.data = { room, idx };
    s.emit('joined', { idx });
    sendRoom(r);
  });

  // ホストのみ設定変更可（開始前）。変更したら準備OKはリセット
  s.on('settings', v => {
    const { r, idx } = ctx();
    if (!r || idx !== 0 || !['waiting', 'lobby'].includes(r.phase)) return;
    r.settings = cleanSettings(v || {}); r.ready = [false, false]; sendRoom(r);
  });

  s.on('ready', on => {
    const { r, idx } = ctx();
    if (!r || r.phase !== 'lobby') return;
    r.ready[idx] = !!on; sendRoom(r);
    if (r.ready[0] && r.ready[1]) start(r);
  });

  s.on('rematch', () => {
    const { r } = ctx();
    if (!r || r.phase !== 'done') return;
    r.phase = 'lobby'; r.ready = [false, false]; sendRoom(r);
  });

  s.on('typing', filled => {
    const { r, idx, room } = ctx(); if (!r) return;
    s.to(room).emit('typing', { player: idx, filled: [0, 1, 2].map(i => !!(filled && filled[i])) });
  });

  s.on('submit', answers => {
    const { r, idx, room } = ctx();
    if (!r || r.phase !== 'playing' || r.lock || r.turn !== idx || !Array.isArray(answers)) return;
    const results = r.q[idx].map((id, i) => Number(String(answers[i]).normalize('NFKC')) === id);
    const wrong = results.filter(ok => !ok).length;
    if (wrong === 0) {
      r.stats[idx].ok++;
      const bonus = r.settings.bonusOn ? r.settings.bonus : 0;
      r.time[idx] += bonus;
      io.to(room).emit('answer_result', { player: idx, ok: true, ids: r.q[idx], bonus });
      r.turn = 1 - idx; newQuestion(r, r.turn);
      io.to(room).emit('tick', { time: r.time, turn: r.turn });
    } else {
      r.stats[idx].ng++;
      const penalty = r.settings.penalty;
      r.time[idx] -= penalty; r.lock = true;
      io.to(room).emit('answer_result', { player: idx, ok: false, wrong, penalty, results, ids: r.q[idx], given: answers.map(a => Number(String(a).normalize('NFKC'))) });
      io.to(room).emit('tick', { time: r.time, turn: r.turn });
      if (r.time[idx] <= 0) return finish(r, idx);
      setTimeout(() => { // 結果を見せたあと、3匹とも入れ替える
        if (rooms[room] !== r || r.phase !== 'playing') return;
        r.lock = false; newQuestion(r, idx);
      }, REVEAL_MS);
    }
  });

  s.on('disconnect', () => {
    const { r, idx, room } = ctx(); if (!r || !r.players.includes(s.id)) return;
    if (idx === 1 && ['waiting', 'lobby'].includes(r.phase)) { // ゲスト退出：ホストは待機に戻る
      r.players.pop(); r.names.pop(); r.ready = [false, false]; r.phase = 'waiting'; return sendRoom(r);
    }
    clearInterval(r.timer); io.to(room).emit('opponent_left'); delete rooms[room];
  });
});

srv.listen(process.env.PORT || 3000, () => console.log('http://localhost:3000'));
