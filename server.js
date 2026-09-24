const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const GAME_FILE = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(GAME_FILE, (err, data) => {
      if (err) {
        res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'});
        res.end('index.html을 찾을 수 없습니다.');
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(data);
    });
    return;
  }
  res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
  res.end('Not Found');
});

const wss = new WebSocket.Server({ server });
const players = new Map();
const challenges = new Map(); // targetId -> {fromId, expiresAt}
const duels = new Map();      // duelId -> duel
const usedRoomSlots = new Set();
let nextId = 1;
let nextDuelId = 1;

const SWORD_DAMAGE = {1:1, 2:3, 3:5, 4:10, 5:25, 6:50};
const ARMOR_REDUCTION = {0:1, 1:0.9, 2:0.7, 3:0.5, 4:0.2, 5:0.1};

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj, predicate = () => true) {
  const msg = JSON.stringify(obj);
  for (const p of players.values()) {
    if (predicate(p) && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}
function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    x: p.x, y: p.y, z: p.z,
    rotationY: p.rotationY,
    hp: p.hp,
    gear: p.loadout.gear,
    swordTier: p.loadout.swordTier,
    armorTier: p.loadout.armorTier,
    ignitium: p.loadout.ignitium,
    incineratorUpgraded: !!p.loadout.incineratorUpgraded,
    dueling: !!p.duelId,
    shieldUntil: p.shieldUntil
  };
}
function world4Players() {
  return [...players.values()].filter(p => p.world === 4).map(publicPlayer);
}
function broadcastWorld4() {
  const list = world4Players();
  broadcast({type:'players', players:list}, p => p.world === 4);
}
function sanitizeNumber(v, fallback=0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-100000, Math.min(100000, n)) : fallback;
}
function sanitizeLoadout(l) {
  l = l || {};
  return {
    gear: ['normal','sword','incinerator','ignitium'].includes(l.gear) ? l.gear : 'normal',
    swordTier: Math.max(0, Math.min(6, Math.floor(Number(l.swordTier)||0))),
    armorTier: Math.max(0, Math.min(5, Math.floor(Number(l.armorTier)||0))),
    ignitium: Array.isArray(l.ignitium) ? l.ignitium.slice(0,4).map(Boolean) : [false,false,false,false],
    incinerator: !!l.incinerator,
    incineratorUpgraded: !!l.incineratorUpgraded
  };
}
function distance(a,b) { return Math.hypot(a.x-b.x, a.z-b.z); }
function duelPair(p) {
  if (!p.duelId) return null;
  const d = duels.get(p.duelId);
  if (!d) return null;
  return d.a === p.id ? players.get(d.b) : players.get(d.a);
}
function getFreeRoomSlot() {
  for (let i=0;i<100;i++) if (!usedRoomSlots.has(i)) { usedRoomSlots.add(i); return i; }
  return null;
}
function endDuel(duel, winnerId, reason) {
  if (!duel || !duels.has(duel.id)) return;
  duels.delete(duel.id);
  usedRoomSlots.delete(duel.roomSlot);
  const a = players.get(duel.a), b = players.get(duel.b);
  if (a) { a.duelId = null; const rp=duel.returnPos[a.id]; if(rp){a.x=rp.x;a.y=2.6;a.z=rp.z;} a.shieldUntil=0; }
  if (b) { b.duelId = null; const rp=duel.returnPos[b.id]; if(rp){b.x=rp.x;b.y=2.6;b.z=rp.z;} b.shieldUntil=0; }
  if (a) send(a.ws, {type:'duelEnd', win:winnerId===a.id, reason:reason||'', returnPos:a?duel.returnPos[a.id]:null});
  if (b) send(b.ws, {type:'duelEnd', win:winnerId===b.id, reason:reason||'', returnPos:b?duel.returnPos[b.id]:null});
  broadcastWorld4();
}
function startDuel(a,b) {
  const roomSlot = getFreeRoomSlot();
  if (roomSlot === null) {
    send(a.ws,{type:'serverMessage',text:'대결 경기장이 가득 찼습니다.'});
    send(b.ws,{type:'serverMessage',text:'대결 경기장이 가득 찼습니다.'});
    return;
  }
  const id = String(nextDuelId++);
  const duel = {id, a:a.id, b:b.id, roomSlot, lastAttack:new Map(), returnPos:{
    [a.id]:{x:a.x,y:a.y,z:a.z},
    [b.id]:{x:b.x,y:b.y,z:b.z}
  }};
  duels.set(id, duel); a.duelId=id; b.duelId=id;
  const bx = 1500 + roomSlot*25, bz=1500;
  a.x=bx+10; a.y=2.6; a.z=bz+13; a.rotationY=0; a.hp=100;
  b.x=bx+10; b.y=2.6; b.z=bz+6; b.rotationY=Math.PI; b.hp=100;
  a.shieldUntil=0; b.shieldUntil=0;
  send(a.ws,{type:'duelStart',duelId:id,role:'a',opponentId:b.id,opponentName:b.name,roomSlot});
  send(b.ws,{type:'duelStart',duelId:id,role:'b',opponentId:a.id,opponentName:a.name,roomSlot});
  broadcastWorld4();
}
function handleChallenge(ws,p,msg) {
  const target=players.get(String(msg.targetId));
  if (!target || target.world!==4 || target.id===p.id) return;
  if (p.duelId || target.duelId) { send(ws,{type:'serverMessage',text:'이미 대결 중인 플레이어입니다.'}); return; }
  if (distance(p,target)>12) { send(ws,{type:'serverMessage',text:'상대가 너무 멉니다. 12블록 안에서 신청하세요.'}); return; }
  if ([...challenges.values()].some(c=>c.fromId===p.id)) return;
  challenges.set(target.id,{fromId:p.id,expiresAt:Date.now()+15000});
  send(target.ws,{type:'challengeReceived',fromId:p.id,fromName:p.name});
  send(ws,{type:'challengeSent',toName:target.name});
}
function handleAccept(ws,p) {
  const c=challenges.get(p.id);
  if (!c || c.expiresAt<Date.now()) { challenges.delete(p.id); return; }
  const from=players.get(c.fromId); challenges.delete(p.id);
  if (!from || from.world!==4 || p.world!==4 || from.duelId || p.duelId) return;
  if (distance(from,p)>14) { send(ws,{type:'serverMessage',text:'신청자가 너무 멀어져 대결을 시작할 수 없습니다.'}); return; }
  startDuel(from,p);
}
function handleReject(ws,p) {
  const c=challenges.get(p.id); if(!c)return; challenges.delete(p.id);
  const from=players.get(c.fromId); if(from) send(from.ws,{type:'challengeRejected',fromName:p.name});
}
function handleAttack(p,msg) {
  if (!p.duelId) return;
  const d=duels.get(p.duelId); if(!d)return;
  const targetId = String(msg.targetId);
  const opponent = players.get(targetId);
  if (!opponent || (d.a!==p.id && d.b!==p.id) || (d.a!==opponent.id && d.b!==opponent.id)) return;
  if (opponent.id===p.id || opponent.duelId!==p.duelId) return;
  const now=Date.now(); const last=d.lastAttack.get(p.id)||0;
  if(now-last<350)return;
  d.lastAttack.set(p.id,now);
  if(distance(p,opponent)>5.6)return;
  if(opponent.shieldUntil>Date.now()){send(p.ws,{type:'shieldBlocked',targetId:opponent.id});return;}
  let damage=0,crit=false;
  if(msg.weapon==='incinerator' && p.loadout.incinerator){
    const upgraded=!!p.loadout.incineratorUpgraded;
    if(upgraded){ attackKind='wave'; crit=true; damage=500; }
    else { attackKind=msg.attackKind==='wave'?'wave':'melee'; crit=attackKind==='wave'; damage=attackKind==='wave'?150:100; }
  } else if(msg.weapon==='sword' && p.loadout.gear==='sword') {
    const tier=Math.max(1,Math.min(6,Math.floor(Number(msg.swordTier)||p.loadout.swordTier)));
    damage=SWORD_DAMAGE[tier]||0;
  } else return;
  const pieces=p.loadout.ignitium.filter(Boolean).length;
  const reduction=pieces>=4?0.01:(pieces>0?0.10:(ARMOR_REDUCTION[p.loadout.armorTier]||1));
  const finalDamage=damage*reduction;
  opponent.hp=Math.max(0,opponent.hp-finalDamage);
  broadcast({type:'pvpDamage',attackerId:p.id,targetId:opponent.id,hp:opponent.hp,damage:finalDamage,crit,attackKind,attackerX:p.x,attackerY:p.y,attackerZ:p.z,attackerRotationY:Number(msg.rotationY)||p.rotationY,incineratorUpgraded:!!p.loadout.incineratorUpgraded}, q=>q.world===4 && (q.id===p.id||q.id===opponent.id));
  if(opponent.hp<=0) endDuel(d,p.id,`${p.name} 승리`);
}
function handleMessage(ws,p,msg) {
  if(!msg || typeof msg.type!=='string')return;
  if(msg.type==='joinWorld4'){
    p.world=4;p.x=sanitizeNumber(msg.x,1100);p.y=2.6;p.z=sanitizeNumber(msg.z,1100);p.rotationY=sanitizeNumber(msg.rotationY,0);p.hp=100;p.loadout=sanitizeLoadout(msg.loadout);broadcastWorld4();return;
  }
  if(msg.type==='leaveWorld4'){
    if(p.duelId){const d=duels.get(p.duelId);if(d)endDuel(d,duelPair(p)?.id,'상대가 월드4를 나갔습니다.');}
    p.world=1;p.duelId=null;p.shieldUntil=0;broadcastWorld4();return;
  }
  if(msg.type==='state' && p.world===4){
    p.x=sanitizeNumber(msg.x,p.x);p.y=2.6;p.z=sanitizeNumber(msg.z,p.z);p.rotationY=sanitizeNumber(msg.rotationY,p.rotationY);p.hp=Math.max(0,Math.min(100,sanitizeNumber(msg.hp,p.hp)));p.loadout=sanitizeLoadout(msg.loadout);p.shieldUntil=Math.max(0,sanitizeNumber(msg.shieldUntil,p.shieldUntil));broadcastWorld4();return;
  }
  if(msg.type==='challenge'){handleChallenge(ws,p,msg);return;}
  if(msg.type==='challengeAccept'){handleAccept(ws,p);return;}
  if(msg.type==='challengeReject'){handleReject(ws,p);return;}
  if(msg.type==='pvpAttack'){handleAttack(p,msg);return;}
  if(msg.type==='shieldStart' && p.duelId){p.shieldUntil=Date.now()+5000;return;}
}

