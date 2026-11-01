/* One AI answer streaming to one browser tab, over four transports.

   The left of the picture is a sequence diagram: the browser's lifeline on the left,
   the server's on the right, time running down. Every request, response, frame and
   event is an arrow, drawn as it crosses the network, so you can watch how each
   transport opens, carries tokens, notices a drop and comes back. A corporate proxy
   (for the proxy situation) and Envoy (for gRPC-Web) get lifelines of their own.

   The right shows what the user sees, one square per token (red when a token arrives
   twice), the connection's state with the requests this tab has sent, and the load the
   whole fleet would put on the load balancer at that situation's number of streams.
   A checklist along the bottom ticks the four constraints.

   The model (run()) builds the list of messages for one answer, deterministic;
   js/sim-player.js supplies the controls and scoreboard. */

import { tx } from '../../js/i18n.js';
import { css } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';
import { icon } from '../../js/sim-draw.js';

export const SETUPS = ['ws', 'sse', 'poll', 'grpc'];
export const SITUATIONS = ['calm', 'drop', 'proxy', 'peak'];

export const LAT = 0.075;          // one way across a mobile network: 150 ms round trip
export const SERVER = 0.02;        // seconds the server takes to answer a request
export const RATE = 30;            // tokens a second from the model
export const TOKENS = 180;         // tokens in this answer
export const TTFT = 0.35;          // seconds from prompt to first token, on the server
export const DROP = [3, 4.8];      // the phone switches networks: no network for 1.8 s
export const RETRY = 1;            // SSE retry:, and the poll / gRPC retry wait
export const BACKOFF = [0.5, 1, 2, 4];   // B: the reconnect code's waits
export const STREAMS = { calm: 1200, drop: 1200, proxy: 1200, peak: 20000 };
export const ANSWER = 13;          // seconds an average answer (about 400 tokens) streams
export const LIMIT = 10000;        // requests a second the load balancer and auth have spare
export const RESUME = 3;           // after a drop, tokens flow again within 3 s of the network
export const END = 8;

const DONE = 1 / RATE;

/* Run one situation through one setup. Pure; memoised, because the scoreboard asks often. */
const memo = new Map();
export function run(setup, situation) {
  const k = `${setup}:${situation}`;
  if (!memo.has(k)) memo.set(k, simulate(setup, situation));
  return memo.get(k);
}

