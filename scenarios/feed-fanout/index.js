import * as simulation from './sim.js';

export default {
  category: 'scalability',
  topic: { en: 'Feed fanout: push, pull and hybrid', vi: 'Fanout feed: push, pull và hybrid' },
  title: {
    en: 'One post, 1.5 million feeds',
    vi: 'Một bài đăng, 1,5 triệu feed',
  },

  scenario: {
    en: `You run the home feed for a photo-sharing app with **6 million users** and about **40,000 posts a day**. Most accounts have a couple of hundred followers. Last month a well-known footballer joined, and now has **1.5 million followers**.

Today the feed is built when it is read. When someone opens the app, the feed service asks the **4 read replicas** for recent posts from the ~250 accounts they follow, merges them and returns the newest 50. On an ordinary evening that is about **2,500 feed reads a second**. Together the replicas can serve about **4,400 of these merges a second** (about 1,100 each), and p99 is under 100 ms.

On Saturday the footballer posted, and the app sent a push notification to all 1.5M followers. About 450,000 of them opened the app over the next two minutes. The replicas fell behind, feed requests queued until they hit the 5-second timeout, and the app showed spinners and errors.

What you have to work with:
- A Redis cluster sized to keep a capped timeline list per user. It takes about **25,000 timeline writes a second** in total before its latency suffers, and that is its limit this quarter.
- The event stream you already run, whose consumer can update a per-user feed table in Postgres at about **10,000 rows a second**.
- A handful of accounts have more than **100,000 followers**, and the footballer is the biggest. Most users follow none of them, or one or two.

What the new design must do:
- **Feed reads stay fast**: p99 under 200 ms, including the minutes after a notification brings a big account's followers in.
- **Posts show up quickly**: a new post is in all its followers' feeds within 30 seconds, whoever posted it.`,
    vi: `Bạn phụ trách feed trang chủ của một app chia sẻ ảnh với **6 triệu người dùng** và khoảng **40.000 bài đăng mỗi ngày**. Phần lớn tài khoản có vài trăm follower. Tháng trước một cầu thủ bóng đá nổi tiếng tham gia, và giờ có **1,5 triệu follower**.

Hiện tại feed được dựng lúc đọc. Khi ai đó mở app, feed service hỏi **4 read replica** các bài mới của ~250 tài khoản người đó theo dõi, gộp lại và trả về 50 bài mới nhất. Vào một buổi tối bình thường, đó là khoảng **2.500 lượt đọc feed mỗi giây**. Cả nhóm replica phục vụ được khoảng **4.400 lượt gộp như vậy mỗi giây** (mỗi cái khoảng 1.100), và p99 dưới 100 ms.

Thứ Bảy vừa rồi cầu thủ đăng một bài, và app gửi push notification tới cả 1,5 triệu follower. Khoảng 450.000 người mở app trong hai phút sau đó. Các replica tụt lại phía sau, request đọc feed xếp hàng tới khi chạm timeout 5 giây, và app hiện vòng xoay chờ cùng thông báo lỗi.

Những gì bạn có trong tay:
- Một cluster Redis đủ chỗ để giữ một list timeline có giới hạn độ dài cho mỗi người dùng. Nó nhận được khoảng **25.000 lượt ghi timeline mỗi giây** tổng cộng trước khi độ trễ tăng, và đó là giới hạn của nó trong quý này.
- Event stream bạn đang chạy sẵn, với consumer có thể cập nhật một bảng feed theo từng người dùng trong Postgres ở mức khoảng **10.000 dòng mỗi giây**.
- Có vài tài khoản trên **100.000 follower**, và cầu thủ là tài khoản lớn nhất. Phần lớn người dùng không theo dõi ai trong số đó, hoặc chỉ một hai người.

Thiết kế mới phải làm được:
- **Đọc feed vẫn nhanh**: p99 dưới 200 ms, kể cả trong những phút sau khi một thông báo kéo follower của một tài khoản lớn vào app.
- **Bài đăng hiện ra nhanh**: một bài mới có mặt trong feed của tất cả follower trong vòng 30 giây, bất kể ai đăng.`,
  },

  question: {
    en: 'How should posts reach feeds?',
    vi: 'Bài đăng nên đi vào feed theo cách nào?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Fanout on write: when anyone posts, workers push the post ID into each follower’s timeline list in Redis, capped with `LTRIM`. A feed read is one list fetch.',
        vi: 'Fanout on write: khi ai đó đăng bài, worker đẩy ID của bài vào list timeline của từng follower trong Redis, giới hạn độ dài bằng `LTRIM`. Một lượt đọc feed là lấy đúng một list.',
      },
      why: {
        en: 'Reads become cheap: one list fetch, a few milliseconds even in the notification rush. The cost moves to the write path, and it grows with the follower count. An ordinary post is about 200 writes. The footballer’s is 1.5 million, a full minute of the cluster’s 25,000 a second. For that minute the post is missing from many of the feeds the notification just sent people to. With one queue, every ordinary post made in that minute waits behind it too. A separate queue for big accounts would rescue the ordinary posts but not the footballer’s, since a minute is still twice the limit. Push is the right default for accounts with a bounded audience. Twitter fanned out to Redis timelines this way, and reported that a tweet from one of its largest accounts could take minutes to reach every follower.',
        vi: 'Lượt đọc trở nên rẻ: lấy một list, vài mili giây kể cả trong đợt dồn từ thông báo. Chi phí dời sang đường ghi, và tăng theo số follower. Một bài thường khoảng 200 lượt ghi. Bài của cầu thủ là 1,5 triệu, tròn một phút trong 25.000 lượt mỗi giây của cluster. Trong phút đó, bài vắng mặt ở rất nhiều feed mà thông báo vừa đưa người ta tới. Vì chỉ có một hàng đợi, mọi bài thường đăng trong phút đó cũng phải chờ phía sau. Một hàng đợi riêng cho tài khoản lớn sẽ cứu được bài thường, nhưng không cứu được bài của cầu thủ, vì một phút vẫn gấp đôi giới hạn. Push là lựa chọn mặc định đúng cho những tài khoản có lượng người xem giới hạn. Twitter đã fanout vào timeline trên Redis theo cách này, và kể rằng tweet của một trong những tài khoản lớn nhất có thể mất vài phút mới tới được mọi follower.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Keep fanout on read, which keeps writes trivial and posts always fresh, and double the read replicas to 8 so the feed merge has headroom.',
        vi: 'Giữ fanout on read, vốn giúp việc ghi đơn giản và bài luôn mới, rồi tăng gấp đôi read replica lên 8 để việc gộp feed có dư địa.',
      },
      why: {
        en: 'Writes stay at one row per post, and a post is in every feed the moment it exists, since nothing is copied ahead. But each read costs a merge across ~250 accounts, and a notification to 1.5M followers turns into a rush of reads: 2,500 a second plus up to about 8,300 more at the peak. Eight replicas serve about 8,800. For half a minute the rush beats them, the queue builds and p99 reaches seconds. More replicas move the cliff, and the next bigger account or the next notification pushes past it again. Pull is the right model when reads are rare compared with writes, or for accounts so big that copying their posts is wasteful. That second case is half of the right answer.',
        vi: 'Việc ghi vẫn là một dòng mỗi bài, và một bài có mặt trong mọi feed ngay khi nó tồn tại, vì không có gì được chép trước. Nhưng mỗi lượt đọc phải gộp ~250 tài khoản, và một thông báo tới 1,5 triệu follower biến thành một đợt dồn lượt đọc: 2.500 mỗi giây cộng thêm tới khoảng 8.300 ở đỉnh. Tám replica phục vụ được khoảng 8.800. Trong nửa phút đợt dồn vượt qua chúng, hàng đợi dài ra và p99 lên tới vài giây. Thêm replica chỉ dời vách đá đi chỗ khác, và tài khoản lớn hơn tiếp theo hay thông báo tiếp theo lại vượt qua nó. Pull là mô hình đúng khi lượt đọc hiếm so với lượt ghi, hoặc cho những tài khoản lớn tới mức chép bài của họ là lãng phí. Trường hợp thứ hai đó là một nửa của đáp án đúng.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Hybrid: fan out on write for accounts up to 100,000 followers. Accounts above that write each post once, to their own capped list in Redis, and the feed service merges the lists of the few big accounts a user follows into that user’s timeline at read time.',
        vi: 'Hybrid: fanout on write cho tài khoản tới 100.000 follower. Tài khoản trên mức đó ghi mỗi bài một lần, vào list riêng có giới hạn độ dài trong Redis, và feed service gộp list của vài tài khoản lớn mà người dùng theo dõi vào timeline của người đó lúc đọc.',
      },
      why: {
        en: 'Each account is delivered the way that is cheap for it. Ordinary posts cost about 200 writes each, around 400 a second in all, far below the 25,000 limit, so they reach feeds in under a second. The footballer’s post is one write, and it is in every follower’s feed on their next read. A read is the user’s timeline plus the lists of the big accounts they follow, usually one or two: a few milliseconds, even at 10,800 reads a second. That is load a cache handles easily, unlike a merge across 250 accounts on a replica. The costs are two read paths to maintain, a threshold to choose, and a migration when an account crosses it. Many readers hit the same hot list at once, so keep it short and cache it in the feed service’s memory for a second or two, so that one Redis key does not become the bottleneck.',
        vi: 'Mỗi tài khoản được giao theo cách rẻ nhất cho nó. Bài thường tốn khoảng 200 lượt ghi mỗi bài, tổng cộng chừng 400 mỗi giây, thấp xa so với giới hạn 25.000, nên chúng vào feed trong chưa đầy một giây. Bài của cầu thủ là một lượt ghi, và nó có mặt trong feed của mọi follower ngay lần đọc kế tiếp. Một lượt đọc là timeline của người dùng cộng với list của các tài khoản lớn họ theo dõi, thường chỉ một hai cái: vài mili giây, kể cả ở mức 10.800 lượt đọc mỗi giây. Đó là tải mà cache kham dễ dàng, khác hẳn việc gộp 250 tài khoản trên một replica. Cái giá là hai đường đọc phải duy trì, một ngưỡng phải chọn, và một lần chuyển đổi khi một tài khoản vượt ngưỡng. Rất nhiều người đọc cùng một hot list cùng lúc, nên hãy giữ nó ngắn và cache nó trong bộ nhớ của feed service một hai giây, để một key Redis không trở thành nút thắt.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'A materialized feed table: a stream consumer writes each new post into a per-user feed row in Postgres, and a feed read is a single row lookup.',
        vi: 'Một bảng feed materialized: một consumer của stream ghi mỗi bài mới vào dòng feed của từng người dùng trong Postgres, và một lượt đọc feed là tra đúng một dòng.',
      },
      why: {
        en: 'This is fanout on write with a different store. Reads are one row and stay fast. But every post is still copied once per follower, and Postgres takes those row updates at about 10,000 a second, so the footballer’s post is two and a half minutes of work, five times the limit. Ordinary posts wait behind it, because the consumer works through the stream in order. Each update also rewrites a row that keeps growing, which costs write amplification and vacuum work. Eventual consistency is fine for a feed, but this one is far too eventual. A feed table can be a durable store behind a cache, used to rebuild timelines after the cache loses them. It does not fix write amplification.',
        vi: 'Đây là fanout on write với một kho lưu khác. Lượt đọc là một dòng và vẫn nhanh. Nhưng mỗi bài vẫn bị chép một lần cho mỗi follower, và Postgres nhận các lượt cập nhật dòng đó ở mức khoảng 10.000 mỗi giây, nên bài của cầu thủ là hai phút rưỡi công việc, gấp năm lần giới hạn. Bài thường phải chờ phía sau, vì consumer xử lý stream theo thứ tự. Mỗi lượt cập nhật còn ghi lại một dòng ngày càng lớn, tốn write amplification và công vacuum. Nhất quán cuối cùng (eventual consistency) thì ổn cho feed, nhưng ở đây "cuối cùng" quá lâu. Một bảng feed có thể là kho bền vững phía sau cache, dùng để dựng lại timeline khi cache mất dữ liệu. Nó không giải quyết được write amplification.',
      },
    },
  ],

  answer: 'C',

  takeaway: {
    en: `Fanout is a choice of when to pay for a post: at write time, once per follower, or at read time, once per reader.

- **Push (fanout on write)** costs writes in proportion to followers. Reads are cheap. It breaks for accounts with huge audiences.
- **Pull (fanout on read)** costs a merge across every followed account on every read. Writes are free and feeds are always fresh. It breaks when reads rush in.
- **Hybrid** pushes for the many small accounts and pulls for the few huge ones. Where to draw the line is a cost comparison. Yahoo's *Feeding Frenzy* paper makes the choice per producer and consumer pair, from their posting and reading rates.

Whichever you choose, store post IDs rather than posts, cap each timeline (Twitter kept 800 entries per home timeline), and rebuild a timeline from durable storage when the cache loses it.`,
    vi: `Fanout là lựa chọn trả giá cho một bài đăng vào lúc nào: lúc ghi, một lần cho mỗi follower, hay lúc đọc, một lần cho mỗi người đọc.

- **Push (fanout on write)** tốn lượt ghi tỉ lệ với số follower. Đọc thì rẻ. Nó gãy với những tài khoản có lượng người xem khổng lồ.
- **Pull (fanout on read)** tốn một lần gộp qua mọi tài khoản được theo dõi ở mỗi lượt đọc. Ghi thì gần như miễn phí và feed luôn mới. Nó gãy khi lượt đọc dồn tới.
- **Hybrid** dùng push cho rất nhiều tài khoản nhỏ và pull cho vài tài khoản khổng lồ. Vạch ranh giới ở đâu là một phép so sánh chi phí. Bài báo *Feeding Frenzy* của Yahoo chọn cho từng cặp người đăng và người đọc, dựa trên tần suất đăng và đọc của họ.

Dù chọn cách nào, hãy lưu ID của bài thay vì cả bài, giới hạn độ dài mỗi timeline (Twitter giữ 800 mục cho mỗi home timeline), và dựng lại timeline từ kho lưu bền vững khi cache mất nó.`,
  },

  sources: [
    { title: 'High Scalability: The architecture Twitter uses to deal with 150M active users (2013)', url: 'https://highscalability.com/the-architecture-twitter-uses-to-deal-with-150m-active-users/' },
    { title: 'Raffi Krikorian, InfoQ: Timelines at Scale (2013)', url: 'https://www.infoq.com/presentations/Twitter-Timeline-Scalability/' },
    { title: 'Silberstein, Terrace, Cooper, Ramakrishnan: Feeding Frenzy: Selectively Materializing Users’ Event Feeds (SIGMOD 2010)', url: 'https://sns.cs.princeton.edu/assets/papers/2010-sigmod-silberstein.pdf' },
    { title: 'Redis documentation: LTRIM, and capped lists with LPUSH', url: 'https://redis.io/docs/latest/commands/ltrim/' },
    { title: 'Martin Kleppmann: Designing Data-Intensive Applications, chapter 1 (describing load: home timelines)', url: 'https://www.oreilly.com/library/view/designing-data-intensive-applications/9781491903063/' },
  ],

  simulation,
};