wss.on('connection',(ws,req)=>{
  const id=String(nextId++);
  const p={id,name:`플레이어-${id}`,ws,world:1,x:1100,y:2.6,z:1100,rotationY:0,hp:100,loadout:sanitizeLoadout(),duelId:null,shieldUntil:0};
  players.set(id,p);
  send(ws,{type:'welcome',id,name:p.name});
  ws.on('message',data=>{try{handleMessage(ws,p,JSON.parse(data.toString()));}catch(e){console.error('message error',e);}});
  ws.on('close',()=>{
    if(p.duelId){const d=duels.get(p.duelId);if(d){const opponent=duelPair(p);endDuel(d,opponent?opponent.id:null,'상대가 접속을 종료했습니다.');}}
    challenges.delete(p.id);
    for(const [target,c] of challenges){if(c.fromId===p.id)challenges.delete(target);}
    players.delete(p.id);broadcastWorld4();
  });
});

setInterval(()=>{
  const now=Date.now();
  for(const [target,c] of challenges){if(c.expiresAt<now){challenges.delete(target);const t=players.get(target);if(t)send(t.ws,{type:'serverMessage',text:'대결 신청이 만료되었습니다.'});}}
  broadcastWorld4();
},100);

server.listen(PORT,'0.0.0.0',()=>console.log(`Pixel Voxel World 멀티 서버: http://localhost:${PORT}`));
