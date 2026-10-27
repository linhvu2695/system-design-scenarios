import * as simulation from './sim.js';

export default {
  category: 'caching',
  topic: { en: 'Bloom filters', vi: 'Bloom filter' },
  title: {
    en: 'Millions of requests for links that were never there',
    vi: 'Hàng triệu request cho những link chưa từng tồn tại',
  },

  scenario: {
    en: `You run a **link shortener**: a 7-character code such as \`q7Xa2Kp\` redirects to a long URL. There are **2 billion links**, and links are never deleted (a link can be disabled, but its code stays taken).

A redirect looks the code up in **Redis**, and on a miss, in **Postgres**. Real links do well: the popular ones live in the cache.

Since last month, scanners have been **guessing codes**: tens of thousands of requests a second for codes nobody ever created. A guess is never in Redis, because there is nothing to cache, so every one goes to Postgres, which searches its index and answers "no such row". Postgres CPU sits at 90%, and redirects for real links are slowing down.

Constraints:
- **A real link must always redirect**, including a custom link created a second ago. Marketing announces custom links such as \`/spring\`, and people often try them before they exist.
- The guesses are **random** and come from **thousands of IP addresses**, a handful each. The same wrong code is rarely asked twice.
- A small share of guesses, **a few percent**, may still reach Postgres. Not tens of thousands a second.
- You have **4 GB of Redis memory** to spare for this. The codes alone are 14 GB as raw bytes (2 billion × 7), before Redis adds any overhead per entry.`,
    vi: `Bạn vận hành một dịch vụ **rút gọn link**: một mã 7 ký tự như \`q7Xa2Kp\` chuyển hướng tới một URL dài. Có **2 tỷ link**, và link không bao giờ bị xoá (một link có thể bị vô hiệu hoá, nhưng mã của nó vẫn bị giữ).

Mỗi lần chuyển hướng tra mã trong **Redis**, và nếu miss thì trong **Postgres**. Link thật chạy tốt: những link phổ biến nằm sẵn trong cache.

Từ tháng trước, các scanner bắt đầu **đoán mã**: hàng chục nghìn request mỗi giây cho những mã chưa ai từng tạo. Một lần đoán không bao giờ có trong Redis, vì chẳng có gì để cache, nên lần nào cũng tới Postgres, nơi tìm trong index rồi trả lời "không có dòng nào". CPU của Postgres ở mức 90%, và việc chuyển hướng cho link thật đang chậm lại.

Ràng buộc:
- **Link thật phải luôn chuyển hướng được**, kể cả một link tuỳ chỉnh vừa được tạo một giây trước. Marketing công bố các link tuỳ chỉnh như \`/spring\`, và mọi người thường thử chúng trước khi chúng tồn tại.
- Các lần đoán là **ngẫu nhiên** và đến từ **hàng nghìn địa chỉ IP**, mỗi IP vài lần. Cùng một mã sai hiếm khi bị hỏi hai lần.
- Một phần nhỏ các lần đoán, **vài phần trăm**, vẫn có thể tới Postgres. Không phải hàng chục nghìn mỗi giây.
- Bạn có **4 GB bộ nhớ Redis** dư cho việc này. Riêng các mã đã chiếm 14 GB dữ liệu thô (2 tỷ × 7 byte), chưa tính overhead mà Redis thêm cho mỗi entry.`,
  },

  question: {
    en: 'How do you stop the guesses from reaching Postgres?',
    vi: 'Bạn chặn các lần đoán khỏi tới Postgres thế nào?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Cache "not found" too: when Postgres has no row for a code, store `code → not found` in Redis for 10 minutes, so the next request for it never reaches Postgres.',
        vi: 'Cache cả "không tìm thấy": khi Postgres không có dòng nào cho một mã, lưu `mã → không tìm thấy` vào Redis trong 10 phút, để request tiếp theo cho mã đó không bao giờ tới Postgres.',
      },
      why: {
        en: 'Negative caching pays off when the same missing key is asked for again and again, such as a broken link embedded on a busy page. Here the guesses are random, so a cached "not found" is almost never asked for again: every guess still costs one Postgres query, and then a Redis entry as well. Those entries take cache space from real links, so during a scan more real links miss and Postgres gets busier, not quieter. It also gets new links wrong: when people try `/spring` before marketing creates it, the "not found" is cached, and the live link answers 404 for up to 10 minutes unless every create also deletes that entry.',
        vi: 'Negative caching có lợi khi cùng một key không tồn tại bị hỏi đi hỏi lại, ví dụ một link hỏng được nhúng trên một trang đông người xem. Ở đây các lần đoán là ngẫu nhiên, nên một "không tìm thấy" đã cache gần như không bao giờ được hỏi lại: mỗi lần đoán vẫn tốn một truy vấn Postgres, rồi thêm một entry Redis. Các entry đó chiếm chỗ của link thật trong cache, nên trong lúc bị quét, nhiều link thật bị miss hơn và Postgres bận hơn, chứ không rảnh hơn. Nó còn làm sai với link mới: khi mọi người thử `/spring` trước khi marketing tạo nó, "không tìm thấy" được cache, và link đã chạy vẫn trả 404 tới 10 phút, trừ khi mỗi lần tạo link cũng xoá entry đó.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Load every existing code into a Redis set and check `SISMEMBER` before the cache. If the code is not in the set, answer 404. Add each new code to the set when its link is created.',
        vi: 'Nạp mọi mã đang có vào một Redis set và kiểm tra `SISMEMBER` trước cache. Nếu mã không có trong set, trả 404. Thêm mỗi mã mới vào set khi link của nó được tạo.',
      },
      why: {
        en: 'It is exact: no false positives, no false negatives, and no guess ever reaches Postgres. Adding the code on create makes new links work at once. The problem is size. An exact set has to store the codes themselves: 2 billion 7-byte codes are 14 GB of raw data before Redis adds its own overhead to every entry, more than three times the 4 GB you have. An exact set is the right tool when the keys fit comfortably in memory, such as a few million usernames.',
        vi: 'Nó chính xác: không false positive, không false negative, và không lần đoán nào tới được Postgres. Thêm mã khi tạo link giúp link mới chạy được ngay. Vấn đề là kích thước. Một set chính xác phải lưu chính các mã: 2 tỷ mã 7 byte là 14 GB dữ liệu thô, chưa tính overhead mà Redis thêm cho từng entry, gấp hơn ba lần 4 GB bạn có. Set chính xác là công cụ đúng khi các key vừa thoải mái trong bộ nhớ, ví dụ vài triệu username.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'A Bloom filter of every existing code, sized for 2 billion codes at a 1% false positive rate (about 2.4 GB, 7 hash functions), checked before the cache. "Definitely not" answers 404 at once; "maybe" goes on to the usual cache and Postgres lookup. Each new link is added to the filter before its create call returns.',
        vi: 'Một Bloom filter chứa mọi mã đang có, chọn kích thước cho 2 tỷ mã ở tỉ lệ false positive 1% (khoảng 2,4 GB, 7 hàm hash), kiểm tra trước cache. "Chắc chắn không" trả 404 ngay; "có thể" đi tiếp tới cache và Postgres như thường lệ. Mỗi link mới được thêm vào filter trước khi lệnh tạo trả về.',
      },
      why: {
        en: 'A Bloom filter is a bit array. Adding a code sets the bits that its hashes point to; checking a code reads the same bits. If any of them is 0, the code was never added, and that answer is certain, so a guess is turned away without touching Redis or Postgres. If all are 1, the code is probably there and the normal lookup confirms it. A real code always finds its own bits set, so a real link is never refused, and adding new codes on create keeps that true for `/spring`. At a 1% false positive rate about 1 guess in 100 slips through to Postgres, which the constraints allow. The size follows from the standard formula: about 9.6 bits per code at 1%, so 2 billion codes need about 19 billion bits, 2.4 GB. Two cautions. A plain Bloom filter cannot remove a code (fine here: links are never deleted). And it must be sized for growth: loaded past the capacity it was sized for, more and more bits are 1 and the false positive rate climbs, so plan to rebuild it larger from Postgres.',
        vi: 'Bloom filter là một mảng bit. Thêm một mã sẽ đặt các bit mà các hàm hash của nó trỏ tới; kiểm tra một mã sẽ đọc lại đúng các bit đó. Nếu có bit nào là 0, mã chưa từng được thêm, và câu trả lời đó là chắc chắn, nên một lần đoán bị từ chối mà không chạm tới Redis hay Postgres. Nếu tất cả là 1, mã có lẽ tồn tại và bước tra cứu bình thường sẽ xác nhận. Một mã thật luôn thấy các bit của chính nó đã được đặt, nên link thật không bao giờ bị từ chối, và việc thêm mã mới khi tạo link giữ điều đó đúng cho cả `/spring`. Ở tỉ lệ false positive 1%, khoảng 1 trên 100 lần đoán lọt tới Postgres, điều mà các ràng buộc cho phép. Kích thước suy ra từ công thức chuẩn: khoảng 9,6 bit mỗi mã ở mức 1%, nên 2 tỷ mã cần khoảng 19 tỷ bit, tức 2,4 GB. Có hai lưu ý. Bloom filter thông thường không thể xoá một mã (ở đây không sao: link không bao giờ bị xoá). Và phải chọn kích thước có tính đến tăng trưởng: khi chứa vượt quá sức chứa đã định, ngày càng nhiều bit là 1 và tỉ lệ false positive tăng lên, nên hãy lên kế hoạch xây lại một filter lớn hơn từ Postgres.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Rate-limit "not found" answers per IP: after 5 lookups for missing codes in a minute, an IP gets 429 until the minute is up.',
        vi: 'Rate limit các câu trả lời "không tìm thấy" theo IP: sau 5 lần tra mã không tồn tại trong một phút, IP đó nhận 429 cho tới hết phút.',
      },
      why: {
        en: 'It is worth having against one noisy client, but this traffic is spread over thousands of IPs that each send a handful of guesses, so almost none ever reaches the limit and nearly every guess still goes to Postgres. Tightening the limit until it bites starts blocking real people behind shared addresses, such as an office or a mobile carrier\'s NAT, who mistype a link. A rate limit caps how much one client can do; it does not make the requests that get through any cheaper.',
        vi: 'Nó đáng có để chặn một client ồn ào, nhưng traffic này trải trên hàng nghìn IP, mỗi IP gửi vài lần đoán, nên gần như không IP nào chạm giới hạn và gần như mọi lần đoán vẫn tới Postgres. Siết giới hạn tới mức có tác dụng thì lại bắt đầu chặn người thật dùng chung địa chỉ, như một văn phòng hay NAT của nhà mạng di động, khi họ gõ nhầm link. Rate limit giới hạn một client làm được bao nhiêu; nó không làm cho các request lọt qua rẻ hơn chút nào.',
      },
    },
  ],

  answer: 'C',

  takeaway: {
    en: `**A cache only helps with keys that exist.** Requests for keys that don't exist go straight through it to the database. To stop them you need a cheap way to say "definitely not here".

- **A Bloom filter answers "definitely not" or "maybe".** A "no" is always right; a "yes" is right except for a false positive rate you choose. It never gives a false negative.
- **How it works:** a bit array and k hash functions. Adding an item sets k bits; checking reads the same k bits. Any 0 means the item was never added.
- **Sizing:** about 9.6 bits per item for 1% false positives, about 14.4 for 0.1%, with 7 and 10 hash functions. You pay per item, not per byte of the item, which is why it beats an exact set for long keys.
- **Size it for growth.** Past its capacity a filter's false positive rate climbs. Rebuild it larger, or use a scalable variant that adds filters as it grows.
- **No deletes** in a plain Bloom filter. If items are removed, look at counting Bloom filters or cuckoo filters.
- **Update it on the write path** (add before the create returns), so a new item is never answered "definitely not".
- The same idea sits inside databases: Cassandra and RocksDB keep a Bloom filter per data file so a read skips files that cannot hold the key.`,
    vi: `**Cache chỉ giúp được với những key có tồn tại.** Request cho key không tồn tại đi thẳng qua cache xuống database. Để chặn chúng, bạn cần một cách rẻ để nói "chắc chắn không có ở đây".

- **Bloom filter trả lời "chắc chắn không" hoặc "có thể".** Câu "không" luôn đúng; câu "có" đúng, trừ một tỉ lệ false positive do bạn chọn. Nó không bao giờ cho false negative.
- **Cách hoạt động:** một mảng bit và k hàm hash. Thêm một phần tử đặt k bit; kiểm tra đọc lại đúng k bit đó. Có một bit 0 nghĩa là phần tử chưa từng được thêm.
- **Kích thước:** khoảng 9,6 bit mỗi phần tử cho 1% false positive, khoảng 14,4 cho 0,1%, với 7 và 10 hàm hash. Bạn trả theo số phần tử, không theo số byte của phần tử, nên nó thắng set chính xác khi key dài.
- **Chọn kích thước có tính tăng trưởng.** Vượt sức chứa, tỉ lệ false positive tăng lên. Xây lại filter lớn hơn, hoặc dùng biến thể scalable tự thêm filter khi lớn dần.
- **Không xoá được** với Bloom filter thông thường. Nếu phần tử bị xoá, hãy xem counting Bloom filter hoặc cuckoo filter.
- **Cập nhật nó trên luồng ghi** (thêm trước khi lệnh tạo trả về), để một phần tử mới không bao giờ bị trả lời "chắc chắn không".
- Ý tưởng này cũng nằm sẵn trong database: Cassandra và RocksDB giữ một Bloom filter cho mỗi file dữ liệu để khi đọc thì bỏ qua những file không thể chứa key.`,
  },

  sources: [
    { title: 'Redis documentation: Bloom filter', url: 'https://redis.io/docs/latest/develop/data-types/probabilistic/bloom-filter/' },
    { title: 'Burton H. Bloom: Space/Time Trade-offs in Hash Coding with Allowable Errors (Communications of the ACM, 1970)', url: 'https://dl.acm.org/doi/10.1145/362686.362692' },
    { title: 'Apache Cassandra documentation: Bloom Filters', url: 'https://cassandra.apache.org/doc/latest/cassandra/managing/operating/bloom_filters.html' },
    { title: 'RocksDB wiki: RocksDB Bloom Filter', url: 'https://github.com/facebook/rocksdb/wiki/RocksDB-Bloom-Filter' },
  ],

  simulation,
};