function simulate(setup, situation) {
  const drop = situation === 'drop', proxy = situation === 'proxy';
  const down = t => drop && t >= DROP[0] && t < DROP[1];
  const msgs = [];      // { t0, t1, dir: 'up' | 'down', kind, label, lost, stop }
  const recv = [];      // { seq, t }
  const conn = [];      // the browser's connection over time: { t0, t1, state }
  let requests = 0;
  // Send one message across the network. Lost if the network is down at any point of its flight.
  const send = (t0, dir, kind, label, extra = {}) => {
    const lost = drop && t0 < DROP[1] && t0 + LAT > DROP[0];
    const m = { t0, t1: t0 + LAT, dir, kind, label, lost, ...extra };
    if (kind === 'req') requests++;
    msgs.push(m);
    return lost ? null : m.t1;
  };
  const gen = (i, start) => start + TTFT + (i - 1) / RATE;

  /* The server streams tokens from+1.. to an open connection, starting at `open`, until
     the drop kills the connection. label(i) names each message. Returns the last token
     the browser received, the time it did, and when the stream was cut (or Infinity). */
  function stream(open, from, start, label) {
    let last = from, lastAt = open, k = 0;
    for (let i = from + 1; i <= TOKENS; i++) {
      const at = Math.max(gen(i, start), open + 0.004 * k++);
      if (drop && at >= DROP[0] && open < DROP[0]) return { last, lastAt, cut: DROP[0] };
      const t1 = send(at, 'down', 'token', label(i), { seq: i });
      if (t1 !== null) { recv.push({ seq: i, t: t1 }); last = i; lastAt = t1; }
    }
    return { last, lastAt, cut: Infinity };
  }

  if (setup === 'sse') {
    send(0, 'up', 'req', 'POST /messages · {prompt}');
    const start = LAT;
    let at = send(LAT + SERVER, 'down', 'resp', '201 · {id: "m7"}');
    let cursor = 0, first = true;
    conn.push({ t0: 0, t1: at, state: 'opening' });
    while (cursor < TOKENS && at < END) {
      const label = first ? 'GET /m7/stream · Accept: text/event-stream' : `GET /m7/stream · Last-Event-ID: ${cursor}`;
      if (down(at)) { send(at, 'up', 'req', label, { stop: true }); conn.push({ t0: at, t1: at + RETRY, state: 'retry' }); at += RETRY; continue; }
      const got = send(at, 'up', 'req', label);
      const open = got + SERVER;
      const head = send(open, 'down', 'resp', first ? '200 · text/event-stream · retry: 1000' : '200 · text/event-stream');
      const s = stream(open + 0.004, cursor, start, i => `id: ${i} · data: "…"`);
      conn.push({ t0: at, t1: Math.min(s.cut, END), state: 'open' });
      first = false;
      if (s.cut < Infinity) { cursor = s.last; conn.push({ t0: s.cut, t1: s.cut + RETRY, state: 'retry' }); at = s.cut + RETRY; continue; }
      cursor = s.last;
      send(gen(TOKENS, start) + DONE, 'down', 'ctl', 'event: done → close()');
      void head;
    }
  }

  if (setup === 'poll') {
    send(0, 'up', 'req', 'POST /messages · {prompt}');
    const start = LAT;
    let at = send(LAT + SERVER, 'down', 'resp', '201 · {id: "m7"}');
    conn.push({ t0: 0, t1: at, state: 'opening' });
    let cursor = 0, guard = 0;
    while (cursor < TOKENS && at < END && guard++ < 500) {
      const label = `GET /poll?after=${cursor}`;
      if (down(at)) { send(at, 'up', 'req', label, { stop: true }); conn.push({ t0: at, t1: at + RETRY, state: 'retry' }); at += RETRY; continue; }
      const got = send(at, 'up', 'req', label);
      if (got === null) { conn.push({ t0: at, t1: DROP[0] + RETRY, state: 'retry' }); at = DROP[0] + RETRY; continue; }
      const reply = Math.max(got + SERVER, gen(cursor + 1, start));
      if (drop && reply >= DROP[0] && got < DROP[0]) { conn.push({ t0: at, t1: DROP[0], state: 'open' }, { t0: DROP[0], t1: DROP[0] + RETRY, state: 'retry' }); at = DROP[0] + RETRY; continue; }
      let to = cursor;
      while (to < TOKENS && gen(to + 1, start) <= reply) to++;
      const done = to === TOKENS;
      const t1 = send(reply, 'down', 'resp', `200 · [${cursor + 1}–${to}]${done ? ' · done' : ''}`, { seq: to, batch: [cursor + 1, to] });
      conn.push({ t0: at, t1: t1 ?? DROP[0], state: 'open' });
      if (t1 === null) { conn.push({ t0: DROP[0], t1: DROP[0] + RETRY, state: 'retry' }); at = DROP[0] + RETRY; continue; }
      for (let i = cursor + 1; i <= to; i++) recv.push({ seq: i, t: t1 });
      cursor = to;
      at = t1 + 0.002;
    }
  }

  if (setup === 'ws') {
    let at = 0, first = true, cursor = 0, start = null, tries = 0;
    while (cursor < TOKENS && at < END) {
      const label = 'GET /chat · Upgrade: websocket';
      if (proxy) {
        send(at, 'up', 'req', label, { stop: 'proxy' });
        const back = at + LAT / 2 + SERVER;
        msgs.push({ t0: back, t1: back + LAT / 2, dir: 'down', kind: 'fail', label: '403 · Upgrade refused', from: 'proxy' });
        const wait = BACKOFF[Math.min(tries++, BACKOFF.length - 1)];
        conn.push({ t0: at, t1: back + LAT / 2, state: 'opening' }, { t0: back + LAT / 2, t1: back + LAT / 2 + wait, state: 'blocked' });
        at = back + LAT / 2 + wait;
        continue;
      }
      if (down(at)) {
        send(at, 'up', 'req', label, { stop: true });
        const wait = BACKOFF[Math.min(tries++, BACKOFF.length - 1)];
        conn.push({ t0: at, t1: at + wait, state: 'retry' });
        at += wait;
        continue;
      }
      const got = send(at, 'up', 'req', label);
      const back = send(got + SERVER, 'down', 'ctl', '101 Switching Protocols');
      const frame = first ? 'frame ↑ {"prompt": "…"}' : `frame ↑ {"resume": "m7", "after": ${cursor}}`;
      const sent = send(back, 'up', 'frame', frame);
      if (first) start = sent;
      const s = stream(sent + SERVER, cursor, start, i => `frame ↓ {"seq": ${i}, "t": "…"}`);
      conn.push({ t0: at, t1: Math.min(s.cut, END), state: 'open' });
      first = false;
      cursor = s.last;
      if (s.cut < Infinity) {
        tries = 0;
        const wait = BACKOFF[tries++];
        conn.push({ t0: s.cut, t1: s.cut + wait, state: 'retry' });
        at = s.cut + wait;
        continue;
      }
      send(gen(TOKENS, start) + DONE, 'down', 'ctl', 'frame ↓ {"done": true}');
    }
  }

  if (setup === 'grpc') {
    let at = 0, start = LAT, first = true;
    while (at < END) {
      const label = 'POST /chat.Chat/Answer · grpc-web-text';
      if (down(at)) { send(at, 'up', 'req', label, { stop: true }); conn.push({ t0: at, t1: at + RETRY, state: 'retry' }); at += RETRY; continue; }
      const got = send(at, 'up', 'req', label);
      if (first) start = got;
      const open = got + SERVER;
      send(open, 'down', 'resp', '200 · application/grpc-web-text');
      // No cursor in the call: every call streams the message from its first token.
      const s = stream(open + 0.004, 0, start, i => `msg [len][token ${i}]`);
      conn.push({ t0: at, t1: Math.min(s.cut, END), state: 'open' });
      first = false;
      if (s.cut < Infinity) {
        msgs.push({ t0: s.cut, t1: s.cut, dir: 'down', kind: 'fail', label: 'UNAVAILABLE', local: true });
        conn.push({ t0: s.cut, t1: s.cut + RETRY, state: 'retry' });
        at = s.cut + RETRY;
        continue;
      }
      send(Math.max(gen(TOKENS, start), s.lastAt - LAT) + DONE, 'down', 'ctl', 'trailers · grpc-status: 0');
      break;
    }
  }

  // The facts.
  msgs.sort((a, b) => a.t0 - b.t0);
  recv.sort((a, b) => a.t - b.t);
  const counts = new Array(TOKENS + 1).fill(0);
  for (const x of recv) counts[x.seq]++;
  const missing = counts.slice(1).filter(c => c === 0).length;
  const dupes = counts.slice(1).reduce((a, c) => a + Math.max(0, c - 1), 0);
  const afterDrop = drop ? recv.find(x => x.t >= DROP[1]) : null;
  const resumeGap = drop ? (afterDrop ? afterDrop.t - DROP[1] : Infinity) : 0;
  const lastBefore = drop ? Math.max(0, ...recv.filter(x => x.t < DROP[1]).map(x => x.seq)) : 0;
  const polls = msgs.filter(m => m.kind === 'req' && m.label.startsWith('GET /poll') && !m.stop);
  const span = polls.length > 1 ? polls[polls.length - 1].t0 - polls[0].t0 : 1;
  const perStream = setup === 'poll' ? polls.length / span : (setup === 'sse' ? 2 : 1) / ANSWER;
  const lb = STREAMS[situation] * perStream;
  const checks = {
    full: missing === 0,
    clean: missing === 0 && dupes === 0 && resumeGap <= RESUME,
    load: lb <= LIMIT,
    infra: setup !== 'grpc',
  };
  const r = {
    setup, situation, end: END, msgs, recv, conn, requests, missing, dupes, resumeGap, lastBefore,
    perStream, lb, checks, ok: Object.values(checks).every(Boolean),
    firstToken: recv.length ? recv[0].t : Infinity,
  };
  r.steps = story(r);
  r.summary = summary(r);
  return r;
}

