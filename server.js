const express = require('express'), http = require('http'), { Server } = require('socket.io');
const app = express(); app.use(express.static(__dirname + '/public'));
const srv = http.createServer(app), io = new Server(srv);

const REVEAL_MS = 2500, COUNTDOWN_SEC = 5, rooms = {};
const clamp = (v, a, b, d) => { v = parseInt(v, 10); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
const cleanName = n => String(n || '').replace(/[<>&"'`]/g, '').trim().slice(0, 10);

const cleanSettings = (s, solo) => {
  const c = s.counts || [], g = s.regions || {}, h = s.handi || {};
  let kanto = !!g.kanto, johto = !!g.johto;
  if (!kanto && !johto) kanto = true; // 地方は最低1つ
  return {
    time: clamp(s.time, 30, 600, 120),             // 持ち時間(秒)
    penalty: clamp(s.penalty, 0, 60, 10),          // 誤答ペナルティ(秒)
    bonusOn: solo ? false : !!s.bonusOn,           // 正解時の加算（対戦のみ）
    bonus: clamp(s.bonus, 1, 60, 5),
    counts: [clamp(c[0], 1, 5, 3), clamp(c[1], 1, 5, 3)], // 出題匹数（1P/2P別）
    regions: { kanto, johto },                    // 出題範囲
    hint: solo ? !!s.hint : false,                 // ひとり練習：下1桁表示
    handi: solo ? { on: false, target: 0, extraOn: false, extra: 30, digitOn: false } : {
      on: !!h.on, target: Number(h.target) === 0 ? 0 : 1,
      extraOn: !!h.extraOn, extra: clamp(h.extra, 1, 300, 30), digitOn: !!h.digitOn
    }
  };
};
const pool = g => { const a = []; if (g.kanto) for (let i = 1; i <= 151; i++) a.push(i); if (g.johto) for (let i = 152; i <= 251; i++) a.push(i); return a; };
const pick = (p, n) => { const a = p.slice(), out = []; while (out.length < n) out.push(a.splice(Math.floor(Math.random() * a.length), 1)[0]); return out; };

const roomState = r => ({ id: r.id, solo: !!r.solo, phase: r.phase, names: r.names, settings: r.settings, ready: r.ready, count: r.players.length });
const sendRoom = r => io.to(r.id).emit('room_state', roomState(r));
const snapshot = r => ({ solo: !!r.solo, settings: r.settings, time: r.time, turn: r.turn, q: r.q, names: r.names, started: r.phase === 'playing' });

// 【修正箇所1】newRoom: デフォルトの phase を 'lobby' に統一
const newRoom = (id, solo) => ({
  id, solo, players: [], names: [], phase: 'lobby', ready: [false, false],
  settings: cleanSettings({}, solo), time: [0, 0], turn: 0, q: [[], []], lock: false, stats: [], last: null
});

function newQuestion(r, p) {
  const S = r.settings, h = S.handi;
  r.q[p] = pick(pool(S.regions), S.counts[p]);
  const hintOn = r.solo ? S.hint : (h.on && h.digitOn && h.target === p);
  r.last = { player: p, ids: r.q[p], kind: 'pending' };
  io.to(r.id).emit('question_updated', { player: p, ids: r.q[p], hint: hintOn ? r.q[p].map(i => i % 10) : null });
}

function finish(r, loser) {
  clearInterval(r.timer); r.phase = 'done'; r.lock = false;
  io.to(r.id).emit('game_over', {
    solo: !!r.solo, loser, winner: r.solo ? 0 : 1 - loser,
    time: r.time.map(t => Math.max(t, 0)), stats: r.stats, last: r.last
  });
}

function start(r) {
  r.phase = 'playing'; r.turn = 0; r.lock = false; r.q = [[], []];
  r.time = [r.settings.time, r.settings.time];
  const h = r.settings.handi;
  if (h.on && h.extraOn) r.time[h.target] += h.extra;
  r.stats = [{ ok: 0, ng: 0 }, { ok: 0, ng: 0 }];
  sendRoom(r);
  io.to(r.id).emit('state', snapshot(r));
  newQuestion(r, 0);
  r.timer = setInterval(() => {
    if (r.lock) return;
    r.time[r.turn]--;
    io.to(r.id).emit('tick', { time: r.time, turn: r.turn });
    if (r.time[r.turn] <= 0) finish(r, r.turn);
  }, 1000);
}

function countdown(r) {
  r.phase = 'countdown'; sendRoom(r);
  let n = COUNTDOWN_SEC; io.to(r.id).emit('countdown', { n });
  r.cd = setInterval(() => {
    n--;
    if (n > 0) return io.to(r.id).emit('countdown', { n });
    clearInterval(r.cd); start(r);
  }, 1000);
}

io.on('connection', s => {
  const ctx = () => { const { room, idx } = s.data || {}; return { r: rooms[room], idx, room }; };

  s.on('join', ({ room, name }) => {
    if (s.data) return;
    room = String(room || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    if (!room) return s.emit('err', 'ルームIDは半角英数字で入力してください');
    const r = rooms[room] || (rooms[room] = newRoom(room, false));
    if (r.solo || r.players.length >= 2) return s.emit('err', 'このルームは満員です');
    const idx = r.players.length;
    r.players.push(s.id); r.names[idx] = cleanName(name) || `${idx + 1}P`;
    
    // 【修正箇所2】readyの初期化のみ。phaseの強制上書きを解除
    r.ready = [false, false];
    
    s.join(room); s.data = { room, idx };
    s.emit('joined', { idx }); sendRoom(r);
  });

  s.on('solo', ({ name } = {}) => {
    if (s.data) return;
    const id = 'solo' + s.id.replace(/[^a-z0-9]/gi, '');
    const r = rooms[id] = newRoom(id, true);
    r.players.push(s.id); r.names[0] = cleanName(name) || 'あなた';
    s.join(id); s.data = { room: id, idx: 0 };
    s.emit('joined', { idx: 0 }); sendRoom(r);
  });

  s.on('settings', v => {
    const { r, idx } = ctx();
    if (!r || idx !== 0 || !['waiting', 'lobby'].includes(r.phase)) return;
    r.settings = cleanSettings(v || {}, r.solo); r.ready = [false, false]; sendRoom(r);
  });

  s.on('ready', on => {
    const { r, idx } = ctx();
    if (!r || r.phase !== 'lobby') return;
    r.ready[idx] = !!on; sendRoom(r);
    if (r.solo ? r.ready[0] : (r.ready[0] && r.ready[1])) countdown(r);
  });

  s.on('rematch', () => {
    const { r } = ctx();
    if (!r || r.phase !== 'done') return;
    r.phase = 'lobby'; r.ready = [false, false]; sendRoom(r);
  });

  s.on('typing', filled => {
    const { r, idx, room } = ctx(); if (!r) return;
    s.to(room).emit('typing', { player: idx, filled: Array.isArray(filled) ? filled.slice(0, 5).map(Boolean) : [] });
  });

  s.on('submit', answers => {
    const { r, idx, room } = ctx();
    if (!r || r.phase !== 'playing' || r.lock || r.turn !== idx || !Array.isArray(answers)) return;
    const given = r.q[idx].map((_, i) => Number(String(answers[i]).normalize('NFKC')));
    const results = r.q[idx].map((id, i) => given[i] === id);
    const wrong = results.filter(ok => !ok).length;
    if (wrong === 0) {
      r.stats[idx].ok++;
      const bonus = r.settings.bonusOn ? r.settings.bonus : 0;
      r.time[idx] += bonus;
      io.to(room).emit('answer_result', { player: idx, ok: true, ids: r.q[idx], bonus });
      if (!r.solo) r.turn = 1 - idx;
      newQuestion(r, r.turn);
      io.to(room).emit('tick', { time: r.time, turn: r.turn });
    } else {
      r.stats[idx].ng++;
      const penalty = r.settings.penalty;
      r.time[idx] -= penalty; r.lock = true;
      r.last = { player: idx, ids: r.q[idx], kind: 'wrong', given, results };
      io.to(room).emit('answer_result', { player: idx, ok: false, wrong, penalty, results, ids: r.q[idx], given });
      io.to(room).emit('tick', { time: r.time, turn: r.turn });
      setTimeout(() => {
        if (rooms[room] !== r || r.phase !== 'playing') return;
        if (r.time[idx] <= 0) return finish(r, idx);
        r.lock = false; newQuestion(r, idx);
      }, REVEAL_MS);
    }
  });

  s.on('disconnect', () => {
    const { r, idx, room } = ctx(); if (!r || !r.players.includes(s.id)) return;
    if (idx === 1 && ['waiting', 'lobby'].includes(r.phase)) {
      r.players.pop(); r.names.pop(); r.ready = [false, false]; r.phase = 'lobby'; return sendRoom(r);
    }
    clearInterval(r.timer); clearInterval(r.cd);
    io.to(room).emit('opponent_left'); delete rooms[room];
  });
});

srv.listen(process.env.PORT || 3000, () => console.log('http://localhost:3000'));
