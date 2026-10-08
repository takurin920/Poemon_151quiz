const express = require('express'), http = require('http'), { Server } = require('socket.io');
const app = express(); app.use(express.static(__dirname + '/public', { etag: false, setHeaders: res => res.set('Cache-Control', 'no-store') })); // 古い画面が残らないように
const srv = http.createServer(app), io = new Server(srv);

const VER = 'phase1-step1.1';
app.get('/version', (q, res) => res.json({ ver: VER })); // 動作中のサーバーの版を確認用
const REVEAL_MS = 2500, COUNTDOWN_SEC = 5, rooms = {};
const clamp = (v, a, b, d) => { v = parseInt(v, 10); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
const cleanName = n => String(n || '').replace(/[<>&"'`]/g, '').trim().slice(0, 10);

const bool = (v, d) => v === undefined ? d : !!v;
const cleanRegions = g => {
  if (!g) return { kanto: true, johto: true };
  const kanto = !!g.kanto, johto = !!g.johto;
  return kanto || johto ? { kanto, johto } : { kanto: true, johto: false }; // 地方は最低1つ
};
const cleanPlayer = p => {
  p = p || {};
  return {
    time: clamp(p.time, 30, 600, 120), penalty: clamp(p.penalty, 0, 120, 10),
    bonusOn: bool(p.bonusOn, true), bonus: clamp(p.bonus, 1, 60, 5),
    count: clamp(p.count, 1, 5, 3), showDigit: bool(p.showDigit, false),
    regions: cleanRegions(p.regions)
  };
};
const cleanSettings = s => {
  s = s || {}; const b = cleanPlayer(s);
  return {
    time: b.time, penalty: b.penalty, bonusOn: b.bonusOn, bonus: b.bonus, regions: b.regions, // 簡易（共通）
    advOn: bool(s.advOn, false),                                                               // 詳細モード
    p1: cleanPlayer(s.p1), p2: cleanPlayer(s.p2)                                               // 詳細（個別）
  };
};
// プレイヤーpに適用される実効設定（簡易なら共通値、詳細なら個別値）
const eff = (r, p) => {
  const S = r.settings;
  const e = S.advOn ? { ...S[p ? 'p2' : 'p1'] }
    : { time: S.time, penalty: S.penalty, bonusOn: S.bonusOn, bonus: S.bonus, count: 3, showDigit: false, regions: S.regions };
  if (r.solo) e.bonusOn = false; // ひとり練習は時間加算なし
  return e;
};
const pool = g => { const a = []; if (g.kanto) for (let i = 1; i <= 151; i++) a.push(i); if (g.johto) for (let i = 152; i <= 251; i++) a.push(i); return a; };
const pick = (p, n) => { const a = p.slice(), out = []; while (out.length < n) out.push(a.splice(Math.floor(Math.random() * a.length), 1)[0]); return out; };

const roomState = r => ({ id: r.id, solo: !!r.solo, phase: r.phase, names: r.names, settings: r.settings, ready: r.ready, count: r.players.length });
const sendRoom = r => io.to(r.id).emit('room_state', roomState(r));
const snapshot = r => ({ solo: !!r.solo, settings: r.settings, time: r.time, turn: r.turn, q: r.q, names: r.names, started: r.phase === 'playing' });
const newRoom = (id, solo) => ({
  id, solo, players: [], names: [], phase: solo ? 'lobby' : 'waiting', ready: [false, false],
  settings: cleanSettings({}), time: [0, 0], turn: 0, q: [[], []], lock: false, stats: [], last: null
});

function newQuestion(r, p) {
  const e = eff(r, p);
  r.q[p] = pick(pool(e.regions), e.count);
  const hintOn = e.showDigit;
  r.last = { player: p, ids: r.q[p], kind: 'pending' };
  io.to(r.id).emit('question_updated', { player: p, ids: r.q[p], hint: hintOn ? r.q[p].map(i => i % 10) : null });
}

function finish(r, loser) {
  clearInterval(r.timer); r.phase = 'done'; r.lock = false;
  io.to(r.id).emit('game_over', {
    solo: !!r.solo, loser, winner: r.solo ? 0 : 1 - loser,
    time: r.time.map(t => Math.max(t, 0)), stats: r.stats, last: r.last // lastは最終問題（結果画面で表示）
  });
}

function start(r) {
  r.phase = 'playing'; r.turn = 0; r.lock = false; r.q = [[], []];
  r.time = [eff(r, 0).time, eff(r, 1).time];
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

function countdown(r) { // 開始前カウントダウン
  r.phase = 'countdown'; sendRoom(r);
  let n = COUNTDOWN_SEC; io.to(r.id).emit('countdown', { n });
  r.cd = setInterval(() => {
    n--;
    if (n > 0) return io.to(r.id).emit('countdown', { n });
    clearInterval(r.cd); start(r);
  }, 1000);
}

io.on('connection', s => {
  s.emit('hello', { ver: VER });
  const ctx = () => { const { room, idx } = s.data || {}; return { r: rooms[room], idx, room }; };

  s.on('join', ({ room, name }) => {
    if (s.data && s.data.room) return; // すでに入室済みなら無視（socket.dataは最初から{}のため room で判定）
    // 全角→半角、大文字→小文字、英数字以外は除去（別部屋になるのを防ぐ）
    room = String(room || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    if (!room) return s.emit('err', 'ルームIDは半角英数字で入力してください');
    const r = rooms[room] || (rooms[room] = newRoom(room, false));
    if (r.solo || r.players.length >= 2) return s.emit('err', 'このルームは満員です');
    const idx = r.players.length;
    r.players.push(s.id); r.names[idx] = cleanName(name) || `${idx + 1}P`;
    r.ready = [false, false]; r.phase = idx === 1 ? 'lobby' : 'waiting';
    s.join(room); s.data = { room, idx };
    s.emit('joined', { idx }); sendRoom(r);
  });

  s.on('solo', ({ name } = {}) => { // ひとり練習モード（ルームID不要）
    if (s.data && s.data.room) return; // すでに入室済みなら無視（socket.dataは最初から{}のため room で判定）
    const id = 'solo' + s.id.replace(/[^a-z0-9]/gi, '');
    const r = rooms[id] = newRoom(id, true);
    r.players.push(s.id); r.names[0] = cleanName(name) || 'あなた';
    s.join(id); s.data = { room: id, idx: 0 };
    s.emit('joined', { idx: 0 }); sendRoom(r);
  });

  s.on('settings', v => {
    const { r, idx } = ctx();
    if (!r || idx !== 0 || !['waiting', 'lobby'].includes(r.phase)) return;
    r.settings = cleanSettings(v || {}); r.ready = [false, false]; sendRoom(r);
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
      const e = eff(r, idx), bonus = e.bonusOn ? e.bonus : 0;
      r.time[idx] += bonus;
      io.to(room).emit('answer_result', { player: idx, ok: true, ids: r.q[idx], bonus });
      if (!r.solo) r.turn = 1 - idx;   // 対戦は手番交代、ひとり練習は同じ人が続ける
      newQuestion(r, r.turn);
      io.to(room).emit('tick', { time: r.time, turn: r.turn });
    } else {
      r.stats[idx].ng++;
      const penalty = eff(r, idx).penalty;
      r.time[idx] -= penalty; r.lock = true;
      r.last = { player: idx, ids: r.q[idx], kind: 'wrong', given, results };
      io.to(room).emit('answer_result', { player: idx, ok: false, wrong, penalty, results, ids: r.q[idx], given });
      io.to(room).emit('tick', { time: r.time, turn: r.turn });
      setTimeout(() => { // 結果を見せたあと、終了 or 入れ替え
        if (rooms[room] !== r || r.phase !== 'playing') return;
        if (r.time[idx] <= 0) return finish(r, idx);
        r.lock = false; newQuestion(r, idx);
      }, REVEAL_MS);
    }
  });

  s.on('disconnect', () => {
    const { r, idx, room } = ctx(); if (!r || !r.players.includes(s.id)) return;
    if (idx === 1 && ['waiting', 'lobby'].includes(r.phase)) { // ゲスト退出：ホストは待機に戻る
      r.players.pop(); r.names.pop(); r.ready = [false, false]; r.phase = 'waiting'; return sendRoom(r);
    }
    clearInterval(r.timer); clearInterval(r.cd);
    io.to(room).emit('opponent_left'); delete rooms[room];
  });
});

srv.listen(process.env.PORT || 3000, () => console.log('http://localhost:3000'));