export const survives = (setup, situation) => run(setup, situation).ok;

const secs = x => (x < 1 ? `${Math.round(x * 1000)} ms` : `${x < 10 ? x.toFixed(1) : Math.round(x)} s`);
export const count = n => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

const LABEL = {
  ws: { en: 'WebSockets', vi: 'WebSockets' },
  sse: { en: 'Server-Sent Events', vi: 'Server-Sent Events' },
  poll: { en: 'Long polling', vi: 'Long polling' },
  grpc: { en: 'gRPC-Web streaming', vi: 'gRPC-Web streaming' },
};

const SITUATION = {
  calm: { en: 'One answer, steady Wi-Fi', vi: 'Một câu trả lời, Wi-Fi ổn định' },
  drop: { en: 'Phone switches networks', vi: 'Điện thoại đổi mạng' },
  proxy: { en: 'Behind a corporate proxy', vi: 'Sau proxy công ty' },
  peak: { en: 'Launch peak: 20,000 streams', vi: 'Đỉnh ra mắt: 20.000 stream' },
};

const HOW = {
  poll: { en: 'A: long polling. The browser asks "anything after token n?". The server holds the request until there is, answers with what it has, and the browser asks again at once.', vi: 'A: long polling. Trình duyệt hỏi "có gì sau token n không?". Server giữ request tới khi có, trả về những gì đang có, và trình duyệt hỏi lại ngay.' },
  ws: { en: 'B: WebSockets. One HTTP request is upgraded into a two-way socket. The prompt goes up as a frame and tokens come down as frames. On a drop, your own code reconnects and asks to resume after the last token it has.', vi: 'B: WebSockets. Một request HTTP được nâng cấp (upgrade) thành một socket hai chiều. Prompt đi lên dưới dạng frame, token đi xuống dưới dạng frame. Khi rớt mạng, code của chính bạn kết nối lại và xin tiếp tục sau token cuối cùng đã có.' },
  sse: { en: 'C: Server-Sent Events. The prompt is an ordinary POST. Then one GET whose response never ends: the server writes each token as an event with an id. EventSource reconnects by itself and sends the last id it saw.', vi: 'C: Server-Sent Events. Prompt là một POST bình thường. Sau đó là một GET có response không bao giờ kết thúc: server ghi mỗi token thành một event có id. EventSource tự kết nối lại và gửi id cuối cùng nó đã thấy.' },
  grpc: { en: 'D: gRPC server streaming. Browsers cannot make real gRPC calls, so the call goes out as gRPC-Web, and an Envoy proxy, new to your stack, translates it to gRPC over HTTP/2. Tokens come back as length-prefixed messages.', vi: 'D: gRPC server streaming. Trình duyệt không gọi gRPC thật được, nên lời gọi đi dưới dạng gRPC-Web, và một proxy Envoy, mới với hệ thống của bạn, dịch nó sang gRPC trên HTTP/2. Token quay về dưới dạng các message có tiền tố độ dài.' },
};

