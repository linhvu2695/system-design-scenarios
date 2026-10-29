import * as simulation from './sim.js';

export default {
  category: 'caching',
  topic: { en: 'Cache stampede', vi: 'Cache stampede' },
  title: {
    en: 'The home page flinches every minute',
    vi: 'Trang chủ giật mình mỗi phút',
  },

  scenario: {
    en: `Your news app's home page shows one **"Trending now"** feed, the same for every reader. Building it is expensive: a Postgres query that ranks the last hour of reading activity. It takes about **400 ms** and **two and a half of the database's 8 cores** while it runs. When Postgres is busy it can take 2 seconds.

The API runs on **40 Node.js pods** (autoscaled between 20 and 60). Each request reads the feed from Redis, key \`feed:home\`, **TTL 60 seconds**. On a miss, the request runs the query and writes the result back.

At the evening peak, about **9,000 requests a second** hit the home page. Once a minute, the dashboards show the same picture: the key expires, hundreds of feed queries start at once, Postgres CPU pins at 100%, checkout slows down, and home page requests time out for several seconds until one query finally finishes and refills the key.

Constraints:
- **Never more than one feed query at a time.** Two at once already slow checkout.
- **p99 latency of the home page under 150 ms, measured every second**, including the moment the feed is rebuilt.
- The feed may be **up to 60 seconds old**. Nobody notices a trending list that is half a minute behind.
- Pods come and go with autoscaling, and any pod, including a background worker, can be evicted.`,
    vi: `Trang chủ của ứng dụng tin tức hiển thị một feed **"Đang thịnh hành"**, giống nhau cho mọi người đọc. Dựng nó rất tốn kém: một truy vấn Postgres xếp hạng hoạt động đọc trong một giờ qua. Nó mất khoảng **400 ms** và dùng **hai lõi rưỡi trong 8 lõi của database** khi chạy. Lúc Postgres bận, nó có thể mất 2 giây.

API chạy trên **40 pod Node.js** (autoscale từ 20 tới 60). Mỗi request đọc feed từ Redis, key \`feed:home\`, **TTL 60 giây**. Khi miss, request chạy truy vấn rồi ghi kết quả lại.

Giờ cao điểm buổi tối, khoảng **9.000 request mỗi giây** vào trang chủ. Cứ mỗi phút, dashboard lại cho thấy cùng một cảnh: key hết hạn, hàng trăm truy vấn feed bắt đầu cùng lúc, CPU của Postgres kịch 100%, thanh toán chậm lại, và request trang chủ bị timeout trong vài giây cho tới khi một truy vấn cuối cùng xong và nạp lại key.

Ràng buộc:
- **Không bao giờ quá một truy vấn feed cùng lúc.** Hai truy vấn cùng lúc đã làm chậm thanh toán.
- **p99 độ trễ trang chủ dưới 150 ms, đo từng giây**, kể cả lúc feed được dựng lại.
- Feed được phép **cũ tối đa 60 giây**. Không ai để ý một danh sách thịnh hành trễ nửa phút.
- Pod đến và đi theo autoscale, và bất kỳ pod nào, kể cả một worker chạy nền, đều có thể bị evict.`,
  },

  question: {
    en: 'How do you stop the stampede?',
    vi: 'Bạn chặn cơn stampede này thế nào?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Lock the rebuild: on a miss, the first request takes a Redis lock (`SET NX` with a short expiry) and rebuilds the feed. Every other request checks again every 50 ms until the key is back.',
        vi: 'Lock khi dựng lại: khi miss, request đầu tiên lấy một lock trong Redis (`SET NX` với thời hạn ngắn) và dựng lại feed. Mọi request khác kiểm tra lại mỗi 50 ms cho tới khi key có lại.',
      },
      why: {
        en: 'It protects Postgres completely: one query per expiry. But the key is still gone while that query runs, and every request in that window waits for it. At 9,000 a second, a 400 ms rebuild parks about 3,600 requests, so the second that contains the rebuild has a p99 of around 400 ms, and 2 seconds when Postgres is slow. Every minute. Facebook\'s memcache uses the same idea, leases, so that only the first client to miss goes to the database. A lock works much better when the waiting requests can be given the previous value instead of waiting. But plain expiry has already deleted that previous value.',
        vi: 'Nó bảo vệ Postgres hoàn toàn: mỗi lần hết hạn chỉ một truy vấn. Nhưng key vẫn biến mất trong lúc truy vấn đó chạy, và mọi request trong khoảng đó phải chờ. Với 9.000 request mỗi giây, một lần dựng lại 400 ms giữ lại khoảng 3.600 request, nên giây chứa lần dựng lại có p99 khoảng 400 ms, và 2 giây khi Postgres chậm. Mỗi phút một lần. Memcache của Facebook dùng cùng ý tưởng này, gọi là lease, để chỉ client miss đầu tiên được đi tới database. Lock hiệu quả hơn nhiều khi các request đang chờ được trả giá trị cũ thay vì phải chờ. Nhưng hết hạn kiểu thông thường đã xoá mất giá trị cũ đó.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Probabilistic early refresh (XFetch): on every read, a request rebuilds the feed early with a probability that rises as the TTL runs out, so the key is usually refreshed before it ever expires.',
        vi: 'Refresh sớm theo xác suất (XFetch): mỗi lần đọc, request dựng lại feed sớm với xác suất tăng dần khi TTL sắp hết, nên key thường được refresh trước khi kịp hết hạn.',
      },
      why: {
        en: 'Readers stop seeing misses: the key is rebuilt a few seconds before it expires, and everyone else keeps reading the old value meanwhile. It needs no lock and no extra process, which makes it great for many hot keys you cannot list in advance. What it cannot do is promise one rebuild. The winners do not know about each other, so with 9,000 reads a second another read can win while the first rebuild is still running: two feed queries at once at peak. When Postgres is slow it gets worse. The rebuild takes longer, so the early window opens wider and more readers win: the simulation shows eight at once. Adding a lock to stop the duplicates brings back the coordination it was meant to avoid. For one key you know about, a schedule is simpler.',
        vi: 'Người đọc không còn gặp miss: key được dựng lại vài giây trước khi hết hạn, và mọi người khác vẫn đọc giá trị cũ trong lúc đó. Nó không cần lock, không cần thêm process, nên rất hợp với nhiều key nóng mà bạn không liệt kê trước được. Điều nó không hứa được là chỉ dựng lại một lần. Các request trúng không biết về nhau, nên với 9.000 lần đọc mỗi giây, một lần đọc khác có thể trúng trong lúc lần dựng đầu tiên còn đang chạy: hai truy vấn feed cùng lúc giờ cao điểm. Khi Postgres chậm thì còn tệ hơn. Dựng lại lâu hơn, nên cửa sổ refresh sớm mở rộng hơn và nhiều người đọc trúng hơn: mô phỏng cho thấy tám truy vấn cùng lúc. Thêm lock để chặn các lần trùng lại mang về đúng sự phối hợp mà nó muốn tránh. Với một key mà bạn biết rõ, chạy theo lịch đơn giản hơn.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Coalesce requests: in each API pod, concurrent misses for the feed share one in-flight database query and all get its result.',
        vi: 'Gộp request: trong mỗi API pod, các lần miss đồng thời cho feed dùng chung một truy vấn database đang chạy và cùng nhận kết quả của nó.',
      },
      why: {
        en: 'It collapses thousands of queries into one per pod, but there are 40 pods (60 when autoscaled), each with its own query. Forty feed queries at once is still a stampede: they share the CPU, each takes several times longer, and every request in every pod waits for its pod\'s query. The key still expires, so it still happens every minute. Coalescing, like Go\'s `singleflight`, is a cheap and useful backstop inside a process. It does not reach across processes.',
        vi: 'Nó gộp hàng nghìn truy vấn thành một truy vấn mỗi pod, nhưng có 40 pod (60 khi autoscale), mỗi pod một truy vấn. Bốn mươi truy vấn feed cùng lúc vẫn là một cơn stampede: chúng chia nhau CPU, mỗi truy vấn lâu hơn nhiều lần, và mọi request trong mọi pod phải chờ truy vấn của pod mình. Key vẫn hết hạn, nên chuyện này vẫn xảy ra mỗi phút. Gộp request, như `singleflight` của Go, là một lớp dự phòng rẻ và hữu ích trong một process. Nó không vươn qua được các process khác.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Refresh ahead: one scheduled worker rebuilds the feed every 20 seconds and writes it with a 5-minute TTL. Requests only read the key, and an alert fires if the feed is ever older than 45 seconds.',
        vi: 'Refresh trước: một worker chạy theo lịch dựng lại feed mỗi 20 giây và ghi với TTL 5 phút. Request chỉ đọc key, và cảnh báo bật nếu feed cũ hơn 45 giây.',
      },
      why: {
        en: 'The key never expires under traffic, so there is no moment to stampede. Postgres runs exactly one feed query every 20 seconds, however many readers or pods there are. Every request is a Redis read, so the p99 does not move when the feed is rebuilt, and the feed is at most about 20 seconds old. The long TTL is the safety net: if the worker\'s pod is evicted, readers keep getting the last feed for up to 5 minutes while it is rescheduled, and the age alert says so long before the key could expire. Run the worker as a single scheduled job (or behind leader election) so two copies never refresh at once, and keep per-pod coalescing as a backstop for the day the key is missing anyway. The trade-offs: the feed is rebuilt even when nobody is reading, which is cheap for one key, and this only works for keys you know in advance. It is the same idea as Caffeine\'s `refreshAfterWrite`: refresh before expiry, keep serving the old value.',
        vi: 'Key không bao giờ hết hạn khi đang có lưu lượng, nên không có khoảnh khắc nào để stampede. Postgres chạy đúng một truy vấn feed mỗi 20 giây, bất kể có bao nhiêu người đọc hay bao nhiêu pod. Mọi request đều là một lần đọc Redis, nên p99 không nhúc nhích khi feed được dựng lại, và feed cũ tối đa khoảng 20 giây. TTL dài là lưới an toàn: nếu pod của worker bị evict, người đọc vẫn nhận feed cuối cùng trong tối đa 5 phút trong lúc nó được lên lịch lại, và cảnh báo tuổi feed báo động từ lâu trước khi key có thể hết hạn. Chạy worker như một job theo lịch duy nhất (hoặc sau leader election) để không bao giờ có hai bản cùng refresh, và giữ việc gộp request trong từng pod làm lớp dự phòng cho ngày key vẫn bị mất. Đánh đổi: feed vẫn được dựng lại kể cả khi không ai đọc, rất rẻ với một key, và cách này chỉ dùng được cho những key bạn biết trước. Đây cũng là ý tưởng của `refreshAfterWrite` trong Caffeine: refresh trước khi hết hạn, vẫn phục vụ giá trị cũ.',
      },
    },
  ],

  answer: 'D',

  takeaway: {
    en: `A cache stampede (thundering herd) happens when a hot key disappears and every reader tries to rebuild it at once. The fixes differ in **who rebuilds** and **what everyone else gets meanwhile**.

- **Lock**: one rebuilder, everyone else waits. Protects the database, costs latency, unless waiters can be given a stale copy.
- **Probabilistic early refresh**: a random reader rebuilds before expiry. No coordination and no misses, but duplicate rebuilds under heavy traffic. Best for many keys you cannot list.
- **Coalescing**: one rebuild per process. A cheap backstop; with many processes it is still many rebuilds.
- **Refresh ahead**: a scheduler rebuilds before expiry and the TTL is only a safety net. Best for a few known, very hot keys: the key never goes missing, so there is nothing to stampede.

In practice they combine: refresh ahead for the keys you know, early refresh or a lock for the long tail, and coalescing everywhere as the last line.`,
    vi: `Cache stampede (thundering herd) xảy ra khi một key nóng biến mất và mọi người đọc cùng lúc cố dựng lại nó. Các cách sửa khác nhau ở chỗ **ai dựng lại** và **mọi người khác nhận gì trong lúc đó**.

- **Lock**: một người dựng lại, mọi người khác chờ. Bảo vệ database, tốn độ trễ, trừ khi người chờ được trả bản cũ.
- **Refresh sớm theo xác suất**: một người đọc ngẫu nhiên dựng lại trước khi hết hạn. Không cần phối hợp, không có miss, nhưng có dựng lại trùng khi lưu lượng lớn. Hợp nhất cho nhiều key không liệt kê trước được.
- **Gộp request**: mỗi process dựng lại một lần. Lớp dự phòng rẻ; nhiều process thì vẫn là nhiều lần dựng lại.
- **Refresh trước**: một bộ lập lịch dựng lại trước khi hết hạn, TTL chỉ còn là lưới an toàn. Hợp nhất cho vài key đã biết, rất nóng: key không bao giờ mất, nên không có gì để stampede.

Trong thực tế chúng được kết hợp: refresh trước cho các key bạn biết, refresh sớm hoặc lock cho phần đuôi dài, và gộp request ở mọi nơi như tuyến phòng thủ cuối cùng.`,
  },

  sources: [
    { title: 'Vattani, Chierichetti, Lowenstein: Optimal Probabilistic Cache Stampede Prevention (VLDB 2015)', url: 'https://www.vldb.org/pvldb/vol8/p886-vattani.pdf' },
    { title: 'Nishtala et al.: Scaling Memcache at Facebook (NSDI 2013), leases and thundering herds', url: 'https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala' },
    { title: 'Go package documentation: golang.org/x/sync/singleflight', url: 'https://pkg.go.dev/golang.org/x/sync/singleflight' },
    { title: 'Caffeine wiki: Refresh (refreshAfterWrite)', url: 'https://github.com/ben-manes/caffeine/wiki/Refresh' },
    { title: 'Redis documentation: SET (NX and expiry options)', url: 'https://redis.io/docs/latest/commands/set/' },
  ],

  simulation,
};
