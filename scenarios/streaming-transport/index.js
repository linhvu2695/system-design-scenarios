import * as simulation from './sim.js';

export default {
  category: 'networking',
  topic: { en: 'Streaming transports: WebSockets, SSE, long polling, gRPC', vi: 'Giao thức streaming: WebSockets, SSE, long polling, gRPC' },
  title: {
    en: 'Streaming an AI answer to a phone on a train',
    vi: 'Stream câu trả lời AI tới chiếc điện thoại trên tàu',
  },

  scenario: {
    en: `You're adding an AI assistant to a project-management web app. The model streams its answer at about **30 tokens a second**, and answers average about 400 tokens. The client is the existing React app in the browser, on desktop and mobile web. There is no native app.

Tokens only flow one way. The prompt is sent once at the start, and "stop generating" can be its own request.

What you already have:
- A managed L7 load balancer (HTTP/1.1 and HTTP/2 to browsers) and an auth gateway in front of the API. Together they have room for about **10,000 more requests a second** on top of today's traffic.
- A generation service that writes every token to a Redis stream keyed by message id, with a sequence number, and keeps generating if the client goes away.
- A platform team that will not take on a new proxy or gateway this quarter.

What you expect:
- About **1,200 answers streaming at once** in a busy hour, and launch-week peaks of **20,000**.
- Many users on phones, whose networks change under them: Wi-Fi to cellular, tunnels, lifts. A round trip takes about 150 ms.
- About **1 in 12 business customers** sit behind a corporate proxy that passes ordinary HTTPS but blocks WebSocket upgrades. You know this from support tickets about the real-time comments feature.

What the transport must do:
- **Reach everyone**: every user gets the whole answer, including those behind the corporate proxies.
- **Survive drops**: when a connection drops, the answer continues where it stopped, within 3 seconds of the network coming back, with no lost or repeated text.
- **Fit the headroom**: stay within the 10,000 requests a second at the launch peak.
- **No new infrastructure** this quarter.`,
    vi: `Bạn đang thêm một trợ lý AI vào một web app quản lý dự án. Model stream câu trả lời với tốc độ khoảng **30 token mỗi giây**, và một câu trả lời trung bình khoảng 400 token. Client là app React hiện có chạy trong trình duyệt, trên desktop và web di động. Không có app native.

Token chỉ đi một chiều. Prompt được gửi một lần lúc đầu, và "dừng tạo câu trả lời" có thể là một request riêng.

Những gì bạn đã có:
- Một L7 load balancer dạng managed (HTTP/1.1 và HTTP/2 tới trình duyệt) và một auth gateway đứng trước API. Cả hai còn dư khoảng **10.000 request mỗi giây** so với lưu lượng hiện tại.
- Một service sinh câu trả lời ghi mọi token vào một Redis stream theo id của message, kèm số thứ tự, và vẫn tiếp tục sinh nếu client rời đi.
- Một team platform sẽ không nhận thêm proxy hay gateway mới nào trong quý này.

Những gì bạn dự kiến:
- Khoảng **1.200 câu trả lời stream cùng lúc** vào giờ cao điểm, và đỉnh tuần ra mắt là **20.000**.
- Nhiều người dùng trên điện thoại, mạng đổi liên tục: Wi-Fi sang 4G, đường hầm, thang máy. Một vòng đi về mất khoảng 150 ms.
- Khoảng **1 trên 12 khách hàng doanh nghiệp** ngồi sau một proxy công ty cho HTTPS bình thường đi qua nhưng chặn WebSocket upgrade. Bạn biết điều này qua các ticket hỗ trợ về tính năng bình luận real-time.

Giao thức phải làm được:
- **Tới được mọi người**: người dùng nào cũng nhận đủ câu trả lời, kể cả những người sau proxy công ty.
- **Sống sót khi rớt mạng**: khi kết nối rớt, câu trả lời tiếp tục từ chỗ đã dừng, trong vòng 3 giây sau khi có mạng lại, không mất và không lặp chữ nào.
- **Vừa với phần dư**: nằm trong 10.000 request mỗi giây ở đỉnh ra mắt.
- **Không thêm hạ tầng mới** trong quý này.`,
  },

  question: {
    en: 'Which transport do you ship?',
    vi: 'Bạn chọn giao thức nào?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Long polling: POST the prompt, then call `GET /poll?after=n` in a loop. The server holds each request until there are tokens after `n`, returns them, and the browser asks again at once.',
        vi: 'Long polling: POST prompt, rồi gọi `GET /poll?after=n` liên tục. Server giữ mỗi request tới khi có token sau `n`, trả chúng về, và trình duyệt hỏi lại ngay.',
      },
      why: {
        en: 'It works everywhere, because every poll is plain HTTPS, and it survives drops well, because the cursor travels in every request. The cost is the request count. Each round trip brings back only the tokens made during it, about five on a 150 ms mobile round trip, so one answer costs around six requests a second, each with headers and a trip through the auth gateway. At 1,200 streams that fits. At the 20,000 launch peak it is well over 100,000 requests a second, ten times the headroom. Tokens also arrive in bursts rather than one by one. Long polling is the right fallback when nothing else gets through, which is why Socket.IO starts every connection with it.',
        vi: 'Nó chạy ở mọi nơi, vì mỗi lượt poll là HTTPS bình thường, và nó vượt qua rớt mạng tốt, vì con trỏ đi kèm mọi request. Cái giá là số request. Mỗi vòng đi về chỉ mang về các token được tạo trong lúc đó, khoảng năm token với vòng đi về 150 ms trên di động, nên một câu trả lời tốn chừng sáu request mỗi giây, mỗi request có header và đi qua auth gateway. Với 1.200 stream thì vừa. Ở đỉnh ra mắt 20.000 thì vượt xa 100.000 request mỗi giây, gấp mười lần phần dư. Token cũng tới theo từng cụm thay vì từng cái một. Long polling là phương án dự phòng đúng khi không gì khác đi qua được, và đó là lý do Socket.IO bắt đầu mọi kết nối bằng nó.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'WebSockets: upgrade one connection per conversation, send the prompt and the tokens as frames, and write reconnect code that resumes after the last sequence number the browser has.',
        vi: 'WebSockets: upgrade một kết nối cho mỗi cuộc hội thoại, gửi prompt và token dưới dạng frame, và viết code kết nối lại để tiếp tục sau số thứ tự cuối cùng trình duyệt đã có.',
      },
      why: {
        en: 'It is efficient: one upgrade, then small frames with no headers. With the reconnect code you planned, drops are handled too. But WebSockets are the one option here that needs the Upgrade handshake, and the corporate proxies at 1 in 12 business customers refuse it, so those users get no answer at all. Fixing that means a fallback transport, which is what Socket.IO is for. You also own the reconnect, backoff, heartbeat and resume protocol, and after the upgrade your messages no longer pass through HTTP middleware such as auth, rate limits and logs. The two-way channel buys nothing here, since the prompt goes up once. WebSockets are right when the client talks continuously, as in collaborative editing, games or voice.',
        vi: 'Nó hiệu quả: một lần upgrade, rồi các frame nhỏ không có header. Với code kết nối lại bạn đã định viết, rớt mạng cũng được xử lý. Nhưng WebSockets là lựa chọn duy nhất ở đây cần bước bắt tay Upgrade, và proxy công ty ở 1 trên 12 khách hàng doanh nghiệp từ chối nó, nên những người dùng đó không nhận được câu trả lời nào. Sửa điều đó nghĩa là cần một giao thức dự phòng, chính là việc Socket.IO làm. Bạn cũng phải tự lo việc kết nối lại, backoff, heartbeat và giao thức tiếp tục, và sau khi upgrade, các message không còn đi qua middleware HTTP như auth, rate limit và log. Kênh hai chiều chẳng mang lại gì ở đây, vì prompt chỉ đi lên một lần. WebSockets là lựa chọn đúng khi client nói liên tục, như soạn thảo cộng tác, game hay thoại.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Server-Sent Events: POST the prompt to get a message id, then open an `EventSource` on `GET /messages/{id}/stream`, with each token’s sequence number as its event `id`.',
        vi: 'Server-Sent Events: POST prompt để lấy id của message, rồi mở một `EventSource` trên `GET /messages/{id}/stream`, dùng số thứ tự của mỗi token làm `id` của event.',
      },
      why: {
        en: 'This is an ordinary HTTP response that does not end. The proxy passes it, the load balancer sees two requests per answer (about 3,000 a second at the peak), and nothing new is deployed. Reconnecting is built into the browser: `EventSource` waits the `retry` time the server set, reconnects, and sends `Last-Event-ID`, and the server replays the rest from the Redis stream. Splitting the work into a POST and a GET matters, because `EventSource` can only GET and cannot set headers, so it relies on the session cookie. A few things to get right: send an `event: done` and call `close()`, or `EventSource` will reconnect when the response ends. Serve it over HTTP/2, because on HTTP/1.1 a browser allows only 6 connections per domain across all tabs. Send comment lines as keep-alives within the load balancer’s idle timeout, and turn off buffering and compression on the stream.',
        vi: 'Đây là một response HTTP bình thường, chỉ là không kết thúc. Proxy cho nó qua, load balancer thấy hai request cho mỗi câu trả lời (khoảng 3.000 mỗi giây ở đỉnh), và không cần triển khai gì mới. Việc kết nối lại có sẵn trong trình duyệt: `EventSource` chờ thời gian `retry` mà server đặt, kết nối lại, và gửi `Last-Event-ID`, rồi server phát lại phần còn lại từ Redis stream. Việc tách thành một POST và một GET là quan trọng, vì `EventSource` chỉ GET được và không đặt được header, nên nó dựa vào cookie phiên. Vài điều cần làm đúng: gửi `event: done` và gọi `close()`, nếu không `EventSource` sẽ kết nối lại khi response kết thúc. Phục vụ qua HTTP/2, vì trên HTTP/1.1 một trình duyệt chỉ cho 6 kết nối mỗi domain trên tất cả các tab. Gửi các dòng comment làm keep-alive trong khoảng idle timeout của load balancer, và tắt buffering cùng nén trên stream.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'gRPC server streaming: define the answer as a server-streaming RPC and call it from the browser with gRPC-Web.',
        vi: 'gRPC server streaming: định nghĩa câu trả lời là một RPC server-streaming và gọi nó từ trình duyệt bằng gRPC-Web.',
      },
      why: {
        en: 'You get a typed contract and compact framing. But browsers cannot make real gRPC calls, because no browser API gives a page the raw HTTP/2 frames gRPC needs. gRPC-Web works around that with a proxy, Envoy by default, that translates between the browser’s requests and gRPC, and that is a new piece of infrastructure the platform team will not run this quarter. gRPC-Web also supports only server streaming, and only in its text mode. Nothing in gRPC resumes a stream either: after a drop the call fails with UNAVAILABLE, and calling again starts from the first token unless you add your own cursor. gRPC streaming is the right choice between services, where both ends speak HTTP/2.',
        vi: 'Bạn có một hợp đồng có kiểu và cách đóng gói gọn. Nhưng trình duyệt không gọi gRPC thật được, vì không API trình duyệt nào cho trang web truy cập các frame HTTP/2 thô mà gRPC cần. gRPC-Web vượt qua chuyện đó bằng một proxy, mặc định là Envoy, để dịch giữa request của trình duyệt và gRPC, và đó là một thành phần hạ tầng mới mà team platform sẽ không vận hành trong quý này. gRPC-Web cũng chỉ hỗ trợ server streaming, và chỉ ở chế độ text. Trong gRPC cũng không có gì để tiếp tục một stream: sau khi rớt mạng, lời gọi thất bại với UNAVAILABLE, và gọi lại sẽ bắt đầu từ token đầu tiên, trừ khi bạn tự thêm con trỏ. gRPC streaming là lựa chọn đúng giữa các service với nhau, nơi cả hai đầu đều nói HTTP/2.',
      },
    },
  ],

  answer: 'C',

  takeaway: {
    en: `Pick a transport by which way the data flows and which networks it has to cross.

- **SSE**: server to client over one ordinary HTTP response. Reconnecting and resuming (\`Last-Event-ID\`) are built into the browser. It is the default for streaming LLM output to browsers.
- **WebSockets**: both directions on one upgraded connection. Use them when the client talks continuously. You own reconnecting and resuming, and some proxies block the upgrade.
- **Long polling**: a request per batch. It works through anything, so it makes a good fallback, but it costs requests in proportion to how fast data arrives.
- **gRPC streaming**: between services. Browsers need gRPC-Web and a translating proxy.

Whichever transport you pick, resuming is the server's job. Number every token, keep them in a buffer that outlives the connection, and let the client say where it stopped.`,
    vi: `Chọn giao thức theo chiều dữ liệu đi và những mạng nó phải vượt qua.

- **SSE**: server tới client qua một response HTTP bình thường. Kết nối lại và tiếp tục (\`Last-Event-ID\`) có sẵn trong trình duyệt. Đây là lựa chọn mặc định để stream output của LLM tới trình duyệt.
- **WebSockets**: hai chiều trên một kết nối đã upgrade. Dùng khi client nói liên tục. Bạn tự lo kết nối lại và tiếp tục, và một số proxy chặn upgrade.
- **Long polling**: mỗi cụm dữ liệu là một request. Nó đi qua được mọi thứ, nên là phương án dự phòng tốt, nhưng số request tỉ lệ với tốc độ dữ liệu tới.
- **gRPC streaming**: giữa các service. Trình duyệt cần gRPC-Web và một proxy để dịch.

Dù chọn giao thức nào, việc tiếp tục là trách nhiệm của server. Đánh số mọi token, giữ chúng trong một bộ đệm sống lâu hơn kết nối, và để client nói nó đã dừng ở đâu.`,
  },

  sources: [
    { title: 'WHATWG HTML Living Standard: Server-sent events (Last-Event-ID, retry, reconnection)', url: 'https://html.spec.whatwg.org/multipage/server-sent-events.html' },
    { title: 'MDN: Using server-sent events (event fields, keep-alive comments, the 6-connection limit on HTTP/1.1)', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events' },
    { title: 'RFC 6455: The WebSocket Protocol', url: 'https://www.rfc-editor.org/rfc/rfc6455' },
    { title: 'Socket.IO documentation: How it works (why it starts with HTTP long-polling)', url: 'https://socket.io/docs/v4/how-it-works/' },
    { title: 'grpc-web on GitHub: the proxy, and which streaming modes are supported', url: 'https://github.com/grpc/grpc-web' },
    { title: 'gRPC blog: The state of gRPC in the browser', url: 'https://grpc.io/blog/state-of-grpc-web/' },
  ],

  simulation,
};