function story(r) {
  const { setup, situation } = r;
  const m = [];
  const add = (t0, t1, dur, tone, en, vi) => { if (t1 > t0 || !m.length) m.push({ t0, t1, dur, tone, say: { en, vi } }); };
  add(0, 0, 2.5, null, HOW[setup].en, HOW[setup].vi);
  const proxy = situation === 'proxy', drop = situation === 'drop';
  const via = proxy ? [' The company’s proxy passes it: it is ordinary HTTPS.', ' Proxy của công ty cho nó đi qua: đó là HTTPS bình thường.'] : ['', ''];
  const pollRate = r.perStream.toFixed(1).replace('.0', '');

  if (setup === 'ws' && proxy) {
    add(0, 0.6, 6, 'bad', 'GET /chat with Upgrade: websocket reaches the company’s proxy, which lets ordinary HTTP through but not upgrades. It refuses, and the socket never opens.', 'GET /chat với Upgrade: websocket tới proxy của công ty, vốn cho HTTP bình thường đi qua nhưng không cho upgrade. Nó từ chối, và socket không bao giờ mở.');
    add(0.6, END, 6, 'bad', 'The reconnect code backs off, 0.5, 1, 2 then 4 seconds, and the proxy refuses every time. This user sees a spinner and no answer. Socket.IO starts every connection with long polling for exactly this reason.', 'Code kết nối lại lùi dần, 0,5, 1, 2 rồi 4 giây, và lần nào proxy cũng từ chối. Người dùng này chỉ thấy vòng xoay chờ, không có câu trả lời. Socket.IO bắt đầu mọi kết nối bằng long polling chính vì lý do này.');
    return m;
  }

  const open = {
    poll: ['POST /messages sends the prompt and gets back a message id. Then the first GET /poll?after=0, which the server holds until the first token exists.', 'POST /messages gửi prompt và nhận về id của message. Sau đó là GET /poll?after=0 đầu tiên, server giữ nó tới khi token đầu tiên xuất hiện.'],
    ws: ['GET /chat with Upgrade: websocket. The server answers 101 Switching Protocols, and from then on this connection is a socket, not HTTP. The prompt goes up as the first frame.', 'GET /chat với Upgrade: websocket. Server trả 101 Switching Protocols, và từ đó kết nối này là một socket, không còn là HTTP. Prompt đi lên trong frame đầu tiên.'],
    sse: ['POST /messages sends the prompt and gets back an id. Then GET /messages/m7/stream with Accept: text/event-stream. The server answers 200, sets retry to 1 second, and never finishes the response.', 'POST /messages gửi prompt và nhận về một id. Sau đó là GET /messages/m7/stream với Accept: text/event-stream. Server trả 200, đặt retry là 1 giây, và không bao giờ kết thúc response.'],
    grpc: ['The browser POSTs a gRPC-Web request carrying the prompt. Envoy turns it into a real gRPC call over HTTP/2, and turns the replies back into a response the browser can read.', 'Trình duyệt POST một request gRPC-Web mang prompt. Envoy biến nó thành một lời gọi gRPC thật trên HTTP/2, và biến các phản hồi thành một response mà trình duyệt đọc được.'],
  }[setup];
  add(0, 0.6, 6, null, open[0] + via[0], open[1] + via[1]);

  const flow = {
    poll: [`Each reply carries the tokens made since the last poll, about ${Math.round(RATE / r.perStream)} at a time, and each costs a full request with headers and auth: ${pollRate} requests a second from this tab alone.`, `Mỗi phản hồi mang các token tạo ra từ lần poll trước, khoảng ${Math.round(RATE / r.perStream)} token mỗi lần, và mỗi lần tốn trọn một request với header và auth: ${pollRate} request mỗi giây chỉ từ tab này.`],
    ws: ['Each token is a small frame on the open socket: no headers and no new requests.', 'Mỗi token là một frame nhỏ trên socket đang mở: không header, không request mới.'],
    sse: ['Each token is a few lines on the open response: "id: 41", "data: …", then a blank line. No new requests. The id is what makes resuming possible.', 'Mỗi token là vài dòng trên response đang mở: "id: 41", "data: …", rồi một dòng trống. Không có request mới. Chính id giúp việc tiếp tục trở nên khả thi.'],
    grpc: ['Each token is a protobuf message with a 5-byte length prefix, base64-encoded for grpc-web-text, inside one long response.', 'Mỗi token là một message protobuf với tiền tố độ dài 5 byte, mã hoá base64 cho grpc-web-text, nằm trong một response dài.'],
  }[setup];
  add(0.6, DROP[0], 5, null, ...flow);

  if (drop) {
    const lost = {
      poll: ['The phone switches networks. The poll in flight dies with the old connection. The browser waits a second and tries again, but there is no network yet.', 'Điện thoại đổi mạng. Lượt poll đang bay chết theo kết nối cũ. Trình duyệt chờ một giây rồi thử lại, nhưng vẫn chưa có mạng.'],
      ws: ['The phone switches networks and the socket closes. Your reconnect code waits 0.5 s, then 1 s, failing while there is no network.', 'Điện thoại đổi mạng và socket đóng. Code kết nối lại của bạn chờ 0,5 giây, rồi 1 giây, thất bại trong lúc chưa có mạng.'],
      sse: ['The phone switches networks and the stream closes. EventSource waits the retry time the server set, 1 second, and tries again by itself.', 'Điện thoại đổi mạng và stream đóng. EventSource chờ đúng thời gian retry mà server đặt, 1 giây, rồi tự thử lại.'],
      grpc: ['The phone switches networks and the call fails with UNAVAILABLE. The app waits a second and calls again.', 'Điện thoại đổi mạng và lời gọi thất bại với UNAVAILABLE. App chờ một giây rồi gọi lại.'],
    }[setup];
    add(DROP[0], DROP[1], 5, 'warn', ...lost);
    const n = r.lastBefore;
    const back = {
      poll: [`The network is back. The next poll asks for tokens after ${n}, the last one it got, so nothing is lost or repeated: the cursor travels in every request.`, `Mạng đã trở lại. Lượt poll kế tiếp xin các token sau ${n}, token cuối cùng nó đã nhận, nên không mất cũng không lặp: con trỏ đi kèm mọi request.`],
      ws: [`The network is back. Your code opens a new socket and sends {"resume": "m7", "after": ${n}}, and the server replays from ${n + 1}. It works because you wrote both ends of that protocol.`, `Mạng đã trở lại. Code của bạn mở một socket mới và gửi {"resume": "m7", "after": ${n}}, và server phát lại từ ${n + 1}. Nó chạy được vì bạn đã tự viết cả hai đầu của giao thức đó.`],
      sse: [`The network is back. EventSource reconnects and sends Last-Event-ID: ${n} on its own, and the server replays from ${n + 1} out of the token buffer.`, `Mạng đã trở lại. EventSource tự kết nối lại và gửi Last-Event-ID: ${n}, và server phát lại từ ${n + 1} từ bộ đệm token.`],
      grpc: [`The network is back and the app calls again. The call carries no cursor, so the stream starts again at token 1: the user sees ${r.dupes} tokens a second time.`, `Mạng đã trở lại và app gọi lại. Lời gọi không mang con trỏ nào, nên stream bắt đầu lại từ token 1: người dùng thấy ${r.dupes} token lần thứ hai.`],
    }[setup];
    add(DROP[1], 6.5, 5, setup === 'grpc' ? 'bad' : null, ...back);
  }

  const lb = count(r.lb), streams = count(STREAMS[situation]);
  const close = {
    poll: situation === 'peak'
      ? [`Now multiply: ${streams} streams polling ${pollRate} times a second is ${lb} requests a second at the load balancer, against 10,000 to spare.`, `Giờ nhân lên: ${streams} stream, mỗi stream poll ${pollRate} lần mỗi giây, là ${lb} request mỗi giây ở load balancer, trong khi chỉ dư 10.000.`]
      : [`The last poll returns the final tokens marked done, and the browser stops. At ${streams} streams that is ${lb} requests a second at the load balancer.`, `Lượt poll cuối trả về các token cuối cùng có đánh dấu done, và trình duyệt dừng. Với ${streams} stream, đó là ${lb} request mỗi giây ở load balancer.`],
    ws: [`When the answer is done the server sends a done frame, and the socket can stay open for the next prompt. Load balancer: one upgrade per conversation, about ${lb} requests a second at ${streams} streams.`, `Khi câu trả lời xong, server gửi một frame done, và socket có thể mở tiếp cho prompt sau. Load balancer: một lần upgrade mỗi cuộc hội thoại, khoảng ${lb} request mỗi giây với ${streams} stream.`],
    sse: [`After the last token the server sends "event: done" and the page calls close(). Without it, EventSource would take the end of the response for a drop and reconnect. Load balancer: two requests per answer, about ${lb} a second at ${streams} streams.`, `Sau token cuối, server gửi "event: done" và trang gọi close(). Thiếu nó, EventSource sẽ coi việc response kết thúc là rớt mạng và kết nối lại. Load balancer: hai request mỗi câu trả lời, khoảng ${lb} mỗi giây với ${streams} stream.`],
    grpc: ['The stream ends with trailers: grpc-status: 0. It works, but only through Envoy, a proxy the platform team does not run today.', 'Stream kết thúc bằng trailer: grpc-status: 0. Nó chạy, nhưng chỉ qua Envoy, một proxy mà team platform hiện không vận hành.'],
  }[setup];
  const bad = (setup === 'poll' && situation === 'peak') || setup === 'grpc';
  add(drop ? 6.5 : DROP[0], END, 5, bad ? 'bad' : null, ...close);
  return m;
}

