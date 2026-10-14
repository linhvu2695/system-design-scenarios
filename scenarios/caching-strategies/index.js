import * as simulation from './sim.js';

export default {
  category: 'caching',
  topic: { en: 'Caching strategies', vi: 'Chiến lược caching' },
  title: {
    en: 'Breaking news breaks the counter',
    vi: 'Tin nóng làm sập bộ đếm',
  },

  scenario: {
    en: `You run a news site. Every article page shows a live **view counter** ("1.2M views"), stored in Postgres as \`articles.views\`. Each page view runs:

\`\`\`
UPDATE articles SET views = views + 1 WHERE id = $1
\`\`\`

On a normal day that is fine. During breaking news it is not: about **150,000 views a second** land on a handful of articles, and every one of them updates **the same few rows**. Each update waits for the row lock held by the one before it. Updates queue up, connections run out, and the article pages themselves start timing out, so the counter takes the whole site down with it.

You already run Redis next to Postgres for article text.

Constraints:
- Postgres must see **a few hundred counter writes a second at most**, however busy the news gets.
- The number on the page may **trail by a few seconds**. Nobody needs it exact to the view.
- If Redis dies, losing **a few seconds of views is acceptable**. Ad billing does not use this counter; it is counted separately from the request logs.
- A page view must not wait on Postgres.`,
    vi: `Bạn vận hành một trang tin tức. Mỗi trang bài viết hiển thị một **bộ đếm lượt xem** trực tiếp ("1,2 triệu lượt xem"), lưu trong Postgres ở \`articles.views\`. Mỗi lượt xem trang chạy:

\`\`\`
UPDATE articles SET views = views + 1 WHERE id = $1
\`\`\`

Ngày thường thì ổn. Lúc có tin nóng thì không: khoảng **150.000 lượt xem mỗi giây** dồn vào một nhóm nhỏ bài viết, và mỗi lượt đều cập nhật **cùng vài dòng**. Mỗi lệnh cập nhật phải chờ khoá dòng mà lệnh trước đang giữ. Các lệnh xếp hàng, hết connection, và chính các trang bài viết bắt đầu timeout, nên bộ đếm kéo sập cả trang web.

Bạn đã chạy Redis bên cạnh Postgres để cache nội dung bài viết.

Ràng buộc:
- Postgres chỉ được nhận **tối đa vài trăm lượt ghi bộ đếm mỗi giây**, dù tin tức nóng đến đâu.
- Con số trên trang được phép **trễ vài giây**. Không ai cần chính xác tới từng lượt.
- Nếu Redis sập, mất **vài giây lượt xem là chấp nhận được**. Việc tính tiền quảng cáo không dùng bộ đếm này; nó được đếm riêng từ log request.
- Một lượt xem trang không được phải chờ Postgres.`,
  },

  question: {
    en: 'Which caching strategy do you use for the view counter?',
    vi: 'Bạn dùng chiến lược caching nào cho bộ đếm lượt xem?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Cache-aside: read the count from Redis and load it from Postgres on a miss. On each view, update Postgres, then delete the Redis key so the next read loads the new count.',
        vi: 'Cache-aside: đọc số đếm từ Redis và nạp từ Postgres khi cache miss. Mỗi lượt xem, cập nhật Postgres rồi xoá key trong Redis để lần đọc sau nạp số mới.',
      },
      why: {
        en: 'It caches the reads, but the problem is the writes, and they are unchanged: every view is still an `UPDATE` on the same hot row, 150,000 a second. It makes reads worse too. Each view deletes the key, so at this rate the key is almost never there, and nearly every read misses and goes to Postgres as well. Cache-aside is the right default for data that is read far more often than it changes, such as the article text itself.',
        vi: 'Nó cache phần đọc, nhưng vấn đề nằm ở phần ghi, và phần ghi không đổi: mỗi lượt xem vẫn là một lệnh `UPDATE` trên cùng một dòng nóng, 150.000 lần mỗi giây. Nó còn làm phần đọc tệ hơn. Mỗi lượt xem xoá key, nên ở tốc độ này key gần như không bao giờ tồn tại, và gần như mọi lần đọc đều miss rồi cũng đi tới Postgres. Cache-aside là lựa chọn mặc định đúng cho dữ liệu được đọc nhiều hơn thay đổi rất nhiều, như chính nội dung bài viết.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Write-through: on each view, increment the count in Redis and update Postgres in the same request, so the cache and the database always agree.',
        vi: 'Write-through: mỗi lượt xem, tăng số đếm trong Redis và cập nhật Postgres trong cùng request, để cache và database luôn khớp nhau.',
      },
      why: {
        en: 'Readers always see a fresh number from Redis, which is write-through\'s strength. But every view still writes to Postgres, synchronously, so it keeps all 150,000 updates a second on the same rows and makes the page view wait for both. Write-through fits data written rarely and read right after, such as a user changing their profile, where the extra write latency is worth an always-fresh cache.',
        vi: 'Người đọc luôn thấy số mới từ Redis, đó là điểm mạnh của write-through. Nhưng mỗi lượt xem vẫn ghi vào Postgres, một cách đồng bộ, nên nó giữ nguyên 150.000 lệnh cập nhật mỗi giây trên cùng các dòng và bắt lượt xem trang chờ cả hai. Write-through hợp với dữ liệu ít khi ghi và được đọc ngay sau đó, như người dùng sửa hồ sơ, khi độ trễ ghi thêm đáng để đổi lấy một cache luôn mới.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Write-behind: each view increments the count in Redis (`INCR`) and returns. Every few seconds a background job takes each article\'s accumulated increments and adds them to Postgres in one update.',
        vi: 'Write-behind: mỗi lượt xem tăng số đếm trong Redis (`INCR`) rồi trả về. Cứ vài giây, một job chạy nền lấy tổng số lượt tăng tích luỹ của từng bài viết và cộng vào Postgres bằng một lệnh cập nhật.',
      },
      why: {
        en: 'It is the only option that changes the number of database writes. A Redis `INCR` is atomic and takes microseconds, so 150,000 views a second never touch Postgres. Every 5 seconds the flusher atomically reads and resets each hot article\'s pending count (for example with `GETDEL`) and runs one `UPDATE ... SET views = views + $delta`: that is one write per active article per flush, a few hundred a second at most, however big the spike. Pages read the count from Redis, so they are fresh. The cost is exactly what the constraints allow: if Redis dies before a flush, the increments it held are lost, up to one flush interval. Redis persistence (the append-only file synced every second) shrinks that further. Write-behind is wrong for money or stock, where a lost write is a real loss.',
        vi: 'Đây là phương án duy nhất thay đổi số lần ghi database. Một lệnh `INCR` trong Redis là nguyên tử và mất vài micro giây, nên 150.000 lượt xem mỗi giây không hề chạm vào Postgres. Cứ 5 giây, flusher đọc và reset một cách nguyên tử số lượt đang chờ của từng bài viết nóng (ví dụ bằng `GETDEL`) rồi chạy một lệnh `UPDATE ... SET views = views + $delta`: mỗi bài viết đang hoạt động một lần ghi cho mỗi lần flush, nhiều nhất vài trăm mỗi giây, dù đợt tăng vọt lớn đến đâu. Trang đọc số đếm từ Redis, nên luôn mới. Cái giá đúng bằng những gì ràng buộc cho phép: nếu Redis sập trước khi flush, các lượt tăng nó đang giữ sẽ mất, tối đa một chu kỳ flush. Cơ chế lưu trữ của Redis (file append-only fsync mỗi giây) còn thu nhỏ con số đó hơn nữa. Write-behind là lựa chọn sai cho tiền hay tồn kho, nơi mất một lượt ghi là mất thật.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Read-through: the cache loads the count from Postgres itself on a miss and keeps it for 10 seconds. Views keep updating Postgres directly.',
        vi: 'Read-through: cache tự nạp số đếm từ Postgres khi miss và giữ nó 10 giây. Các lượt xem vẫn cập nhật trực tiếp Postgres.',
      },
      why: {
        en: 'It takes nearly all the reads off Postgres: one load per article every 10 seconds. That is useful, but reads were never the problem. Every view is still an `UPDATE` on the hot row, so the lock queue and the timeouts stay exactly where they were. Readers also see a number up to 10 seconds old, which is allowed here but buys nothing. Read-through, like cache-aside, is for read-heavy data. The difference is only who loads the miss: the cache layer instead of your code.',
        vi: 'Nó lấy gần hết lượt đọc khỏi Postgres: mỗi bài viết một lần nạp mỗi 10 giây. Hữu ích, nhưng phần đọc chưa bao giờ là vấn đề. Mỗi lượt xem vẫn là một lệnh `UPDATE` trên dòng nóng, nên hàng đợi khoá và các lần timeout vẫn y nguyên. Người đọc còn thấy con số cũ tới 10 giây, được phép ở đây nhưng chẳng đổi lại được gì. Read-through, giống cache-aside, dành cho dữ liệu được đọc nhiều. Khác biệt chỉ là ai nạp khi miss: tầng cache thay vì code của bạn.',
      },
    },
  ],

  answer: 'C',

  takeaway: {
    en: `Pick a caching strategy by asking which side hurts: reads or writes, and what a stale or lost value costs.

- **Cache-aside**: your code reads the cache, loads from the database on a miss, and deletes the key after a write. The default for read-heavy data.
- **Read-through**: the same, but the cache layer loads the miss itself. Usually paired with a TTL, so readers can see values up to that old.
- **Write-through**: every write updates the cache and the database together. Always-fresh reads, but writes are slower and the database still takes every write.
- **Write-behind**: writes go to the cache and are flushed to the database later, batched. It absorbs write spikes, and the price is losing whatever has not been flushed when the cache dies. Use it for counters, likes and metrics, never for money.`,
    vi: `Chọn chiến lược caching bằng cách hỏi phía nào đang đau: đọc hay ghi, và một giá trị cũ hay bị mất thì tốn bao nhiêu.

- **Cache-aside**: code của bạn đọc cache, nạp từ database khi miss, và xoá key sau khi ghi. Mặc định cho dữ liệu đọc nhiều.
- **Read-through**: giống vậy, nhưng tầng cache tự nạp khi miss. Thường đi kèm TTL, nên người đọc có thể thấy giá trị cũ tới mức đó.
- **Write-through**: mỗi lần ghi cập nhật cả cache và database cùng lúc. Đọc luôn mới, nhưng ghi chậm hơn và database vẫn nhận mọi lượt ghi.
- **Write-behind**: ghi vào cache rồi flush xuống database sau, theo lô. Nó hấp thụ được các đợt ghi tăng vọt, và cái giá là mất những gì chưa kịp flush khi cache sập. Dùng cho bộ đếm, lượt thích và số liệu, không bao giờ cho tiền.`,
  },

  sources: [
    { title: 'AWS ElastiCache documentation: Caching strategies (lazy loading, write-through, TTL)', url: 'https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Strategies.html' },
    { title: 'Microsoft Azure Architecture Center: Cache-Aside pattern', url: 'https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside' },
    { title: 'Redis documentation: INCR (the counter pattern)', url: 'https://redis.io/docs/latest/commands/incr/' },
    { title: 'Redis documentation: Persistence (AOF fsync policies)', url: 'https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/' },
  ],

  simulation,
};
