import * as simulation from './sim.js';

export default {
  category: 'networking',
  topic: { en: 'Rate limiting', vi: 'Giới hạn tần suất' },
  title: {
    en: 'Sync failed after the flight',
    vi: 'Đồng bộ lỗi sau chuyến bay',
  },

  scenario: {
    en: `You run the sync API of a note-taking app with about **5 million** active users. Each user has a rate limit, kept in Redis. Today it is a fixed window: **30 requests per minute**, and anything over gets a \`429\`.

Two messages land the same week.

Support: users who open the app after a flight or a day offline see "Sync failed". On launch the app catches up by sending **up to 40 requests** within a second or two. The limiter rejects everything past 30, and the app's retries make it worse.

Someone proposes raising the limit to 70 a minute. The database team says no: the sync service is sized for **30 requests per minute per user, on average**. Short bursts are fine. A sustained 70 is not.

What the new limiter must do:
- Let a burst of **up to 40** requests through at once.
- Over time, hold every user to an average of **30 per minute**, one every 2 seconds.
- Right after a burst, keep accepting a user who goes on editing. The app autosaves about **once every 3 seconds**.
- Answer every request **immediately** with \`200\` or \`429\`. The app gives up after 10 seconds, and the API servers must not hold requests open.
- Store only a few bytes per user.`,
    vi: `Bạn vận hành API đồng bộ của một ứng dụng ghi chú với khoảng **5 triệu** người dùng hoạt động. Mỗi người dùng có một giới hạn tần suất, lưu trong Redis. Hiện tại đó là cửa sổ cố định (fixed window): **30 request mỗi phút**, vượt quá thì nhận \`429\`.

Cùng một tuần có hai tin nhắn.

Team hỗ trợ: người dùng mở app sau một chuyến bay hay một ngày offline thấy "Đồng bộ thất bại". Khi khởi động, app bắt kịp bằng cách gửi **tới 40 request** trong một hai giây. Bộ giới hạn từ chối mọi request sau cái thứ 30, và cơ chế retry của app làm mọi thứ tệ hơn.

Có người đề xuất nâng giới hạn lên 70 mỗi phút. Team database không đồng ý: service đồng bộ được tính toán cho **trung bình 30 request mỗi phút mỗi người dùng**. Dồn ngắn thì được. 70 liên tục thì không.

Bộ giới hạn mới phải:
- Cho một loạt **tới 40** request đi qua cùng lúc.
- Về lâu dài, giữ mỗi người dùng ở mức trung bình **30 mỗi phút**, tức một request mỗi 2 giây.
- Ngay sau một loạt dồn, vẫn chấp nhận người dùng tiếp tục soạn ghi chú. App tự lưu khoảng **3 giây một lần**.
- Trả lời mọi request **ngay lập tức** bằng \`200\` hoặc \`429\`. App bỏ cuộc sau 10 giây, và API server không được giữ request treo.
- Chỉ lưu vài byte cho mỗi người dùng.`,
  },

  question: {
    en: 'Which algorithm do you switch the limiter to?',
    vi: 'Bạn chuyển bộ giới hạn sang thuật toán nào?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Sliding window log: keep the timestamp of every accepted request, and accept a new one only if fewer than 40 are from the last 80 seconds.',
        vi: 'Nhật ký cửa sổ trượt (sliding window log): lưu mốc thời gian của mọi request được chấp nhận, và chỉ nhận request mới nếu có ít hơn 40 cái trong 80 giây gần nhất.',
      },
      why: {
        en: 'It is exact, and 40 per 80 seconds does allow the burst and average 30 a minute. That pairing is also where it breaks. Once the app spends 40 on sync, the window stays full until those timestamps are 80 seconds old, so every autosave in between gets a `429`: the user is locked out for over a minute right after opening the app. Allow fewer than 40 and the burst fails. Use a shorter window and the average goes up. One count over one window cannot say "big burst, slow refill". It also costs the most memory: up to 40 timestamps per user, about 200 million entries for 5 million users. Use a log when limits are small and exactness is part of the contract.',
        vi: 'Nó chính xác, và 40 trong 80 giây đúng là cho qua loạt dồn và giữ trung bình 30 mỗi phút. Chính cặp số đó cũng là chỗ nó hỏng. Khi app tiêu hết 40 cho việc đồng bộ, cửa sổ vẫn đầy cho tới khi các mốc thời gian đó đủ 80 giây, nên mọi lần tự lưu trong khoảng đó đều nhận `429`: người dùng bị chặn hơn một phút ngay sau khi mở app. Cho ít hơn 40 thì loạt dồn hỏng. Thu ngắn cửa sổ thì trung bình tăng lên. Một con số đếm trên một cửa sổ không thể diễn đạt "dồn nhiều, nạp lại chậm". Nó cũng tốn bộ nhớ nhất: tới 40 mốc thời gian mỗi người dùng, khoảng 200 triệu phần tử cho 5 triệu người dùng. Hãy dùng log khi giới hạn nhỏ và độ chính xác là một phần của hợp đồng.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Sliding window counter: keep this window\'s and the previous window\'s counts, weight the previous one by how much of it still overlaps, and allow 40 per 80 seconds.',
        vi: 'Bộ đếm cửa sổ trượt (sliding window counter): giữ số đếm của cửa sổ này và cửa sổ trước, nhân số của cửa sổ trước với phần còn chồng lấn, và cho phép 40 trong 80 giây.',
      },
      why: {
        en: 'It fixes the log\'s memory problem with two counters per user, and it is a close approximation of the log. That is the problem: it approximates the same rule, so it inherits the same lockout. After the 40-request burst, the estimate stays near 40 for most of the next 80 seconds and autosaves are rejected. A sliding window counter is a good, cheap fix for a fixed window\'s boundary bursts when you want "N per T". Here the requirement is not "N per T" but "a burst of 40, then one every 2 seconds", which a window does not express.',
        vi: 'Nó giải quyết vấn đề bộ nhớ của log bằng hai bộ đếm mỗi người dùng, và xấp xỉ log khá sát. Đó lại chính là vấn đề: nó xấp xỉ cùng một quy tắc, nên thừa hưởng luôn việc chặn người dùng. Sau loạt 40 request, ước lượng gần 40 trong phần lớn 80 giây tiếp theo và các lần tự lưu bị từ chối. Bộ đếm cửa sổ trượt là cách sửa tốt và rẻ cho lỗi dồn ở ranh giới của cửa sổ cố định khi bạn muốn "N trong T". Ở đây yêu cầu không phải "N trong T" mà là "dồn 40, rồi mỗi 2 giây một cái", điều mà cửa sổ không diễn đạt được.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Leaky bucket: put each user\'s requests in a queue of up to 40 that drains at one request every 2 seconds, and reject only when the queue is full.',
        vi: 'Leaky bucket: đưa request của mỗi người dùng vào một hàng đợi tối đa 40, xả ra với tốc độ một request mỗi 2 giây, và chỉ từ chối khi hàng đợi đầy.',
      },
      why: {
        en: 'Nothing in the sync burst is rejected, but nothing is fast either. The queue releases one request every 2 seconds, so the 40th sync request waits about 80 seconds, eight times longer than the app is willing to wait, while an API server holds the connection open. Both are ruled out. A leaky bucket is a shaper: it turns bursty input into a steady output. That is right when the thing behind it must receive a steady rate, such as a partner API that allows exactly N calls per second. NGINX\'s `limit_req` works this way. Run as a meter that rejects instead of queuing, a leaky bucket admits exactly what a token bucket does.',
        vi: 'Không request nào trong loạt đồng bộ bị từ chối, nhưng cũng chẳng cái nào nhanh. Hàng đợi chỉ nhả một request mỗi 2 giây, nên request đồng bộ thứ 40 phải chờ khoảng 80 giây, gấp tám lần thời gian app chịu chờ, trong khi một API server giữ kết nối mở. Cả hai đều không được phép. Leaky bucket là bộ định hình (shaper): nó biến đầu vào dồn dập thành đầu ra đều đặn. Điều đó đúng khi thứ phía sau cần nhận một tốc độ đều, chẳng hạn API của đối tác chỉ cho phép đúng N lời gọi mỗi giây. `limit_req` của NGINX hoạt động theo cách này. Khi chạy như một bộ đo (meter) từ chối thay vì xếp hàng, leaky bucket cho qua đúng những gì token bucket cho qua.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Token bucket: give each user a bucket of 40 tokens that refills at one token every 2 seconds. Each request spends a token, or gets a `429` if the bucket is empty.',
        vi: 'Token bucket: cho mỗi người dùng một cái xô 40 token, được nạp lại một token mỗi 2 giây. Mỗi request tiêu một token, hoặc nhận `429` nếu xô rỗng.',
      },
      why: {
        en: 'It is the only option that separates burst size from rate: 40 is how much can go at once, and one every 2 seconds is how fast it comes back. The sync burst spends the full bucket. Tokens then return faster than autosave spends them (one every 2 seconds against one every 3), so the user who keeps editing never sees a `429`. Over time no one averages more than 30 a minute. Each request gets an immediate answer. Per user it stores two numbers, the tokens left and when they were last counted, and tops up lazily on each request, so no timer runs. Do the read, top-up and spend in one Redis Lua script so it stays atomic. Stripe and Envoy both rate-limit with token buckets. The trade-off: a user can get up to 40 + 30 = 70 requests into one minute after a quiet spell, which the database team has accepted as a short burst.',
        vi: 'Đây là phương án duy nhất tách kích thước loạt dồn khỏi tốc độ: 40 là lượng có thể đi cùng lúc, và mỗi 2 giây một token là tốc độ nạp lại. Loạt đồng bộ tiêu hết cả xô. Sau đó token quay lại nhanh hơn tốc độ tự lưu tiêu (mỗi 2 giây một token so với mỗi 3 giây một lần lưu), nên người dùng tiếp tục soạn không bao giờ thấy `429`. Về lâu dài không ai vượt trung bình 30 mỗi phút. Mỗi request được trả lời ngay. Mỗi người dùng chỉ lưu hai con số, số token còn lại và lần cuối được tính, và nạp bù một cách lười biếng mỗi khi có request, nên không cần timer nào chạy. Hãy làm việc đọc, nạp bù và tiêu trong một Lua script trên Redis để giữ tính nguyên tử. Stripe và Envoy đều giới hạn tần suất bằng token bucket. Đánh đổi: sau một khoảng yên lặng, một người dùng có thể đưa tới 40 + 30 = 70 request vào một phút, điều mà team database đã chấp nhận như một loạt dồn ngắn.',
      },
    },
  ],

  answer: 'D',

  takeaway: {
    en: `Each algorithm answers a different question. Pick the one whose question matches your contract.

- **Fixed window**: "at most N per clock minute". One counter. Lets up to 2× through across a window edge.
- **Sliding window log**: "at most N in any T seconds", exactly. Memory grows with N.
- **Sliding window counter**: the same rule, approximately, for two counters.
- **Token bucket**: "bursts up to B, then R per second". Two numbers per key, an immediate answer, and burst size and rate tuned separately. The usual choice for APIs.
- **Leaky bucket** (queue): "never more than R per second downstream". It delays instead of rejecting, which suits a fragile or strictly metered backend, not clients waiting on an answer.`,
    vi: `Mỗi thuật toán trả lời một câu hỏi khác nhau. Hãy chọn cái có câu hỏi khớp với hợp đồng của bạn.

- **Cửa sổ cố định**: "tối đa N mỗi phút theo đồng hồ". Một bộ đếm. Cho tới gấp đôi đi qua ở ranh giới cửa sổ.
- **Nhật ký cửa sổ trượt**: "tối đa N trong bất kỳ T giây nào", chính xác. Bộ nhớ tăng theo N.
- **Bộ đếm cửa sổ trượt**: cùng quy tắc đó, xấp xỉ, với giá hai bộ đếm.
- **Token bucket**: "dồn tối đa B, sau đó R mỗi giây". Hai con số mỗi key, trả lời ngay, và chỉnh riêng được kích thước dồn và tốc độ. Lựa chọn thường gặp cho API.
- **Leaky bucket** (hàng đợi): "không bao giờ quá R mỗi giây xuống phía sau". Nó trì hoãn thay vì từ chối, hợp với backend mong manh hay bị giới hạn nghiêm ngặt, không hợp với client đang chờ câu trả lời.`,
  },

  sources: [
    { title: 'Stripe: Scaling your API with rate limiters', url: 'https://stripe.com/blog/rate-limiters' },
    { title: 'Cloudflare: How we built rate limiting capable of scaling to millions of domains', url: 'https://blog.cloudflare.com/counting-things-a-lot-of-different-things/' },
    { title: 'NGINX documentation: ngx_http_limit_req_module', url: 'https://nginx.org/en/docs/http/ngx_http_limit_req_module.html' },
    { title: 'Envoy documentation: Local rate limit filter', url: 'https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/local_rate_limit_filter' },
  ],

  simulation,
};