function summary(r) {
  if (r.ok) return {
    calm: { en: 'One POST, one long response, every token once.', vi: 'Một POST, một response dài, mỗi token đúng một lần.' },
    drop: { en: `Back ${secs(r.resumeGap)} after the network, with nothing lost or repeated.`, vi: `Trở lại ${secs(r.resumeGap)} sau khi có mạng, không mất cũng không lặp gì.` },
    proxy: { en: 'Ordinary HTTPS, so the proxy let it through.', vi: 'HTTPS bình thường, nên proxy cho đi qua.' },
    peak: { en: `About ${count(r.lb)} requests a second at the load balancer, well within 10,000.`, vi: `Khoảng ${count(r.lb)} request mỗi giây ở load balancer, nằm gọn trong 10.000.` },
  }[r.situation];
  const c = r.checks, en = [], vi = [];
  if (!c.full) { en.push(`The user got ${TOKENS - r.missing} of ${TOKENS} tokens.`); vi.push(`Người dùng nhận được ${TOKENS - r.missing} / ${TOKENS} token.`); }
  if (c.full && !c.clean) { en.push(r.dupes ? `${r.dupes} tokens arrived twice.` : `Tokens came back ${secs(r.resumeGap)} after the network.`); vi.push(r.dupes ? `${r.dupes} token tới hai lần.` : `Token quay lại ${secs(r.resumeGap)} sau khi có mạng.`); }
  if (!c.load) { en.push(`${count(r.lb)} requests a second at the load balancer, against 10,000.`); vi.push(`${count(r.lb)} request mỗi giây ở load balancer, so với 10.000.`); }
  if (!c.infra) { en.push('It needs Envoy, new infrastructure.'); vi.push('Nó cần Envoy, hạ tầng mới.'); }
  return { en: `Broken: ${en.join(' ')}`, vi: `Hỏng: ${vi.join(' ')}` };
}

export function mount(root, ctx) {
  let cached = null;   // the player asks for each run once; the drawing reads the same result
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { calm: 'sun', drop: 'nowifi', proxy: 'building', peak: 'gauge' }[x], tone: x === 'calm' ? 'ok' : undefined })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { ws: 'flow', sse: 'inbox', poll: 'replay', grpc: 'layers' }[x] })),
    open: ['ws'],
    initial: { situation: 'drop' },
    run: (setup, situation) => (cached = run(setup, situation)),
    survives, height: 620,
    duration: st => st.dur,
    tone: st => st.tone,
    draw: ({ g, w, h, k, p }) => {
      const st = cached.steps[k];
      draw(g, w, h, cached, st ? st.t0 + p * (st.t1 - st.t0) : cached.end);
    },
  });
}

/* ---------------- drawing ---------------- */

const mono = (px, wt = 600) => `${wt} ${px}px "IBM Plex Mono", monospace`;
const sans = (px, wt = 500) => `${wt} ${px}px "Hanken Grotesk", sans-serif`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const KIND = { req: 'blue', resp: 'violet', token: 'ok', frame: 'blue', ctl: 'warn', fail: 'bad' };
const WIN = 2.4;   // seconds of the sequence diagram on screen

