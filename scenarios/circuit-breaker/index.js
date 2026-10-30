import * as simulation from './sim.js';

export default {
  category: 'reliability',
  topic: { en: 'Circuit breakers and bulkheads', vi: 'Circuit breaker và bulkhead' },
  title: {
    en: 'Checkout is down, and it isn’t your outage',
    vi: 'Checkout sập, mà sự cố đâu phải của bạn',
  },

  scenario: {
    en: `You run checkout for an online store. It is a NestJS service on **20 pods**, and the same pods also serve \`/cart\`, \`/orders\` and \`/health\`. Every outbound HTTP call from a pod goes through one shared client that allows **at most 40 requests in flight**. Past that, calls wait in the client's queue.

Each checkout makes two calls: a **fraud check** to a third-party API, which usually answers in about 150 ms, then the **payment** call. The fraud call has a **20-second timeout**. If the fraud call fails, checkout already accepts the order as **pending review**, and the risk team checks it from a queue before it ships. They have agreed to use this fallback for as long as the fraud API is unavailable.

This afternoon the fraud API stopped answering. Calls hang until the 20-second timeout. Within seconds, all 40 connections on every pod are held by fraud calls. \`/cart\` and \`/orders\` requests queue behind them, though their own services are healthy. Checkout p99 goes from about 400 ms to over 20 seconds, customers retry, memory climbs with the queue, and pods get OOM-killed. The provider's status page says about 15 minutes to recover, and asks clients to back off in the meantime.

Per pod, that is about **6 checkouts** and **30 cart and order requests** a second.

What the fix must do, for this incident and the next:
- **\`/cart\` and \`/orders\` stay fast**: p99 under 500 ms, whatever the fraud API does.
- **Checkout keeps answering**: from one minute into an incident, checkout p99 is under 2 seconds. A pending-review order counts as an answer.
- **Back off a failing provider**: from one minute into an incident, calls to the fraud API drop below 10% of normal, whether it hangs or answers with errors.
- **Recover on its own**: within 40 seconds of the provider's fix, orders get a real fraud check again, without anyone redeploying.`,
    vi: `Bạn phụ trách checkout của một cửa hàng online. Đó là một service NestJS chạy trên **20 pod**, và cũng chính các pod đó phục vụ \`/cart\`, \`/orders\` và \`/health\`. Mọi lời gọi HTTP đi ra từ một pod đều qua một client dùng chung, cho phép **tối đa 40 request cùng lúc**. Quá mức đó, lời gọi phải chờ trong hàng đợi của client.

Mỗi lần checkout gọi hai nơi: **kiểm tra gian lận** (fraud check) ở một API bên thứ ba, thường trả lời trong khoảng 150 ms, rồi tới lời gọi **thanh toán**. Lời gọi fraud có **timeout 20 giây**. Nếu lời gọi fraud thất bại, checkout vốn đã nhận đơn ở trạng thái **chờ duyệt** (pending review), và team rủi ro kiểm tra nó từ một hàng đợi trước khi giao hàng. Họ đã đồng ý dùng phương án dự phòng này chừng nào API fraud còn chưa dùng được.

Chiều nay API fraud ngừng trả lời. Lời gọi treo cho tới timeout 20 giây. Chỉ trong vài giây, cả 40 kết nối trên mọi pod đều bị lời gọi fraud chiếm. Request \`/cart\` và \`/orders\` xếp hàng phía sau, dù service của chính chúng vẫn khỏe. p99 của checkout tăng từ khoảng 400 ms lên hơn 20 giây, khách hàng thử lại, bộ nhớ phình theo hàng đợi, và các pod bị OOM-kill. Trang trạng thái của nhà cung cấp nói khoảng 15 phút nữa sẽ phục hồi, và đề nghị các client giảm tải trong lúc chờ.

Tính trên mỗi pod, đó là khoảng **6 lượt checkout** và **30 request giỏ hàng và đơn hàng** mỗi giây.

Cách sửa phải làm được những điều sau, cho sự cố này và lần sau:
- **\`/cart\` và \`/orders\` vẫn nhanh**: p99 dưới 500 ms, bất kể API fraud ra sao.
- **Checkout vẫn trả lời**: từ phút thứ nhất của sự cố trở đi, p99 của checkout dưới 2 giây. Một đơn chờ duyệt cũng tính là một câu trả lời.
- **Giảm tải cho nhà cung cấp đang lỗi**: từ phút thứ nhất của sự cố trở đi, số lời gọi tới API fraud giảm xuống dưới 10% mức bình thường, dù nó treo hay trả về lỗi.
- **Tự phục hồi**: trong vòng 40 giây sau khi nhà cung cấp sửa xong, đơn hàng lại được kiểm tra gian lận thật, không cần ai deploy lại.`,
  },

  question: {
    en: 'What do you change?',
    vi: 'Bạn thay đổi gì?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Cut the fraud call’s timeout to 2 seconds and retry it up to 3 times with exponential backoff (0.2, 0.4, then 0.8 s) before falling back to pending review.',
        vi: 'Giảm timeout của lời gọi fraud xuống 2 giây và thử lại tối đa 3 lần với exponential backoff (0,2, 0,4, rồi 0,8 giây) trước khi chuyển sang chờ duyệt.',
      },
      why: {
        en: 'The shorter timeout is a good idea. The retries are what sink it. While the API hangs, each order now holds a connection for four 2-second attempts, about 8 seconds instead of 20. At 6 checkouts a second that still wants more than the 40 connections a pod has, so `/cart` and `/orders` keep queueing. The pod also sends the fraud API about three times its normal traffic, and four times when it answers with 503s, exactly when the provider asked clients to back off. Retries are for brief, transient failures. Against an outage they multiply the load at every layer that retries. Use them for blips, with a retry budget, behind something that notices an outage.',
        vi: 'Timeout ngắn hơn là ý hay. Chính các lần thử lại làm nó chìm. Khi API treo, mỗi đơn giờ giữ một kết nối qua bốn lần thử 2 giây, khoảng 8 giây thay vì 20. Với 6 lượt checkout mỗi giây, nhu cầu vẫn vượt 40 kết nối của một pod, nên `/cart` và `/orders` vẫn phải xếp hàng. Pod còn gửi tới API fraud gấp khoảng ba lần lưu lượng bình thường, và gấp bốn khi nó trả 503, đúng lúc nhà cung cấp đề nghị client giảm tải. Thử lại dành cho lỗi ngắn, thoáng qua. Trước một sự cố kéo dài, nó nhân tải lên ở mọi tầng có thử lại. Hãy dùng nó cho các lỗi chớp nhoáng, với một ngân sách thử lại (retry budget), phía sau một thứ nhận ra được sự cố.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Put a circuit breaker on the fraud call. When at least half of the last 10 calls failed, it opens for 30 seconds and checkout goes straight to pending review. Then it lets one probe call through, and closes only if that call succeeds.',
        vi: 'Đặt một circuit breaker cho lời gọi fraud. Khi ít nhất một nửa trong 10 lời gọi gần nhất thất bại, nó mở trong 30 giây và checkout chuyển thẳng sang chờ duyệt. Sau đó nó cho một lời gọi thăm dò (probe) đi qua, và chỉ đóng lại nếu lời gọi đó thành công.',
      },
      why: {
        en: 'This is how you stop calling a provider that is down and come back by yourself. When the API answers with 503s, the breaker opens in about a second, and from then on the pod sends only one probe every 30 seconds. But a breaker counts failures as calls finish, and a hanging call does not fail until its 20-second timeout. For those first 20 seconds every fraud call takes a connection from the shared 40, so the pool fills in about 7 seconds and `/cart` and `/orders` queue behind it. By the time the breaker opens, about 80 fraud calls are already waiting in the client’s queue. They were let through while it was closed, and each one hangs in turn. A breaker decides whether to call. It does not limit how many calls can be stuck at once.',
        vi: 'Đây là cách ngừng gọi một nhà cung cấp đang sập và tự quay lại khi nó ổn. Khi API trả 503, breaker mở sau khoảng một giây, và từ đó pod chỉ gửi một probe mỗi 30 giây. Nhưng breaker đếm lỗi khi lời gọi kết thúc, mà một lời gọi treo chỉ thất bại khi hết timeout 20 giây. Trong 20 giây đầu đó, mỗi lời gọi fraud chiếm một kết nối trong 40 kết nối dùng chung, nên pool đầy sau khoảng 7 giây và `/cart`, `/orders` xếp hàng phía sau. Tới lúc breaker mở, khoảng 80 lời gọi fraud đã nằm sẵn trong hàng đợi của client. Chúng được cho qua khi breaker còn đóng, và lần lượt từng cái treo. Breaker quyết định có gọi hay không. Nó không giới hạn được bao nhiêu lời gọi bị kẹt cùng lúc.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Bulkhead the fraud API: give it its own 8 of the 40 connections, through a separate HTTP agent with `maxSockets: 8`. When all 8 are busy, the order goes straight to pending review instead of waiting.',
        vi: 'Dựng bulkhead cho API fraud: cho nó 8 trong 40 kết nối làm phần riêng, qua một HTTP agent riêng với `maxSockets: 8`. Khi cả 8 đều bận, đơn hàng chuyển thẳng sang chờ duyệt thay vì phải chờ.',
      },
      why: {
        en: '`/cart`, `/orders` and the payment call are now safe. They keep 32 connections the fraud API can never take, so their p99 does not move. But the bulkhead never stops calling. Every 20 seconds the 8 fraud connections free up, 8 new orders take them, and those orders hang for 20 seconds. That is about 7% of checkouts for as long as the incident lasts, so checkout p99 stays around 20 seconds. When the API fails fast with 503s, no connection stays busy, so every order still calls it: 6 a second, exactly what the provider asked you not to do. A bulkhead limits the damage. It does not notice the failure.',
        vi: '`/cart`, `/orders` và lời gọi thanh toán giờ đã an toàn. Chúng giữ 32 kết nối mà API fraud không bao giờ lấy được, nên p99 của chúng không nhúc nhích. Nhưng bulkhead không bao giờ ngừng gọi. Cứ mỗi 20 giây, 8 kết nối fraud được giải phóng, 8 đơn mới chiếm lấy chúng, và các đơn đó treo 20 giây. Đó là khoảng 7% lượt checkout suốt thời gian sự cố, nên p99 của checkout vẫn ở quanh 20 giây. Khi API lỗi nhanh bằng 503, không kết nối nào bận lâu, nên đơn nào cũng vẫn gọi nó: 6 lần mỗi giây, đúng điều nhà cung cấp đề nghị bạn đừng làm. Bulkhead giới hạn thiệt hại. Nó không nhận ra sự cố.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Both: the bulkhead from C, with the circuit breaker from B in front of it.',
        vi: 'Cả hai: bulkhead của C, với circuit breaker của B đặt phía trước.',
      },
      why: {
        en: 'Each one covers the other’s gap. The bulkhead limits the damage while the breaker is still collecting evidence. During the first 20 seconds only 8 connections hang, so `/cart`, `/orders` and payment are untouched, and orders past those 8 go to pending review at once. When those 8 time out, the breaker opens. From then on checkout skips the fraud API except for one probe every 30 seconds, so checkout p99 drops to about a quarter of a second and the provider gets a trickle. After the provider recovers, the next probe succeeds and the breaker closes by itself. The cost is that some orders skip the real check and wait for manual review, which the risk team has accepted. Also shorten the timeout, or count slow calls as failures (resilience4j has a slow-call threshold for this), so the breaker opens in seconds instead of 20.',
        vi: 'Mỗi cái lấp chỗ hở của cái kia. Bulkhead giới hạn thiệt hại trong lúc breaker còn đang thu thập bằng chứng. Trong 20 giây đầu chỉ 8 kết nối bị treo, nên `/cart`, `/orders` và thanh toán không bị ảnh hưởng, và các đơn vượt quá 8 cái đó chuyển ngay sang chờ duyệt. Khi 8 lời gọi đó hết timeout, breaker mở. Từ đó checkout bỏ qua API fraud, chỉ trừ một probe mỗi 30 giây, nên p99 của checkout giảm xuống khoảng một phần tư giây và nhà cung cấp chỉ nhận một dòng nhỏ giọt. Sau khi nhà cung cấp phục hồi, probe kế tiếp thành công và breaker tự đóng lại. Cái giá là một số đơn bỏ qua bước kiểm tra thật và chờ duyệt thủ công, điều team rủi ro đã chấp nhận. Nên rút ngắn timeout luôn, hoặc tính lời gọi chậm là lỗi (resilience4j có ngưỡng slow-call cho việc này), để breaker mở sau vài giây thay vì 20.',
      },
    },
  ],

  answer: 'D',

  takeaway: {
    en: `Timeouts, retries, circuit breakers and bulkheads each answer a different question about a dependency.

- **Timeout**: how long one call may hold your resources.
- **Retry**: was that failure a fluke? Use retries only for transient errors, with a budget. During an outage they multiply load.
- **Circuit breaker**: should we call at all right now? It stops calling a dependency that keeps failing and probes for recovery. It needs a fallback, and it can only react as fast as failures arrive.
- **Bulkhead**: how much of us can this dependency take down? It caps the resources one dependency can hold, so everything else keeps working.

In Node there is no thread per request to isolate. The shared resources are outbound sockets, pending promises and memory. A bulkhead there is a separate \`http.Agent\` with its own \`maxSockets\`, or a concurrency limit that fails fast when full.`,
    vi: `Timeout, thử lại, circuit breaker và bulkhead, mỗi thứ trả lời một câu hỏi khác nhau về một dependency.

- **Timeout**: một lời gọi được giữ tài nguyên của bạn bao lâu.
- **Thử lại**: lỗi vừa rồi có phải ngẫu nhiên không? Chỉ thử lại với lỗi thoáng qua, và có ngân sách. Trong một sự cố kéo dài, nó nhân tải lên.
- **Circuit breaker**: lúc này có nên gọi không? Nó ngừng gọi một dependency cứ liên tục lỗi và thăm dò xem nó đã phục hồi chưa. Nó cần một phương án dự phòng, và chỉ phản ứng nhanh bằng tốc độ lỗi xuất hiện.
- **Bulkhead**: dependency này kéo sập được bao nhiêu phần của mình? Nó giới hạn tài nguyên một dependency được giữ, để mọi thứ khác vẫn chạy.

Trong Node không có thread cho mỗi request để mà cô lập. Tài nguyên dùng chung là socket đi ra, promise đang chờ và bộ nhớ. Ở đó, bulkhead là một \`http.Agent\` riêng với \`maxSockets\` riêng, hoặc một giới hạn đồng thời, từ chối ngay khi đầy.`,
  },

  sources: [
    { title: 'Microsoft Azure Architecture Center: Circuit Breaker pattern', url: 'https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker' },
    { title: 'Microsoft Azure Architecture Center: Bulkhead pattern', url: 'https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead' },
    { title: 'Martin Fowler: CircuitBreaker (2014)', url: 'https://martinfowler.com/bliki/CircuitBreaker.html' },
    { title: 'Resilience4j documentation: CircuitBreaker (states, slow-call threshold, half-open)', url: 'https://resilience4j.readme.io/docs/circuitbreaker' },
    { title: 'Resilience4j documentation: Bulkhead', url: 'https://resilience4j.readme.io/docs/bulkhead' },
    { title: 'Marc Brooker, AWS: Timeouts, retries, and backoff with jitter', url: 'https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter' },
    { title: 'Node.js documentation: http.Agent and maxSockets', url: 'https://nodejs.org/api/http.html#class-httpagent' },
    { title: 'opossum: a circuit breaker for Node.js', url: 'https://github.com/nodeshift/opossum' },
  ],

  simulation,
};