function draw(g, w, h, r, t) {
  const { setup, situation } = r;
  g.clearRect(0, 0, w, h);
  g.textBaseline = 'middle';
  const text = (s, x, y, color = 'muted', font = mono(10, 400), align = 'left', max) => {
    g.font = font; g.textAlign = align; g.fillStyle = css(color); g.fillText(s, x, y, max);
  };
  const box = (x, y, bw, bh, rad, fill, stroke, alpha = 1, lw = 1) => {
    g.beginPath(); g.roundRect(x, y, Math.max(0, bw), Math.max(0, bh), rad);
    if (fill) { g.globalAlpha = alpha; g.fillStyle = css(fill); g.fill(); g.globalAlpha = 1; }
    if (stroke) { g.lineWidth = lw; g.strokeStyle = css(stroke); g.stroke(); g.lineWidth = 1; }
  };
  const line = (x1, y1, x2, y2, color, alpha = 1, lw = 1, dash) => {
    g.save(); g.globalAlpha = alpha; g.strokeStyle = css(color); g.lineWidth = lw; if (dash) g.setLineDash(dash);
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.restore();
  };

  // ---- Layout: the sequence diagram on the left, the user and the fleet on the right. ----
  const top = 14, bot = h - 76;
  const dw = Math.max(320, Math.round((w - 28) * 0.6));
  const dx0 = 14, dx1 = dx0 + dw;
  const rx0 = dx1 + 16, rx1 = w - 14, rw = rx1 - rx0;
  box(dx0, top, dw, bot - top, 12, 'surface2', 'line', 1);

  // Lifelines.
  const bx = dx0 + 64, sx = dx1 - 60;
  const px = situation === 'proxy' ? bx + (sx - bx) * 0.38 : null;
  const ex = setup === 'grpc' ? sx - 74 : null;
  const ly0 = top + 46, ly1 = bot - 12;
  const head = (x, label, sub, color, name) => {
    icon(g, name, x, top + 16, 15, color);
    text(label, x, top + 31, color, mono(9.5, 700), 'center');
    if (sub) text(sub, x, top + 41, color, mono(8, 600), 'center');
    line(x, ly0, x, ly1, color, 0.5, 1.5, [2, 4]);
  };
  head(bx, tx({ en: 'BROWSER', vi: 'TRÌNH DUYỆT' }), null, 'text', 'user');
  head(sx, tx({ en: 'SERVER', vi: 'SERVER' }), null, 'text', 'server');
  if (px) head(px, tx({ en: 'CORP PROXY', vi: 'PROXY CÔNG TY' }), tx({ en: 'no Upgrade', vi: 'chặn Upgrade' }), 'warn', 'stop');
  if (ex) head(ex, 'ENVOY', tx({ en: 'new · translates', vi: 'mới · dịch' }), 'bad', 'gear');

  // Time runs down. The window scrolls once the answer passes WIN seconds.
  const w0 = Math.max(0, t - WIN * 0.85), w1 = w0 + WIN;
  const Y = s => ly0 + 14 + ((s - w0) / WIN) * (ly1 - ly0 - 20);
  g.save(); g.beginPath(); g.rect(dx0, ly0, dw, ly1 - ly0 + 8); g.clip();
  for (let s = Math.ceil(w0 * 2) / 2; s <= w1; s += 0.5) {
    const y = Y(s);
    line(dx0 + 8, y, dx0 + 18, y, 'line', 1);
    text(`${s.toFixed(1)} s`, dx0 + 22, y, 'faint', mono(8.5, 500));
  }
  if (situation === 'drop' && DROP[1] > w0 && DROP[0] < w1) {
    const y0 = Y(Math.max(DROP[0], w0)), y1 = Y(Math.min(DROP[1], w1));
    box(bx - 20, y0, sx - bx + 40, y1 - y0, 4, 'bad', null, 0.1);
    text(tx({ en: 'NO NETWORK · switching to cellular', vi: 'MẤT MẠNG · đang chuyển sang 4G' }), (bx + sx) / 2, (y0 + y1) / 2, 'bad', mono(9.5, 700), 'center');
  }
  // The now line.
  line(dx0 + 8, Y(t), dx1 - 8, Y(t), 'text', 0.35, 1);

  // The browser's connection, along its lifeline.
  for (const c of r.conn) {
    if (c.t1 < w0 || c.t0 > Math.min(t, w1)) continue;
    const y0 = Y(Math.max(c.t0, w0)), y1 = Y(Math.min(c.t1, t, w1));
    const color = { open: 'ok', opening: 'blue', retry: 'warn', blocked: 'bad' }[c.state];
    box(bx - 4, y0, 8, Math.max(1, y1 - y0), 3, color, null, c.state === 'open' ? 0.75 : 0.5);
  }

  // The messages. A message is drawn from where it leaves to where it has got to by t.
  const xs = { up: [bx, sx], down: [sx, bx] };
  const labelled = [];
  const shown = r.msgs.filter(m => m.t0 <= t && m.t1 >= w0 - 0.2 && m.t0 <= w1);
  const order = [...shown.filter(m => m.kind !== 'token'), ...shown.filter(m => m.kind === 'token')];
  for (const m of order) {
    const color = m.lost ? 'bad' : KIND[m.kind];
    if (m.local) {   // an error raised in the browser itself
      const y = Y(m.t0);
      box(bx + 8, y - 8, 96, 16, 4, 'bad', null, 0.15);
      text(m.label, bx + 14, y, 'bad', mono(9, 700));
      continue;
    }
    let [xa, xb] = m.from === 'proxy' ? [px, bx] : xs[m.dir];
    // A blocked or failed request stops where it is refused.
    let stopX = null;
    if (m.stop === 'proxy') stopX = px;
    else if (m.stop) stopX = bx + 26;
    else if (m.lost) stopX = xa + (xb - xa) * 0.5;
    const frac = clamp((t - m.t0) / (m.t1 - m.t0 || 1), 0, 1);
    const xe = xa + (xb - xa) * frac, ye = Y(m.t0 + (m.t1 - m.t0) * frac);
    const xend = stopX !== null && Math.abs(stopX - xa) < Math.abs(xe - xa) ? stopX : xe;
    const yend = stopX !== null && xend === stopX ? Y(m.t0 + (m.t1 - m.t0) * Math.abs(stopX - xa) / Math.abs(xb - xa)) : ye;
    const thin = m.kind === 'token';
    line(xa, Y(m.t0), xend, yend, color, thin ? 0.55 : 0.95, thin ? 1 : 1.6);
    if (stopX !== null && xend === stopX) {
      g.save(); g.strokeStyle = css('bad'); g.lineWidth = 2;
      g.beginPath(); g.moveTo(xend - 4, yend - 4); g.lineTo(xend + 4, yend + 4); g.moveTo(xend + 4, yend - 4); g.lineTo(xend - 4, yend + 4); g.stroke(); g.restore();
    } else if (frac >= 1) {
      const d = m.dir === 'up' && m.from !== 'proxy' ? 1 : -1;
      g.fillStyle = css(color); g.beginPath();
      g.moveTo(xb, Y(m.t1)); g.lineTo(xb - d * 6, Y(m.t1) - 3); g.lineTo(xb - d * 6, Y(m.t1) + 3); g.fill();
    } else {
      g.fillStyle = css(color); g.beginPath(); g.arc(xe, ye, thin ? 2 : 3.5, 0, Math.PI * 2); g.fill();
    }
    // Labels: every control message, and tokens where there is room.
    const ly = Y(m.t0) - 6;
    if (labelled.some(y => Math.abs(y - ly) < 12)) continue;
    if (thin && labelled.some(y => Math.abs(y - ly) < 30)) continue;
    labelled.push(ly);
    const lx = m.dir === 'up' || m.from === 'proxy' ? bx + 12 : sx - 12;
    const align = m.dir === 'up' || m.from === 'proxy' ? 'left' : 'right';
    text(m.label + (m.lost ? tx({ en: ' · lost', vi: ' · mất' }) : ''), lx, ly, m.lost ? 'bad' : color === 'ok' ? 'muted' : color, mono(thin ? 8.5 : 9, thin ? 500 : 700), align, sx - bx - 30);
  }
  g.restore();
  if (ex) {
    // Envoy rewrites every message it passes.
    text('grpc-web ⇄ HTTP/2 gRPC', ex, ly1 - 6, 'bad', mono(8, 600), 'center');
  }

  // ---- Right: the user's screen. ----
  const got = r.recv.filter(x => x.t <= t);
  const counts = new Array(TOKENS + 1).fill(0);
  for (const x of got) counts[x.seq]++;
  const uTop = top, uH = 196;
  box(rx0, uTop, rw, uH, 12, 'surface2', 'line', 1);
  icon(g, 'user', rx0 + 18, uTop + 18, 14, 'text');
  text(tx({ en: 'WHAT THE USER SEES', vi: 'NGƯỜI DÙNG THẤY GÌ' }), rx0 + 32, uTop + 19, 'text', mono(9.5, 700));
  text(tx({ en: `1 square = 1 token · ${TOKENS}`, vi: `1 ô = 1 token · ${TOKENS}` }), rx1 - 12, uTop + 19, 'faint', mono(8.5, 500), 'right');
  const cols = 20, rows = TOKENS / cols;
  const cell = Math.max(4, Math.floor(Math.min((rw - 24) / cols, 110 / rows)));
  const gx = rx0 + 12, gy = uTop + 34;
  for (let i = 1; i <= TOKENS; i++) {
    const x = gx + ((i - 1) % cols) * cell, y = gy + Math.floor((i - 1) / cols) * cell;
    const c = counts[i];
    box(x + 1, y + 1, cell - 2, cell - 2, 2, c === 0 ? 'bg2' : c > 1 ? 'bad' : 'ok', null, c === 0 ? 1 : 0.8);
  }
  const last = got.length ? got[got.length - 1].t : null;
  const dupNow = counts.reduce((a, c) => a + Math.max(0, c - 1), 0);
  const have = counts.slice(1).filter(Boolean).length;
  let say, sayColor = 'ok';
  if (!got.length) { say = setup === 'ws' && situation === 'proxy' ? tx({ en: 'spinner… nothing arrives', vi: 'vòng xoay… không có gì tới' }) : tx({ en: 'waiting for the first token', vi: 'chờ token đầu tiên' }); sayColor = setup === 'ws' && situation === 'proxy' && t > 1 ? 'bad' : 'muted'; }
  else if (dupNow) { say = tx({ en: `${dupNow} tokens shown twice: the answer restarted`, vi: `${dupNow} token hiện hai lần: câu trả lời chạy lại từ đầu` }); sayColor = 'bad'; }
  else if (have === TOKENS) say = tx({ en: `complete · first token at ${secs(r.firstToken)}`, vi: `đủ · token đầu lúc ${secs(r.firstToken)}` });
  else if (t - last > 0.4) { say = tx({ en: `stalled for ${secs(t - last)} at token ${have}`, vi: `đứng ${secs(t - last)} ở token ${have}` }); sayColor = 'warn'; }
  else say = tx({ en: `streaming · ${have} of ${TOKENS}`, vi: `đang chạy · ${have} / ${TOKENS}` });
  text(say, rx0 + 12, uTop + uH - 18, sayColor, mono(10, 700), 'left', rw - 24);

  // ---- Right: the connection. ----
  const cTop = uTop + uH + 10, cH = 120;
  const now = r.conn.filter(c => c.t0 <= t && t < c.t1).pop() || (r.conn.length && t >= r.conn[r.conn.length - 1].t1 ? { state: 'done' } : { state: 'opening' });
  const stateColor = { open: 'ok', opening: 'blue', retry: 'warn', blocked: 'bad', done: 'muted' }[now.state];
  box(rx0, cTop, rw, cH, 12, 'surface2', stateColor, 1, 1);
  icon(g, 'arrow', rx0 + 18, cTop + 18, 14, stateColor);
  text(tx(LABEL[setup]).toUpperCase(), rx0 + 32, cTop + 19, stateColor, mono(9.5, 700), 'left', rw - 44);
  const stateText = {
    open: { ws: tx({ en: 'socket open', vi: 'socket đang mở' }), sse: tx({ en: 'response held open', vi: 'response đang mở' }), poll: tx({ en: 'one poll held at a time', vi: 'mỗi lúc giữ một lượt poll' }), grpc: tx({ en: 'call open, through Envoy', vi: 'lời gọi đang mở, qua Envoy' }) }[setup],
    opening: tx({ en: 'opening…', vi: 'đang mở…' }),
    retry: { ws: tx({ en: 'closed · your code reconnects', vi: 'đã đóng · code của bạn kết nối lại' }), sse: tx({ en: 'closed · EventSource retries', vi: 'đã đóng · EventSource tự thử lại' }), poll: tx({ en: 'failed · polling again', vi: 'thất bại · poll lại' }), grpc: tx({ en: 'UNAVAILABLE · calling again', vi: 'UNAVAILABLE · gọi lại' }) }[setup],
    blocked: tx({ en: 'refused by the proxy · backing off', vi: 'bị proxy từ chối · đang lùi' }),
    done: tx({ en: 'answer complete', vi: 'đã trả lời xong' }),
  }[now.state];
  text(stateText, rx0 + 12, cTop + 44, stateColor, mono(10.5, 700), 'left', rw - 24);
  const reqs = r.msgs.filter(m => m.kind === 'req' && m.t0 <= t).length;
  const downs = r.msgs.filter(m => m.dir === 'down' && m.t1 <= t && !m.lost && m.kind !== 'fail').length;
  text(tx({ en: `HTTP requests from this tab: ${reqs}`, vi: `request HTTP từ tab này: ${reqs}` }), rx0 + 12, cTop + 68, 'text', mono(9.5, 600), 'left', rw - 24);
  text(tx({ en: `messages received: ${downs}`, vi: `message đã nhận: ${downs}` }), rx0 + 12, cTop + 86, 'muted', mono(9.5, 500), 'left', rw - 24);
  const resume = { ws: tx({ en: 'resume: your own protocol', vi: 'tiếp tục: giao thức tự viết' }), sse: tx({ en: 'resume: Last-Event-ID, built in', vi: 'tiếp tục: Last-Event-ID, có sẵn' }), poll: tx({ en: 'resume: cursor in every request', vi: 'tiếp tục: con trỏ trong mọi request' }), grpc: tx({ en: 'resume: none in gRPC', vi: 'tiếp tục: gRPC không có' }) }[setup];
  text(resume, rx0 + 12, cTop + 104, setup === 'grpc' ? 'bad' : 'muted', mono(9.5, 500), 'left', rw - 24);

  // ---- Right: the whole fleet at the load balancer. ----
  const fTop = cTop + cH + 10, fBot = bot;
  const over = r.lb > LIMIT;
  box(rx0, fTop, rw, fBot - fTop, 12, 'surface2', over ? 'bad' : 'line', 1, 1);
  icon(g, 'server', rx0 + 18, fTop + 18, 14, over ? 'bad' : 'text');
  text(tx({ en: 'LOAD BALANCER · WHOLE FLEET', vi: 'LOAD BALANCER · TOÀN HỆ THỐNG' }), rx0 + 32, fTop + 19, over ? 'bad' : 'text', mono(9.5, 700), 'left', rw - 44);
  text(tx({ en: `${count(STREAMS[situation])} answers streaming at once`, vi: `${count(STREAMS[situation])} câu trả lời cùng lúc` }), rx0 + 12, fTop + 42, 'muted', mono(9.5, 500), 'left', rw - 24);
  const bxx = rx0 + 12, bww = rw - 24, by = fTop + 56;
  const scale = Math.max(LIMIT * 1.4, r.lb * 1.05);
  box(bxx, by, bww, 14, 4, 'bg2', 'line', 1);
  box(bxx, by, bww * Math.min(1, r.lb / scale), 14, 4, over ? 'bad' : 'ok', null, 0.85);
  line(bxx + bww * (LIMIT / scale), by - 4, bxx + bww * (LIMIT / scale), by + 18, 'bad', 0.9, 1.5, [3, 2]);
  text('10k', bxx + bww * (LIMIT / scale), by + 26, 'bad', mono(8.5, 600), 'center');
  text(tx({ en: `${count(r.lb)} requests / s`, vi: `${count(r.lb)} request / giây` }), bxx, by + 44, over ? 'bad' : 'ok', mono(11, 700), 'left', bww);
  const per = setup === 'poll' ? tx({ en: `${r.perStream.toFixed(1)} polls / s per answer`, vi: `${r.perStream.toFixed(1)} lượt poll / giây mỗi câu` }) : setup === 'sse' ? tx({ en: '2 requests per answer', vi: '2 request mỗi câu trả lời' }) : tx({ en: '1 request per answer', vi: '1 request mỗi câu trả lời' });
  text(per, bxx, by + 60, 'muted', mono(9.5, 500), 'left', bww);

  checks(g, w, h, r, t, text, box);
}

/* The four constraints, ticked live. */
function checks(g, w, h, r, t, text, box) {
  const done = t >= r.end - 1e-6;
  const got = r.recv.filter(x => x.t <= t);
  const counts = new Array(TOKENS + 1).fill(0);
  for (const x of got) counts[x.seq]++;
  const have = counts.slice(1).filter(Boolean).length, dup = counts.reduce((a, c) => a + Math.max(0, c - 1), 0);
  const items = [];
  items.push({ label: tx({ en: 'the whole answer arrives', vi: 'nhận đủ câu trả lời' }), value: `${have} / ${TOKENS}`, ok: done ? r.checks.full : have === TOKENS ? true : undefined });
  let clean;
  if (r.situation !== 'drop') clean = { value: dup ? tx({ en: `${dup} repeated`, vi: `${dup} bị lặp` }) : tx({ en: 'no drop', vi: 'không rớt mạng' }), ok: done ? r.checks.clean || !r.checks.full : !dup };
  else if (t < DROP[1]) clean = { value: t < DROP[0] ? tx({ en: 'drop at 3.0 s', vi: 'rớt lúc 3,0 giây' }) : tx({ en: 'network down', vi: 'đang mất mạng' }) };
  else if (dup) clean = { value: tx({ en: `${dup} repeated`, vi: `${dup} bị lặp` }), ok: false };
  else if (t < DROP[1] + r.resumeGap) clean = { value: tx({ en: `waiting ${secs(t - DROP[1])}`, vi: `chờ ${secs(t - DROP[1])}` }), ok: t - DROP[1] > RESUME ? false : undefined };
  else clean = { value: tx({ en: `back in ${secs(r.resumeGap)}`, vi: `trở lại sau ${secs(r.resumeGap)}` }), ok: r.resumeGap <= RESUME && (!done || r.checks.clean) };
  items.push({ label: tx({ en: 'clean resume after a drop', vi: 'tiếp tục sạch sau khi rớt mạng' }), ...clean });
  items.push({ label: tx({ en: 'load balancer under 10k / s', vi: 'load balancer dưới 10k / giây' }), value: count(r.lb), ok: r.checks.load });
  items.push({ label: tx({ en: 'no new infrastructure', vi: 'không thêm hạ tầng' }), value: r.checks.infra ? tx({ en: 'HTTP only', vi: 'chỉ HTTP' }) : tx({ en: 'needs Envoy', vi: 'cần Envoy' }), ok: r.checks.infra });

  const y = h - 62, cw = (w - 28 - 30) / 4;
  items.forEach((it, i) => {
    const x = 14 + i * (cw + 10);
    const tone = it.ok === undefined ? 'muted' : it.ok ? 'ok' : 'bad';
    box(x, y, cw, 50, 8, tone, tone, 0.07, 1);
    icon(g, it.ok === undefined ? 'clock' : it.ok ? 'check' : 'cross', x + 16, y + 17, 14, tone);
    text(it.label, x + 30, y + 17, 'text', sans(11.5, 600), 'left', cw - 38);
    text(it.value, x + 30, y + 35, tone, mono(11, 700), 'left', cw - 38);
  });
}
